use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;
use crate::state::*;
use crate::errors::PokerError;
use crate::events::RakeDistributed;
use crate::constants::*;

const STEEL_DEPOSIT_PUBLIC_REVENUE_DISC: u8 = 25;

fn transfer_lamports_atomic(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }

    let mut from_lamports = from.try_borrow_mut_lamports()?;
    let mut to_lamports = to.try_borrow_mut_lamports()?;

    let next_from = (**from_lamports)
        .checked_sub(amount)
        .ok_or(PokerError::VaultInsufficient)?;
    let next_to = (**to_lamports)
        .checked_add(amount)
        .ok_or(PokerError::Overflow)?;

    **from_lamports = next_from;
    **to_lamports = next_to;
    Ok(())
}

/// Process rake distribution for a cash game table — runs on L1. PERMISSIONLESS.
/// Reads rake_accumulated directly from deserialized Table account.
///
/// Security (100% contract-level, zero frontend dependency):
/// 1. rake_accumulated READ from table account — caller CANNOT inflate.
/// 2. total_rake_distributed delta prevents double-distribution.
/// 3. pool/treasury/creator validated against table account data.
/// 4. Vault balance check prevents spending player funds.
/// 5. Permissionless — anyone can trigger, but payout amounts are contract-determined.

#[derive(Accounts)]
pub struct ProcessRakeDistribution<'info> {
    /// Crank or anyone paying for the TX
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Table PDA — read-only. Contains rake_accumulated, pool, creator, is_user_created.
    #[account(
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
    )]
    pub table: Account<'info, Table>,

    /// TableVault PDA — holds SOL.
    #[account(
        mut,
        seeds = [VAULT_SEED, table.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, TableVault>,

    /// Pool PDA — receives 50% (staker share)
    /// CHECK: Validated against table.pool field
    #[account(mut)]
    pub pool_account: AccountInfo<'info>,

    /// Treasury wallet
    /// CHECK: Must match TREASURY constant
    #[account(
        mut,
        constraint = treasury_account.key() == TREASURY @ PokerError::InvalidTableConfig,
    )]
    pub treasury_account: AccountInfo<'info>,

    /// Creator wallet — receives 25% for user-created tables
    /// CHECK: Validated against table.creator field
    #[account(mut)]
    pub creator_account: AccountInfo<'info>,

    /// CHECK: Steel Tokenomics program for DepositPublicRevenue CPI
    #[account(address = STEEL_PROGRAM_ID)]
    pub steel_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ProcessRakeDistribution>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    let table = &ctx.accounts.table;

    // Validate pool_account matches table's pool field
    require!(
        ctx.accounts.pool_account.key() == table.pool,
        PokerError::InvalidTableConfig
    );

    // Validate creator_account matches table data
    if table.is_user_created {
        require!(
            ctx.accounts.creator_account.key() == table.creator,
            PokerError::InvalidTableConfig
        );
    }

    // Delta check: only distribute what's NEW
    let cumulative_rake = table.rake_accumulated;
    let rake_amount = cumulative_rake
        .checked_sub(vault.total_rake_distributed)
        .unwrap_or(0);

    if rake_amount == 0 {
        msg!("No new rake (table_cumulative={}, vault_distributed={})",
             cumulative_rake, vault.total_rake_distributed);
        return Ok(());
    }

    // Split: creator gets 45% (user-created only), 5% dealer (accumulated in crank_pool on settle),
    // rest → Steel public revenue (25% stakers, 25% treasury)
    let creator_share = if table.is_user_created { rake_amount * 45 / 100 } else { 0u64 };
    let platform_share = rake_amount - creator_share;
    let total_transfer = creator_share + platform_share;

    // Verify vault has enough SOL (minus rent)
    let rent = Rent::get()?;
    let vault_rent = rent.minimum_balance(TableVault::SIZE);
    let vault_lamports = vault.to_account_info().lamports();
    require!(
        vault_lamports >= total_transfer.checked_add(vault_rent).unwrap_or(u64::MAX),
        PokerError::VaultInsufficient
    );

    // Route platform share through Steel's DepositPublicRevenue in the same instruction.
    // Payer fronts the transfer into Steel first, then vault reimburses payer.
    // This guarantees pool/treasury routing before any vault payout to caller.
    if platform_share > 0 {
        let mut steel_data = vec![STEEL_DEPOSIT_PUBLIC_REVENUE_DISC];
        steel_data.extend_from_slice(&platform_share.to_le_bytes());

        let steel_ix = Instruction {
            program_id: STEEL_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(ctx.accounts.payer.key(), true),
                AccountMeta::new(ctx.accounts.pool_account.key(), false),
                AccountMeta::new(ctx.accounts.treasury_account.key(), false),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            ],
            data: steel_data,
        };

        invoke(
            &steel_ix,
            &[
                ctx.accounts.steel_program.to_account_info(),
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.pool_account.to_account_info(),
                ctx.accounts.treasury_account.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        ).map_err(|e| {
            msg!("Steel DepositPublicRevenue CPI failed: {:?}", e);
            PokerError::InvalidAccountData
        })?;

        // Reimburse payer from vault only after Steel CPI succeeds.
        transfer_lamports_atomic(
            &vault.to_account_info(),
            &ctx.accounts.payer.to_account_info(),
            platform_share,
        )?;

        msg!("Rake: {} platform share deposited via Steel and reimbursed", platform_share);
    }

    // Transfer creator share directly from vault (after platform routing succeeds)
    if creator_share > 0 {
        transfer_lamports_atomic(
            &vault.to_account_info(),
            &ctx.accounts.creator_account,
            creator_share,
        )?;
        msg!("Rake: {} to creator {}", creator_share, ctx.accounts.creator_account.key());
    }

    // Track withdrawal + cumulative distributed
    vault.total_withdrawn = vault.total_withdrawn
        .checked_add(total_transfer)
        .ok_or(PokerError::Overflow)?;
    vault.total_rake_distributed = vault.total_rake_distributed
        .checked_add(rake_amount)
        .ok_or(PokerError::Overflow)?;
    vault.rake_nonce = vault.rake_nonce
        .checked_add(1)
        .ok_or(PokerError::Overflow)?;

    let staker_share = platform_share / 2;
    let treasury_share = platform_share - staker_share;

    emit!(RakeDistributed {
        table: ctx.accounts.table.key(),
        total_rake: rake_amount,
        staker_share,
        creator_share,
        treasury_share,
    });

    msg!(
        "Rake distributed: {} (delta) | Cumulative: {} | Stakers: {} | Creator: {} | Treasury: {}",
        rake_amount, vault.total_rake_distributed, staker_share, creator_share, treasury_share
    );

    // === Optional: Record L1 action in CrankTallyL1 ===
    // If remaining_accounts[0] is the CrankTallyL1 PDA for this table, record payer's action.
    // L1 actions get 2× weight in distribute_crank_rewards.
    if !ctx.remaining_accounts.is_empty() {
        let tally_info = &ctx.remaining_accounts[0];
        let (expected_tally, _) = Pubkey::find_program_address(
            &[CRANK_TALLY_L1_SEED, ctx.accounts.table.key().as_ref()],
            &crate::ID,
        );
        if tally_info.key() == expected_tally && tally_info.owner == &crate::ID && tally_info.is_writable {
            if let Ok(mut data) = tally_info.try_borrow_mut_data() {
                if data.len() >= CrankTally::SIZE {
                    let caller = ctx.accounts.payer.key();
                    let mut recorded = false;
                    for i in 0..MAX_CRANK_OPERATORS {
                        let pk_start = 40 + (i * 32);
                        let count_start = 168 + (i * 4);
                        let pk = Pubkey::try_from(&data[pk_start..pk_start + 32]).unwrap_or_default();
                        if pk == caller {
                            let count = u32::from_le_bytes(data[count_start..count_start + 4].try_into().unwrap_or([0; 4]));
                            data[count_start..count_start + 4].copy_from_slice(&(count.saturating_add(1)).to_le_bytes());
                            recorded = true;
                            break;
                        }
                        if pk == Pubkey::default() {
                            data[pk_start..pk_start + 32].copy_from_slice(caller.as_ref());
                            data[count_start..count_start + 4].copy_from_slice(&1u32.to_le_bytes());
                            recorded = true;
                            break;
                        }
                    }
                    let ta_off = 184;
                    let ta = u32::from_le_bytes(data[ta_off..ta_off + 4].try_into().unwrap_or([0; 4]));
                    data[ta_off..ta_off + 4].copy_from_slice(&(ta.saturating_add(1)).to_le_bytes());
                    if recorded {
                        msg!("L1 action recorded for dealer {}", caller);
                    }
                }
            }
        }
    }

    Ok(())
}
