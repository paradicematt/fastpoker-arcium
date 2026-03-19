use poker_api::prelude::*;
use steel::*;

/// Process a player action (fold, check, call, raise, all-in)
pub fn process_player_action(accounts: &[AccountInfo<'_>], data: &[u8]) -> ProgramResult {
    // Parse instruction data
    let args = PlayerAction::try_from_bytes(data)?;
    let action_type = args.action_type;
    let raise_amount = u64::from_le_bytes(args.amount);

    // Parse accounts
    let [player_info, table_info, seat_info] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate player is signer
    player_info.is_signer()?;

    // Load table
    let table = table_info.as_account_mut::<Table>(&poker_api::ID)?;

    // Check game is in active phase
    let phase = table.phase();
    if phase == GamePhase::Waiting as u8 || phase == GamePhase::Showdown as u8 {
        return Err(PokerError::InvalidAction.into());
    }

    // Load player seat
    let seat = seat_info.as_account_mut::<PlayerSeat>(&poker_api::ID)?;

    // Verify this is the player's seat
    if seat.wallet != *player_info.key {
        return Err(PokerError::NotYourSeat.into());
    }

    // Verify it's this player's turn
    if seat.seat_number != table.current_player_seat() {
        return Err(PokerError::NotYourTurn.into());
    }

    // Verify player can act
    if !seat.can_act() {
        return Err(PokerError::InvalidAction.into());
    }

    // Get current bet to call
    let min_bet = table.min_bet;
    let to_call = min_bet.saturating_sub(seat.bet_this_round);

    // Process action
    match action_type {
        0 => {
            // FOLD
            seat.has_folded = 1;
            seat.is_active = 0;
        }
        1 => {
            // CHECK - only valid if nothing to call
            if to_call > 0 {
                return Err(PokerError::InvalidAction.into());
            }
        }
        2 => {
            // CALL
            if to_call == 0 {
                // Nothing to call, treat as check
            } else if seat.chips >= to_call {
                seat.chips -= to_call;
                seat.bet_this_round += to_call;
                seat.total_bet_this_hand += to_call;
                table.pot += to_call;
            } else {
                // All-in call
                let all_in_amount = seat.chips;
                seat.bet_this_round += all_in_amount;
                seat.total_bet_this_hand += all_in_amount;
                table.pot += all_in_amount;
                seat.chips = 0;
                seat.is_all_in = 1;
            }
        }
        3 => {
            // RAISE
            let total_bet = seat.bet_this_round + raise_amount;
            
            // Raise must be at least min_bet + big_blind (min raise)
            if total_bet < min_bet + table.big_blind {
                return Err(PokerError::InvalidAmount.into());
            }
            
            if seat.chips < raise_amount {
                return Err(PokerError::InsufficientBalance.into());
            }
            
            seat.chips -= raise_amount;
            seat.bet_this_round += raise_amount;
            seat.total_bet_this_hand += raise_amount;
            table.pot += raise_amount;
            table.min_bet = seat.bet_this_round;
        }
        4 => {
            // ALL-IN
            let all_in_amount = seat.chips;
            seat.bet_this_round += all_in_amount;
            seat.total_bet_this_hand += all_in_amount;
            table.pot += all_in_amount;
            seat.chips = 0;
            seat.is_all_in = 1;
            
            // Update min bet if this is a raise
            if seat.bet_this_round > table.min_bet {
                table.min_bet = seat.bet_this_round;
            }
        }
        _ => {
            return Err(PokerError::InvalidAction.into());
        }
    }

    // Update last action time
    seat.last_action_time = solana_program::clock::Clock::get()?.unix_timestamp;

    // Check if betting round is complete
    // Round is complete when we've gone around and all active players have matched the bet
    let current_seat_num = seat.seat_number;
    let next_seat = table.next_active_seat(current_seat_num);
    
    // For now, use simplified logic for heads-up:
    // If we're back to the first active player and all bets are matched, advance phase
    let betting_complete = if let Some(next) = next_seat {
        // Check if next player has already matched the bet (or is the one who set it)
        // In heads-up, after both players act and bets are equal, round ends
        // We need to track who opened the action - simplified: if both have same bet_this_round
        // and next player is NOT the one who raised, round is complete
        
        // For simplicity: advance if this was a call/check and to_call was 0
        // This means both players have matched the current bet
        (action_type == 1 || action_type == 2) && to_call == 0
    } else {
        // No next active player - only one player left, they win
        true
    };
    
    if betting_complete && action_type != 3 { // Don't advance after a raise
        // Advance to next phase
        let current_phase = table.phase();
        let new_phase = match current_phase {
            p if p == GamePhase::PreFlop as u8 => GamePhase::Flop as u8,
            p if p == GamePhase::Flop as u8 => GamePhase::Turn as u8,
            p if p == GamePhase::Turn as u8 => GamePhase::River as u8,
            p if p == GamePhase::River as u8 => GamePhase::Showdown as u8,
            _ => current_phase,
        };
        
        if new_phase != current_phase {
            table.set_phase(new_phase);
            // Reset min_bet for new round (except preflop->flop keeps blinds logic)
            table.min_bet = 0;
            
            // Reset bet_this_round for all seats would require iterating seats
            // For now, the deal_cards or settle_hand will handle this
            
            // In post-flop, first to act is first active player after dealer
            if new_phase != GamePhase::Showdown as u8 {
                if let Some(first) = table.next_active_seat(table.dealer_seat()) {
                    table.set_current_player_seat(first);
                }
            }
        }
    } else if let Some(next) = next_seat {
        // Move to next player
        table.set_current_player_seat(next);
    }

    Ok(())
}
