use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::state::dealer_license::*;
use crate::constants::*;
use crate::errors::PokerError;

// ─────────────────────────────────────────────────────────────
// init_dealer_registry — Admin creates the singleton registry
// ─────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitDealerRegistry<'info> {
    #[account(
        mut,
        constraint = payer.key().to_bytes() == SUPER_ADMIN @ PokerError::Unauthorized,
    )]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = DealerRegistry::SIZE,
        seeds = [DEALER_REGISTRY_SEED],
        bump,
    )]
    pub registry: Account<'info, DealerRegistry>,

    pub system_program: Program<'info, System>,
}

pub fn init_dealer_registry_handler(ctx: Context<InitDealerRegistry>) -> Result<()> {
    let registry = &mut ctx.accounts.registry;
    registry.total_sold = 0;
    registry.total_revenue = 0;
    registry.authority = ctx.accounts.payer.key();
    registry.bump = ctx.bumps.registry;

    msg!("DealerRegistry initialized by {}", ctx.accounts.payer.key());
    Ok(())
}

// ─────────────────────────────────────────────────────────────
// grant_dealer_license — Admin grants a free license
// ─────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct GrantDealerLicense<'info> {
    #[account(
        mut,
        constraint = payer.key().to_bytes() == SUPER_ADMIN @ PokerError::Unauthorized,
    )]
    pub payer: Signer<'info>,

    /// CHECK: The wallet receiving the license. Validated by PDA derivation.
    pub beneficiary: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [DEALER_REGISTRY_SEED],
        bump = registry.bump,
    )]
    pub registry: Account<'info, DealerRegistry>,

    #[account(
        init,
        payer = payer,
        space = DealerLicense::SIZE,
        seeds = [DEALER_LICENSE_SEED, beneficiary.key().as_ref()],
        bump,
    )]
    pub license: Account<'info, DealerLicense>,

    pub system_program: Program<'info, System>,
}

pub fn grant_dealer_license_handler(ctx: Context<GrantDealerLicense>) -> Result<()> {
    let registry = &mut ctx.accounts.registry;
    let license = &mut ctx.accounts.license;

    license.wallet = ctx.accounts.beneficiary.key();
    license.license_number = registry.total_sold;
    license.purchased_at = Clock::get()?.unix_timestamp;
    license.price_paid = 0; // granted for free
    license.bump = ctx.bumps.license;

    registry.total_sold = registry.total_sold.checked_add(1).unwrap();

    msg!(
        "DealerLicense #{} granted to {} (free)",
        license.license_number,
        license.wallet,
    );
    Ok(())
}

// ─────────────────────────────────────────────────────────────
// purchase_dealer_license — Permissionless bonding curve purchase
// ─────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct PurchaseDealerLicense<'info> {
    /// Buyer — signs and pays SOL
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// CHECK: Beneficiary — receives the license PDA. Can be same as buyer or different.
    pub beneficiary: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [DEALER_REGISTRY_SEED],
        bump = registry.bump,
    )]
    pub registry: Account<'info, DealerRegistry>,

    #[account(
        init,
        payer = buyer,
        space = DealerLicense::SIZE,
        seeds = [DEALER_LICENSE_SEED, beneficiary.key().as_ref()],
        bump,
    )]
    pub license: Account<'info, DealerLicense>,

    /// CHECK: Treasury wallet — receives 50% of purchase price.
    #[account(
        mut,
        constraint = treasury.key() == TREASURY @ PokerError::InvalidAccountData,
    )]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: Steel staker pool — receives 50% of purchase price.
    /// Validated by the caller passing the correct known address.
    #[account(mut)]
    pub staker_pool: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Calculate license price from bonding curve
pub fn calculate_license_price(total_sold: u32) -> u64 {
    let price = DEALER_LICENSE_BASE_PRICE
        .saturating_add((total_sold as u64).saturating_mul(DEALER_LICENSE_INCREMENT));
    price.min(DEALER_LICENSE_MAX_PRICE)
}

pub fn purchase_dealer_license_handler(ctx: Context<PurchaseDealerLicense>) -> Result<()> {
    let registry = &mut ctx.accounts.registry;

    // Calculate price from bonding curve
    let price = calculate_license_price(registry.total_sold);
    require!(price > 0, PokerError::InvalidBetAmount);

    // Split: 50% treasury, 50% staker pool
    let treasury_share = price
        .checked_mul(DEALER_LICENSE_TREASURY_BPS)
        .and_then(|v| v.checked_div(10_000))
        .ok_or(PokerError::InvalidBetAmount)?;
    let staker_share = price.saturating_sub(treasury_share);

    // Transfer to treasury
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
            },
        ),
        treasury_share,
    )?;

    // Transfer to staker pool
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.staker_pool.to_account_info(),
            },
        ),
        staker_share,
    )?;

    // Initialize license
    let license = &mut ctx.accounts.license;
    license.wallet = ctx.accounts.beneficiary.key();
    license.license_number = registry.total_sold;
    license.purchased_at = Clock::get()?.unix_timestamp;
    license.price_paid = price;
    license.bump = ctx.bumps.license;

    // Update registry
    registry.total_sold = registry.total_sold.checked_add(1).unwrap();
    registry.total_revenue = registry.total_revenue.saturating_add(price);

    msg!(
        "DealerLicense #{} purchased by {} for {} (beneficiary: {}). Treasury: {}, Stakers: {}",
        license.license_number,
        ctx.accounts.buyer.key(),
        price,
        license.wallet,
        treasury_share,
        staker_share,
    );
    Ok(())
}
