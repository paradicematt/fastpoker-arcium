use anchor_lang::prelude::*;
use crate::state::*;
use crate::constants::SUPER_ADMIN;
use crate::errors::PokerError;

/// Admin-only: manually create a ListedToken PDA for a token mint.
/// Used to restore listings after program redeploy or to list tokens
/// that won auctions under the old epoch system.

#[derive(Accounts)]
pub struct AdminListToken<'info> {
    #[account(
        mut,
        constraint = admin.key().to_bytes() == SUPER_ADMIN @ PokerError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    /// CHECK: The SPL token mint to list. Validated as a real SPL token mint.
    pub token_mint: AccountInfo<'info>,

    /// ListedToken PDA — created here.
    #[account(
        init_if_needed,
        payer = admin,
        space = ListedToken::SIZE,
        seeds = [LISTED_TOKEN_SEED, token_mint.key().as_ref()],
        bump,
    )]
    pub listed_token: Account<'info, ListedToken>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<AdminListToken>, epoch: u64) -> Result<()> {
    let clock = Clock::get()?;
    let mint_info = &ctx.accounts.token_mint;

    // Basic SPL token mint validation
    let spl_token_id = anchor_spl::token::ID;
    require!(*mint_info.owner == spl_token_id, PokerError::NotValidMint);
    let mint_data = mint_info.try_borrow_data()?;
    require!(mint_data.len() >= 82, PokerError::NotValidMint);
    require!(mint_data[45] == 1, PokerError::NotValidMint); // is_initialized
    drop(mint_data);

    let listed = &mut ctx.accounts.listed_token;
    listed.token_mint = mint_info.key();
    listed.winning_epoch = epoch;
    listed.listed_at = clock.unix_timestamp;
    listed.bump = ctx.bumps.listed_token;

    msg!(
        "Admin listed token {} (epoch {}) at {}",
        mint_info.key(),
        epoch,
        clock.unix_timestamp,
    );

    Ok(())
}
