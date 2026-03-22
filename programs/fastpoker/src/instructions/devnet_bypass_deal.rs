use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::slot_hashes;
use crate::state::*;
use crate::errors::PokerError;
use crate::constants::*;
use crate::hand_eval::CARD_NOT_DEALT;

/// Mock deal for testing without Arcium MPC.
/// Uses on-chain entropy (SlotHashes + Clock) for deterministic shuffle.
/// Cards are written as PLAINTEXT — no encryption. Only for ARCIUM_MOCK=true mode.
///
/// This instruction replaces tee_deal for local/devnet testing.
/// In production, arcium_deal + MPC callback handles encrypted dealing.
///
/// PERMISSIONLESS — anyone can call when phase is Starting.

#[derive(Accounts)]
pub struct DevnetBypassDeal<'info> {
    /// CHECK: Permissionless — anyone can trigger the deal
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
        constraint = table.phase == GamePhase::Starting @ PokerError::InvalidActionForPhase,
    )]
    pub table: Account<'info, Table>,

    #[account(
        mut,
        seeds = [DECK_STATE_SEED, table.key().as_ref()],
        bump = deck_state.bump,
    )]
    pub deck_state: Box<Account<'info, DeckState>>,

    /// CHECK: SlotHashes sysvar for entropy
    #[account(address = slot_hashes::ID)]
    pub slot_hashes: AccountInfo<'info>,
}

