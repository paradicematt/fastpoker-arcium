use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod hand_eval;
pub mod side_pots;

pub mod state {
    pub mod table;
    pub mod seat;
    pub mod session;
    pub mod seat_cards;
    pub mod player;
    pub mod escrow;
    pub mod player_table_marker;
    pub mod unclaimed_balance;
    pub mod auction;
    pub mod rake_vault;
    pub mod listed_token;
    pub mod table_vault;
    pub mod cashout_receipt;
    pub mod deck_state;
    pub mod token_tier_config;
    pub mod crank_tally;
    pub mod crank_operator;
    pub mod tip_jar;
    pub mod dealer_license;
    
    pub use table::*;
    pub use seat::*;
    pub use session::*;
    pub use seat_cards::*;
    pub use player::*;
    pub use escrow::*;
    pub use player_table_marker::*;
    pub use unclaimed_balance::*;
    pub use auction::*;
    pub use rake_vault::*;
    pub use listed_token::*;
    pub use table_vault::*;
    pub use cashout_receipt::*;
    pub use deck_state::*;
    pub use token_tier_config::*;
    pub use crank_tally::*;
    pub use crank_operator::*;
    pub use tip_jar::*;
    pub mod whitelist_entry;
    pub use whitelist_entry::*;
    pub use dealer_license::*;
}

pub mod instructions {
    pub mod create_table;
    pub mod close_table;
    pub mod join_table;
    pub mod leave_table;
    pub mod player_action;
    pub mod session;
    pub mod start_game;
    pub mod settle;
    pub mod timeout;
    pub mod register;
    pub mod sit_out;
    pub mod crank_remove;
    pub mod crank_kick_inactive;
    pub mod create_user_table;
    pub mod claim_creator_rake;
    pub mod distribute_prizes;
    pub mod claim_unclaimed;
    pub mod reclaim_expired;
    pub mod cancel_hand;
    pub mod admin_close_table;
    pub mod admin_fix_table;
    pub mod admin_reset_vault;
    pub mod admin_recover_vault;
    pub mod admin_close_accounts;
    pub mod admin_remove_player;
    pub mod claim_sol_winnings;
    pub mod claim_unclaimed_sol;
    pub mod award_xp;
    pub mod process_cashout_v3;
    pub mod process_rake_distribution;
    pub mod process_spl_rake_distribution;
    pub mod init_table_seat;
    pub mod reset_sng_table;
    pub mod arcium_deal;
    pub mod arcium_deal_callback;
    pub mod arcium_reveal;
    pub mod arcium_reveal_queue;
    pub mod arcium_showdown;
    pub mod arcium_showdown_queue;
    pub mod init_comp_defs;
    
    pub use create_table::*;
    pub use award_xp::*;
    pub use claim_unclaimed::*;
    pub use reclaim_expired::*;
    pub use cancel_hand::*;
    pub use admin_close_table::*;
    pub use admin_fix_table::*;
    pub use admin_reset_vault::*;
    pub use admin_recover_vault::*;
    pub use admin_close_accounts::*;
    pub use admin_remove_player::*;
    pub use claim_sol_winnings::*;
    pub use claim_unclaimed_sol::*;
    pub use process_cashout_v3::*;
    pub use process_rake_distribution::*;
    pub use process_spl_rake_distribution::*;
    pub use init_table_seat::*;
    pub use reset_sng_table::*;
    pub use arcium_deal::*;
    pub use arcium_deal_callback::*;
    pub use arcium_reveal::*;
    pub use arcium_reveal_queue::*;
    pub use arcium_showdown::*;
    pub use arcium_showdown_queue::*;
    pub use init_comp_defs::*;
    pub mod place_bid;
    pub mod resolve_auction;
    pub mod initialize_auction_config;
    pub use place_bid::*;
    pub use resolve_auction::*;
    pub use initialize_auction_config::*;
    pub mod admin_list_token;
    pub use admin_list_token::*;
    pub mod init_token_tier_config;
    pub use init_token_tier_config::*;
    pub mod register_crank_operator;
    pub use register_crank_operator::*;
    pub mod deposit_tip;
    pub use deposit_tip::*;
    pub mod init_crank_tally;
    pub use init_crank_tally::*;
    pub mod init_table_vault;
    pub use init_table_vault::*;
    pub mod distribute_crank_rewards;
    pub use distribute_crank_rewards::*;
    pub mod dealer_license;
    pub use dealer_license::*;
    pub mod manage_whitelist;
    pub use manage_whitelist::*;
    pub mod use_time_bank;
    pub use use_time_bank::*;
    pub mod set_x25519_key;
    pub use set_x25519_key::*;
    pub mod rebuy;
    pub use rebuy::*;
    pub mod init_rake_vault;
    pub mod deposit_to_vault;
    pub mod claim_rake_reward;
    pub use init_rake_vault::*;
    pub use deposit_to_vault::*;
    pub use claim_rake_reward::*;
    pub use claim_creator_rake::*;
    pub use create_user_table::*;
    pub use close_table::*;
    pub use join_table::*;
    pub use leave_table::*;
    pub use player_action::*;
    pub use session::*;
    pub use start_game::*;
    pub use settle::*;
    pub use timeout::*;
    pub use register::*;
    pub use sit_out::*;
    pub use crank_remove::*;
    pub use crank_kick_inactive::*;
    pub use distribute_prizes::*;
}


