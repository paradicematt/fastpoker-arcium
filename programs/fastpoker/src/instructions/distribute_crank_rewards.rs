use anchor_lang::prelude::*;
use crate::state::*;
use crate::state::dealer_license::{DEALER_LICENSE_SEED, DealerLicense};
use crate::constants::*;
use crate::errors::PokerError;

/// L1-only instruction: distribute accumulated crank pool to operators.
///
/// Flow:
///   1. Read table.crank_pool_accumulated directly from deserialized Table
///   2. Compute delta = crank_pool_accumulated - vault.total_crank_distributed
///   3. Read CrankTallyER + CrankTallyL1, merge operator actions (L1 = 2× weight)
///   4. Pay each tracked operator their action-weighted share of delta
///   5. Update vault.total_crank_distributed += delta
///   6. Update each CrankOperator's lifetime stats
///
/// Guards:
///   - delta must be > 0 (no free payouts)
///   - Monotonic: vault.total_crank_distributed can only increase
///   - Operator PDAs validated via seeds
///
/// Called by crank-service or admin periodically (e.g., every N hands or on rake distribution).
const L1_WEIGHT_MULTIPLIER: u64 = 2;

#[derive(Accounts)]
pub struct DistributeCrankRewards<'info> {
    /// Anyone can call (permissionless — crank-service or admin)
    #[account(mut)]
    pub caller: Signer<'info>,

    /// The table whose crank pool is being distributed.
    #[account(
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
        constraint = table.key() == vault.table @ PokerError::InvalidTableConfig,
    )]
    pub table: Account<'info, Table>,

    /// Vault PDA — source of truth for distribution tracking.
    #[account(
        mut,
        seeds = [VAULT_SEED, table.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, TableVault>,

    /// CrankTallyER — read-only, TEE-side action tallies (may be delegation-owned).
    /// CHECK: Validated via seeds derivation.
    #[account(
        seeds = [CRANK_TALLY_ER_SEED, table.key().as_ref()],
        bump,
    )]
    pub crank_tally_er: UncheckedAccount<'info>,

    /// CrankTallyL1 — read-only, L1-side action tallies (never delegated).
    /// CHECK: Validated via seeds.
    #[account(
        seeds = [CRANK_TALLY_L1_SEED, table.key().as_ref()],
        bump,
    )]
    pub crank_tally_l1: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    // Remaining accounts: triplets of [operator_wallet (mut), crank_operator_pda (mut), dealer_license_pda (read)]
    // for each tracked operator to receive payout + stats update.
    // The dealer_license_pda is checked for validity — unlicensed operators get weight=0.
}

/// Merged operator entry: pubkey + weighted action count
struct OperatorWeight {
    pubkey: Pubkey,
    weight: u64,
}

