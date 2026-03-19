use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
pub struct SessionToken {
    /// Player's main wallet (owner)
    pub owner: Pubkey,
    /// Ephemeral session keypair pubkey (holds SOL for fees)
    pub session_key: Pubkey,
    /// DEPRECATED: Was table-scoped, now global per user
    /// Kept for account size compatibility, unused
    pub _reserved: Pubkey,
    /// Expiration timestamp (Unix seconds)
    pub valid_until: i64,
    /// Bitmask of allowed actions
    /// Bit 0: Fold
    /// Bit 1: Check
    /// Bit 2: Call
    /// Bit 3: Bet
    /// Bit 4: Raise
    /// Bit 5: AllIn
    /// Bit 6: SitOut
    /// Bit 7: ReturnToPlay
    pub allowed_actions: u8,
    /// Whether session is currently active
    pub is_active: bool,
    /// PDA bump
    pub bump: u8,
}

impl SessionToken {
    pub const SIZE: usize = 8 + // discriminator
        32 + // owner
        32 + // session_key
        32 + // _reserved (was table, kept for compatibility)
        8 + // valid_until
        1 + // allowed_actions
        1 + // is_active
        1 + // bump
        16; // padding

    // Action bit flags
    pub const ACTION_FOLD: u8 = 1 << 0;
    pub const ACTION_CHECK: u8 = 1 << 1;
    pub const ACTION_CALL: u8 = 1 << 2;
    pub const ACTION_BET: u8 = 1 << 3;
    pub const ACTION_RAISE: u8 = 1 << 4;
    pub const ACTION_ALLIN: u8 = 1 << 5;
    pub const ACTION_SITOUT: u8 = 1 << 6;
    pub const ACTION_RETURN: u8 = 1 << 7;
    
    // All gameplay actions (no withdrawals/admin)
    pub const ALL_GAMEPLAY_ACTIONS: u8 = 
        Self::ACTION_FOLD | 
        Self::ACTION_CHECK | 
        Self::ACTION_CALL | 
        Self::ACTION_BET | 
        Self::ACTION_RAISE | 
        Self::ACTION_ALLIN |
        Self::ACTION_SITOUT |
        Self::ACTION_RETURN;

    pub fn is_valid(&self, clock: &Clock) -> bool {
        self.is_active && clock.unix_timestamp < self.valid_until
    }

    pub fn can_perform_action(&self, action_bit: u8) -> bool {
        self.allowed_actions & action_bit != 0
    }

    pub fn action_bit_for(action: &super::PokerAction) -> u8 {
        match action {
            super::PokerAction::Fold => Self::ACTION_FOLD,
            super::PokerAction::Check => Self::ACTION_CHECK,
            super::PokerAction::Call => Self::ACTION_CALL,
            super::PokerAction::Bet { .. } => Self::ACTION_BET,
            super::PokerAction::Raise { .. } => Self::ACTION_RAISE,
            super::PokerAction::AllIn => Self::ACTION_ALLIN,
            super::PokerAction::SitOut => Self::ACTION_SITOUT,
            super::PokerAction::ReturnToPlay => Self::ACTION_RETURN,
            super::PokerAction::LeaveCashGame => Self::ACTION_RETURN, // meta-action, always allowed
            super::PokerAction::RebuyTopUp { .. } => Self::ACTION_RETURN, // meta-action, always allowed
        }
    }
}
