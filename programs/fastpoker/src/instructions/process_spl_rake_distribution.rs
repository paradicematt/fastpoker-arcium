use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount};
use crate::state::*;
use crate::errors::PokerError;
use crate::events::RakeDistributed;
use crate::constants::*;

/// Process SPL token rake distribution for a cash game table — runs on L1. PERMISSIONLESS.
/// Reads rake_accumulated directly from deserialized Table account.
/// Table PDA signs the token transfers using ["table", table_id, bump] seeds.
///
/// Security:
///   - Reads rake/user-created/creator/pool from Table account (no trusted args)
///   - Real token::transfer CPI — SPL Token program enforces balances
///   - Token program validated as real SPL Token program (Anchor Program<Token>)
///   - Destination token-account owners validated (pool/treasury/creator)
///   - Escrow source validated against table config

#[derive(Accounts)]
pub struct ProcessSplRakeDistribution<'info> {
    /// Crank or anyone paying for the TX
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Table PDA — needed as CPI signer for token transfers.
    #[account(
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
    )]
    pub table: Account<'info, Table>,

    /// TableVault PDA — for nonce tracking.
    #[account(
        mut,
        seeds = [VAULT_SEED, table.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, TableVault>,

    /// Table's token escrow — source of SPL tokens (ATA owned by table PDA)
    #[account(mut)]
    pub table_token_account: Account<'info, TokenAccount>,

    /// Pool's token account — receives 50% (staker share)
    #[account(mut)]
    pub pool_token_account: Account<'info, TokenAccount>,

    /// Treasury's token account — receives 25-50%
    #[account(mut)]
    pub treasury_token_account: Account<'info, TokenAccount>,

    /// Creator's token account — receives 0-25%
    #[account(mut)]
    pub creator_token_account: Account<'info, TokenAccount>,

    /// SPL Token program — validated by Anchor's Program<Token> type
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<ProcessSplRakeDistribution>,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    let table = &ctx.accounts.table;
    let table_token_mint = table.token_mint;

    // Delta check: only distribute what's NEW
    let cumulative_rake = table.rake_accumulated;
    let rake_amount = cumulative_rake
        .checked_sub(vault.total_rake_distributed)
        .unwrap_or(0);

    if rake_amount == 0 {
        msg!("No new SPL rake to distribute (cumulative={}, already_distributed={})",
             cumulative_rake, vault.total_rake_distributed);
        return Ok(());
    }

    // Validate source escrow account. If table.token_escrow is configured, enforce exact key.
    if table.token_escrow != Pubkey::default() {
        require!(
            ctx.accounts.table_token_account.key() == table.token_escrow,
            PokerError::InvalidEscrow
        );
    } else {
        require!(
            ctx.accounts.table_token_account.owner == ctx.accounts.table.key(),
            PokerError::InvalidEscrow
        );
    }

    // Validate mint and destination ownerships (prevents same-mint attacker redirection).
    require!(
        ctx.accounts.table_token_account.mint == table_token_mint,
        PokerError::InvalidTableConfig
    );
    require!(
        ctx.accounts.pool_token_account.mint == table_token_mint,
        PokerError::InvalidTableConfig
    );
    require!(
        ctx.accounts.pool_token_account.owner == table.pool,
        PokerError::InvalidTableConfig
    );
    require!(
        ctx.accounts.treasury_token_account.mint == table_token_mint,
        PokerError::InvalidTableConfig
    );
    require!(
        ctx.accounts.treasury_token_account.owner == TREASURY,
        PokerError::InvalidTableConfig
    );

    if table.is_user_created {
        require!(
            ctx.accounts.creator_token_account.mint == table_token_mint,
            PokerError::InvalidTableConfig
        );
        require!(
            ctx.accounts.creator_token_account.owner == table.creator,
            PokerError::InvalidTableConfig
        );
    } else {
        // For system tables creator share is zero; force creator account to alias treasury.
        require!(
            ctx.accounts.creator_token_account.key() == ctx.accounts.treasury_token_account.key(),
            PokerError::InvalidTableConfig
        );
    }

    // Verify sufficient token balance in escrow
    require!(
        ctx.accounts.table_token_account.amount >= rake_amount,
        PokerError::VaultInsufficient
    );

    // Calculate distribution splits
    // User-created:  50% creator, 25% stakers, 25% treasury
    // System tables:  50% stakers, 50% treasury
    let (staker_share, creator_share, treasury_share) = if table.is_user_created {
        let creator = rake_amount * 50 / 100;         // 50%
        let platform = rake_amount - creator;         // 50%
        let staker = platform / 2;                    // 25%
        let treasury = platform - staker;             // 25%
        (staker, creator, treasury)
    } else {
        let staker = rake_amount / 2;
        let treasury = rake_amount - staker;
        (staker, 0u64, treasury)
    };

    let total_transfer = staker_share + creator_share + treasury_share;

    // Table PDA signer seeds for CPI
    let table_id = table.table_id;
    let table_bump = table.bump;
    let seeds = &[TABLE_SEED, table_id.as_ref(), &[table_bump]];
    let signer_seeds = &[&seeds[..]];

    // Transfer staker share to pool's token account
    if staker_share > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.table_token_account.to_account_info(),
                    to: ctx.accounts.pool_token_account.to_account_info(),
                    authority: ctx.accounts.table.to_account_info(),
                },
                signer_seeds,
            ),
            staker_share,
        )?;
        msg!("SPL rake: {} to pool (stakers)", staker_share);
    }

    // Transfer creator share
    if creator_share > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.table_token_account.to_account_info(),
                    to: ctx.accounts.creator_token_account.to_account_info(),
                    authority: ctx.accounts.table.to_account_info(),
                },
                signer_seeds,
            ),
            creator_share,
        )?;
        msg!("SPL rake: {} to creator", creator_share);
    }

    // Transfer treasury share
    if treasury_share > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.table_token_account.to_account_info(),
                    to: ctx.accounts.treasury_token_account.to_account_info(),
                    authority: ctx.accounts.table.to_account_info(),
                },
                signer_seeds,
            ),
            treasury_share,
        )?;
        msg!("SPL rake: {} to treasury", treasury_share);
    }

    // Track withdrawal + cumulative rake distributed + bump nonce
    vault.total_withdrawn = vault.total_withdrawn
        .checked_add(total_transfer)
        .ok_or(PokerError::Overflow)?;
    vault.total_rake_distributed = vault.total_rake_distributed
        .checked_add(rake_amount)
        .ok_or(PokerError::Overflow)?;
    vault.rake_nonce = vault.rake_nonce
        .checked_add(1)
        .ok_or(PokerError::Overflow)?;

    emit!(RakeDistributed {
        table: ctx.accounts.table.key(),
        total_rake: rake_amount,
        staker_share,
        creator_share,
        treasury_share,
    });

    msg!(
        "SPL rake distributed: {} total | Stakers: {} | Creator: {} | Treasury: {} | Mint: {}",
        rake_amount, staker_share, creator_share, treasury_share, table_token_mint
    );

    Ok(())
}
