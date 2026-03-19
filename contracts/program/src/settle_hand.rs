use poker_api::prelude::*;
use steel::*;

/// Rake percentage (5% = 500 basis points)
const RAKE_BPS: u64 = 500;

/// Settle hand - PERMISSIONLESS CRANK
/// Anyone can call this when:
/// - Only one player remains (everyone else folded) - auto-win
/// - Phase is Showdown - on-chain hand evaluation determines winner
pub fn process_settle_hand(accounts: &[AccountInfo<'_>], _data: &[u8]) -> ProgramResult {
    // Parse accounts
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let cranker_info = &accounts[0]; // Anyone can crank
    let table_info = &accounts[1];
    let _pool_info = &accounts[2];
    let seat_accounts = &accounts[3..];

    // Cranker must sign (pays TX fee)
    cranker_info.is_signer()?;

    // Load table
    let table = table_info.as_account_mut::<Table>(&poker_api::ID)?;

    // Count active (non-folded) players and find them
    let mut active_seats: [u8; 9] = [255; 9];
    let mut active_count = 0;
    
    for seat_info in seat_accounts.iter() {
        if let Ok(seat) = seat_info.as_account::<PlayerSeat>(&poker_api::ID) {
            if seat.wallet != Pubkey::default() && seat.has_folded == 0 && 
               (seat.is_active == 1 || seat.is_all_in == 1) {
                if active_count < 9 {
                    active_seats[active_count] = seat.seat_number;
                }
                active_count += 1;
            }
        }
    }

    let phase = table.phase();
    
    // Determine winners based on game state
    let (winner_seats, amounts) = if active_count == 1 {
        // Only one player left - they win by fold
        let winner = active_seats[0];
        let mut seats = [255u8; 9];
        let mut amts = [[0u8; 8]; 9];
        seats[0] = winner;
        amts[0] = table.pot.to_le_bytes();
        (seats, amts)
    } else if phase == GamePhase::Showdown as u8 || phase == GamePhase::River as u8 {
        // Showdown - evaluate hands on-chain
        evaluate_showdown(table, seat_accounts, &active_seats, active_count)?
    } else {
        // Game still in progress - can't settle yet
        return Err(PokerError::InvalidAction.into());
    };

    // Calculate rake (only for cash games, not tournaments)
    // Rake is only taken if hand went past preflop (flop was dealt)
    // stakes_level 0 = tournament (no rake), 1+ = cash game (has rake)
    let total_pot = table.pot;
    let is_tournament = table.stakes_level() == 0;
    let saw_flop = phase >= GamePhase::Flop as u8; // Phase >= Flop means community cards were dealt
    
    let rake = if is_tournament || !saw_flop {
        0 // No rake for tournaments or preflop-only hands
    } else {
        (total_pot * RAKE_BPS) / 10000 // 5% rake for cash games after flop
    };
    let _net_pot = total_pot - rake;

    // Count winners
    let mut winner_count = 0;
    for &seat in winner_seats.iter() {
        if seat != 255 {
            winner_count += 1;
        }
    }

    if winner_count == 0 {
        return Err(PokerError::InvalidAction.into());
    }

    // Distribute pot to winners
    for (i, &seat_num) in winner_seats.iter().enumerate() {
        if seat_num == 255 {
            continue;
        }

        let win_amount = u64::from_le_bytes(amounts[i]);
        
        // Find the seat and award winnings
        for seat_info in seat_accounts.iter() {
            if let Ok(seat) = seat_info.as_account_mut::<PlayerSeat>(&poker_api::ID) {
                if seat.seat_number == seat_num {
                    seat.chips += win_amount;
                    break;
                }
            }
        }
    }

    // Add rake to table's accumulated rake
    table.rake_accumulated += rake;

    // Transfer rake to pool if above threshold (optional - could batch)
    // For now, just accumulate and transfer later via separate instruction
    
    // Reset table for next hand
    table.pot = 0;
    table.min_bet = table.big_blind;
    table.community_cards = [255, 255, 255, 255, 255, 255, 255, 255];
    table.set_phase(GamePhase::Waiting as u8);
    table.set_current_player_seat(255);

    // Move dealer button
    let current_dealer = table.dealer_seat();
    let next_dealer = (current_dealer + 1) % table.player_count();
    table.set_dealer_seat(next_dealer);

    // Reset player states for next hand
    for seat_info in seat_accounts.iter() {
        if let Ok(seat) = seat_info.as_account_mut::<PlayerSeat>(&poker_api::ID) {
            if seat.wallet != Pubkey::default() {
                seat.hole_cards = [255, 255];
                seat.bet_this_round = 0;
                seat.total_bet_this_hand = 0;
                seat.has_folded = 0;
                seat.is_all_in = 0;
                
                // Mark as active if they have chips
                if seat.chips > 0 && seat.is_sitting_out == 0 {
                    seat.is_active = 1;
                } else {
                    seat.is_active = 0;
                }
            }
        }
    }

    Ok(())
}

/// Evaluate showdown and determine winner(s) with on-chain hand ranking
fn evaluate_showdown(
    table: &Table,
    seat_accounts: &[AccountInfo],
    active_seats: &[u8; 9],
    active_count: usize,
) -> Result<([u8; 9], [[u8; 8]; 9]), ProgramError> {
    let community = &table.community_cards[0..5];
    
    // Evaluate each active player's hand
    let mut best_rank: u32 = 0;
    let mut best_seats: [u8; 9] = [255; 9];
    let mut best_count = 0;
    
    for i in 0..active_count {
        let seat_num = active_seats[i];
        if seat_num == 255 {
            continue;
        }
        
        // Find seat and get hole cards
        for seat_info in seat_accounts.iter() {
            if let Ok(seat) = seat_info.as_account::<PlayerSeat>(&poker_api::ID) {
                if seat.seat_number == seat_num {
                    let hole = &seat.hole_cards;
                    let rank = evaluate_hand(hole, community);
                    
                    if rank > best_rank {
                        best_rank = rank;
                        best_seats = [255; 9];
                        best_seats[0] = seat_num;
                        best_count = 1;
                    } else if rank == best_rank {
                        // Tie - add to winners
                        if best_count < 9 {
                            best_seats[best_count] = seat_num;
                            best_count += 1;
                        }
                    }
                    break;
                }
            }
        }
    }
    
    // Split pot among winners
    let pot = table.pot;
    let share = pot / best_count as u64;
    let remainder = pot % best_count as u64;
    
    let mut amounts: [[u8; 8]; 9] = [[0; 8]; 9];
    for i in 0..best_count {
        let mut amount = share;
        if i == 0 {
            amount += remainder; // First winner gets remainder
        }
        amounts[i] = amount.to_le_bytes();
    }
    
    Ok((best_seats, amounts))
}

/// Evaluate a 7-card poker hand (2 hole + 5 community) and return ranking score
/// Higher score = better hand
/// Score format: RRRRR_KKKKK where R = rank type (0-9), K = kickers
fn evaluate_hand(hole: &[u8; 2], community: &[u8]) -> u32 {
    // Combine all 7 cards
    let mut cards = [255u8; 7];
    cards[0] = hole[0];
    cards[1] = hole[1];
    for (i, &c) in community.iter().take(5).enumerate() {
        cards[i + 2] = c;
    }
    
    // Extract ranks and suits
    let mut ranks = [0u8; 7];
    let mut suits = [0u8; 7];
    let mut rank_counts = [0u8; 13];
    let mut suit_counts = [0u8; 4];
    
    for (i, &card) in cards.iter().enumerate() {
        if card < 52 {
            ranks[i] = card % 13;
            suits[i] = card / 13;
            rank_counts[ranks[i] as usize] += 1;
            suit_counts[suits[i] as usize] += 1;
        }
    }
    
    // Check for flush
    let flush_suit = suit_counts.iter().position(|&c| c >= 5);
    
    // Check for straight (including wheel: A-2-3-4-5)
    let straight_high = find_straight(&rank_counts);
    
    // Count pairs, trips, quads
    let mut quads = 255u8;
    let mut trips = 255u8;
    let mut pairs = [255u8; 2];
    let mut pair_count = 0;
    
    for rank in (0..13).rev() {
        match rank_counts[rank] {
            4 => quads = rank as u8,
            3 => {
                if trips == 255 {
                    trips = rank as u8;
                }
            }
            2 => {
                if pair_count < 2 {
                    pairs[pair_count] = rank as u8;
                    pair_count += 1;
                }
            }
            _ => {}
        }
    }
    
    // Determine hand rank (higher = better)
    // 9: Straight flush, 8: Quads, 7: Full house, 6: Flush
    // 5: Straight, 4: Trips, 3: Two pair, 2: Pair, 1: High card
    
    if let Some(suit) = flush_suit {
        // Check for straight flush
        let mut flush_ranks = [0u8; 13];
        for (i, &card) in cards.iter().enumerate() {
            if card < 52 && suits[i] == suit as u8 {
                flush_ranks[ranks[i] as usize] += 1;
            }
        }
        if let Some(sf_high) = find_straight(&flush_ranks) {
            return 9 * 100000 + sf_high as u32 * 1000; // Straight flush
        }
    }
    
    if quads != 255 {
        return 8 * 100000 + quads as u32 * 1000; // Four of a kind
    }
    
    if trips != 255 && pairs[0] != 255 {
        return 7 * 100000 + trips as u32 * 1000 + pairs[0] as u32; // Full house
    }
    
    if flush_suit.is_some() {
        return 6 * 100000; // Flush (simplified - would need kickers)
    }
    
    if let Some(high) = straight_high {
        return 5 * 100000 + high as u32 * 1000; // Straight
    }
    
    if trips != 255 {
        return 4 * 100000 + trips as u32 * 1000; // Three of a kind
    }
    
    if pair_count >= 2 {
        return 3 * 100000 + pairs[0] as u32 * 1000 + pairs[1] as u32; // Two pair
    }
    
    if pair_count == 1 {
        return 2 * 100000 + pairs[0] as u32 * 1000; // One pair
    }
    
    // High card
    let high_card = ranks.iter().filter(|&&r| r < 13).max().unwrap_or(&0);
    1 * 100000 + *high_card as u32 * 1000
}

/// Find highest straight in rank counts, returns high card of straight
fn find_straight(rank_counts: &[u8; 13]) -> Option<u8> {
    // Check A-high down to 5-high (wheel)
    // Ranks: 0=2, 1=3, ..., 8=T, 9=J, 10=Q, 11=K, 12=A
    
    // Check regular straights (T-A down to 2-6)
    for high in (4..13).rev() {
        let mut is_straight = true;
        for i in 0..5 {
            if rank_counts[high - i] == 0 {
                is_straight = false;
                break;
            }
        }
        if is_straight {
            return Some(high as u8);
        }
    }
    
    // Check wheel (A-2-3-4-5)
    if rank_counts[12] > 0 && rank_counts[0] > 0 && rank_counts[1] > 0 && 
       rank_counts[2] > 0 && rank_counts[3] > 0 {
        return Some(3); // 5-high straight (wheel)
    }
    
    None
}
