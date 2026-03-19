use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;
use crate::events::PlayerLeft;
use crate::constants::*;

#[derive(Accounts)]
pub struct LeaveTable<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
        constraint = table.phase == GamePhase::Waiting || table.phase == GamePhase::Complete @ PokerError::HandInProgress,
    )]
    pub table: Account<'info, Table>,

    #[account(
        mut,
        close = player,
        seeds = [SEAT_SEED, table.key().as_ref(), &[seat.seat_number]],
        bump = seat.bump,
        constraint = seat.wallet == player.key() @ PokerError::Unauthorized,
    )]
    pub seat: Account<'info, PlayerSeat>,

    /// Player-Table marker - closed when player leaves to allow rejoining later
    #[account(
        mut,
        close = player,
        seeds = [b"player_table", player.key().as_ref(), table.key().as_ref()],
        bump = player_table_marker.bump,
    )]
    pub player_table_marker: Account<'info, PlayerTableMarker>,

    /// CHECK: Player's token account for cash-out (for cash games)
    #[account(mut)]
    pub player_token_account: Option<UncheckedAccount<'info>>,

    /// CHECK: Table's token escrow (for cash games)
    #[account(mut)]
    pub table_token_account: Option<UncheckedAccount<'info>>,

    pub token_program: Option<Program<'info, anchor_spl::token::Token>>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<LeaveTable>) -> Result<()> {
    let table = &mut ctx.accounts.table;
    let seat = &ctx.accounts.seat;

    let chips_cashed_out = seat.chips;
    let seat_number = seat.seat_number;

    // For cash games, transfer chips back to player from escrow
    if table.game_type == GameType::CashGame && chips_cashed_out > 0 {
        if table.token_mint == Pubkey::default() {
            // SOL table: transfer SOL lamports from table PDA back to player
            // Cap at available balance minus rent to avoid breaking rent exemption
            let rent = Rent::get()?;
            let min_balance = rent.minimum_balance(table.to_account_info().data_len());
            let available = table.to_account_info().lamports()
                .checked_sub(min_balance)
                .unwrap_or(0);
            let transfer_amount = std::cmp::min(chips_cashed_out, available);
            if transfer_amount > 0 {
                **table.to_account_info().try_borrow_mut_lamports()? -= transfer_amount;
                **ctx.accounts.player.to_account_info().try_borrow_mut_lamports()? += transfer_amount;
            }
            msg!("SOL cashout: requested={}, available={}, transferred={}", chips_cashed_out, available, transfer_amount);
        } else if let (Some(player_token), Some(table_token), Some(token_prog)) = (
            ctx.accounts.player_token_account.as_ref(),
            ctx.accounts.table_token_account.as_ref(),
            ctx.accounts.token_program.as_ref(),
        ) {
            // SPL token table: transfer tokens from table escrow to player
            let table_id = table.table_id;
            let seeds = &[
                crate::constants::TABLE_SEED,
                table_id.as_ref(),
                &[table.bump],
            ];
            
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(
                    token_prog.to_account_info(),
                    anchor_spl::token::Transfer {
                        from: table_token.to_account_info(),
                        to: player_token.to_account_info(),
                        authority: table.to_account_info(),
                    },
                    &[seeds],
                ),
                chips_cashed_out,
            )?;
            msg!("Transferred {} tokens from escrow to player", chips_cashed_out);
        }
    }

    // For Sit & Go: refund escrowed SOL buy-in (entry + fee) if leaving during Waiting phase
    if table.is_sit_and_go() && seat.paid_entry && table.phase == GamePhase::Waiting {
        let refund_amount = table.entry_amount
            .checked_add(table.fee_amount)
            .unwrap_or(0);

        if refund_amount > 0 {
            // Refund full buy-in (entry + fee) from table PDA back to player
            **table.to_account_info().try_borrow_mut_lamports()? -= refund_amount;
            **ctx.accounts.player.to_account_info().try_borrow_mut_lamports()? += refund_amount;

            // Decrement prize pool (entry portion only)
            table.prize_pool = table.prize_pool.saturating_sub(table.entry_amount);
            // Decrement total escrowed (entry + fee)
            table.entry_fees_escrowed = table.entry_fees_escrowed.saturating_sub(refund_amount);

            msg!("Refunded {} SOL buy-in to player (prize_pool: {}, escrowed: {})",
                refund_amount, table.prize_pool, table.entry_fees_escrowed);
        }
    }

    // Update table
    table.current_players = table.current_players.saturating_sub(1);
    table.vacate_seat(seat_number);

    emit!(PlayerLeft {
        table: table.key(),
        player: seat.wallet,
        seat_number,
        chips_cashed_out,
    });

    msg!("Player {} left table, cashed out {} chips", seat.wallet, chips_cashed_out);
    Ok(())
}
