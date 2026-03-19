use anchor_lang::prelude::*;

pub const TIP_JAR_SEED: &[u8] = b"tip_jar";

/// Maximum hands a tip jar can fund at once (grief protection)
pub const TIP_JAR_MAX_HANDS: u16 = 100;

/// Per-table tip jar for dealer (crank) tips.
/// Created with every table (mandatory). Delegated with table to TEE.
/// Players deposit SOL tips; settle_hand decrements hands_remaining
/// and pays the active crank operator per hand.
///
/// Seeds: ["tip_jar", table]
///
/// Grief protection: deposit_tip requires
///   (balance + amount) / hands_remaining <= balance_before / hands_before
///   i.e., you can't inflate per-hand rate by depositing tiny amounts with many hands.
///   Simplified: new per-hand rate >= old per-hand rate (or first deposit).
#[account]
pub struct TipJar {
    /// Table this tip jar belongs to
    pub table: Pubkey,
    /// Current SOL balance available for tips (lamports)
    pub balance: u64,
    /// Number of hands remaining before tip jar is empty
    pub hands_remaining: u16,
    /// Lifetime total tips deposited (lamports)
    pub total_deposited: u64,
    /// Lifetime total tips paid out to dealers (lamports)
    pub total_tipped: u64,
    /// PDA bump
    pub bump: u8,
}

impl TipJar {
    pub const SIZE: usize = 8 +  // discriminator
        32 +                      // table
        8 +                       // balance
        2 +                       // hands_remaining
        8 +                       // total_deposited
        8 +                       // total_tipped
        1;                        // bump
    // = 8 + 32 + 8 + 2 + 8 + 8 + 1 = 67 bytes

    /// Calculate per-hand tip amount (balance / hands_remaining, or 0 if empty)
    pub fn per_hand_tip(&self) -> u64 {
        if self.hands_remaining == 0 || self.balance == 0 {
            return 0;
        }
        self.balance / (self.hands_remaining as u64)
    }

    /// Deduct one hand's tip. Returns the tip amount paid (0 if empty).
    pub fn deduct_hand(&mut self) -> u64 {
        let tip = self.per_hand_tip();
        if tip > 0 {
            self.balance = self.balance.saturating_sub(tip);
            self.hands_remaining = self.hands_remaining.saturating_sub(1);
            self.total_tipped = self.total_tipped.saturating_add(tip);
        }
        tip
    }
}
