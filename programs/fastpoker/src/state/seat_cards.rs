use anchor_lang::prelude::*;

/// SeatCards PDA — stores encrypted + plaintext hole cards for a single seat.
///
/// Privacy model (Arcium MPC):
///   - enc_card1/enc_card2: Rescue ciphertext encrypted to the player's x25519 key.
///     Anyone can read the account — they see ciphertext they can't decrypt.
///   - card1/card2: Plaintext (0-51). Written ONLY at showdown by MPC callback.
///     During active play, these stay 255 (NOT_DEALT).
///   - nonce: Used by the player's frontend to decrypt enc_card1/enc_card2 locally.
///
/// Seeds: ["seat_cards", table_pda.as_ref(), &[seat_index]]
#[account]
pub struct SeatCards {
    /// The table this seat belongs to
    pub table: Pubkey,
    /// Seat index (0-8)
    pub seat_index: u8,
    /// Player who owns these cards
    pub player: Pubkey,
    /// First hole card plaintext (0-51, or 255 for not dealt). Written at showdown only.
    pub card1: u8,
    /// Second hole card plaintext (0-51, or 255 for not dealt). Written at showdown only.
    pub card2: u8,
    /// Bump seed for PDA
    pub bump: u8,
    /// Encrypted first hole card (32 bytes Rescue ciphertext, encrypted to player's x25519 key)
    pub enc_card1: [u8; 32],
    /// Encrypted second hole card (32 bytes Rescue ciphertext)
    pub enc_card2: [u8; 32],
    /// Nonce for Rescue cipher decryption (player uses this + shared secret to decrypt)
    pub nonce: [u8; 16],
}

impl SeatCards {
    pub const LEN: usize = 32 + // table
        1 +   // seat_index
        32 +  // player
        1 +   // card1
        1 +   // card2
        1 +   // bump
        32 +  // enc_card1
        32 +  // enc_card2
        16;   // nonce
    // = 148 bytes (up from 68)
    
    pub const NOT_DEALT: u8 = 255;
    
    pub fn is_dealt(&self) -> bool {
        self.card1 != Self::NOT_DEALT && self.card2 != Self::NOT_DEALT
    }
    
    pub fn has_encrypted_cards(&self) -> bool {
        self.enc_card1 != [0u8; 32]
    }
    
    pub fn clear(&mut self) {
        self.card1 = Self::NOT_DEALT;
        self.card2 = Self::NOT_DEALT;
        self.enc_card1 = [0u8; 32];
        self.enc_card2 = [0u8; 32];
        self.nonce = [0u8; 16];
    }
}
