use steel::*;

use crate::consts::*;
use crate::prelude::*;

/// Derive the pool PDA address
pub fn pool_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[POOL], &crate::ID)
}

/// Derive a stake account PDA for a given owner
pub fn stake_pda(owner: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[STAKE, owner.as_ref()], &crate::ID)
}

/// Derive an unrefined rewards PDA for a given owner
pub fn unrefined_pda(owner: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[UNREFINED, owner.as_ref()], &crate::ID)
}

/// Derive an epoch PDA for a given epoch number
pub fn epoch_pda(epoch_number: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[EPOCH, &epoch_number.to_le_bytes()], &crate::ID)
}

/// Calculate claim amount after 10% tax
pub fn calculate_claim_after_tax(amount: u64) -> (u64, u64) {
    let tax = amount
        .checked_mul(CLAIM_TAX_BPS)
        .unwrap_or(0)
        .checked_div(BPS_DENOMINATOR)
        .unwrap_or(0);
    let net = amount.checked_sub(tax).unwrap_or(0);
    (net, tax)
}

/// Calculate staker share of revenue (50%)
pub fn calculate_staker_share(revenue: u64) -> u64 {
    revenue
        .checked_mul(STAKER_SHARE_BPS)
        .unwrap_or(0)
        .checked_div(BPS_DENOMINATOR)
        .unwrap_or(0)
}
