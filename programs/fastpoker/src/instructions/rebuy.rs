use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::state::*;
use crate::errors::PokerError;
use crate::constants::*;

/// L1 Rebuy / Top-Up — cash games only.
///
/// Allows a seated player to add chips between hands (Waiting phase).
/// Supports both SOL tables (transfer to TableVault) and SPL token tables
/// (transfer to table's token escrow account).
///
/// Constraints:
///   - Cash games only (not SNG/tournament)
///   - Table must be in Waiting phase (between hands)
///   - Player must be seated (SittingOut or Active with 0 chips)
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
        constraint = table.phase == GamePhase::Waiting @ PokerError::HandInProgress,
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

    // Player must be seated — Active (waiting between hands) or SittingOut (rebuy to return)
    require!(
        seat.status == SeatStatus::Active
            || seat.status == SeatStatus::SittingOut,
        PokerError::InvalidActionForPhase
    );

    // Validate final chip stack against buy-in limits
    let new_chips = seat.chips.checked_add(amount).ok_or(PokerError::Overflow)?;
    let (min_bb, max_bb): (u64, u64) = if table.buy_in_type == 1 { (50, 250) } else { (20, 100) };
    let max_buy_in = table.big_blind.checked_mul(max_bb).ok_or(PokerError::Overflow)?;

    // Cannot exceed max buy-in
    require!(new_chips <= max_buy_in, PokerError::InvalidBuyIn);

    // If player had 0 chips (busted/sitting out), enforce minimum buy-in
    if seat.chips == 0 {
        let min_buy_in = table.big_blind.checked_mul(min_bb).ok_or(PokerError::Overflow)?;
        require!(new_chips >= min_buy_in, PokerError::InvalidBuyIn);
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

    // Update seat chips
    seat.chips = new_chips;

    // B8 fix: auto-activate after rebuy if SittingOut (common after bust).
    // Without this, player stays SittingOut and must manually ReturnToPlay.
    if seat.status == SeatStatus::SittingOut {
        seat.hands_since_bust = 0;
        if new_chips > 0 {
            seat.status = SeatStatus::Active;
            seat.waiting_for_bb = true; // Must wait for BB position per standard rules
            table.seats_occupied |= 1 << seat.seat_number;
            msg!("Rebuy auto-activated seat {} (was SittingOut)", seat.seat_number);
        }
    }

    msg!(
        "Rebuy complete: seat {} now has {} chips (added {}), max={}",
        seat.seat_number, new_chips, amount, max_buy_in
    );

    Ok(())
}
