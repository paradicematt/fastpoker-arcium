use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;
use crate::constants::*;

/// PERMISSIONLESS: Return unclaimed SOL to a player's wallet from a cash game table.
/// Anyone can call this (crank, other players, the player themselves).
///
/// For SOL tables (token_mint == default), buy-in SOL is stored as lamports
/// in the table PDA itself. When crank_remove_player moves chips to an
/// UnclaimedBalance PDA, this instruction transfers the actual SOL back.
///
/// Flow: caller triggers → SOL from table PDA → player wallet
///       UnclaimedBalance PDA rent → caller (crank incentive)

#[derive(Accounts)]
#[instruction(player_wallet: Pubkey)]
pub struct ClaimUnclaimedSol<'info> {
    /// Anyone can trigger — PERMISSIONLESS
    /// Receives UnclaimedBalance PDA rent as incentive
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
        constraint = table.game_type == GameType::CashGame @ PokerError::InvalidGameType,
        constraint = table.token_mint == Pubkey::default() @ PokerError::InvalidTokenAccount,
    )]
    pub table: Account<'info, Table>,

    /// Unclaimed balance PDA — rent refund goes to caller (crank incentive)
    #[account(
        mut,
        seeds = [UNCLAIMED_SEED, table.key().as_ref(), player_wallet.as_ref()],
        bump = unclaimed.bump,
        constraint = unclaimed.player == player_wallet @ PokerError::Unauthorized,
        constraint = unclaimed.table == table.key() @ PokerError::InvalidAccountData,
        constraint = unclaimed.amount > 0 @ PokerError::NothingToWithdraw,
        close = caller,
    )]
    pub unclaimed: Account<'info, UnclaimedBalance>,

    /// CHECK: Player's wallet to receive SOL — verified against unclaimed.player
    #[account(
        mut,
        constraint = player_wallet_account.key() == player_wallet @ PokerError::InvalidAccountData,
    )]
    pub player_wallet_account: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ClaimUnclaimedSol>, player_wallet: Pubkey) -> Result<()> {
    let unclaimed = &ctx.accounts.unclaimed;
    let table = &mut ctx.accounts.table;

    let amount = unclaimed.amount;

    // Transfer SOL lamports from table PDA to player wallet
    // Cap at available balance minus rent to avoid breaking rent exemption
    let rent = Rent::get()?;
    let min_balance = rent.minimum_balance(table.to_account_info().data_len());
    let available = table.to_account_info().lamports()
        .checked_sub(min_balance)
        .unwrap_or(0);
    let transfer_amount = std::cmp::min(amount, available);

    if transfer_amount > 0 {
        **table.to_account_info().try_borrow_mut_lamports()? -= transfer_amount;
        **ctx.accounts.player_wallet_account.to_account_info().try_borrow_mut_lamports()? += transfer_amount;
    }

    // Decrement table's unclaimed balance count
    table.unclaimed_balance_count = table.unclaimed_balance_count.saturating_sub(1);

    msg!(
        "Unclaimed SOL returned: player={} amount={} table={} (available={}, transferred={})",
        player_wallet,
        amount,
        table.key(),
        available,
        transfer_amount
    );

    // UnclaimedBalance PDA closed by Anchor → rent to caller
    Ok(())
}
