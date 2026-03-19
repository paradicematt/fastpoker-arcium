use anchor_lang::prelude::*;
use anchor_lang::solana_program;
use anchor_spl::token;
use crate::state::*;
use crate::errors::PokerError;
use crate::events::TableCreated;
use crate::constants::*;

/// User-created cash game table configuration
/// Supports any denomination (SOL, POKER, USDC, or auction-listed tokens)
/// Fee: flat 0.05 SOL (via Steel) + denomination fee (1-2 BB in table's token)
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UserTableConfig {
    pub table_id: [u8; 32],
    pub max_players: u8,
    /// Small blind in the table's native denomination
    pub small_blind: u64,
    /// Big blind in the table's native denomination
    pub big_blind: u64,
    /// Token mint: Pubkey::default() = SOL table, otherwise SPL token mint
    pub token_mint: Pubkey,
    /// Buy-in type: 0=Normal (20-100 BB, fee=1 BB), 1=Deep Stack (50-250 BB, fee=2 BB)
    pub buy_in_type: u8,
    /// Whether this table is private (whitelist-only). Immutable after creation.
    pub is_private: bool,
}

/// Create a user-owned cash game table
/// - CASH GAMES ONLY (Sit & Go tournaments are system-managed)
/// - Creator earns 45% of rake (5% goes to dealers)
/// - Creation fee = 1 BB in the table's native token (premium tokens only for now)
/// - For SOL tables: fee paid in SOL via system_program
/// - For SPL token tables: fee paid in tokens via token::transfer
#[derive(Accounts)]
#[instruction(config: UserTableConfig)]
pub struct CreateUserTable<'info> {
    /// User creating the table (becomes creator, earns rake share)
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        init,
        payer = creator,
        space = Table::SIZE,
        seeds = [TABLE_SEED, config.table_id.as_ref()],
        bump
    )]
    pub table: Account<'info, Table>,

    /// CHECK: Pool PDA from Steel program — receives 50% of SOL fees via Steel CPI
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,

    /// Treasury receives 50% of SOL fees (via Steel) or 100% of SPL token fees
    /// CHECK: Validated by address constraint
    #[account(mut, address = TREASURY)]
    pub treasury: AccountInfo<'info>,

    /// Creator's token account (for SPL token fees) — pass program_id placeholder for SOL tables
    /// CHECK: Validated when used for SPL transfer; writability enforced by CPI
    pub creator_token_account: UncheckedAccount<'info>,

    /// Treasury's token account (for SPL token fees) — pass program_id placeholder for SOL tables
    /// CHECK: Validated when used for SPL transfer; writability enforced by CPI
    pub treasury_token_account: UncheckedAccount<'info>,

    /// Pool's token account (for SPL token fees — staker share) — pass program_id placeholder for SOL tables
    /// CHECK: Validated when used for SPL transfer; writability enforced by CPI
    pub pool_token_account: UncheckedAccount<'info>,

    /// SPL Token program — pass program_id placeholder for SOL tables
    /// CHECK: Validated by address when used
    pub token_program: UncheckedAccount<'info>,

    /// Steel staking program for CPI (50/50 fee split on SOL tables)
    /// CHECK: Validated by address constraint
    #[account(address = STEEL_PROGRAM_ID)]
    pub steel_program: AccountInfo<'info>,

    /// TableVault PDA — holds all player SOL for cash games. Never delegated.
    #[account(
        init,
        payer = creator,
        space = TableVault::SIZE,
        seeds = [VAULT_SEED, table.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, TableVault>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CreateUserTable>, config: UserTableConfig) -> Result<()> {
    let table = &mut ctx.accounts.table;
    let clock = Clock::get()?;

    // Validate config - only 2, 6, or 9 max players
    require!(
        config.max_players == 2 || config.max_players == 6 || config.max_players == 9,
        PokerError::InvalidTableConfig
    );

    // Validate blinds
    require!(
        config.small_blind > 0 && config.big_blind > config.small_blind,
        PokerError::InvalidBlinds
    );
    require!(
        config.big_blind == config.small_blind * 2,
        PokerError::InvalidBlinds
    );

    // Validate token mint: must be premium (SOL, POKER) OR auction-listed
    if !is_premium_token(&config.token_mint) {
        // Non-premium token: must have a ListedToken PDA proving it won an auction.
        // Client passes it as remaining_accounts[0].
        let remaining = ctx.remaining_accounts;
        require!(!remaining.is_empty(), PokerError::InvalidTokenMint);

        let listed_info = &remaining[0];
        let (expected_pda, _) = Pubkey::find_program_address(
            &[LISTED_TOKEN_SEED, config.token_mint.as_ref()],
            ctx.program_id,
        );
        require!(listed_info.key() == expected_pda, PokerError::InvalidTokenMint);
        require!(listed_info.owner == ctx.program_id, PokerError::InvalidTokenMint);
        require!(listed_info.data_len() == ListedToken::SIZE, PokerError::InvalidTokenMint);
    }

    // Validate buy_in_type: 0=Normal, 1=Deep Stack
    require!(
        config.buy_in_type <= 1,
        PokerError::InvalidTableConfig
    );

    // Denomination fee based on buy-in type: Normal=1 BB, Deep Stack=2 BB
    let fee_multiplier: u64 = if config.buy_in_type == 1 { 2 } else { 1 };
    let denom_fee = config.big_blind.checked_mul(fee_multiplier)
        .ok_or(PokerError::Overflow)?;

    let is_sol_table = config.token_mint == Pubkey::default();

    // ── FLAT FEE: 0.05 SOL via Steel (all table types) ──
    let flat_sol_fee: u64 = 50_000_000; // 0.05 SOL
    // For SOL tables, combine flat fee + denomination fee into a single Steel CPI
    let steel_amount = if is_sol_table {
        flat_sol_fee.checked_add(denom_fee).ok_or(PokerError::Overflow)?
    } else {
        flat_sol_fee
    };

    let mut ix_data = vec![25u8]; // discriminator for DepositPublicRevenue
    ix_data.extend_from_slice(&steel_amount.to_le_bytes());

    let ix = solana_program::instruction::Instruction {
        program_id: STEEL_PROGRAM_ID,
        accounts: vec![
            solana_program::instruction::AccountMeta::new(ctx.accounts.creator.key(), true),
            solana_program::instruction::AccountMeta::new(ctx.accounts.pool.key(), false),
            solana_program::instruction::AccountMeta::new(ctx.accounts.treasury.key(), false),
            solana_program::instruction::AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
        ],
        data: ix_data,
    };

    solana_program::program::invoke(
        &ix,
        &[
            ctx.accounts.creator.to_account_info(),
            ctx.accounts.pool.to_account_info(),
            ctx.accounts.treasury.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;
    msg!("Flat SOL fee: {} lamports (50/50 via Steel)", steel_amount);

    // ── DENOMINATION FEE: for SPL token tables, charge BB-based fee in tokens ──
    // Split 50/50 between treasury and pool (stakers), same as SOL via Steel.
    if !is_sol_table {
        require!(
            ctx.accounts.token_program.key() == anchor_spl::token::ID,
            PokerError::InvalidTokenProgram
        );

        let pool_share = denom_fee / 2;
        let treasury_share = denom_fee.saturating_sub(pool_share); // remainder to treasury

        // Treasury share
        if treasury_share > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    token::Transfer {
                        from: ctx.accounts.creator_token_account.to_account_info(),
                        to: ctx.accounts.treasury_token_account.to_account_info(),
                        authority: ctx.accounts.creator.to_account_info(),
                    },
                ),
                treasury_share,
            )?;
        }

        // Pool (staker) share
        if pool_share > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    token::Transfer {
                        from: ctx.accounts.creator_token_account.to_account_info(),
                        to: ctx.accounts.pool_token_account.to_account_info(),
                        authority: ctx.accounts.creator.to_account_info(),
                    },
                ),
                pool_share,
            )?;
        }

        msg!("Token denom fee: {} total ({} treasury, {} pool) mint {}",
             denom_fee, treasury_share, pool_share, config.token_mint);
    }

    // Derive table authority PDA — same pattern as create_table (permissionless)
    let (table_authority_pda, _) = Pubkey::find_program_address(
        &[TABLE_AUTHORITY_SEED],
        ctx.program_id,
    );

    table.table_id = config.table_id;
    table.authority = table_authority_pda;
    table.pool = ctx.accounts.pool.key();
    table.game_type = GameType::CashGame;
    table.small_blind = config.small_blind;
    table.big_blind = config.big_blind;
    table.max_players = config.max_players;
    table.current_players = 0;
    table.hand_number = 0;
    table.pot = 0;
    table.min_bet = 0;
    table.rake_accumulated = 0;
    table.community_cards = [CARD_NOT_DEALT; 5];
    table.phase = GamePhase::Waiting;
    table.current_player = 0;
    table.dealer_button = 0;
    table.small_blind_seat = 0;
    table.big_blind_seat = 0;
    table.last_action_slot = clock.unix_timestamp as u64;
    table.is_delegated = false;
    table.revealed_hands = [255; 18];
    table.hand_results = [0; 9];
    table.pre_community = [255; 5];
    table.deck_seed = [0; 32];
    table.deck_index = 0;
    table.stakes_level = 0;
    table.blind_level = 0;
    table.tournament_start_slot = 0;

    // User-created table specific fields
    table.creator = ctx.accounts.creator.key();
    table.is_user_created = true;
    table.creator_rake_total = 0;
    table.last_rake_epoch = 0;

    // Cash game fields
    table.seats_occupied = 0;
    table.seats_allin = 0;
    table.seats_folded = 0;
    table.dead_button = false;
    table.flop_reached = false;
    table.token_escrow = Pubkey::default();
    table.token_mint = config.token_mint;
    table.buy_in_type = config.buy_in_type;

    // === Protocol Economics: compute rake_cap from TokenTierConfig ===
    // TokenTierConfig PDA is passed as the LAST remaining_account.
    // If not present, rake_cap = 0 (no cap, backwards compatible).
    let remaining = ctx.remaining_accounts;
    let tier_config_idx = if is_premium_token(&config.token_mint) {
        // Premium tokens: no ListedToken check, so remaining_accounts[0] = TierConfig (if any)
        0
    } else {
        // Non-premium: remaining_accounts[0] = ListedToken, [1] = TierConfig (if any)
        1
    };

    table.rake_cap = if remaining.len() > tier_config_idx {
        let tier_info = &remaining[tier_config_idx];
        // Validate it's the correct PDA
        let (expected_pda, _) = Pubkey::find_program_address(
            &[TIER_CONFIG_SEED, config.token_mint.as_ref()],
            ctx.program_id,
        );
        if tier_info.key() == expected_pda && tier_info.owner == ctx.program_id {
            // Deserialize and compute cap
            let data = tier_info.try_borrow_data()?;
            if data.len() >= TokenTierConfig::SIZE {
                // Skip 8-byte discriminator, read tier_boundaries at offset 32 (after token_mint)
                let tier_config = TokenTierConfig::try_deserialize(&mut &data[..])?;
                let table_type = TokenTierConfig::table_type_from_max_players(config.max_players);
                let cap = tier_config.compute_rake_cap(config.big_blind, table_type);
                msg!("Rake cap computed: {} (tier={}, table_type={})",
                    cap, tier_config.tier_for_bb(config.big_blind), table_type);
                cap
            } else {
                0 // Invalid data size — no cap
            }
        } else {
            0 // Wrong PDA or not owned by program — no cap
        }
    } else {
        0 // No TierConfig passed — no cap (backwards compatible)
    };

    // Protocol economics: dealer rake is mandatory (5% of rake to dealers)
    table.is_private = config.is_private;
    table.crank_pool_accumulated = 0;

    table.bump = ctx.bumps.table;

    // Initialize vault PDA (L1 source of truth for token_mint)
    let vault = &mut ctx.accounts.vault;
    vault.table = table.key();
    vault.total_deposited = 0;
    vault.total_withdrawn = 0;
    vault.rake_nonce = 0;
    vault.total_rake_distributed = 0;
    vault.token_mint = config.token_mint;
    vault.total_crank_distributed = 0;
    vault.bump = ctx.bumps.vault;

    emit!(TableCreated {
        table: table.key(),
        table_id: config.table_id,
        authority: table.authority,
        max_players: table.max_players,
        small_blind: config.small_blind,
        big_blind: config.big_blind,
    });

    msg!(
        "User table created by {} - Blinds: {}/{}, Max: {} players, Mint: {}",
        ctx.accounts.creator.key(),
        config.small_blind,
        config.big_blind,
        config.max_players,
        config.token_mint
    );

    Ok(())
}
