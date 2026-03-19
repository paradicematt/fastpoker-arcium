use anchor_lang::prelude::*;
use crate::state::*;

/// Permissionless one-time initialization of the AuctionConfig singleton.
/// Anyone can call this, but it can only succeed once (init constraint).
/// Sets the first epoch to start immediately with a 7-day duration.

#[derive(Accounts)]
pub struct InitializeAuctionConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = AuctionConfig::SIZE,
        seeds = [AUCTION_CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, AuctionConfig>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeAuctionConfig>) -> Result<()> {
    let clock = Clock::get()?;
    let config = &mut ctx.accounts.config;

    config.current_epoch = 1;
    config.current_epoch_start = clock.unix_timestamp;
    config.current_epoch_duration = AUCTION_EPOCH_SECS; // 7 days default
    config.last_total_bid = 0;
    config.bump = ctx.bumps.config;

    msg!(
        "AuctionConfig initialized: epoch 1, duration {}s ({}d), start {}",
        config.current_epoch_duration,
        config.current_epoch_duration / 86_400,
        config.current_epoch_start,
    );

    Ok(())
}
