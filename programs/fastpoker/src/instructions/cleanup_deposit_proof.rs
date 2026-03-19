use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use crate::constants::*;

/// Permissionless: undelegate a consumed DepositProof on ER.
/// Anyone can call this — only consumed proofs can be cleaned up.
/// Uses UncheckedAccount for deposit_proof to avoid Anchor auto-serialization
/// after the Magic undelegate CPI changes account ownership.

#[derive(Accounts)]
#[instruction(seat_index: u8)]
pub struct CleanupDepositProof<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Table pubkey — just for PDA derivation
    pub table: UncheckedAccount<'info>,

    /// CHECK: DepositProof PDA — manually validated below.
    /// Must be UncheckedAccount because the Magic undelegate CPI changes ownership,
    /// which would cause Anchor's auto-serialization to fail with ExternalAccountDataModified.
    #[account(mut)]
    pub deposit_proof: UncheckedAccount<'info>,

    /// CHECK: MagicBlock delegation program
    pub magic_program: UncheckedAccount<'info>,

    /// CHECK: MagicBlock context PDA
    #[account(mut)]
    pub magic_context: UncheckedAccount<'info>,
}

pub fn handler(
    ctx: Context<CleanupDepositProof>,
    seat_index: u8,
) -> Result<()> {
    let proof_info = ctx.accounts.deposit_proof.to_account_info();
    let payer_info = ctx.accounts.payer.to_account_info();
    let magic_program = &ctx.accounts.magic_program;
    let magic_context = &ctx.accounts.magic_context;
    let table_key = ctx.accounts.table.key();

    // Manual PDA validation (since we use UncheckedAccount)
    let (expected_pda, _bump) = Pubkey::find_program_address(
        &[DEPOSIT_PROOF_SEED, table_key.as_ref(), &[seat_index]],
        ctx.program_id,
    );
    require!(proof_info.key() == expected_pda, crate::errors::PokerError::InvalidAccountData);

    // Verify consumed flag at correct offset:
    // DepositProof layout: disc(8) + table(32) + seat_index(1) + depositor(32) + buy_in(8) + reserve(8) + consumed(1) + bump(1)
    // Offsets:              0         8            40              41               73           81           89            90
    let data = proof_info.try_borrow_data()?;
    require!(data.len() >= 91, crate::errors::PokerError::InvalidAccountData);
    let consumed = data[89]; // consumed: disc(8)+table(32)+seat_index(1)+depositor(32)+buy_in(8)+reserve(8) = 89
    drop(data);

    if consumed != 1 {
        // Unconsumed proof — only allow cleanup if the corresponding seat is Empty.
        // This handles the case where seat_player failed (e.g., seat was Leaving)
        // and the proof was delegated but never consumed, permanently blocking the seat.
        // The seat PDA must be passed as remaining_accounts[0] to prove the seat is empty.
        let remaining = ctx.remaining_accounts;
        require!(!remaining.is_empty(), crate::errors::PokerError::InvalidAccountData);
        let seat_info = &remaining[0];

        // Validate seat PDA
        let (expected_seat, _) = Pubkey::find_program_address(
            &[SEAT_SEED, table_key.as_ref(), &[seat_index]],
            ctx.program_id,
        );
        require!(seat_info.key() == expected_seat, crate::errors::PokerError::InvalidAccountData);

        // Read seat status — must be Empty (0)
        let seat_data = seat_info.try_borrow_data()?;
        let status_offset = 227usize; // SeatStatus offset in PlayerSeat
        require!(seat_data.len() > status_offset, crate::errors::PokerError::InvalidAccountData);
        let seat_status = seat_data[status_offset];
        require!(seat_status == 0, crate::errors::PokerError::InvalidAccountData); // 0 = Empty
        drop(seat_data);

        msg!("Cleaning up UNCONSUMED DepositProof {} (seat {} is Empty — stale proof recovery)", proof_info.key(), seat_index);
    } else {
        msg!("Cleaning up consumed DepositProof {}", proof_info.key());
    }

    // CPI to MagicBlock to undelegate the proof back to L1
    let undelegate_disc: [u8; 4] = [2, 0, 0, 0];
    let ix = Instruction {
        program_id: magic_program.key(),
        accounts: vec![
            AccountMeta::new(payer_info.key(), true),
            AccountMeta::new(magic_context.key(), false),
            AccountMeta::new(proof_info.key(), false),
        ],
        data: undelegate_disc.to_vec(),
    };

    match anchor_lang::solana_program::program::invoke(
        &ix,
        &[payer_info.clone(), magic_context.to_account_info(), proof_info.clone()],
    ) {
        Ok(_) => msg!("DepositProof undelegated"),
        Err(e) => msg!("Undelegate CPI failed: {:?}", e),
    }

    msg!("DepositProof cleanup complete");
    Ok(())
}
