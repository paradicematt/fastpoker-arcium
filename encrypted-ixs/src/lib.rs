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

    // ALL cards (5 community + 18 hole = 23 bytes) packed into a SINGLE MXE output.
    // Pack<[u8; 23]> = 1 field element (23 bytes / 26 per element).
    // Using a single MXE output avoids the Arcium bug where the second MXE output
    // in a multi-MXE circuit produces corrupted ciphertext.
    // Layout: [comm1, comm2, comm3, comm4, comm5, p0c1, p0c2, p1c1, ..., p8c2]
    type AllCards = Pack<[u8; 23]>;

    // ========================================================================
    // Circuit 1: shuffle_and_deal
    //
    // Shuffles a 52-card deck and outputs:
    //   - ALL 23 cards (5 community + 18 hole) in a single MXE Pack
    //   - Per-player hole cards encrypted to Shared (Enc<Shared, u16>)
    //
    // Single MXE output eliminates the multi-MXE corruption bug.
    //
    // Total outputs: 1 Mxe(Pack) + 9 Shared = 10 ciphertexts.
    // SIZE = 10 × 32 = 320 bytes.
    // ========================================================================
    #[instruction]
    pub fn shuffle_and_deal(
        mxe_all: Mxe,
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
        Enc<Mxe, AllCards>,   // All 23 cards via Pack<[u8; 23]> (1 field element)
        Enc<Shared, u16>,     // Player 0-8 packed hole cards (card1*256+card2) for client decrypt
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

        // Pack ALL 23 cards into Pack<[u8; 23]> — single MXE output.
        // Layout: [comm1..comm5, p0c1, p0c2, p1c1, p1c2, ..., p8c1, p8c2]
        // Using Blackjack pattern: init with zeros, then assign (avoids Arcis Pack type inference issue).
        let mut all_cards: [u8; 23] = [0u8; 23];
        all_cards[0]  = deck[18]; // comm1
        all_cards[1]  = deck[19]; // comm2
        all_cards[2]  = deck[20]; // comm3
        all_cards[3]  = deck[21]; // comm4
        all_cards[4]  = deck[22]; // comm5
        all_cards[5]  = deck[0];  // p0c1
        all_cards[6]  = deck[1];  // p0c2
        all_cards[7]  = deck[2];  // p1c1
        all_cards[8]  = deck[3];  // p1c2
        all_cards[9]  = deck[4];  // p2c1
        all_cards[10] = deck[5];  // p2c2
        all_cards[11] = deck[6];  // p3c1
        all_cards[12] = deck[7];  // p3c2
        all_cards[13] = deck[8];  // p4c1
        all_cards[14] = deck[9];  // p4c2
        all_cards[15] = deck[10]; // p5c1
        all_cards[16] = deck[11]; // p5c2
        all_cards[17] = deck[12]; // p6c1
        all_cards[18] = deck[13]; // p6c2
        all_cards[19] = deck[14]; // p7c1
        all_cards[20] = deck[15]; // p7c2
        all_cards[21] = deck[16]; // p8c1
        all_cards[22] = deck[17]; // p8c2

        (
            mxe_all.from_arcis(Pack::new(all_cards)),
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
    // Decrypts the single MXE Pack and returns community cards as plaintext.
    // Called at flop (3), turn (4), river (5) — num_to_reveal controls how many.
    // Returns all 5 slots; unrevealed slots return 255.
    // ========================================================================
    #[instruction]
    pub fn reveal_community(
        packed_all: Enc<Mxe, AllCards>,
        num_to_reveal: u8,
    ) -> (u8, u8, u8, u8, u8) {
        let all: [u8; 23] = packed_all.to_arcis().unpack();
        // Community cards are at indices 0-4
        let not_revealed: u8 = 255;

        let r1 = if num_to_reveal >= 1 { all[0] } else { not_revealed };
        let r2 = if num_to_reveal >= 2 { all[1] } else { not_revealed };
        let r3 = if num_to_reveal >= 3 { all[2] } else { not_revealed };
        let r4 = if num_to_reveal >= 4 { all[3] } else { not_revealed };
        let r5 = if num_to_reveal >= 5 { all[4] } else { not_revealed };

        (r1.reveal(), r2.reveal(), r3.reveal(), r4.reveal(), r5.reveal())
    }

    // ========================================================================
    // Circuit 3: reveal_all_showdown
    //
    // Decrypts the single MXE Pack and returns ALL players' hole cards.
    // Takes the same Enc<Mxe, Pack<[u8;23]>> as reveal_community.
    //
    // Returns 9 packed u16 values (card1*256+card2). Inactive/folded seats get 0xFFFF.
    //
    // Parameters: PlaintextU128 (nonce) + Ciphertext (Pack ct) + PlaintextU16 (mask)
    // Output: 9 × PlaintextU16
    // ========================================================================
    #[instruction]
    pub fn reveal_all_showdown(
        packed_all: Enc<Mxe, AllCards>,
        active_mask: u16,
    ) -> (u16, u16, u16, u16, u16, u16, u16, u16, u16) {
        let all: [u8; 23] = packed_all.to_arcis().unpack();
        let not_dealt: u16 = 255 * 256 + 255; // 0xFFFF

        // Hole cards start at index 5 in the Pack
        // Layout: [comm1..comm5, p0c1, p0c2, p1c1, ..., p8c2]

        // Extract active_mask bits via div/mod (Arcis has no bitwise &)
        let b0: u16 = active_mask % 2;
        let b1: u16 = (active_mask / 2) % 2;
        let b2: u16 = (active_mask / 4) % 2;
        let b3: u16 = (active_mask / 8) % 2;
        let b4: u16 = (active_mask / 16) % 2;
        let b5: u16 = (active_mask / 32) % 2;
        let b6: u16 = (active_mask / 64) % 2;
        let b7: u16 = (active_mask / 128) % 2;
        let b8: u16 = (active_mask / 256) % 2;

        // Build per-player packed u16 (card1*256+card2), applying active_mask
        let s0: u16 = if b0 > 0 { (all[5] as u16) * 256 + (all[6] as u16) } else { not_dealt };
        let s1: u16 = if b1 > 0 { (all[7] as u16) * 256 + (all[8] as u16) } else { not_dealt };
        let s2: u16 = if b2 > 0 { (all[9] as u16) * 256 + (all[10] as u16) } else { not_dealt };
        let s3: u16 = if b3 > 0 { (all[11] as u16) * 256 + (all[12] as u16) } else { not_dealt };
        let s4: u16 = if b4 > 0 { (all[13] as u16) * 256 + (all[14] as u16) } else { not_dealt };
        let s5: u16 = if b5 > 0 { (all[15] as u16) * 256 + (all[16] as u16) } else { not_dealt };
        let s6: u16 = if b6 > 0 { (all[17] as u16) * 256 + (all[18] as u16) } else { not_dealt };
        let s7: u16 = if b7 > 0 { (all[19] as u16) * 256 + (all[20] as u16) } else { not_dealt };
        let s8: u16 = if b8 > 0 { (all[21] as u16) * 256 + (all[22] as u16) } else { not_dealt };

        (
            s0.reveal(), s1.reveal(), s2.reveal(), s3.reveal(), s4.reveal(),
            s5.reveal(), s6.reveal(), s7.reveal(), s8.reveal(),
        )
    }
}
