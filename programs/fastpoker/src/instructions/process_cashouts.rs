use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;
use crate::events::PlayerLeft;
use crate::constants::*;

/// Process pending cashouts for cash game players who are sitting out.
/// PERMISSIONLESS — anyone can call this (crank, other players, etc.)
///
/// The sit_out action on ER serves as the player's authorization to withdraw.
/// SOL goes directly from table PDA to the player's wallet.
/// Marker PDA rent refund goes to caller as incentive.
///
/// Must be called on L1 (table not delegated).

#[derive(Accounts)]
#[instruction(player_wallet: Pubkey)]
pub struct ProcessCashout<'info> {
    /// Anyone can trigger cashout — PERMISSIONLESS
    /// Receives marker PDA rent as incentive
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
        constraint = table.game_type == GameType::CashGame @ PokerError::InvalidGameType,
        constraint = table.phase == GamePhase::Waiting || table.phase == GamePhase::Complete @ PokerError::HandInProgress,
    )]
    pub table: Account<'info, Table>,

    /// Seat to cash out — must be Leaving or SittingOut (player's authorization)
    #[account(
        mut,
        seeds = [SEAT_SEED, table.key().as_ref(), &[seat.seat_number]],
        bump = seat.bump,
        constraint = seat.wallet == player_wallet @ PokerError::InvalidAccountData,
        constraint = (seat.status == SeatStatus::Leaving || seat.status == SeatStatus::SittingOut) @ PokerError::PlayerNotSittingOut,
    )]
    pub seat: Account<'info, PlayerSeat>,

    /// CHECK: Player's wallet to receive SOL — verified against seat.wallet
    #[account(
        mut,
        constraint = player_wallet_account.key() == player_wallet @ PokerError::InvalidAccountData,
    )]
    pub player_wallet_account: UncheckedAccount<'info>,

    /// CHECK: Player-Table marker — may not exist on L1 if player joined on ER.
    /// If it exists, we close it to caller (rent refund = crank incentive).
    #[account(mut)]
    pub player_table_marker: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ProcessCashout>, player_wallet: Pubkey) -> Result<()> {
    let table_key = ctx.accounts.table.key();
    let table = &mut ctx.accounts.table;
    let seat = &mut ctx.accounts.seat;

    let chips_cashed_out = seat.chips;
    let seat_number = seat.seat_number;

    // Transfer SOL from table PDA to player wallet
    if chips_cashed_out > 0 {
        if table.token_mint == Pubkey::default() {
            // SOL table: direct lamport transfer
            let rent = Rent::get()?;
            let min_balance = rent.minimum_balance(table.to_account_info().data_len());
            let available = table.to_account_info().lamports()
                .checked_sub(min_balance)
                .unwrap_or(0);
            let transfer_amount = std::cmp::min(chips_cashed_out, available);
            if transfer_amount > 0 {
                **table.to_account_info().try_borrow_mut_lamports()? -= transfer_amount;
                **ctx.accounts.player_wallet_account.to_account_info().try_borrow_mut_lamports()? += transfer_amount;
            }
            msg!("SOL cashout: requested={}, available={}, transferred={}", chips_cashed_out, available, transfer_amount);
        }
        // TODO: SPL token cashout support (pass token accounts via remaining_accounts)
    }

    // Clear the seat
    seat.chips = 0;
    seat.wallet = Pubkey::default();
    seat.session_key = Pubkey::default();
    seat.status = SeatStatus::Empty;
    seat.bet_this_round = 0;
    seat.total_bet_this_hand = 0;
    seat.missed_sb = false;
    seat.missed_bb = false;
    seat.missed_bb_count = 0;
    seat.sit_out_button_count = 0;
    seat.auto_fold_count = 0;
    seat.waiting_for_bb = false;

    // Update table state
    table.vacate_seat(seat_number);
    table.current_players = table.current_players.saturating_sub(1);

    // Store chip lock data in marker PDA (anti-ratholing)
    // If player rejoins within 12h, they must bring at least this many chips.
    // Marker is NOT closed — it persists for chip lock enforcement.
    let marker_info = ctx.accounts.player_table_marker.to_account_info();
    if marker_info.lamports() > 0 && marker_info.data_len() > 0 {
        let (expected_marker, _) = Pubkey::find_program_address(
            &[b"player_table", player_wallet.as_ref(), table_key.as_ref()],
            ctx.program_id,
        );
        if *marker_info.key == expected_marker {
            let mut data = marker_info.try_borrow_mut_data()?;
            // Clear the player field so marker doesn't block rejoining
            // (join_table checks marker.player != default && != wallet)
            data[8..40].copy_from_slice(&Pubkey::default().to_bytes());
            // Write chip lock data in trailing bytes (anti-ratholing)
            let co = PlayerTableMarker::CHIP_LOCK_CHIPS_OFFSET;
            let to = PlayerTableMarker::CHIP_LOCK_TIME_OFFSET;
            if data.len() >= to + 8 {
                data[co..co + 8].copy_from_slice(&chips_cashed_out.to_le_bytes());
                data[to..to + 8].copy_from_slice(&Clock::get()?.unix_timestamp.to_le_bytes());
                msg!("Chip lock set: {} chips, player must rejoin with >= this within 12h", chips_cashed_out);
            }
        }
    }

    emit!(PlayerLeft {
        table: table.key(),
        player: player_wallet,
        seat_number,
        chips_cashed_out,
    });

    msg!(
        "Cashout processed: player {} seat {} — {} lamports returned permissionlessly",
        player_wallet,
        seat_number,
        chips_cashed_out
    );
    Ok(())
}
