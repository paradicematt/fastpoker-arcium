use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    // Standard 52-card deck (0-51 index: rank = idx % 13, suit = idx / 13)
    const INITIAL_DECK: [u8; 52] = [
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
        20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37,
        38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51,
    ];

    // ========================================================================
    // Circuit 1: shuffle_and_deal
    //
    // Shuffles a 52-card deck and outputs:
    //   - Per-player PACKED hole cards (up to 9 players, Enc<Shared, u16>)
    //     Each u16 = card1 * 256 + card2 (high byte = card1, low byte = card2)
    //   - Community cards encrypted to MXE (5 cards, Enc<Mxe, u8>)
    //
    // Each player's cards are encrypted to their unique x25519 pubkey.
    // Community cards are encrypted to MXE — nobody can read until reveal.
    //
    // Supports 2-9 players. Unused seats get dummy encrypted values (card=255).
    //
    // Total outputs: 9 (packed hole) + 5 (community) = 14 ciphertexts = 448 bytes
    // This fits in a single MPC callback transaction (vs 23 outputs = 736 bytes which doesn't).
    // ========================================================================
    #[instruction]
    pub fn shuffle_and_deal(
        mxe: Mxe,
        p0: Shared,
        p1: Shared,
        p2: Shared,
        p3: Shared,
        p4: Shared,
        p5: Shared,
        p6: Shared,
        p7: Shared,
        p8: Shared,
        num_players: u8,
    ) -> (
        // Packed community cards (single Mxe output — consumed once, no nonce slot)
        // u64 = comm1*256^4 + comm2*256^3 + comm3*256^2 + comm4*256 + comm5
        Enc<Mxe, u64>,
        // Player 0-8 packed hole cards (card1 * 256 + card2)
        Enc<Shared, u16>,
        Enc<Shared, u16>,
        Enc<Shared, u16>,
        Enc<Shared, u16>,
        Enc<Shared, u16>,
        Enc<Shared, u16>,
        Enc<Shared, u16>,
        Enc<Shared, u16>,
        Enc<Shared, u16>,
    ) {
        let mut deck = INITIAL_DECK;
        ArcisRNG::shuffle(&mut deck);

        // Deal hole cards: 2 per player, packed into u16 = card1 * 256 + card2
        // Unused player slots get 0xFFFF (both cards = 255 = NOT_DEALT)
        let not_dealt: u16 = 255 * 256 + 255; // 0xFFFF

        let p0_pack: u16 = if num_players > 0 { (deck[0] as u16) * 256 + (deck[1] as u16) } else { not_dealt };
        let p1_pack: u16 = if num_players > 1 { (deck[2] as u16) * 256 + (deck[3] as u16) } else { not_dealt };
        let p2_pack: u16 = if num_players > 2 { (deck[4] as u16) * 256 + (deck[5] as u16) } else { not_dealt };
        let p3_pack: u16 = if num_players > 3 { (deck[6] as u16) * 256 + (deck[7] as u16) } else { not_dealt };
        let p4_pack: u16 = if num_players > 4 { (deck[8] as u16) * 256 + (deck[9] as u16) } else { not_dealt };
        let p5_pack: u16 = if num_players > 5 { (deck[10] as u16) * 256 + (deck[11] as u16) } else { not_dealt };
        let p6_pack: u16 = if num_players > 6 { (deck[12] as u16) * 256 + (deck[13] as u16) } else { not_dealt };
        let p7_pack: u16 = if num_players > 7 { (deck[14] as u16) * 256 + (deck[15] as u16) } else { not_dealt };
        let p8_pack: u16 = if num_players > 8 { (deck[16] as u16) * 256 + (deck[17] as u16) } else { not_dealt };

        // Community cards: positions 18-22 (after max 18 hole cards for 9 players)
        // Pack all 5 into a single u64: comm1*256^4 + comm2*256^3 + comm3*256^2 + comm4*256 + comm5
        let packed_comm: u64 = (deck[18] as u64) * 256 * 256 * 256 * 256
                             + (deck[19] as u64) * 256 * 256 * 256
                             + (deck[20] as u64) * 256 * 256
                             + (deck[21] as u64) * 256
                             + (deck[22] as u64);

        (
            mxe.from_arcis(packed_comm),
            p0.from_arcis(p0_pack),
            p1.from_arcis(p1_pack),
            p2.from_arcis(p2_pack),
            p3.from_arcis(p3_pack),
            p4.from_arcis(p4_pack),
            p5.from_arcis(p5_pack),
            p6.from_arcis(p6_pack),
            p7.from_arcis(p7_pack),
            p8.from_arcis(p8_pack),
        )
    }

    // ========================================================================
    // Circuit 2: reveal_community
    //
    // Decrypts MXE-encrypted community cards and returns them as plaintext.
    // Called at flop (3), turn (4), river (5) — num_to_reveal controls how many.
    // Returns all 5 slots; unrevealed slots return 255.
    // ========================================================================
    #[instruction]
    pub fn reveal_community(
        packed_community: Enc<Mxe, u64>,
        num_to_reveal: u8,
    ) -> (u8, u8, u8, u8, u8) {
        // Unpack: u64 = comm1*256^4 + comm2*256^3 + comm3*256^2 + comm4*256 + comm5
        let packed = packed_community.to_arcis();
        let c1 = (packed / (256 * 256 * 256 * 256)) as u8;
        let c2 = ((packed / (256 * 256 * 256)) % 256) as u8;
        let c3 = ((packed / (256 * 256)) % 256) as u8;
        let c4 = ((packed / 256) % 256) as u8;
        let c5 = (packed % 256) as u8;

        let not_revealed: u8 = 255;

        let r1 = if num_to_reveal >= 1 { c1 } else { not_revealed };
        let r2 = if num_to_reveal >= 2 { c2 } else { not_revealed };
        let r3 = if num_to_reveal >= 3 { c3 } else { not_revealed };
        let r4 = if num_to_reveal >= 4 { c4 } else { not_revealed };
        let r5 = if num_to_reveal >= 5 { c5 } else { not_revealed };

        (r1.reveal(), r2.reveal(), r3.reveal(), r4.reveal(), r5.reveal())
    }

    // ========================================================================
    // Circuit 3: reveal_player_cards
    //
    // Decrypts a single player's packed hole cards at showdown.
    // Takes Shared-encrypted packed u16 (from SeatCards after shuffle_and_deal)
    // and returns the plaintext packed u16 value.
    //
    // Called once per active (non-folded) player at showdown.
    // The Enc<Shared, u16> parameter carries its own implicit Shared context
    // (x25519 pubkey + nonce), so no explicit Shared param is needed.
    //
    // Returns packed u16: card1*256+card2.
    // The callback unpacks: card1 = u16 >> 8, card2 = u16 & 0xFF.
    //
    // Parameters: 3 (ArcisX25519Pubkey + PlaintextU128 + Ciphertext)
    // Output: 1 PlaintextU16
    //
    // NOTE: Uses per-player calls instead of a single 9-player circuit to
    // avoid Arcium node off-by-one panic with large Enc<Shared,T> param arrays.
    // ========================================================================
    #[instruction]
    pub fn reveal_player_cards(
        packed: Enc<Shared, u16>,
    ) -> u16 {
        packed.to_arcis().reveal()
    }
}
