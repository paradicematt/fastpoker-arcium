use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;
use crate::constants::*;
use crate::hand_eval::CARD_NOT_DEALT;

/// Initialize a single seat PDA + seat_cards PDA for a table.
/// Also creates DeckState PDA on first call (init_if_needed).
/// Called BEFORE delegation — table must still be owned by our program on L1.
/// Creator (table authority) pays rent. Called once per seat (0..max_players-1).
///
/// Flow: create_table → init_table_seat(0) → init_table_seat(1) → ... → delegate_all

#[derive(Accounts)]
#[instruction(seat_index: u8)]
pub struct InitTableSeat<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
    )]
    pub table: Box<Account<'info, Table>>,

    #[account(
        init,
        payer = creator,
        space = PlayerSeat::SIZE,
        seeds = [SEAT_SEED, table.key().as_ref(), &[seat_index]],
        bump
    )]
    pub seat: Box<Account<'info, PlayerSeat>>,

    #[account(
        init,
        payer = creator,
        space = 8 + SeatCards::LEN,
        seeds = [SEAT_CARDS_SEED, table.key().as_ref(), &[seat_index]],
        bump
    )]
    pub seat_cards: Box<Account<'info, SeatCards>>,

    /// DeckState PDA — stores used-card bitmask (separated from Table for privacy).
    /// Created on first seat init (seat 0), no-op on subsequent seats.
    #[account(
        init_if_needed,
        payer = creator,
        space = DeckState::SIZE,
        seeds = [DECK_STATE_SEED, table.key().as_ref()],
        bump
    )]
    pub deck_state: Box<Account<'info, DeckState>>,

    /// CashoutReceipt — pre-created per seat. Creator pays rent; reclaimed on close_table.
    /// Used by deposit_for_join (init_if_needed becomes no-op since it already exists).
    #[account(
        init,
        payer = creator,
        space = CashoutReceipt::SIZE,
        seeds = [RECEIPT_SEED, table.key().as_ref(), &[seat_index]],
        bump
    )]
    pub receipt: Box<Account<'info, CashoutReceipt>>,

    /// TableVault PDA — holds crank_cut from distribute_prizes.
    /// Created on first seat init (seat 0), no-op on subsequent seats.
    #[account(
        init_if_needed,
        payer = creator,
        space = TableVault::SIZE,
        seeds = [VAULT_SEED, table.key().as_ref()],
        bump
    )]
    pub vault: Box<Account<'info, TableVault>>,

    /// CrankTallyER — delegated to TEE for tracking crank actions during game.
    /// Created on first seat init (seat 0), no-op on subsequent seats.
    #[account(
        init_if_needed,
        payer = creator,
        space = CrankTally::SIZE,
        seeds = [CRANK_TALLY_ER_SEED, table.key().as_ref()],
        bump
    )]
    pub crank_tally_er: Box<Account<'info, CrankTally>>,

    /// CrankTallyL1 — stays on L1, never delegated. Used by distribute_crank_rewards.
    /// Created on first seat init (seat 0), no-op on subsequent seats.
    #[account(
        init_if_needed,
        payer = creator,
        space = CrankTally::SIZE,
        seeds = [CRANK_TALLY_L1_SEED, table.key().as_ref()],
        bump
    )]
    pub crank_tally_l1: Box<Account<'info, CrankTally>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitTableSeat>, seat_index: u8) -> Result<()> {
    let table = &ctx.accounts.table;
    let seat = &mut ctx.accounts.seat;
    let seat_cards = &mut ctx.accounts.seat_cards;

    // Only table creator, table authority, or SUPER_ADMIN can init seats
    let caller = ctx.accounts.creator.key();
    let is_creator = caller == table.creator;
    let is_authority = caller == table.authority;
    let is_super = caller.to_bytes() == SUPER_ADMIN;
    require!(is_creator || is_authority || is_super, PokerError::Unauthorized);

    // Validate seat index
    require!(seat_index < table.max_players, PokerError::TableFull);

    // Initialize empty seat
    seat.wallet = Pubkey::default();
    seat.session_key = Pubkey::default();
    seat.table = table.key();
    seat.chips = 0;
    seat.bet_this_round = 0;
    seat.total_bet_this_hand = 0;
    seat.hole_cards_encrypted = [0; 64];
    seat.hole_cards_commitment = [0; 32];
    seat.hole_cards = [CARD_NOT_DEALT, CARD_NOT_DEALT];
    seat.seat_number = seat_index;
    seat.status = SeatStatus::Empty;
    seat.last_action_slot = 0;
    seat.missed_sb = false;
    seat.missed_bb = false;
    seat.posted_blind = false;
    seat.waiting_for_bb = false;
    seat.bump = ctx.bumps.seat;
    seat.vault_reserve = 0;
    seat.cashout_chips = 0;
    seat.cashout_nonce = 0;
    seat.sit_out_timestamp = 0;

    // Initialize empty seat_cards
    seat_cards.table = table.key();
    seat_cards.seat_index = seat_index;
    seat_cards.player = Pubkey::default();
    seat_cards.card1 = SeatCards::NOT_DEALT;
    seat_cards.card2 = SeatCards::NOT_DEALT;
    seat_cards.bump = ctx.bumps.seat_cards;

    // Initialize DeckState if this is the first seat (init_if_needed handles idempotency)
    let deck_state = &mut ctx.accounts.deck_state;
    if deck_state.table == Pubkey::default() {
        deck_state.table = table.key();
        deck_state.bump = ctx.bumps.deck_state;
        deck_state.shuffle_complete = false;
        deck_state.cards_revealed = 0;
        deck_state.hand_number = 0;
        deck_state.computation_offset = 0;
        deck_state.encrypted_community = [[0u8; 32]; 5];
        deck_state.encrypted_hole_cards = [[0u8; 32]; 12];
        deck_state.community_nonces = [[0u8; 16]; 5];
        deck_state.hole_card_nonces = [[0u8; 16]; 12];
        msg!("Initialized DeckState for table {}", table.key());
    }

    // Initialize TableVault if this is the first seat
    let vault = &mut ctx.accounts.vault;
    if vault.table == Pubkey::default() {
        vault.table = table.key();
        vault.total_deposited = 0;
        vault.total_withdrawn = 0;
        vault.bump = ctx.bumps.vault;
        vault.rake_nonce = 0;
        vault.total_rake_distributed = 0;
        vault.token_mint = Pubkey::default(); // SOL
        vault.total_crank_distributed = 0;
        msg!("Initialized TableVault for table {}", table.key());
    }

    // Initialize CrankTallyER if this is the first seat
    let tally_er = &mut ctx.accounts.crank_tally_er;
    if tally_er.table == Pubkey::default() {
        tally_er.table = table.key();
        tally_er.bump = ctx.bumps.crank_tally_er;
        msg!("Initialized CrankTallyER for table {}", table.key());
    }

    // Initialize CrankTallyL1 if this is the first seat
    let tally_l1 = &mut ctx.accounts.crank_tally_l1;
    if tally_l1.table == Pubkey::default() {
        tally_l1.table = table.key();
        tally_l1.bump = ctx.bumps.crank_tally_l1;
        msg!("Initialized CrankTallyL1 for table {}", table.key());
    }

    // Initialize CashoutReceipt (per-seat, creator pays rent)
    let receipt = &mut ctx.accounts.receipt;
    receipt.table = table.key();
    receipt.seat_index = seat_index;
    receipt.depositor = Pubkey::default();
    receipt.last_processed_nonce = 0;
    receipt.bump = ctx.bumps.receipt;

    msg!("Initialized seat {} + seat_cards for table {}", seat_index, table.key());
    Ok(())
}
