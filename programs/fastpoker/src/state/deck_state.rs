use anchor_lang::prelude::*;

/// DeckState PDA — stores Arcium MPC encrypted community cards and computation tracking.
///
/// After shuffle_and_deal MPC callback:
///   - encrypted_community[0..4] filled with ciphertexts (5 community cards)
///   - encrypted_hole_cards[0..11] filled with MXE-encrypted copies for showdown
///   - shuffle_complete = true
///
/// Community cards are decrypted via reveal_community MPC callback at flop/turn/river.
/// Hole cards are decrypted via reveal_showdown MPC callback at showdown.
///
/// Seeds: ["deck_state", table_pda.as_ref()]
#[account]
pub struct DeckState {
    /// The table this deck belongs to
    pub table: Pubkey,
    /// PDA bump
    pub bump: u8,
    /// Whether the MPC shuffle+deal callback has completed
    pub shuffle_complete: bool,
    /// How many community cards have been revealed (0, 3, 4, 5)
    pub cards_revealed: u8,
    /// Hand number — prevents cross-hand replay of encrypted data
    pub hand_number: u64,
    /// MXE computation offset for tracking the active MPC job
    pub computation_offset: u64,
    /// Encrypted community cards (5 × 32 bytes = 160 bytes of Rescue ciphertext)
    /// Written by shuffle_and_deal callback, read by reveal_community
    pub encrypted_community: [[u8; 32]; 5],
    /// MXE-encrypted copies of all hole cards (12 × 32 bytes = 384 bytes)
    /// Written by shuffle_and_deal callback, read by reveal_showdown
    /// Layout: [p0c1, p0c2, p1c1, p1c2, ..., p5c1, p5c2]
    pub encrypted_hole_cards: [[u8; 32]; 12],
    /// Nonces for community card decryption (5 × 16 bytes = 80 bytes)
    pub community_nonces: [[u8; 16]; 5],
    /// Nonces for hole card decryption (12 × 16 bytes = 192 bytes)
    pub hole_card_nonces: [[u8; 16]; 12],
    /// Number of per-player showdown reveals expected (set by first queue call)
    pub showdown_reveals_expected: u8,
    /// Number of per-player showdown reveals completed (incremented by each callback)
    pub showdown_reveals_done: u8,
    /// Number of per-player showdown reveals queued (incremented by each queue call)
    pub showdown_reveals_queued: u8,
    /// Ordered list of seat indices for showdown reveals.
    /// showdown_reveal_seats[i] = seat_idx for the i-th queued reveal.
    /// Callback reads showdown_reveal_seats[showdown_reveals_done] to know which seat.
    pub showdown_reveal_seats: [u8; 9],
}

impl DeckState {
    pub const SIZE: usize = 8 +   // discriminator
        32 +  // table
        1 +   // bump
        1 +   // shuffle_complete
        1 +   // cards_revealed
        8 +   // hand_number
        8 +   // computation_offset
        160 + // encrypted_community (5 * 32)
        384 + // encrypted_hole_cards (12 * 32)
        80 +  // community_nonces (5 * 16)
        192 + // hole_card_nonces (12 * 16)
        1 +   // showdown_reveals_expected
        1 +   // showdown_reveals_done
        1 +   // showdown_reveals_queued
        9;    // showdown_reveal_seats
    // = 887 bytes

    pub fn reset_for_new_hand(&mut self) {
        self.shuffle_complete = false;
        self.cards_revealed = 0;
        self.computation_offset = 0;
        self.encrypted_community = [[0u8; 32]; 5];
        self.encrypted_hole_cards = [[0u8; 32]; 12];
        self.community_nonces = [[0u8; 16]; 5];
        self.hole_card_nonces = [[0u8; 16]; 12];
        self.showdown_reveals_expected = 0;
        self.showdown_reveals_done = 0;
        self.showdown_reveals_queued = 0;
        self.showdown_reveal_seats = [0u8; 9];
    }
}
