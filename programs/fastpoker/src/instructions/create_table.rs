use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;
use crate::events::TableCreated;
use crate::constants::*;

#[derive(Accounts)]
#[instruction(config: TableConfig)]
pub struct CreateTable<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = Table::SIZE,
        seeds = [TABLE_SEED, config.table_id.as_ref()],
        bump
    )]
    pub table: Account<'info, Table>,

    /// CHECK: Pool PDA from Steel program (validated by seed)
    pub pool: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CreateTable>, config: TableConfig) -> Result<()> {
    let table = &mut ctx.accounts.table;
    let clock = Clock::get()?;

    // Validate config
    require!(
        config.max_players == 2 || config.max_players == 6 || config.max_players == 9,
        PokerError::InvalidTableConfig
    );

    // Get blinds - use Sit & Go starting blinds (10/20) or stakes for cash games
    let (small_blind, big_blind) = match config.game_type {
        GameType::SitAndGoHeadsUp | GameType::SitAndGo6Max | GameType::SitAndGo9Max => {
            (10, 20) // Sit & Go starts at level 1 blinds
        }
        GameType::CashGame => config.stakes.blinds(),
    };

    // Initialize table
    // Derive table authority PDA — no external keypair needed
    let (table_authority_pda, _) = Pubkey::find_program_address(
        &[TABLE_AUTHORITY_SEED],
        ctx.program_id,
    );

    table.table_id = config.table_id;
    table.authority = table_authority_pda;
    table.pool = ctx.accounts.pool.key();
    table.game_type = config.game_type;
    table.small_blind = small_blind;
    table.big_blind = big_blind;
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
    table.stakes_level = match config.stakes {
        Stakes::Micro => 0,
        Stakes::Low => 1,
        Stakes::Mid => 2,
        Stakes::High => 3,
    };
    table.blind_level = 0;
    table.tournament_start_slot = 0;
    table.creator = ctx.accounts.payer.key();
    table.bump = ctx.bumps.table;

    // Tiered SNG buy-in fields
    table.tier = config.tier;
    table.entry_amount = config.tier.entry_amount();
    table.fee_amount = config.tier.fee_amount();
    table.prize_pool = 0;
    table.token_mint = Pubkey::default(); // System tables are SOL-denominated
    table.buy_in_type = 0; // Normal buy-in for system tables

    // === Protocol Economics: compute rake_cap from TokenTierConfig (if provided) ===
    // System tables are always SOL. TokenTierConfig PDA passed as remaining_accounts[0].
    // For SNG tables, rake_cap is irrelevant (no rake on SNGs).
    table.rake_cap = if config.game_type == GameType::CashGame && !ctx.remaining_accounts.is_empty() {
        let tier_info = &ctx.remaining_accounts[0];
        let sol_mint = Pubkey::default();
        let (expected_pda, _) = Pubkey::find_program_address(
            &[TIER_CONFIG_SEED, sol_mint.as_ref()],
            ctx.program_id,
        );
        if tier_info.key() == expected_pda && tier_info.owner == ctx.program_id {
            let data = tier_info.try_borrow_data()?;
            if data.len() >= TokenTierConfig::SIZE {
                if let Ok(tier_config) = TokenTierConfig::try_deserialize(&mut &data[..]) {
                    let table_type = TokenTierConfig::table_type_from_max_players(config.max_players);
                    let cap = tier_config.compute_rake_cap(big_blind, table_type);
                    msg!("System table rake cap: {} (tier={})", cap, tier_config.tier_for_bb(big_blind));
                    cap
                } else { 0 }
            } else { 0 }
        } else { 0 }
    } else { 0 };

    table.is_private = false; // System tables are always public
    table.crank_pool_accumulated = 0;

    emit!(TableCreated {
        table: table.key(),
        table_id: config.table_id,
        authority: table.authority,
        max_players: table.max_players,
        small_blind,
        big_blind,
    });

    msg!("Table created: {:?}", table.key());
    Ok(())
}
