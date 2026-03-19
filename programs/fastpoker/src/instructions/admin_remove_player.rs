use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;
use crate::constants::*;

/// Admin force-remove a player from a cash game table.
/// Same as crank_remove_player but skips the sit_out_button_count >= 3 check.
/// Requires super-admin (program deployer) signature.
/// Chips are moved to UnclaimedBalance PDA so the player can reclaim later.

#[derive(Accounts)]
pub struct AdminRemovePlayer<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
        constraint = table.game_type == GameType::CashGame @ PokerError::InvalidTableConfig,
    )]
    pub table: Account<'info, Table>,

    #[account(
        mut,
        seeds = [SEAT_SEED, table.key().as_ref(), &[seat.seat_number]],
        bump = seat.bump,
    )]
    pub seat: Account<'info, PlayerSeat>,

    /// Unclaimed balance PDA - created if player has remaining chips
    #[account(
        init_if_needed,
        payer = authority,
        space = UnclaimedBalance::SIZE,
        seeds = [UNCLAIMED_SEED, table.key().as_ref(), seat.wallet.as_ref()],
        bump,
    )]
    pub unclaimed_balance: Account<'info, UnclaimedBalance>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<AdminRemovePlayer>) -> Result<()> {
    // Must be super-admin
    require!(
        ctx.accounts.authority.key().to_bytes() == SUPER_ADMIN,
        PokerError::InvalidAuthority
    );

    let table = &mut ctx.accounts.table;
    let seat = &mut ctx.accounts.seat;
    let unclaimed = &mut ctx.accounts.unclaimed_balance;
    let clock = Clock::get()?;

    // Must not be empty
    require!(
        seat.status != SeatStatus::Empty,
        PokerError::SeatEmpty
    );

    let player_wallet = seat.wallet;
    let chips_to_move = seat.chips;

    // Move chips to UnclaimedBalance PDA
    if chips_to_move > 0 {
        unclaimed.player = player_wallet;
        unclaimed.table = table.key();
        unclaimed.amount = unclaimed.amount.saturating_add(chips_to_move);
        unclaimed.last_active_at = clock.unix_timestamp;
        unclaimed.bump = ctx.bumps.unclaimed_balance;

        table.unclaimed_balance_count = table.unclaimed_balance_count.saturating_add(1);

        msg!(
            "Admin moved {} chips to unclaimed balance for player {}",
            chips_to_move,
            player_wallet
        );
    }

    // Remove player from table
    let seat_number = seat.seat_number;
    let seat_mask = 1u16 << seat_number;
    table.seats_occupied &= !seat_mask;
    table.seats_folded &= !seat_mask;
    table.seats_allin &= !seat_mask;
    table.current_players = table.current_players.saturating_sub(1);

    // Reset seat state
    seat.status = SeatStatus::Empty;
    seat.chips = 0;
    seat.wallet = Pubkey::default();
    seat.session_key = Pubkey::default();
    seat.bet_this_round = 0;
    seat.total_bet_this_hand = 0;
    seat.hole_cards = [255, 255];
    seat.hole_cards_encrypted = [0; 64];
    seat.hole_cards_commitment = [0; 32];
    seat.missed_sb = false;
    seat.missed_bb = false;
    seat.posted_blind = false;
    seat.waiting_for_bb = false;
    seat.sit_out_button_count = 0;
    seat.hands_since_bust = 0;
    seat.auto_fold_count = 0;
    seat.missed_bb_count = 0;

    msg!(
        "Admin removed player {} from seat {}. {} chips moved to unclaimed.",
        player_wallet,
        seat_number,
        chips_to_move
    );

    Ok(())
}
