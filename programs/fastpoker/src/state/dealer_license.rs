use anchor_lang::prelude::*;

pub const DEALER_REGISTRY_SEED: &[u8] = b"dealer_registry";
pub const DEALER_LICENSE_SEED: &[u8] = b"dealer_license";

/// Singleton registry tracking total dealer licenses sold + revenue.
/// Seeds: ["dealer_registry"]
#[account]
pub struct DealerRegistry {
    /// Total licenses sold (determines next price via bonding curve)
    pub total_sold: u32,
    /// Total SOL revenue collected from license purchases (lamports)
    pub total_revenue: u64,
    /// Admin authority (SUPER_ADMIN) — can grant free licenses
    pub authority: Pubkey,
    /// PDA bump
    pub bump: u8,
}

impl DealerRegistry {
    pub const SIZE: usize = 8 +  // discriminator
        4 +                       // total_sold
        8 +                       // total_revenue
        32 +                      // authority
        1;                        // bump
    // = 53 bytes
}

/// Per-wallet dealer license. Non-transferable, permanently bound to beneficiary.
/// Seeds: ["dealer_license", wallet]
#[account]
pub struct DealerLicense {
    /// Wallet this license is bound to (beneficiary)
    pub wallet: Pubkey,
    /// Sequential license number (0-indexed)
    pub license_number: u32,
    /// Unix timestamp when purchased/granted
    pub purchased_at: i64,
    /// Price paid in lamports (0 for granted licenses)
    pub price_paid: u64,
    /// PDA bump
    pub bump: u8,
}

impl DealerLicense {
    pub const SIZE: usize = 8 +  // discriminator
        32 +                      // wallet
        4 +                       // license_number
        8 +                       // purchased_at
        8 +                       // price_paid
        1;                        // bump
    // = 61 bytes
}
