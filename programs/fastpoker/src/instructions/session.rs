use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;
use crate::events::{SessionCreated, SessionRevoked};
use crate::constants::*;

/// Global session - one per user, works across all tables
#[derive(Accounts)]
pub struct CreateSession<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = SessionToken::SIZE,
        seeds = [SESSION_SEED, owner.key().as_ref()],
        bump
    )]
    pub session_token: Account<'info, SessionToken>,

    pub system_program: Program<'info, System>,
}

pub fn create_handler(
    ctx: Context<CreateSession>,
    session_pubkey: Pubkey,
    valid_until: i64,
) -> Result<()> {
    let session = &mut ctx.accounts.session_token;
    let clock = Clock::get()?;

    // Validate expiration is in the future
    require!(valid_until > clock.unix_timestamp, PokerError::SessionExpired);

    // Max session duration: 30 days for global sessions
    let max_duration = 30 * 24 * 60 * 60;
    require!(
        valid_until <= clock.unix_timestamp + max_duration,
        PokerError::InvalidSessionKey
    );

    // Initialize global session token
    session.owner = ctx.accounts.owner.key();
    session.session_key = session_pubkey;
    session._reserved = Pubkey::default(); // Unused, was table
    session.valid_until = valid_until;
    session.allowed_actions = SessionToken::ALL_GAMEPLAY_ACTIONS;
    session.is_active = true;
    session.bump = ctx.bumps.session_token;

    emit!(SessionCreated {
        owner: session.owner,
        session_key: session.session_key,
        table: Pubkey::default(), // Global session, no specific table
        valid_until,
    });

    msg!(
        "Global session created for {}, valid until {}",
        session.owner,
        valid_until
    );
    Ok(())
}

/// Revoke global session and return rent to owner
#[derive(Accounts)]
pub struct RevokeSession<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        close = owner,
        seeds = [SESSION_SEED, owner.key().as_ref()],
        bump = session_token.bump,
        constraint = session_token.owner == owner.key() @ PokerError::Unauthorized,
    )]
    pub session_token: Account<'info, SessionToken>,

    pub system_program: Program<'info, System>,
}

pub fn revoke_handler(ctx: Context<RevokeSession>) -> Result<()> {
    let session = &ctx.accounts.session_token;

    emit!(SessionRevoked {
        owner: session.owner,
        session_key: session.session_key,
        table: Pubkey::default(), // Global session
    });

    msg!("Global session revoked for {}", session.owner);
    Ok(())
}
