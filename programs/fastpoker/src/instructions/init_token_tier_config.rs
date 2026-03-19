use anchor_lang::prelude::*;
use crate::state::*;
use crate::constants::*;
use crate::errors::PokerError;

/// Admin-only: Initialize a TokenTierConfig PDA for a specific token mint.
/// For SOL (Pubkey::default()), uses hardcoded tier boundaries and cap BPS.
/// For community tokens, this will be called by resolve_auction with anchor-vote-derived values.
///
/// Guards:
/// - Only SUPER_ADMIN can call (for SOL config and manual overrides)
/// - Can only be called once per token_mint (init constraint)

#[derive(Accounts)]
#[instruction(token_mint: Pubkey)]
pub struct InitTokenTierConfig<'info> {
    /// Admin who pays for PDA creation
    #[account(
        mut,
        constraint = admin.key() == Pubkey::new_from_array(SUPER_ADMIN) @ PokerError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = TokenTierConfig::SIZE,
        seeds = [TIER_CONFIG_SEED, token_mint.as_ref()],
        bump,
    )]
    pub tier_config: Account<'info, TokenTierConfig>,

    pub system_program: Program<'info, System>,
}

/// Initialize SOL tier config with hardcoded values from the plan.
/// For community tokens, a separate instruction (or resolve_auction) will create
/// configs with anchor-vote-derived boundaries.
pub fn handler(ctx: Context<InitTokenTierConfig>, token_mint: Pubkey) -> Result<()> {
    let clock = Clock::get()?;
    let config = &mut ctx.accounts.tier_config;

    config.token_mint = token_mint;
    config.authority = ctx.accounts.admin.key();
    config.updated_at = clock.unix_timestamp;
    config.community_governed = false;
    config.bump = ctx.bumps.tier_config;

    // Use hardcoded SOL defaults for SOL (Pubkey::default)
    // For other tokens, admin must pass custom values via update instruction
    if token_mint == Pubkey::default() {
        config.tier_boundaries = SOL_TIER_BOUNDARIES;
        config.cap_bps = SOL_CAP_BPS;
        config.min_bb = 1_000; // 0.000001 SOL minimum BB (1000 lamports)
        msg!("SOL TokenTierConfig initialized with hardcoded tiers");
    } else {
        // Non-SOL tokens: initialize with zero caps (no cap = permissive)
        // Admin or resolve_auction will update with proper values
        config.tier_boundaries = [0; NUM_TIERS];
        config.tier_boundaries[NUM_TIERS - 1] = u64::MAX;
        config.cap_bps = [0; NUM_TIERS * NUM_TABLE_TYPES];
        config.min_bb = 0;
        msg!("TokenTierConfig initialized for mint {} (needs boundary configuration)", token_mint);
    }

    msg!(
        "TokenTierConfig created: mint={}, authority={}, community_governed={}",
        config.token_mint,
        config.authority,
        config.community_governed,
    );

    Ok(())
}

/// Admin-only: Update an existing TokenTierConfig with new boundaries and cap BPS.
/// Used for tuning SOL tiers or manually configuring community token tiers.
#[derive(Accounts)]
pub struct UpdateTokenTierConfig<'info> {
    #[account(
        constraint = admin.key() == tier_config.authority @ PokerError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [TIER_CONFIG_SEED, tier_config.token_mint.as_ref()],
        bump = tier_config.bump,
    )]
    pub tier_config: Account<'info, TokenTierConfig>,
}

pub fn update_handler(
    ctx: Context<UpdateTokenTierConfig>,
    tier_boundaries: [u64; NUM_TIERS],
    cap_bps: [u32; NUM_TIERS * NUM_TABLE_TYPES],
    min_bb: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let config = &mut ctx.accounts.tier_config;

    // Validate: last boundary must be u64::MAX (catch-all for Nosebleed)
    require!(
        tier_boundaries[NUM_TIERS - 1] == u64::MAX,
        PokerError::InvalidTableConfig
    );

    // Validate: boundaries must be monotonically increasing
    for i in 1..NUM_TIERS {
        require!(
            tier_boundaries[i] > tier_boundaries[i - 1],
            PokerError::InvalidTableConfig
        );
    }

    config.tier_boundaries = tier_boundaries;
    config.cap_bps = cap_bps;
    config.min_bb = min_bb;
    config.updated_at = clock.unix_timestamp;

    msg!(
        "TokenTierConfig updated: mint={}, min_bb={}",
        config.token_mint,
        config.min_bb,
    );

    Ok(())
}
