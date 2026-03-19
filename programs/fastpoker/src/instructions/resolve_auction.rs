use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;

/// Permissionless: anyone (crank) resolves an auction after its epoch ends.
/// Caller passes the winning GlobalTokenBid PDA — the #1 on the persistent leaderboard.
/// On resolve: winning bid is ZEROED (removed from leaderboard), ListedToken PDA created,
/// config advances to next epoch with adaptive duration (±1 day based on demand).
///
/// If `computed_anchor > 0`, also auto-creates a TokenTierConfig PDA for the winning token
/// using the anchor formula: [anchor/10, anchor/4, anchor/2, anchor, anchor×5, anchor×10, u64::MAX].
/// The `computed_anchor` is the SOL-weighted median of all bidders' anchor_vote values.
///
/// CK-007: Anchor is now VERIFIED ON-CHAIN. Crank must pass all GlobalBidContribution
/// accounts with votes as remaining_accounts. Contract computes weighted median and
/// requires it matches computed_anchor. Passing computed_anchor=0 skips tier config.

#[derive(Accounts)]
#[instruction(computed_anchor: u64)]
pub struct ResolveAuction<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// AuctionConfig singleton — updated to advance to next epoch
    #[account(
        mut,
        seeds = [AUCTION_CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, AuctionConfig>,

    #[account(
        mut,
        constraint = auction.status == AuctionStatus::Active @ PokerError::AuctionNotActive,
        constraint = auction.epoch == config.current_epoch @ PokerError::InvalidAccountData,
    )]
    pub auction: Account<'info, AuctionState>,

    /// The winning GlobalTokenBid PDA (#1 on leaderboard — highest total_amount)
    #[account(
        mut,
        seeds = [GLOBAL_BID_SEED, winning_bid.token_mint.as_ref()],
        bump = winning_bid.bump,
        constraint = winning_bid.total_amount > 0 @ PokerError::NoBids,
    )]
    pub winning_bid: Account<'info, GlobalTokenBid>,

    /// ListedToken PDA — created here to mark the winning mint as approved for cash games.
    #[account(
        init_if_needed,
        payer = payer,
        space = ListedToken::SIZE,
        seeds = [LISTED_TOKEN_SEED, winning_bid.token_mint.as_ref()],
        bump,
    )]
    pub listed_token: Account<'info, ListedToken>,

    /// TokenTierConfig PDA — auto-created when computed_anchor > 0.
    /// Community-governed config derived from anchor vote weighted median.
    #[account(
        init_if_needed,
        payer = payer,
        space = TokenTierConfig::SIZE,
        seeds = [TIER_CONFIG_SEED, winning_bid.token_mint.as_ref()],
        bump,
    )]
    pub tier_config: Account<'info, TokenTierConfig>,

    pub system_program: Program<'info, System>,
}