pub fn handler(ctx: Context<DistributeCrankRewards>) -> Result<()> {
    // Step 1: Read crank_pool_accumulated directly from table
    let crank_pool_accumulated = ctx.accounts.table.crank_pool_accumulated;

    // Step 2: Compute delta
    let vault = &ctx.accounts.vault;
    let delta = crank_pool_accumulated.saturating_sub(vault.total_crank_distributed);
    require!(delta > 0, PokerError::InsufficientFunds);

    // Step 3: Read and merge tallies
    let mut operators: Vec<OperatorWeight> = Vec::with_capacity(MAX_CRANK_OPERATORS * 2);

    // Helper: parse a CrankTally from account data
    fn parse_tally_operators(account: &AccountInfo, weight_mul: u64) -> Vec<OperatorWeight> {
        let mut result = Vec::new();
        if let Ok(data) = account.try_borrow_data() {
            if data.len() >= CrankTally::SIZE {
                // Parse operator pubkeys at offset 40 (after 8 disc + 32 table)
                // Each operator: 32 bytes pubkey
                // Action counts at offset 40 + 128 = 168 (after 4 × 32 operators)
                for i in 0..MAX_CRANK_OPERATORS {
                    let pk_start = 40 + (i * 32);
                    let count_start = 40 + (MAX_CRANK_OPERATORS * 32) + (i * 4);
                    if pk_start + 32 <= data.len() && count_start + 4 <= data.len() {
                        let pk = Pubkey::try_from(&data[pk_start..pk_start + 32]).unwrap_or_default();
                        if pk != Pubkey::default() {
                            let count = u32::from_le_bytes(
                                data[count_start..count_start + 4].try_into().unwrap_or([0; 4])
                            );
                            if count > 0 {
                                result.push(OperatorWeight {
                                    pubkey: pk,
                                    weight: (count as u64) * weight_mul,
                                });
                            }
                        }
                    }
                }
            }
        }
        result
    }

    // ER tallies (1× weight)
    let er_ops = parse_tally_operators(&ctx.accounts.crank_tally_er, 1);
    // L1 tallies (2× weight)
    let l1_ops = parse_tally_operators(&ctx.accounts.crank_tally_l1, L1_WEIGHT_MULTIPLIER);

    // Merge: combine weights for same operator
    for op in er_ops.into_iter().chain(l1_ops.into_iter()) {
        if let Some(existing) = operators.iter_mut().find(|o| o.pubkey == op.pubkey) {
            existing.weight = existing.weight.saturating_add(op.weight);
        } else {
            operators.push(op);
        }
    }

    // ── Dealer License Enforcement ──
    // For each operator, check if a valid DealerLicense PDA exists in remaining_accounts.
    // Unlicensed operators get weight=0 — their share redistributes to licensed operators.
    let remaining = &ctx.remaining_accounts;
    for op in operators.iter_mut() {
        let (expected_license, _) = Pubkey::find_program_address(
            &[DEALER_LICENSE_SEED, op.pubkey.as_ref()],
            &crate::ID,
        );
        let has_license = remaining.iter().any(|acc| {
            acc.key() == expected_license
                && acc.owner == &crate::ID
                && acc.data_len() >= DealerLicense::SIZE
        });
        if !has_license {
            msg!("Operator {} has NO dealer license — weight zeroed", op.pubkey);
            op.weight = 0;
        }
    }

    let mut total_weight: u64 = operators.iter().map(|o| o.weight).sum();

    // Fallback for old tables with empty tallies: if no operators found in tally data
    // but remaining_accounts has a valid registered CrankOperator with a license, distribute to them.
    if total_weight == 0 && ctx.remaining_accounts.len() >= 3 {
        let wallet = ctx.remaining_accounts[0].key();
        let (expected_pda, _) = Pubkey::find_program_address(
            &[CRANK_OPERATOR_SEED, wallet.as_ref()],
            &crate::ID,
        );
        let (expected_license, _) = Pubkey::find_program_address(
            &[DEALER_LICENSE_SEED, wallet.as_ref()],
            &crate::ID,
        );
        if ctx.remaining_accounts[1].key() == expected_pda
            && ctx.remaining_accounts[1].owner == &crate::ID
            && ctx.remaining_accounts[2].key() == expected_license
            && ctx.remaining_accounts[2].owner == &crate::ID
        {
            operators.push(OperatorWeight { pubkey: wallet, weight: 1 });
            total_weight = 1;
            msg!("Fallback: distributing to licensed operator {} (no tally data)", wallet);
        }
    }

    require!(total_weight > 0, PokerError::InsufficientFunds);

    // Step 4: Pay each operator their weighted share
    // Remaining accounts: triplets [operator_wallet (mut), crank_operator_pda (mut), dealer_license_pda (read)]
    let mut total_paid: u64 = 0;

    for op in &operators {
        // Find the operator's wallet + PDA in remaining_accounts
        let wallet_idx = remaining.iter().position(|a| a.key() == op.pubkey);
        if wallet_idx.is_none() {
            continue; // Operator not passed — their share stays in the pool
        }
        let wallet_idx = wallet_idx.unwrap();

        // Operator wallet must be writable
        let operator_wallet = &remaining[wallet_idx];

        // Calculate share
        let share = delta
            .checked_mul(op.weight)
            .and_then(|v| v.checked_div(total_weight))
            .unwrap_or(0);

        if share == 0 {
            continue;
        }

        // Transfer SOL from vault PDA to operator wallet
        let vault_info = ctx.accounts.vault.to_account_info();
        **vault_info.try_borrow_mut_lamports()? -= share;
        **operator_wallet.try_borrow_mut_lamports()? += share;

        total_paid = total_paid.saturating_add(share);

        // Try to update CrankOperator lifetime stats (next account after wallet)
        if wallet_idx + 1 < remaining.len() {
            let op_pda = &remaining[wallet_idx + 1];
            let (expected_pda, _) = Pubkey::find_program_address(
                &[CRANK_OPERATOR_SEED, op.pubkey.as_ref()],
                &crate::ID,
            );
            if op_pda.key() == expected_pda && op_pda.owner == &crate::ID {
                if let Ok(mut data) = op_pda.try_borrow_mut_data() {
                    if data.len() >= CrankOperator::SIZE {
                        // CrankOperator layout: 8 disc + 32 authority + 1 mode + 8 rake_dist_interval
                        //   + 8 lifetime_actions(49) + 8 lifetime_sol_earned(57) + ...
                        let actions_offset = 49;
                        let earned_offset = 57;
                        // Increment lifetime_actions by this operator's weighted action count
                        if actions_offset + 8 <= data.len() {
                            let current = u64::from_le_bytes(
                                data[actions_offset..actions_offset + 8].try_into().unwrap_or([0; 8])
                            );
                            let new_val = current.saturating_add(op.weight);
                            data[actions_offset..actions_offset + 8].copy_from_slice(&new_val.to_le_bytes());
                        }
                        // Increment lifetime_sol_earned by this operator's share
                        if earned_offset + 8 <= data.len() {
                            let current = u64::from_le_bytes(
                                data[earned_offset..earned_offset + 8].try_into().unwrap_or([0; 8])
                            );
                            let new_val = current.saturating_add(share);
                            data[earned_offset..earned_offset + 8].copy_from_slice(&new_val.to_le_bytes());
                        }
                    }
                }
            }
        }

        msg!("Dealer {} earned {} lamports (weight: {})", op.pubkey, share, op.weight);
    }

    // Step 5: Update vault tracking
    let vault = &mut ctx.accounts.vault;
    vault.total_crank_distributed = vault.total_crank_distributed.saturating_add(total_paid);

    msg!(
        "Crank rewards distributed: {} lamports total, {} operators, pool_accumulated={}, vault_distributed={}",
        total_paid, operators.len(), crank_pool_accumulated, vault.total_crank_distributed
    );

    Ok(())
}
