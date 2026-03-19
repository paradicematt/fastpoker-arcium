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
    //   - Community cards encrypted to MXE (packed u64)
    //   - ALL hole cards encrypted to MXE (packed u128, 7-bit per card)
    //   - Per-player hole cards encrypted to Shared (Enc<Shared, u16>)
    //
    // The MXE packed u128 enables full 9-player showdown: the on-chain callback
    // stores it in DeckState, and reveal_all_showdown decrypts all cards at once.
    //
    // Per-player Shared outputs give P0+P1 client-side card viewing (stride-3
    // layout with 11 outputs = 352 bytes fits 2 full Mxe groups + P0 full + P1 partial).
    //
    // Total outputs: 2 Mxe + 9 Shared = 11 ciphertexts. SIZE = 352 bytes.
    // ========================================================================
    #[instruction]
    pub fn shuffle_and_deal(
        mxe_comm: Mxe,
        mxe_holes: Mxe,
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
        // Packed community cards: u64 = comm1*256^4 + ... + comm5
        Enc<Mxe, u64>,
        // ALL hole cards 7-bit packed into u128 (18 cards × 7 bits = 126 bits)
        // Packing: packed = p0c1*128^17 + p0c2*128^16 + p1c1*128^15 + ... + p8c2*128^0
        // Card values 0-51 (dealt), 127 = NOT_DEALT sentinel
        Enc<Mxe, u128>,
        // Player 0-8 packed hole cards (card1 * 256 + card2) for client-side decrypt
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

        // Pack ALL 18 hole cards into u128 using 7-bit encoding (card values 0-51, sentinel 127)
        // Packing order: p0c1, p0c2, p1c1, p1c2, ..., p8c1, p8c2
        // Each card uses 7 bits (max 127). Total: 18 × 7 = 126 bits ≤ 128.
        let nd7: u128 = 127; // 7-bit NOT_DEALT sentinel
        let mut packed_holes: u128 = 0;
        // Helper: pack card into 7-bit slot using multiply-and-add
        // Position 0 = most significant (p0c1), position 17 = least significant (p8c2)
        let cards: [u128; 18] = [
            if num_players > 0 { deck[0] as u128 } else { nd7 },
            if num_players > 0 { deck[1] as u128 } else { nd7 },
            if num_players > 1 { deck[2] as u128 } else { nd7 },
            if num_players > 1 { deck[3] as u128 } else { nd7 },
            if num_players > 2 { deck[4] as u128 } else { nd7 },
            if num_players > 2 { deck[5] as u128 } else { nd7 },
            if num_players > 3 { deck[6] as u128 } else { nd7 },
            if num_players > 3 { deck[7] as u128 } else { nd7 },
            if num_players > 4 { deck[8] as u128 } else { nd7 },
            if num_players > 4 { deck[9] as u128 } else { nd7 },
            if num_players > 5 { deck[10] as u128 } else { nd7 },
            if num_players > 5 { deck[11] as u128 } else { nd7 },
            if num_players > 6 { deck[12] as u128 } else { nd7 },
            if num_players > 6 { deck[13] as u128 } else { nd7 },
            if num_players > 7 { deck[14] as u128 } else { nd7 },
            if num_players > 7 { deck[15] as u128 } else { nd7 },
            if num_players > 8 { deck[16] as u128 } else { nd7 },
            if num_players > 8 { deck[17] as u128 } else { nd7 },
        ];
        // Pack: packed = cards[0]*128^17 + cards[1]*128^16 + ... + cards[17]*128^0
        // Unrolled — Arcis does not support while loops
        packed_holes = packed_holes * 128 + cards[0];
        packed_holes = packed_holes * 128 + cards[1];
        packed_holes = packed_holes * 128 + cards[2];
        packed_holes = packed_holes * 128 + cards[3];
        packed_holes = packed_holes * 128 + cards[4];
        packed_holes = packed_holes * 128 + cards[5];
        packed_holes = packed_holes * 128 + cards[6];
        packed_holes = packed_holes * 128 + cards[7];
        packed_holes = packed_holes * 128 + cards[8];
        packed_holes = packed_holes * 128 + cards[9];
        packed_holes = packed_holes * 128 + cards[10];
        packed_holes = packed_holes * 128 + cards[11];
        packed_holes = packed_holes * 128 + cards[12];
        packed_holes = packed_holes * 128 + cards[13];
        packed_holes = packed_holes * 128 + cards[14];
        packed_holes = packed_holes * 128 + cards[15];
        packed_holes = packed_holes * 128 + cards[16];
        packed_holes = packed_holes * 128 + cards[17];

        // Community cards: positions 18-22 (after max 18 hole cards for 9 players)
        let packed_comm: u64 = (deck[18] as u64) * 256 * 256 * 256 * 256
                             + (deck[19] as u64) * 256 * 256 * 256
                             + (deck[20] as u64) * 256 * 256
                             + (deck[21] as u64) * 256
                             + (deck[22] as u64);

        (
            mxe_comm.from_arcis(packed_comm),
            mxe_holes.from_arcis(packed_holes),
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
    // Circuit 3: reveal_all_showdown
    //
    // Decrypts ALL players' hole cards at showdown from the MXE-packed u128.
    // Takes the Enc<Mxe, u128> from DeckState (written by shuffle_and_deal callback)
    // and an active_mask (u16 bitmask of which seats are active at showdown).
    //
    // Returns 9 packed u16 values (card1*256+card2). Inactive/folded seats get 0xFFFF.
    //
    // Single MPC call reveals all players simultaneously — no per-player calls needed.
    //
    // Parameters: PlaintextU128 (MXE nonce) + Ciphertext (packed holes ct) + PlaintextU16 (active_mask)
    // Output: 9 × PlaintextU16
    // ========================================================================
    #[instruction]
    pub fn reveal_all_showdown(
        packed_holes: Enc<Mxe, u128>,
        active_mask: u16,
    ) -> (u16, u16, u16, u16, u16, u16, u16, u16, u16) {
        let packed = packed_holes.to_arcis();
        let not_dealt: u16 = 255 * 256 + 255; // 0xFFFF

        // Unpack 7-bit encoded cards from u128 via repeated div/mod by 128
        // packed = p0c1*128^17 + p0c2*128^16 + ... + p8c2*128^0
        // Extract from LSB (p8c2) to MSB (p0c1), unrolled — Arcis has no while loops
        let mut rem = packed;
        let p8c2 = rem % 128; rem = rem / 128;
        let p8c1 = rem % 128; rem = rem / 128;
        let p7c2 = rem % 128; rem = rem / 128;
        let p7c1 = rem % 128; rem = rem / 128;
        let p6c2 = rem % 128; rem = rem / 128;
        let p6c1 = rem % 128; rem = rem / 128;
        let p5c2 = rem % 128; rem = rem / 128;
        let p5c1 = rem % 128; rem = rem / 128;
        let p4c2 = rem % 128; rem = rem / 128;
        let p4c1 = rem % 128; rem = rem / 128;
        let p3c2 = rem % 128; rem = rem / 128;
        let p3c1 = rem % 128; rem = rem / 128;
        let p2c2 = rem % 128; rem = rem / 128;
        let p2c1 = rem % 128; rem = rem / 128;
        let p1c2 = rem % 128; rem = rem / 128;
        let p1c1 = rem % 128; rem = rem / 128;
        let p0c2 = rem % 128; rem = rem / 128;
        let p0c1 = rem % 128;

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
        let s0: u16 = if b0 > 0 { (p0c1 as u16) * 256 + (p0c2 as u16) } else { not_dealt };
        let s1: u16 = if b1 > 0 { (p1c1 as u16) * 256 + (p1c2 as u16) } else { not_dealt };
        let s2: u16 = if b2 > 0 { (p2c1 as u16) * 256 + (p2c2 as u16) } else { not_dealt };
        let s3: u16 = if b3 > 0 { (p3c1 as u16) * 256 + (p3c2 as u16) } else { not_dealt };
        let s4: u16 = if b4 > 0 { (p4c1 as u16) * 256 + (p4c2 as u16) } else { not_dealt };
        let s5: u16 = if b5 > 0 { (p5c1 as u16) * 256 + (p5c2 as u16) } else { not_dealt };
        let s6: u16 = if b6 > 0 { (p6c1 as u16) * 256 + (p6c2 as u16) } else { not_dealt };
        let s7: u16 = if b7 > 0 { (p7c1 as u16) * 256 + (p7c2 as u16) } else { not_dealt };
        let s8: u16 = if b8 > 0 { (p8c1 as u16) * 256 + (p8c2 as u16) } else { not_dealt };

        (
            s0.reveal(), s1.reveal(), s2.reveal(), s3.reveal(), s4.reveal(),
            s5.reveal(), s6.reveal(), s7.reveal(), s8.reveal(),
        )
    }
}
