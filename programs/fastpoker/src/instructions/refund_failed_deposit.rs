use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;
use crate::constants::*;

/// Refund a failed deposit when the player was never seated.
/// Runs on L1 where the vault lives. Permissionless — anyone can call,
/// but funds always go to the original depositor (proof.depositor).
///
/// Security:
/// 1. Proof must NOT be consumed (player was never seated).
/// 2. Seat must be Empty (player wallet == default) — if seated, use leave_cash_game.
/// 3. Timelock: deposit must be at least REFUND_TIMELOCK_SECS old to prevent
///    front-running (player deposits → immediately refunds before crank can seat).
/// 4. Vault balance checked to prevent overdraft.
/// 5. Proof is zeroed after refund to prevent double-refund.

/// 3 minutes — enough time for the crank to attempt seating
const REFUND_TIMELOCK_SECS: i64 = 180;

#[derive(Accounts)]
#[instruction(seat_index: u8)]
pub struct RefundFailedDeposit<'info> {
    /// Anyone can trigger — permissionless
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Table pubkey — may be delegation-owned on L1.
    /// Only used for PDA derivation.
    pub table: UncheckedAccount<'info>,

    /// Seat PDA — must be Empty (wallet == default).
    /// If delegation-owned on L1, we read raw bytes.
    /// CHECK: Validated by PDA seed derivation.
    #[account(
        seeds = [SEAT_SEED, table.key().as_ref(), &[seat_index]],
        bump,
    )]
    pub seat: UncheckedAccount<'info>,

    /// Vault PDA — holds the deposited SOL. Never delegated.
    #[account(
        mut,
        seeds = [VAULT_SEED, table.key().as_ref()],
        bump = vault.bump,
        constraint = vault.table == table.key() @ PokerError::InvalidAccountData,
    )]
    pub vault: Account<'info, TableVault>,

    /// CashoutReceipt PDA — must clear depositor to unblock seat for future deposits.
    #[account(
        mut,
        seeds = [RECEIPT_SEED, table.key().as_ref(), &[seat_index]],
        bump = receipt.bump,
    )]
    pub receipt: Account<'info, CashoutReceipt>,

    /// DepositProof PDA — must exist, not consumed, with valid depositor.
    #[account(
        mut,
        seeds = [DEPOSIT_PROOF_SEED, table.key().as_ref(), &[seat_index]],
        bump = deposit_proof.bump,
        constraint = deposit_proof.table == table.key() @ PokerError::InvalidAccountData,
        constraint = deposit_proof.seat_index == seat_index @ PokerError::InvalidAccountData,
    )]
    pub deposit_proof: Account<'info, DepositProof>,

    /// Player wallet — receives the refund. Must match proof.depositor.
    /// CHECK: Validated against deposit_proof.depositor.
    #[account(mut)]
    pub player_wallet: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RefundFailedDeposit>, seat_index: u8) -> Result<()> {
    let proof = &mut ctx.accounts.deposit_proof;
    let vault = &mut ctx.accounts.vault;

    // 1. Proof must have a valid depositor (not default/zeroed)
    require!(
        proof.depositor != Pubkey::default(),
        PokerError::InvalidAccountData
    );

    // 2. Proof must NOT be consumed (player was never seated)
    require!(
        !proof.consumed,
        PokerError::InvalidAccountData
    );

    // 3. Player wallet must match the depositor
    require!(
        ctx.accounts.player_wallet.key() == proof.depositor,
        PokerError::WalletMismatch
    );

    // 4. Seat must be Empty — check wallet field from seat account bytes.
    //    If seat is delegation-owned on L1, the data is a delegation stub (not real
    //    seat data). In that case, skip the raw byte check — proof.consumed==false
    //    (verified above) is sufficient proof the player was never seated, because
    //    seat_player ALWAYS sets consumed=true before writing the seat wallet.
    {
        let seat_info = ctx.accounts.seat.to_account_info();
        let is_delegated = *seat_info.owner != crate::ID;
        if !is_delegated {
            // Seat is on L1 with our program as owner — can read real data
            let seat_data = seat_info.try_borrow_data()?;
            if seat_data.len() >= 40 {
                let seat_wallet = Pubkey::try_from(&seat_data[8..40])
                    .map_err(|_| PokerError::InvalidAccountData)?;
                require!(
                    seat_wallet == Pubkey::default(),
                    PokerError::SeatOccupied
                );
            }
        }
        // If delegated: proof.consumed == false (checked above) is sufficient —
        // seat_player on TEE always sets consumed=true before writing wallet.
    }

    // 5. Timelock: deposit must be at least REFUND_TIMELOCK_SECS old
    let clock = Clock::get()?;
    let elapsed = clock.unix_timestamp.saturating_sub(proof.deposit_timestamp);
    require!(
        elapsed >= REFUND_TIMELOCK_SECS,
        PokerError::ActionTimeout // Reuse existing error — "too early to refund"
    );

    // 6. Calculate refund amount
    let refund_amount = proof.buy_in
        .checked_add(proof.reserve)
        .ok_or(PokerError::Overflow)?;

    if refund_amount > 0 {
        let is_sol_table = vault.token_mint == Pubkey::default();
        require!(is_sol_table, PokerError::InvalidTokenAccount); // SPL refund TBD

        // Verify vault has enough to refund
        let vault_lamports = vault.to_account_info().lamports();
        let rent = Rent::get()?;
        let vault_rent = rent.minimum_balance(TableVault::SIZE);
        require!(
            vault_lamports >= refund_amount.checked_add(vault_rent).unwrap_or(u64::MAX),
            PokerError::VaultInsufficient
        );

        // Transfer SOL from vault to player
        **vault.to_account_info().try_borrow_mut_lamports()? -= refund_amount;
        **ctx.accounts.player_wallet.try_borrow_mut_lamports()? += refund_amount;

        // Update vault accounting
        vault.total_withdrawn = vault.total_withdrawn
            .checked_add(refund_amount)
            .ok_or(PokerError::Overflow)?;
    }

    // 7. Zero the proof to prevent double-refund (but keep table/seat_index/bump for PDA reuse)
    let depositor_str = proof.depositor.to_string();
    proof.depositor = Pubkey::default();
    proof.buy_in = 0;
    proof.reserve = 0;
    proof.deposit_timestamp = 0;

    // 8. Clear receipt depositor so other players can deposit to this seat
    ctx.accounts.receipt.depositor = Pubkey::default();
    // Do NOT set consumed=true — that's for seat_player. Keep consumed=false so the
    // proof is in a clean state for the next deposit_for_join to this seat.

    msg!(
        "Refund: {} lamports returned to {} (seat {} at table {}). Elapsed: {}s",
        refund_amount,
        depositor_str,
        seat_index,
        ctx.accounts.table.key(),
        elapsed
    );

    Ok(())
}