pub fn handler(ctx: Context<DevnetBypassDeal>) -> Result<()> {
    let table = &mut ctx.accounts.table;
    let deck_state = &mut ctx.accounts.deck_state;
    let clock = Clock::get()?;

    // Generate entropy from SlotHashes + Clock + table key + hand number
    let slot_hashes_data = ctx.accounts.slot_hashes.try_borrow_data()?;
    let mut seed = [0u8; 32];
    // Mix slot hashes (first 32 bytes after length prefix)
    if slot_hashes_data.len() > 40 {
        for i in 0..32 {
            seed[i] = slot_hashes_data[8 + i];
        }
    }
    // Mix with table key
    let table_key_bytes = table.key().to_bytes();
    for i in 0..32 {
        seed[i] ^= table_key_bytes[i];
    }
    // Mix with clock + hand number
    let ts_bytes = clock.unix_timestamp.to_le_bytes();
    for i in 0..8 {
        seed[i] ^= ts_bytes[i];
    }
    let hand_bytes = table.hand_number.to_le_bytes();
    for i in 0..8 {
        seed[8 + i] ^= hand_bytes[i];
    }

    // Fisher-Yates shuffle using SplitMix64 PRNG
    let mut deck: [u8; 52] = [
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
        20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37,
        38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51,
    ];

    // Initialize PRNG state from seed
    let mut rng_state: u64 = u64::from_le_bytes([
        seed[0], seed[1], seed[2], seed[3], seed[4], seed[5], seed[6], seed[7],
    ]);

    for i in (1..52).rev() {
        // SplitMix64 step
        rng_state = rng_state.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = rng_state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z = z ^ (z >> 31);

        let j = (z as usize) % (i + 1);
        deck.swap(i, j);
    }

    // remaining_accounts layout: [seat_0, ..., seat_N, seat_cards_0, ..., seat_cards_N]
    // N = number of active (occupied, non-folded) seats
    let all_accounts = &ctx.remaining_accounts;
    let total = all_accounts.len();
    require!(total > 0 && total % 2 == 0, PokerError::InvalidAccountCount);
    let num_seats = total / 2;
    let seats = &all_accounts[..num_seats];
    let seat_cards = &all_accounts[num_seats..];

    // Byte offsets in PlayerSeat
    let status_offset: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 64 + 32 + 2 + 1; // 227
    let hole_offset: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 64 + 32; // 224 (hole_cards [u8;2])
    let seat_num_offset: usize = 226;

    // Byte offsets in SeatCards (Anchor disc=8 + table=32 + seat_index=1 + player=32 + card1=1 + card2=1)
    let sc_card1_offset: usize = 8 + 32 + 1 + 32; // 73
    let sc_card2_offset: usize = sc_card1_offset + 1; // 74

    // Deal hole cards: 2 per active player
    let mut card_idx: usize = 0;
    let mut active_count: usize = 0;
    let mut active_seats: Vec<(usize, u8)> = Vec::new(); // (account_idx, seat_num)

    for (i, seat_info) in seats.iter().enumerate() {
        let seat_data = seat_info.try_borrow_data()?;
        if seat_data.len() < PlayerSeat::SIZE { continue; }
        let status = seat_data[status_offset];
        let seat_num = seat_data[seat_num_offset];
        // Active=1 or AllIn=3 — deal to them
        if status == 1 || status == 3 {
            active_seats.push((i, seat_num));
            active_count += 1;
        }
    }

    require!(active_count >= 2, PokerError::NotEnoughPlayers);
    require!(active_count * 2 + 5 <= 52, PokerError::InvalidPlayerCount); // need room for 5 community

    // Deal: card1 to each player, then card2 to each player (standard dealing order)
    for (i, (_acc_idx, seat_num)) in active_seats.iter().enumerate() {
        let c1 = deck[card_idx + i];
        let c2 = deck[card_idx + active_count + i];

        // Write to PlayerSeat.hole_cards
        let seat_info = &seats[*_acc_idx];
        {
            let mut seat_data = seat_info.try_borrow_mut_data()?;
            if hole_offset + 2 <= seat_data.len() {
                seat_data[hole_offset] = c1;
                seat_data[hole_offset + 1] = c2;
            }
        }

        // Write to SeatCards.card1/card2 (plaintext — mock mode)
        if *_acc_idx < seat_cards.len() {
            let sc_info = &seat_cards[*_acc_idx];
            let mut sc_data = sc_info.try_borrow_mut_data()?;
            if sc_data.len() > sc_card2_offset {
                sc_data[sc_card1_offset] = c1;
                sc_data[sc_card2_offset] = c2;
            }
        }

        msg!("Seat {} dealt: [{}, {}]", seat_num, c1, c2);
    }
    card_idx += active_count * 2; // advance past all hole cards

    // Community cards (burn + flop + burn + turn + burn + river)
    // Simplified for mock: just take next 5 cards
    if card_idx + 4 < 52 {
        table.pre_community = [
            deck[card_idx],
            deck[card_idx + 1],
            deck[card_idx + 2],
            deck[card_idx + 3],
            deck[card_idx + 4],
        ];
        // community_cards stays [255;5] — revealed incrementally by devnet_bypass_reveal
        // per street (flop=3, turn=4, river=5). This matches production Arcium flow.
    }

    // Mark deck state
    deck_state.shuffle_complete = true;
    deck_state.hand_number = table.hand_number;

    // Advance phase to Preflop
    table.phase = GamePhase::Preflop;
    table.action_nonce = table.action_nonce.wrapping_add(1);
    table.actions_this_round = 0;

    // Set first-to-act for preflop betting
    // HU: SB (dealer) acts first. Multi-way: UTG (left of BB) acts first.
    let active_mask = table.seats_occupied & !table.seats_folded;
    if active_count == 2 {
        // B2 fix: HU dealer/SB acts first preflop (use small_blind_seat, not dealer_button)
        table.current_player = table.small_blind_seat;
    } else {
        // Multi-way: UTG = next active after BB
        if let Some(utg) = table.next_seat_in_mask(table.big_blind_seat, active_mask) {
            table.current_player = utg;
        }
    }

    msg!(
        "MOCK DEAL: hand #{}, {} active players, {} cards dealt, phase=Preflop",
        table.hand_number,
        active_count,
        card_idx,
    );

    Ok(())
}
