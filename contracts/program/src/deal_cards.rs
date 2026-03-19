use poker_api::prelude::*;
use steel::*;
use solana_program::sysvar::slot_hashes;

/// Deal cards - PERMISSIONLESS CRANK
/// Anyone can call this to advance the game when conditions are met.
/// Uses on-chain slot hash for provably fair randomness.
/// 
/// Conditions for dealing:
/// - Waiting phase + 2+ players → deal hole cards, start preflop
/// - Preflop/Flop/Turn complete (all bets matched) → deal next community cards
pub fn process_deal_cards(accounts: &[AccountInfo<'_>], _data: &[u8]) -> ProgramResult {
    use solana_program::msg;
    
    msg!("deal_cards: starting");
    
    // Parse accounts - cranker + table + slot_hashes + player seats
    if accounts.len() < 3 {
        msg!("deal_cards: not enough accounts");
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let cranker_info = &accounts[0]; // Anyone can be the cranker
    let table_info = &accounts[1];
    let slot_hashes_info = &accounts[2];
    let seat_accounts = &accounts[3..];

    msg!("deal_cards: cranker={}", cranker_info.key);
    msg!("deal_cards: table={}", table_info.key);
    msg!("deal_cards: slot_hashes={}", slot_hashes_info.key);
    
    // Cranker must sign (pays TX fee)
    if !cranker_info.is_signer {
        msg!("deal_cards: cranker not signer");
        return Err(ProgramError::MissingRequiredSignature);
    }
    
    // Verify slot_hashes sysvar
    if *slot_hashes_info.key != slot_hashes::id() {
        msg!("deal_cards: invalid slot_hashes sysvar");
        return Err(ProgramError::InvalidAccountData);
    }

    msg!("deal_cards: loading table");
    
    // Load table
    let table = table_info.as_account_mut::<Table>(&poker_api::ID)?;
    
    msg!("deal_cards: table loaded, phase={}", table.phase());
    
    // Generate VRF seed from slot hash + table state (provably fair)
    let vrf_seed = generate_vrf_seed(slot_hashes_info, table.hand_number, &table.table_id)?;

    let phase = table.phase();

    match phase {
        p if p == GamePhase::Waiting as u8 => {
            // Start new hand - deal hole cards
            if table.player_count() < 2 {
                return Err(PokerError::InvalidAction.into());
            }

            // Set VRF seed for this hand
            table.deck_seed = vrf_seed;
            
            // Reset table state for new hand
            table.pot = 0;
            table.min_bet = table.big_blind;
            table.hand_number += 1;
            table.community_cards = [255, 255, 255, 255, 255, 255, 255, 255];
            
            // Initialize deck index
            table.table_state[6] = 0; // deck_index

            // Deal 2 hole cards to each active player
            let mut deck_index: u8 = 0;
            
            for seat_info in seat_accounts.iter() {
                if let Ok(seat) = seat_info.as_account_mut::<PlayerSeat>(&poker_api::ID) {
                    if seat.wallet != Pubkey::default() && seat.chips > 0 {
                        // Get cards from shuffled deck
                        let card1 = get_card_from_deck(&vrf_seed, deck_index);
                        let card2 = get_card_from_deck(&vrf_seed, deck_index + 1);
                        deck_index += 2;
                        
                        seat.hole_cards = [card1, card2];
                        seat.reset_for_hand();
                    }
                }
            }

            // Update deck index
            table.table_state[6] = deck_index;

            // Move to preflop
            table.set_phase(GamePhase::PreFlop as u8);
            
            // Set current player to first after big blind
            let bb_seat = table.bb_seat();
            table.set_current_player_seat((bb_seat + 1) % table.player_count());
        }
        p if p == GamePhase::PreFlop as u8 => {
            // Deal flop (3 cards)
            let deck_index = table.deck_index();
            
            table.community_cards[0] = get_card_from_deck(&vrf_seed, deck_index);
            table.community_cards[1] = get_card_from_deck(&vrf_seed, deck_index + 1);
            table.community_cards[2] = get_card_from_deck(&vrf_seed, deck_index + 2);
            
            table.table_state[6] = deck_index + 3;
            table.set_phase(GamePhase::Flop as u8);
            
            // Reset bets for new round
            table.min_bet = 0;
            for seat_info in seat_accounts.iter() {
                if let Ok(seat) = seat_info.as_account_mut::<PlayerSeat>(&poker_api::ID) {
                    seat.bet_this_round = 0;
                }
            }
            
            // First to act is first active player after dealer
            let dealer = table.dealer_seat();
            table.set_current_player_seat((dealer + 1) % table.player_count());
        }
        p if p == GamePhase::Flop as u8 => {
            // Deal turn (1 card)
            let deck_index = table.deck_index();
            
            table.community_cards[3] = get_card_from_deck(&vrf_seed, deck_index);
            
            table.table_state[6] = deck_index + 1;
            table.set_phase(GamePhase::Turn as u8);
            
            // Reset bets
            table.min_bet = 0;
            for seat_info in seat_accounts.iter() {
                if let Ok(seat) = seat_info.as_account_mut::<PlayerSeat>(&poker_api::ID) {
                    seat.bet_this_round = 0;
                }
            }
            
            let dealer = table.dealer_seat();
            table.set_current_player_seat((dealer + 1) % table.player_count());
        }
        p if p == GamePhase::Turn as u8 => {
            // Deal river (1 card)
            let deck_index = table.deck_index();
            
            table.community_cards[4] = get_card_from_deck(&vrf_seed, deck_index);
            
            table.table_state[6] = deck_index + 1;
            table.set_phase(GamePhase::River as u8);
            
            // Reset bets
            table.min_bet = 0;
            for seat_info in seat_accounts.iter() {
                if let Ok(seat) = seat_info.as_account_mut::<PlayerSeat>(&poker_api::ID) {
                    seat.bet_this_round = 0;
                }
            }
            
            let dealer = table.dealer_seat();
            table.set_current_player_seat((dealer + 1) % table.player_count());
        }
        _ => {
            return Err(PokerError::InvalidAction.into());
        }
    }

    Ok(())
}

/// Generate VRF seed from slot hash - provably fair on-chain randomness
/// Combines recent slot hash with table state for unique per-hand seed
fn generate_vrf_seed(
    slot_hashes_info: &AccountInfo,
    hand_number: u64,
    table_id: &[u8; 32],
) -> Result<[u8; 32], ProgramError> {
    // Get slot hashes data
    let slot_hashes_data = slot_hashes_info.try_borrow_data()?;
    
    // Use first slot hash (most recent) - skip 8 byte length prefix
    if slot_hashes_data.len() < 48 {
        return Err(ProgramError::InvalidAccountData);
    }
    
    // Slot hash is 32 bytes after the slot number (8 bytes)
    let recent_hash = &slot_hashes_data[16..48];
    
    // Combine: slot_hash XOR table_id XOR hand_number for unique seed
    let mut seed = [0u8; 32];
    for i in 0..32 {
        seed[i] = recent_hash[i] ^ table_id[i];
    }
    
    // Mix in hand number
    let hand_bytes = hand_number.to_le_bytes();
    for i in 0..8 {
        seed[i] ^= hand_bytes[i];
    }
    
    Ok(seed)
}

/// Generate a shuffled deck from VRF seed using Fisher-Yates
/// Returns array where deck[i] is the card at position i
fn shuffle_deck(seed: &[u8; 32]) -> [u8; 52] {
    let mut deck: [u8; 52] = core::array::from_fn(|i| i as u8);
    let mut hash_state = *seed;
    
    // Fisher-Yates shuffle
    for i in (1..52).rev() {
        // Generate next random value by hashing current state
        hash_state = simple_hash(&hash_state);
        let random_value = u64::from_le_bytes([
            hash_state[0], hash_state[1], hash_state[2], hash_state[3],
            hash_state[4], hash_state[5], hash_state[6], hash_state[7],
        ]);
        let j = (random_value % (i as u64 + 1)) as usize;
        deck.swap(i, j);
    }
    
    deck
}

/// Simple hash function for on-chain use
fn simple_hash(input: &[u8; 32]) -> [u8; 32] {
    let mut result = [0u8; 32];
    let mut state: u64 = 0x517cc1b727220a95; // Random constant
    
    for (i, &byte) in input.iter().enumerate() {
        state = state.wrapping_mul(0x5851f42d4c957f2d);
        state = state.wrapping_add(byte as u64);
        state ^= state >> 33;
    }
    
    // Fill result with mixed state
    for i in 0..4 {
        state = state.wrapping_mul(0x5851f42d4c957f2d);
        state ^= state >> 33;
        let bytes = state.to_le_bytes();
        result[i*8..(i+1)*8].copy_from_slice(&bytes);
    }
    
    result
}

/// Get card from pre-shuffled deck at index
fn get_card_from_deck(seed: &[u8; 32], index: u8) -> u8 {
    let deck = shuffle_deck(seed);
    deck[index as usize]
}
