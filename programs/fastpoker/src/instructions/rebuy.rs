use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::state::*;
use crate::errors::PokerError;
use crate::constants::*;

/// L1 Rebuy / Top-Up — cash games only.
///
/// Allows a seated player to add chips between or during hands.
/// - During Waiting/Complete phase: funds go directly to chips (instant top-up).
/// - During active hand (any other phase): funds go to vault_reserve,
///   which is converted to chips at next start_game.
///
/// Supports both SOL tables (transfer to TableVault) and SPL token tables
/// (transfer to table's token escrow account).
///
/// Constraints:
///   - Cash games only (not SNG/tournament)
///   - Player must be seated (Active, SittingOut, Folded, or AllIn)
///   - Final chip stack must respect buy-in limits (20-100 BB normal, 50-250 BB deep)
///   - Cannot exceed max buy-in (no over-topping)

#[derive(Accounts)]
#[instruction(amount: u64)]
pub struct Rebuy<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
        constraint = table.game_type == GameType::CashGame @ PokerError::InvalidActionForPhase,
    )]
    pub table: Box<Account<'info, Table>>,

    #[account(
        mut,
        seeds = [SEAT_SEED, table.key().as_ref(), &[seat.seat_number]],
        bump = seat.bump,
        constraint = seat.wallet == player.key() @ PokerError::NotPlayersTurn,
        constraint = seat.table == table.key() @ PokerError::SeatNotAtTable,
    )]
    pub seat: Box<Account<'info, PlayerSeat>>,

    /// TableVault PDA — for SOL tables. Optional (not needed for SPL token tables).
    #[account(
        mut,
        seeds = [VAULT_SEED, table.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Option<Account<'info, TableVault>>,

    /// CHECK: Player's token account (for SPL token tables)
    #[account(mut)]
    pub player_token_account: Option<UncheckedAccount<'info>>,

    /// CHECK: Table's token escrow (for SPL token tables)
    #[account(mut)]
    pub table_token_account: Option<UncheckedAccount<'info>>,

    pub token_program: Option<Program<'info, anchor_spl::token::Token>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Rebuy>, amount: u64) -> Result<()> {
    let table = &mut ctx.accounts.table;
    let seat = &mut ctx.accounts.seat;

    require!(amount > 0, PokerError::InvalidBuyIn);

    // Player must be seated — Active, SittingOut, Folded, or AllIn
    require!(
        seat.status == SeatStatus::Active
            || seat.status == SeatStatus::SittingOut
            || seat.status == SeatStatus::Folded
            || seat.status == SeatStatus::AllIn,
        PokerError::InvalidActionForPhase
    );

    // Calculate buy-in limits
    let (min_bb, max_bb): (u64, u64) = if table.buy_in_type == 1 { (50, 250) } else { (20, 100) };
    let max_buy_in = table.big_blind.checked_mul(max_bb).ok_or(PokerError::Overflow)?;

    // Check total (chips + existing reserve + new amount) against max buy-in
    let total_effective = seat.chips
        .checked_add(seat.vault_reserve).ok_or(PokerError::Overflow)?
        .checked_add(amount).ok_or(PokerError::Overflow)?;
    require!(total_effective <= max_buy_in, PokerError::InvalidBuyIn);

    // Determine if we can apply directly or must stage in vault_reserve
    let is_between_hands = table.phase == GamePhase::Waiting || table.phase == GamePhase::Complete;

    if is_between_hands {
        // Direct apply: validate final chip stack
        let new_chips = seat.chips.checked_add(amount).ok_or(PokerError::Overflow)?
            .checked_add(seat.vault_reserve).ok_or(PokerError::Overflow)?;
        // If player had 0 chips, enforce minimum buy-in
        if seat.chips == 0 && seat.vault_reserve == 0 {
            let min_buy_in = table.big_blind.checked_mul(min_bb).ok_or(PokerError::Overflow)?;
            require!(new_chips >= min_buy_in, PokerError::InvalidBuyIn);
        }
    }

    // Transfer funds based on table denomination
    if table.token_mint == Pubkey::default() {
        // SOL table: transfer lamports to TableVault PDA
        let vault = ctx.accounts.vault.as_mut()
            .ok_or(PokerError::InvalidAccountData)?;
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.player.to_account_info(),
                    to: vault.to_account_info(),
                },
            ),
            amount,
        )?;
        vault.total_deposited = vault.total_deposited
            .checked_add(amount)
            .ok_or(PokerError::Overflow)?;
        msg!("Rebuy: {} lamports transferred to vault", amount);
    } else if let (Some(player_token), Some(table_token), Some(token_prog)) = (
        ctx.accounts.player_token_account.as_ref(),
        ctx.accounts.table_token_account.as_ref(),
        ctx.accounts.token_program.as_ref(),
    ) {
        // SPL token table: validate mints + transfer tokens
        require!(
            token_prog.key() == anchor_spl::token::ID,
            PokerError::InvalidTokenProgram
        );
        // Validate player token account mint matches table
        {
            let pt_data = player_token.try_borrow_data()?;
            require!(pt_data.len() >= 32, PokerError::InvalidTokenAccount);
            let pt_mint = Pubkey::try_from(&pt_data[0..32])
                .map_err(|_| PokerError::InvalidTokenAccount)?;
            require!(pt_mint == table.token_mint, PokerError::InvalidTokenMint);
        }
        // Validate table token account mint + owner
        {
            let tt_data = table_token.try_borrow_data()?;
            require!(tt_data.len() >= 64, PokerError::InvalidTokenAccount);
            let tt_mint = Pubkey::try_from(&tt_data[0..32])
                .map_err(|_| PokerError::InvalidTokenAccount)?;
            require!(tt_mint == table.token_mint, PokerError::InvalidTokenMint);
            let tt_owner = Pubkey::try_from(&tt_data[32..64])
                .map_err(|_| PokerError::InvalidTokenAccount)?;
            require!(tt_owner == table.key(), PokerError::InvalidEscrow);
        }

        anchor_spl::token::transfer(
            CpiContext::new(
                token_prog.to_account_info(),
                anchor_spl::token::Transfer {
                    from: player_token.to_account_info(),
                    to: table_token.to_account_info(),
                    authority: ctx.accounts.player.to_account_info(),
                },
            ),
            amount,
        )?;
        msg!("Rebuy: {} tokens (mint {}) transferred to escrow", amount, table.token_mint);
    } else {
        return Err(PokerError::InvalidAccountData.into());
    }

    if is_between_hands {
        // Direct apply: convert any existing reserve + new amount to chips
        let to_add = amount.checked_add(seat.vault_reserve).ok_or(PokerError::Overflow)?;
        seat.chips = seat.chips.checked_add(to_add).ok_or(PokerError::Overflow)?;
        seat.vault_reserve = 0;

        // B8 fix: auto-activate after rebuy if SittingOut (common after bust).
        if seat.status == SeatStatus::SittingOut {
            seat.hands_since_bust = 0;
            if seat.chips > 0 {
                seat.status = SeatStatus::Active;
                seat.waiting_for_bb = true;
                table.seats_occupied |= 1 << seat.seat_number;
                msg!("Rebuy auto-activated seat {} (was SittingOut)", seat.seat_number);
            }
        }
        msg!(
            "Rebuy complete: seat {} now has {} chips (added {}), max={}",
            seat.seat_number, seat.chips, to_add, max_buy_in
        );
    } else {
        // Mid-hand: stage in vault_reserve, converted at next start_game
        seat.vault_reserve = seat.vault_reserve
            .checked_add(amount).ok_or(PokerError::Overflow)?;
        msg!(
            "Rebuy staged: seat {} vault_reserve={} (added {}), chips={}, max={}",
            seat.seat_number, seat.vault_reserve, amount, seat.chips, max_buy_in
        );
    }

    Ok(())
}
