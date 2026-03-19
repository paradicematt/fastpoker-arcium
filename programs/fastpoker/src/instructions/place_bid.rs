use anchor_lang::prelude::*;
use anchor_lang::solana_program;
use crate::state::*;
use crate::errors::PokerError;
use crate::constants::{TREASURY, STEEL_PROGRAM_ID};

/// Permissionless: anyone bids SOL for a token mint to be listed.
/// Bids are PERSISTENT — they carry across epochs on a global leaderboard.
/// At epoch end, #1 on the leaderboard wins (gets listed for cash games).
/// Winning token is removed; all others carry forward to next epoch.
/// CPI into Steel's DepositPublicRevenue — 50/50 split (stakers + treasury).

#[derive(Accounts)]
#[instruction(epoch: u64, amount: u64, anchor_vote: Option<u64>)]
pub struct PlaceBid<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,

    /// AuctionConfig singleton — validates epoch timing
    #[account(
        seeds = [AUCTION_CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, AuctionConfig>,

    #[account(
        init_if_needed,
        payer = bidder,
        space = AuctionState::SIZE,
        seeds = [AUCTION_SEED, &epoch.to_le_bytes()],
        bump,
    )]
    pub auction: Account<'info, AuctionState>,

    /// CHECK: The SPL token mint the bidder wants listed
    pub candidate_mint: AccountInfo<'info>,

    /// Global persistent bid for this token (carries across epochs)
    #[account(
        init_if_needed,
        payer = bidder,
        space = GlobalTokenBid::SIZE,
        seeds = [GLOBAL_BID_SEED, candidate_mint.key().as_ref()],
        bump,
    )]
    pub global_bid: Account<'info, GlobalTokenBid>,

    /// Bidder's cumulative contribution to this token
    #[account(
        init_if_needed,
        payer = bidder,
        space = GlobalBidContribution::SIZE,
        seeds = [GLOBAL_CONTRIB_SEED, candidate_mint.key().as_ref(), bidder.key().as_ref()],
        bump,
    )]
    pub global_contribution: Account<'info, GlobalBidContribution>,

    /// CHECK: Treasury wallet — validated by address, passed to Steel CPI
    #[account(mut, constraint = treasury.key() == TREASURY @ PokerError::InvalidAuthority)]
    pub treasury: AccountInfo<'info>,

    /// CHECK: Pool PDA from Steel staking program — validated by Steel CPI
    #[account(mut)]
    pub pool: AccountInfo<'info>,

    /// CHECK: Steel staking program — validated by address
    #[account(address = STEEL_PROGRAM_ID)]
    pub steel_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<PlaceBid>, epoch: u64, amount: u64, anchor_vote: Option<u64>) -> Result<()> {
    require!(amount > 0, PokerError::ZeroBidAmount);

    let clock = Clock::get()?;
    let config = &ctx.accounts.config;

    // Validate epoch matches config's current epoch
    require!(epoch == config.current_epoch, PokerError::AuctionNotActive);

    // Validate we're within the epoch's time window
    require!(clock.unix_timestamp >= config.current_epoch_start, PokerError::AuctionNotActive);
    require!(clock.unix_timestamp < config.current_epoch_end(), PokerError::AuctionAlreadyEnded);

    // ── Validate candidate_mint is a real SPL token mint ──
    let mint_info = &ctx.accounts.candidate_mint;
    let mint_data = mint_info.try_borrow_data()?;
    let spl_token_id = anchor_spl::token::ID;
    let token_2022_id: Pubkey = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb".parse().unwrap();

    if *mint_info.owner == token_2022_id {
        return Err(PokerError::Token2022NotSupported.into());
    }
    require!(*mint_info.owner == spl_token_id, PokerError::NotValidMint);
    require!(mint_data.len() >= 82, PokerError::NotValidMint);
    require!(mint_data[45] == 1, PokerError::NotValidMint);

    let freeze_tag = u32::from_le_bytes([mint_data[46], mint_data[47], mint_data[48], mint_data[49]]);
    require!(freeze_tag == 0, PokerError::MintHasFreezeAuthority);

    drop(mint_data);

    let auction = &mut ctx.accounts.auction;

    // Auto-initialize auction on first bid of this epoch
    if auction.bump == 0 {
        auction.epoch = epoch;
        auction.start_time = config.current_epoch_start;
        auction.end_time = config.current_epoch_end();
        auction.status = AuctionStatus::Active;
        auction.winning_mint = Pubkey::default();
        auction.total_bid = 0;
        auction.token_count = 0;
        auction.bump = ctx.bumps.auction;
    }

    require!(auction.status == AuctionStatus::Active, PokerError::AuctionNotActive);

    // CPI into Steel's DepositPublicRevenue (discriminator 25)
    let mut ix_data = vec![25u8];
    ix_data.extend_from_slice(&amount.to_le_bytes());

    let ix = solana_program::instruction::Instruction {
        program_id: STEEL_PROGRAM_ID,
        accounts: vec![
            solana_program::instruction::AccountMeta::new(ctx.accounts.bidder.key(), true),
            solana_program::instruction::AccountMeta::new(ctx.accounts.pool.key(), false),
            solana_program::instruction::AccountMeta::new(ctx.accounts.treasury.key(), false),
            solana_program::instruction::AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
        ],
        data: ix_data,
    };

    solana_program::program::invoke(
        &ix,
        &[
            ctx.accounts.bidder.to_account_info(),
            ctx.accounts.pool.to_account_info(),
            ctx.accounts.treasury.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;

    // ── Update global persistent bid ──
    let global_bid = &mut ctx.accounts.global_bid;
    let is_new_token = global_bid.total_amount == 0 && global_bid.bidder_count == 0;
    if is_new_token {
        global_bid.token_mint = ctx.accounts.candidate_mint.key();
        global_bid.bump = ctx.bumps.global_bid;
    }

    let global_contrib = &mut ctx.accounts.global_contribution;
    let is_new_bidder = global_contrib.amount == 0;
    if is_new_bidder {
        global_contrib.token_mint = ctx.accounts.candidate_mint.key();
        global_contrib.bidder = ctx.accounts.bidder.key();
        global_contrib.bump = ctx.bumps.global_contribution;
        global_bid.bidder_count += 1;
    }

    global_bid.total_amount += amount;
    global_contrib.amount += amount;

    // Store anchor vote (overwrite previous vote if any)
    if anchor_vote.is_some() {
        global_contrib.anchor_vote = anchor_vote;
    }

    // Track epoch-level stats (new SOL deposited this epoch)
    if is_new_token {
        auction.token_count += 1;
    }
    auction.total_bid += amount;

    msg!(
        "Bid placed: {} lamports for mint {} (global total: {}, bidders: {}, epoch {})",
        amount,
        ctx.accounts.candidate_mint.key(),
        global_bid.total_amount,
        global_bid.bidder_count,
        epoch,
    );

    Ok(())
}