pub fn handler<'info>(ctx: Context<'_, '_, 'info, 'info, ResolveAuction<'info>>, computed_anchor: u64) -> Result<()> {
    let clock = Clock::get()?;
    let config = &mut ctx.accounts.config;
    let auction = &mut ctx.accounts.auction;

    // Auction epoch must have ended
    require!(clock.unix_timestamp >= config.current_epoch_end(), PokerError::AuctionNotEnded);

    let winning_bid = &mut ctx.accounts.winning_bid;

    // ── Resolve the auction ──
    auction.status = AuctionStatus::Resolved;
    auction.winning_mint = winning_bid.token_mint;

    // Initialize or update the ListedToken marker
    let listed = &mut ctx.accounts.listed_token;
    listed.token_mint = winning_bid.token_mint;
    listed.winning_epoch = auction.epoch;
    listed.listed_at = clock.unix_timestamp;
    listed.bump = ctx.bumps.listed_token;

    let winner_mint = winning_bid.token_mint;
    let winner_amount = winning_bid.total_amount;
    let winner_bidders = winning_bid.bidder_count;

    // ── CK-007: Verify anchor vote ON-CHAIN from remaining_accounts ──
    // Crank passes GlobalBidContribution accounts as remaining_accounts.
    // Contract validates each via PDA derivation, reads amount + anchor_vote,
    // and computes the SOL-weighted median. Must match computed_anchor.
    let verified_anchor = if computed_anchor > 0 {
        require!(
            !ctx.remaining_accounts.is_empty(),
            PokerError::AnchorVoteMismatch
        );

        // GlobalBidContribution layout (90 bytes):
        // [0..8]   discriminator
        // [8..40]  token_mint (Pubkey)
        // [40..72] bidder (Pubkey)
        // [72..80] amount (u64 LE)
        // [80]     anchor_vote option tag (0=None, 1=Some)
        // [81..89] anchor_vote value (u64 LE, only if tag=1)
        // [89]     bump
        const CONTRIB_MINT_OFF: usize = 8;
        const CONTRIB_BIDDER_OFF: usize = 40;
        const CONTRIB_AMOUNT_OFF: usize = 72;
        const CONTRIB_VOTE_TAG_OFF: usize = 80;
        const CONTRIB_VOTE_VAL_OFF: usize = 81;

        // Collect valid (vote, weight) pairs
        let mut votes: Vec<(u64, u64)> = Vec::new();

        for acct in ctx.remaining_accounts.iter() {
            // Must be owned by our program
            require!(
                acct.owner == ctx.program_id,
                PokerError::InvalidAccountData
            );

            let data = acct.try_borrow_data()?;
            require!(data.len() >= 90, PokerError::InvalidAccountData);

            // Read mint and bidder for PDA verification
            let mint = Pubkey::try_from(&data[CONTRIB_MINT_OFF..CONTRIB_BIDDER_OFF])
                .map_err(|_| error!(PokerError::InvalidAccountData))?;
            let bidder = Pubkey::try_from(&data[CONTRIB_BIDDER_OFF..CONTRIB_AMOUNT_OFF])
                .map_err(|_| error!(PokerError::InvalidAccountData))?;

            // Must be for the winning mint
            require!(mint == winner_mint, PokerError::InvalidAccountData);

            // Verify PDA derivation — proves this is a real GlobalBidContribution
            let (expected_pda, _) = Pubkey::find_program_address(
                &[GLOBAL_CONTRIB_SEED, mint.as_ref(), bidder.as_ref()],
                ctx.program_id,
            );
            require!(expected_pda == acct.key(), PokerError::InvalidAccountData);

            // Read amount and anchor_vote
            let amount = u64::from_le_bytes(
                data[CONTRIB_AMOUNT_OFF..CONTRIB_AMOUNT_OFF + 8].try_into().unwrap()
            );
            let vote_tag = data[CONTRIB_VOTE_TAG_OFF];
            if vote_tag != 1 || amount == 0 { continue; }
            let vote = u64::from_le_bytes(
                data[CONTRIB_VOTE_VAL_OFF..CONTRIB_VOTE_VAL_OFF + 8].try_into().unwrap()
            );
            if vote == 0 { continue; }

            votes.push((vote, amount));
        }

        // Compute SOL-weighted median: sort by vote ascending, find median by cumulative weight
        // Bubble sort — acceptable for small voter counts (< 50 expected)
        for i in 0..votes.len() {
            for j in (i + 1)..votes.len() {
                if votes[j].0 < votes[i].0 {
                    votes.swap(i, j);
                }
            }
        }

        let total_weight: u64 = votes.iter().map(|(_, w)| *w).sum();
        let half_weight = total_weight / 2;
        let mut cum_weight: u64 = 0;
        let mut on_chain_anchor: u64 = 0;
        for (vote, weight) in &votes {
            cum_weight = cum_weight.saturating_add(*weight);
            if cum_weight >= half_weight {
                on_chain_anchor = *vote;
                break;
            }
        }

        msg!(
            "CK-007: On-chain anchor verification — {} voters, total_weight={}, median={}",
            votes.len(), total_weight, on_chain_anchor
        );

        // Must match what the crank claimed
        require!(
            on_chain_anchor == computed_anchor,
            PokerError::AnchorVoteMismatch
        );

        on_chain_anchor
    } else {
        0
    };

    // ── Auto-create TokenTierConfig from verified anchor vote ──
    if verified_anchor > 0 {
        let tier_cfg = &mut ctx.accounts.tier_config;
        tier_cfg.token_mint = winner_mint;
        // Anchor formula: [anchor/10, anchor/4, anchor/2, anchor, anchor*5, anchor*10, u64::MAX]
        tier_cfg.tier_boundaries = [
            verified_anchor / 10,              // Micro ceiling
            verified_anchor / 4,               // Low ceiling
            verified_anchor / 2,               // Mid-Low ceiling
            verified_anchor,                   // Mid ceiling (the anchor itself)
            verified_anchor.saturating_mul(5),  // Mid-High ceiling
            verified_anchor.saturating_mul(10), // High ceiling
            u64::MAX,                          // Nosebleed (catch-all)
        ];
        // Use standard cap BPS table (same ratios as SOL)
        tier_cfg.cap_bps = SOL_CAP_BPS;
        tier_cfg.min_bb = verified_anchor / 100; // 1% of anchor as minimum BB
        tier_cfg.community_governed = true;
        tier_cfg.updated_at = clock.unix_timestamp;
        tier_cfg.authority = ctx.accounts.payer.key(); // resolver becomes authority
        tier_cfg.bump = ctx.bumps.tier_config;

        msg!(
            "TokenTierConfig created from verified anchor vote: anchor={}, boundaries=[{},{},{},{},{},{},MAX]",
            verified_anchor,
            tier_cfg.tier_boundaries[0],
            tier_cfg.tier_boundaries[1],
            tier_cfg.tier_boundaries[2],
            tier_cfg.tier_boundaries[3],
            tier_cfg.tier_boundaries[4],
            tier_cfg.tier_boundaries[5],
        );
    }

    // ── Remove winner from leaderboard (zero out global bid) ──
    winning_bid.total_amount = 0;
    winning_bid.bidder_count = 0;

    // ── Adaptive epoch duration ──
    let current_total = auction.total_bid;
    let last_total = config.last_total_bid;
    let current_duration = config.current_epoch_duration;

    let next_duration = if last_total == 0 {
        current_duration
    } else if current_total > last_total {
        let d = current_duration - AUCTION_STEP_SECS;
        if d < AUCTION_MIN_EPOCH_SECS { AUCTION_MIN_EPOCH_SECS } else { d }
    } else if current_total < last_total {
        let d = current_duration + AUCTION_STEP_SECS;
        if d > AUCTION_EPOCH_SECS { AUCTION_EPOCH_SECS } else { d }
    } else {
        current_duration
    };

    // ── Advance config to next epoch ──
    config.last_total_bid = current_total;
    config.current_epoch += 1;
    config.current_epoch_start = clock.unix_timestamp;
    config.current_epoch_duration = next_duration;

    msg!(
        "Epoch {} resolved: {} LISTED ({} SOL, {} bidders, anchor={}). Next epoch {} ({}d).",
        auction.epoch,
        winner_mint,
        winner_amount,
        winner_bidders,
        computed_anchor,
        config.current_epoch,
        next_duration / 86_400,
    );

    Ok(())
}
