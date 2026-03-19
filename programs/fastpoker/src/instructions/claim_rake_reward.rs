use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::*;
use crate::errors::PokerError;

/// Staker claims their share of rake from a RakeVault.
/// Share is proportional to their stake weight (read from Steel pool).
/// Only claimable if vault epoch has advanced since last claim.

#[derive(Accounts)]
pub struct ClaimRakeReward<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,

    #[account(
        mut,
        seeds = [RAKE_VAULT_SEED, rake_vault.token_mint.as_ref()],
        bump = rake_vault.bump,
    )]
    pub rake_vault: Account<'info, RakeVault>,

    #[account(
        init_if_needed,
        payer = staker,
        space = StakerClaim::SIZE,
        seeds = [STAKER_CLAIM_SEED, rake_vault.key().as_ref(), staker.key().as_ref()],
        bump,
    )]
    pub staker_claim: Account<'info, StakerClaim>,

    /// Vault's token account (source of reward)
    #[account(
        mut,
        constraint = vault_token_account.key() == rake_vault.vault_token_account @ PokerError::InvalidTokenAccount,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Staker's token account (receives reward)
    #[account(
        mut,
        constraint = staker_token_account.mint == rake_vault.token_mint @ PokerError::InvalidTokenMint,
        constraint = staker_token_account.owner == staker.key() @ PokerError::InvalidTokenAccount,
    )]
    pub staker_token_account: Account<'info, TokenAccount>,

    /// CHECK: Steel pool PDA — read stake_amount from staker's stake account
    pub pool: AccountInfo<'info>,

    /// CHECK: Staker's stake PDA in Steel — used to read stake weight
    pub stake_account: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ClaimRakeReward>) -> Result<()> {
    let vault = &ctx.accounts.rake_vault;
    let claim = &mut ctx.accounts.staker_claim;

    // Must have new epochs to claim
    require!(
        vault.current_epoch > claim.last_claimed_epoch,
        PokerError::NoRakeRewardToClaim,
    );

    // Read staker's stake weight from Steel stake account (raw bytes)
    // Steel stake account layout: disc(8) + pool(32) + authority(32) + amount(8) + ...
    let stake_data = ctx.accounts.stake_account.try_borrow_data()?;
    require!(stake_data.len() >= 80, PokerError::InvalidAccountData);
    let stake_amount = u64::from_le_bytes(
        stake_data[72..80].try_into().map_err(|_| PokerError::InvalidAccountData)?
    );
    require!(stake_amount > 0, PokerError::NoRakeRewardToClaim);

    // Read total staked from pool (raw bytes)
    // Steel pool layout: disc(8) + authority(32) + total_stake(8) + ...
    let pool_data = ctx.accounts.pool.try_borrow_data()?;
    require!(pool_data.len() >= 48, PokerError::InvalidAccountData);
    let total_staked = u64::from_le_bytes(
        pool_data[40..48].try_into().map_err(|_| PokerError::InvalidAccountData)?
    );
    require!(total_staked > 0, PokerError::InvalidAccountData);

    // Calculate claimable: (vault_balance * stake_amount) / total_staked
    let vault_balance = ctx.accounts.vault_token_account.amount;
    let claimable = (vault_balance as u128)
        .checked_mul(stake_amount as u128)
        .ok_or(PokerError::Overflow)?
        .checked_div(total_staked as u128)
        .ok_or(PokerError::Overflow)? as u64;

    require!(claimable > 0, PokerError::NoRakeRewardToClaim);

    // Transfer from vault to staker (vault PDA signs)
    let mint_key = vault.token_mint;
    let vault_seeds = &[
        RAKE_VAULT_SEED,
        mint_key.as_ref(),
        &[vault.bump],
    ];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.staker_token_account.to_account_info(),
                authority: ctx.accounts.rake_vault.to_account_info(),
            },
            &[vault_seeds],
        ),
        claimable,
    )?;

    // Update claim state
    let is_new = claim.total_claimed == 0 && claim.last_claimed_epoch == 0;
    if is_new {
        claim.rake_vault = ctx.accounts.rake_vault.key();
        claim.staker = ctx.accounts.staker.key();
        claim.bump = ctx.bumps.staker_claim;
    }
    claim.last_claimed_epoch = vault.current_epoch;
    claim.total_claimed += claimable;

    // Update vault
    let vault = &mut ctx.accounts.rake_vault;
    vault.total_claimed += claimable;

    msg!(
        "Claimed {} tokens from RakeVault (mint={}) | stake={}/{} | epoch={}",
        claimable,
        vault.token_mint,
        stake_amount,
        total_staked,
        vault.current_epoch,
    );

    Ok(())
}