use instructions::*;
use state::*;

declare_id!("BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N");

#[program]
pub mod fastpoker {
    use super::*;

    // === Player Registration ===
    
    /// Register a new player (pays 0.5 SOL, gets 5 free Sit & Go entries)
    pub fn register_player(ctx: Context<RegisterPlayer>) -> Result<()> {
        instructions::register::register_handler(ctx)
    }

    // === Table Management ===
    
    pub fn create_table(ctx: Context<CreateTable>, config: TableConfig) -> Result<()> {
        instructions::create_table::handler(ctx, config)
    }

    /// Create a user-owned cash game table (earns 50% of rake)
    pub fn create_user_table(ctx: Context<CreateUserTable>, config: UserTableConfig) -> Result<()> {
        instructions::create_user_table::handler(ctx, config)
    }

    /// Claim accumulated creator rake (50% of rake for user-created tables)
    pub fn claim_creator_rake(ctx: Context<ClaimCreatorRake>) -> Result<()> {
        instructions::claim_creator_rake::handler(ctx)
    }

    pub fn close_table<'info>(ctx: Context<'_, '_, 'info, 'info, CloseTable<'info>>) -> Result<()> {
        instructions::close_table::handler(ctx)
    }

    /// Admin: force-remove a player from a cash game table (bypasses sit-out count).
    /// Super-admin only. Chips moved to unclaimed balance PDA.
    pub fn admin_remove_player(ctx: Context<AdminRemovePlayer>) -> Result<()> {
        instructions::admin_remove_player::handler(ctx)
    }

    /// Admin: force-close a table regardless of player count or unclaimed balances.
    /// Authority-only. For cleanup of stuck test tables.
    pub fn admin_close_table(ctx: Context<AdminCloseTable>) -> Result<()> {
        instructions::admin_close_table::handler(ctx)
    }


    /// Admin: close any program-owned accounts (seats, markers, etc.) to recover rent.
    pub fn admin_close_accounts<'info>(ctx: Context<'_, '_, 'info, 'info, AdminCloseAccounts<'info>>) -> Result<()> {
        instructions::admin_close_accounts::handler(ctx)
    }

    /// Admin: patch corrupted bool fields so table can be deserialized again.
    pub fn admin_fix_table(ctx: Context<AdminFixTable>, reset_to_waiting: bool) -> Result<()> {
        instructions::admin_fix_table::handler(ctx, reset_to_waiting)
    }

    /// Admin: reset vault counters for testing.
    pub fn admin_reset_vault(ctx: Context<AdminResetVault>) -> Result<()> {
        instructions::admin_reset_vault::handler(ctx)
    }

    /// Super-admin: emergency vault recovery for stuck/orphaned tables.
    pub fn admin_recover_vault(ctx: Context<AdminRecoverVault>, amount: u64) -> Result<()> {
        instructions::admin_recover_vault::handler(ctx, amount)
    }

    // === XP / Level System ===

    /// Award XP to a player (permissionless crank)
    pub fn award_xp(ctx: Context<AwardXp>, args: AwardXpArgs) -> Result<()> {
        instructions::award_xp::handler(ctx, args)
    }

    // === Table Setup ===

    /// Initialize a single seat + seat_cards PDA for a table.
    /// Creator pays rent. Call once per seat (0..max_players-1).
    pub fn init_table_seat(ctx: Context<InitTableSeat>, seat_index: u8) -> Result<()> {
        instructions::init_table_seat::handler(ctx, seat_index)
    }


    // === Player Actions ===

    pub fn join_table(ctx: Context<JoinTable>, buy_in: u64, seat_number: u8, reserve: u64) -> Result<()> {
        instructions::join_table::handler(ctx, buy_in, seat_number, reserve)
    }

    /// L1 Rebuy / Top-Up — cash games only, SOL or SPL token.
    /// Player must be seated and table in Waiting phase.
    pub fn rebuy(ctx: Context<Rebuy>, amount: u64) -> Result<()> {
        instructions::rebuy::handler(ctx, amount)
    }

    pub fn set_x25519_key(ctx: Context<SetX25519Key>, x25519_pubkey: [u8; 32]) -> Result<()> {
        instructions::set_x25519_key::handler(ctx, x25519_pubkey)
    }

    pub fn leave_table(ctx: Context<LeaveTable>) -> Result<()> {
        instructions::leave_table::handler(ctx)
    }

    /// Sit out - remain at table but skip hands
    pub fn sit_out(ctx: Context<SitOut>) -> Result<()> {
        instructions::sit_out::sit_out_handler(ctx)
    }

    /// Sit back in - may need to post missed blinds
    pub fn sit_in(ctx: Context<SitIn>, post_missed_blinds: bool) -> Result<()> {
        instructions::sit_out::sit_in_handler(ctx, post_missed_blinds)
    }

    pub fn player_action<'info>(ctx: Context<'_, '_, 'info, 'info, PlayerAction<'info>>, action: PokerAction) -> Result<()> {
        instructions::player_action::handler(ctx, action)
    }

    /// Start a game when enough players have joined (Waiting → Starting)
    pub fn start_game(ctx: Context<StartGame>) -> Result<()> {
        instructions::start_game::handler(ctx)
    }


    // === Session Keys ===
    
    pub fn create_session(
        ctx: Context<CreateSession>,
        session_pubkey: Pubkey,
        valid_until: i64,
    ) -> Result<()> {
        instructions::session::create_handler(ctx, session_pubkey, valid_until)
    }

    pub fn revoke_session(ctx: Context<RevokeSession>) -> Result<()> {
        instructions::session::revoke_handler(ctx)
    }

    // === Game Logic ===

    /// Settle hand - FULLY ON-CHAIN
    /// Reads seat_cards to compute hand rankings, calculates side pots, determines winners
    /// No external input needed - everything verified on-chain
    pub fn settle_hand(ctx: Context<SettleHand>) -> Result<()> {
        instructions::settle::handler(ctx)
    }

    pub fn handle_timeout(ctx: Context<HandleTimeout>, expected_nonce: u16) -> Result<()> {
        instructions::timeout::handler(ctx, expected_nonce)
    }

    /// Declare a misdeal — refund pot and reset table.
    /// Retry the failing instruction first. Misdeal is last resort.
    pub fn misdeal(ctx: Context<Misdeal>) -> Result<()> {
        instructions::cancel_hand::misdeal_handler(ctx)
    }


    // === Crank/Maintenance ===

    /// Remove inactive player from cash game (anyone can call)
    /// Removes players who sat out for 3+ button passes or bust for 3+ hands
    pub fn crank_remove_player(ctx: Context<CrankRemovePlayer>) -> Result<()> {
        instructions::crank_remove::handler(ctx)
    }

    /// Kick inactive cash game players — PERMISSIONLESS.
    /// Marks seat as Leaving + snapshots cashout. process_cashout_v3 handles payout.
    pub fn crank_kick_inactive(ctx: Context<CrankKickInactive>) -> Result<()> {
        instructions::crank_kick_inactive::handler(ctx)
    }


    // === Tournament Prize Distribution ===

    /// Distribute tournament prizes — PERMISSIONLESS.
    /// Reads elimination order from on-chain state. Anyone/crank can call.
    /// Contract verifies Complete phase + prizes not yet distributed.
    pub fn distribute_prizes<'info>(
        ctx: Context<'_, '_, 'info, 'info, DistributePrizes<'info>>,
    ) -> Result<()> {
        instructions::distribute_prizes::distribute_prizes_handler(ctx)
    }

    /// Reset a completed SNG table for reuse — PERMISSIONLESS.
    /// Zeros all seats, resets table to Waiting phase. Requires phase=Complete
    /// and prizes_distributed=true. Table must be on L1 (undelegated).
    /// remaining_accounts: seat PDAs (0..max_players)
    pub fn reset_sng_table<'info>(
        ctx: Context<'_, '_, 'info, 'info, ResetSngTable<'info>>,
    ) -> Result<()> {
        instructions::reset_sng_table::handler(ctx)
    }


    // === Arcium MPC Setup ===

    /// Initialize shuffle_and_deal computation definition (one-time setup)
    pub fn init_shuffle_comp_def(ctx: Context<InitShuffleCompDef>) -> Result<()> {
        instructions::init_comp_defs::init_shuffle_handler(ctx)
    }

    /// Initialize reveal_community computation definition (one-time setup)
    pub fn init_reveal_comp_def(ctx: Context<InitRevealCompDef>) -> Result<()> {
        instructions::init_comp_defs::init_reveal_handler(ctx)
    }

    /// Initialize reveal_showdown computation definition (one-time setup)
    pub fn init_showdown_comp_def(ctx: Context<InitShowdownCompDef>) -> Result<()> {
        instructions::init_comp_defs::init_showdown_handler(ctx)
    }

    // === Arcium MPC Deal ===

    /// Queue MPC shuffle_and_deal computation via Arcium.
    /// Called by crank after start_game. Transitions Starting → AwaitingDeal.
    pub fn arcium_deal(
        ctx: Context<ArciumDeal>,
        computation_offset: u64,
        player_data: Vec<u8>,
        num_players: u8,
    ) -> Result<()> {
        instructions::arcium_deal::handler(ctx, computation_offset, player_data, num_players)
    }

    /// Callback: MPC shuffle_and_deal results — writes encrypted cards to DeckState/SeatCards.
    /// Called by Arcium MPC cluster after shuffle_and_deal computation completes.
    /// Verifies BLS signature, writes encrypted hole cards + community cards, transitions to Preflop.
    pub fn shuffle_and_deal_callback<'info>(
        ctx: Context<'_, '_, 'info, 'info, ShuffleAndDealCallback<'info>>,
        output: arcium_anchor::SignedComputationOutputs<instructions::arcium_deal_callback::ShuffleAndDealOutput>,
    ) -> Result<()> {
        instructions::arcium_deal_callback::shuffle_and_deal_callback_handler(ctx, output)
    }

    /// Queue MPC reveal_community computation via Arcium.
    /// Called by crank when phase is *RevealPending. Reads encrypted community
    /// cards from DeckState and queues MPC to decrypt them.
    pub fn arcium_reveal_queue(
        ctx: Context<ArciumRevealQueue>,
        computation_offset: u64,
        num_to_reveal: u8,
    ) -> Result<()> {
        instructions::arcium_reveal_queue::handler(ctx, computation_offset, num_to_reveal)
    }

    /// Callback: MPC reveal_community results — writes plaintext community cards.
    /// Called by Arcium MPC cluster after reveal_community computation completes.
    /// Parses SignedComputationOutputs, writes plaintext to Table, advances phase.
    pub fn reveal_community_callback(
        ctx: Context<RevealCommunityCallback>,
        output: arcium_anchor::SignedComputationOutputs<instructions::arcium_reveal::RevealCommunityOutput>,
    ) -> Result<()> {
        instructions::arcium_reveal::reveal_community_callback_handler(ctx, output)
    }

    /// Queue MPC reveal_all_showdown computation via Arcium.
    /// Single call reveals ALL active players' hole cards from MXE-packed u128.
    /// Transitions Showdown → AwaitingShowdown. Callback transitions back.
    pub fn arcium_showdown_queue(
        ctx: Context<ArciumShowdownQueue>,
        computation_offset: u64,
    ) -> Result<()> {
        instructions::arcium_showdown_queue::handler(ctx, computation_offset)
    }

    /// Callback: MPC reveal_all_showdown result — writes all players' plaintext hole cards.
    /// Called ONCE by Arcium MPC cluster. Transitions AwaitingShowdown → Showdown.
    pub fn reveal_showdown_callback<'info>(
        ctx: Context<'_, '_, 'info, 'info, RevealShowdownCallback<'info>>,
        output: arcium_anchor::SignedComputationOutputs<instructions::arcium_showdown::RevealShowdownOutput>,
    ) -> Result<()> {
        instructions::arcium_showdown::reveal_showdown_callback_handler(ctx, output)
    }

    // === Crank Instructions ===

    /// Unified L1 cashout — vault transfer + seat clear in one instruction.
    /// Replaces v1 (wrong fund source) and v2+clear_leaving_seat (two-step ER dance).
    /// SOL from vault → player wallet. SPL from escrow → player ATA.
    /// Nonce-protected, clears seat, writes chip lock. PERMISSIONLESS.
    pub fn process_cashout_v3(ctx: Context<ProcessCashoutV3>, seat_index: u8) -> Result<()> {
        instructions::process_cashout_v3::handler(ctx, seat_index)
    }

    /// Distribute SOL rake from vault to pool/treasury/creator. PERMISSIONLESS.
    /// Reads rake_accumulated from table account — NO caller-provided amounts.
    pub fn process_rake_distribution(ctx: Context<ProcessRakeDistribution>) -> Result<()> {
        instructions::process_rake_distribution::handler(ctx)
    }

    /// Distribute SPL token rake from table escrow to pool/treasury/creator. PERMISSIONLESS.
    /// Uses token::transfer CPI. Reads all inputs from table account (no caller args).
    pub fn process_spl_rake_distribution(ctx: Context<ProcessSplRakeDistribution>) -> Result<()> {
        instructions::process_spl_rake_distribution::handler(ctx)
    }

    // === Unclaimed Balance Instructions ===

    /// Player claims their unclaimed balance from a table
    /// Only callable by the original player before expiry (100 days)
    pub fn claim_unclaimed(ctx: Context<ClaimUnclaimed>) -> Result<()> {
        instructions::claim_unclaimed::handler(ctx)
    }

    /// PERMISSIONLESS: Return unclaimed SOL to player from a SOL cash game table.
    /// Crank calls this after crank_remove_player creates UnclaimedBalance PDAs.
    pub fn claim_unclaimed_sol(ctx: Context<ClaimUnclaimedSol>, player_wallet: Pubkey) -> Result<()> {
        instructions::claim_unclaimed_sol::handler(ctx, player_wallet)
    }

    /// Table creator reclaims expired unclaimed balances
    /// Only callable after 100 days from player's last_active_at
    pub fn reclaim_expired(ctx: Context<ReclaimExpired>, player: Pubkey) -> Result<()> {
        instructions::reclaim_expired::handler(ctx, player)
    }

    // === SOL Winnings Claim ===

    /// Claim accumulated SOL winnings from tiered SNGs.
    /// Only the player can claim their own balance. Works on L1.
    pub fn claim_sol_winnings(ctx: Context<ClaimSolWinnings>) -> Result<()> {
        instructions::claim_sol_winnings::handler(ctx)
    }

    // === Token Listing Auction (Permissionless) ===

    /// One-time permissionless init of the AuctionConfig singleton PDA
    pub fn initialize_auction_config(ctx: Context<InitializeAuctionConfig>) -> Result<()> {
        instructions::initialize_auction_config::handler(ctx)
    }

    /// Bid SOL for a token mint to be listed (auto-creates auction for current epoch)
    pub fn place_bid(ctx: Context<PlaceBid>, epoch: u64, amount: u64, anchor_vote: Option<u64>) -> Result<()> {
        instructions::place_bid::handler(ctx, epoch, amount, anchor_vote)
    }

    /// Resolve an ended auction epoch — anyone can call, advances config with adaptive duration
    pub fn resolve_auction<'info>(ctx: Context<'_, '_, 'info, 'info, ResolveAuction<'info>>, computed_anchor: u64) -> Result<()> {
        instructions::resolve_auction::handler(ctx, computed_anchor)
    }

    /// Admin-only: manually list a token (restore after redeploy or list legacy winners)
    pub fn admin_list_token(ctx: Context<AdminListToken>, epoch: u64) -> Result<()> {
        instructions::admin_list_token::handler(ctx, epoch)
    }

    // === Dealer Service (Crank Economics) ===

    /// Register as a Dealer (crank operator). Anyone can call. Pays own PDA rent.
    pub fn register_crank_operator(ctx: Context<RegisterCrankOperator>) -> Result<()> {
        instructions::register_crank_operator::handler(ctx)
    }

    /// Update Dealer mode and rake distribution interval
    pub fn update_crank_operator(ctx: Context<UpdateCrankOperator>, mode: CrankMode, rake_dist_interval: u64) -> Result<()> {
        instructions::register_crank_operator::update_handler(ctx, mode, rake_dist_interval)
    }

    /// Deposit SOL into a table's tip jar for dealer rewards
    pub fn deposit_tip(ctx: Context<DepositTip>, amount: u64, hands: u16) -> Result<()> {
        instructions::deposit_tip::handler(ctx, amount, hands)
    }

    /// Initialize CrankTallyER for a table (tracks crank actions during gameplay)
    pub fn init_crank_tally_er(ctx: Context<InitCrankTallyEr>) -> Result<()> {
        instructions::init_crank_tally::init_er_handler(ctx)
    }

    /// Initialize CrankTallyL1 for a table (tracks L1-only crank actions)
    pub fn init_crank_tally_l1(ctx: Context<InitCrankTallyL1>) -> Result<()> {
        instructions::init_crank_tally::init_l1_handler(ctx)
    }

    /// Initialize TipJar for a table (tracks dealer tips)
    pub fn init_tip_jar(ctx: Context<InitTipJar>) -> Result<()> {
        instructions::init_crank_tally::init_tip_jar_handler(ctx)
    }

    /// Initialize TableVault for a table (idempotent — required for prize/crank distribution)
    pub fn init_table_vault(ctx: Context<InitTableVault>) -> Result<()> {
        instructions::init_table_vault::handler(ctx)
    }

    /// Distribute accumulated crank pool rewards to operators (action-weighted)
    pub fn distribute_crank_rewards(ctx: Context<DistributeCrankRewards>) -> Result<()> {
        instructions::distribute_crank_rewards::handler(ctx)
    }

    // === Dealer License ===

    /// Admin: create the singleton DealerRegistry PDA
    pub fn init_dealer_registry(ctx: Context<InitDealerRegistry>) -> Result<()> {
        instructions::dealer_license::init_dealer_registry_handler(ctx)
    }

    /// Admin: grant a free dealer license to a wallet
    pub fn grant_dealer_license(ctx: Context<GrantDealerLicense>) -> Result<()> {
        instructions::dealer_license::grant_dealer_license_handler(ctx)
    }

    /// Permissionless: purchase a dealer license via bonding curve
    pub fn purchase_dealer_license(ctx: Context<PurchaseDealerLicense>) -> Result<()> {
        instructions::dealer_license::purchase_dealer_license_handler(ctx)
    }

    // === Private Tables (Whitelist) ===

    /// Add a player to a private table's whitelist (creator only)
    pub fn add_whitelist(ctx: Context<AddWhitelist>, player: Pubkey) -> Result<()> {
        instructions::manage_whitelist::add_handler(ctx, player)
    }

    /// Remove a player from a private table's whitelist (creator only, closes PDA)
    pub fn remove_whitelist(ctx: Context<RemoveWhitelist>, player: Pubkey) -> Result<()> {
        instructions::manage_whitelist::remove_handler(ctx, player)
    }

    // === Time Bank ===

    /// Player uses time bank to get extra time for current action (15s chunks, max 60s total)
    pub fn use_time_bank(ctx: Context<UseTimeBank>) -> Result<()> {
        instructions::use_time_bank::handler(ctx)
    }

    // === Token Tier Config ===

    /// Admin-only: initialize TokenTierConfig for a token mint (SOL gets hardcoded tiers)
    pub fn init_token_tier_config(ctx: Context<InitTokenTierConfig>, token_mint: Pubkey) -> Result<()> {
        instructions::init_token_tier_config::handler(ctx, token_mint)
    }

    /// Admin-only: update TokenTierConfig boundaries and cap BPS
    pub fn update_token_tier_config(
        ctx: Context<UpdateTokenTierConfig>,
        tier_boundaries: [u64; 7],
        cap_bps: [u32; 21],
        min_bb: u64,
    ) -> Result<()> {
        instructions::init_token_tier_config::update_handler(ctx, tier_boundaries, cap_bps, min_bb)
    }

    // === Rake Vault (Multi-Token Staker Rewards) ===

    /// Admin: initialize a RakeVault for a specific token mint
    pub fn init_rake_vault(ctx: Context<InitRakeVault>) -> Result<()> {
        instructions::init_rake_vault::handler(ctx)
    }

    /// Deposit rake tokens into a vault (called by crank after rake distribution)
    pub fn deposit_to_vault(ctx: Context<DepositToVault>, amount: u64) -> Result<()> {
        instructions::deposit_to_vault::handler(ctx, amount)
    }

    /// Staker claims their proportional share of rake from a vault
    pub fn claim_rake_reward(ctx: Context<ClaimRakeReward>) -> Result<()> {
        instructions::claim_rake_reward::handler(ctx)
    }
}

// Arcium MPC integration uses manual CPI (not #[arcium_program] macro)
// because #[arcium_program] conflicts with session-keys crate.
// Account structs for arcium_deal/reveal/showdown will use standard
// Anchor #[derive(Accounts)] with Arcium program accounts passed as
// UncheckedAccount (validated manually in handler).
