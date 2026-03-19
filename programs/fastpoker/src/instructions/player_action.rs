use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;
use crate::events::PlayerActed;
use crate::constants::*;

#[derive(Accounts)]
pub struct PlayerAction<'info> {
    /// Player wallet OR session key signer
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
    )]
    pub table: Account<'info, Table>,

    #[account(
        mut,
        seeds = [SEAT_SEED, table.key().as_ref(), &[seat.seat_number]],
        bump = seat.bump,
    )]
    pub seat: Account<'info, PlayerSeat>,

    /// Optional custom session token for 1-click gameplay.
    /// If None, signer must be the player's wallet directly.
    pub session_token: Option<Account<'info, SessionToken>>,
}

pub fn handler<'info>(ctx: Context<'_, '_, 'info, 'info, PlayerAction<'info>>, action: PokerAction) -> Result<()> {
    let table = &mut ctx.accounts.table;
    let seat = &mut ctx.accounts.seat;
    let signer = &ctx.accounts.signer;
    let clock = Clock::get()?;

    // Auth: either direct wallet signer OR valid custom session token.
    let is_wallet = signer.key() == seat.wallet;
    let has_valid_session = if let Some(ref token) = ctx.accounts.session_token {
        token.owner == seat.wallet
            && token.session_key == signer.key()
            && token.is_valid(&clock)
    } else {
        false
    };
    require!(is_wallet || has_valid_session, PokerError::InvalidSigner);

    // Handle SitOut, ReturnToPlay, LeaveCashGame separately - they don't require turn, active status, or betting phase
    match action {
        PokerAction::SitOut => {
            return process_sit_out(table, seat, clock.slot);
        }
        PokerAction::ReturnToPlay => {
            return process_return_to_play(table, seat, clock.slot);
        }
        PokerAction::LeaveCashGame => {
            let table_key = table.key();
            return process_leave_cash_game(table, seat, clock.slot, table_key);
        }
        PokerAction::RebuyTopUp { .. } => {
            // DEPRECATED: RebuyTopUp used ER vault_reserve (always 0 in Arcium architecture).
            // L1 rebuys will be a separate instruction with direct SOL transfer.
            msg!("RebuyTopUp is deprecated — use L1 rebuy instruction");
            return Err(PokerError::InvalidActionForPhase.into());
        }
        _ => {}
    }

    // Gameplay actions are only valid in active betting phases.
    require!(
        matches!(
            table.phase,
            GamePhase::Preflop | GamePhase::Flop | GamePhase::Turn | GamePhase::River
        ),
        PokerError::InvalidActionForPhase
    );

    // For regular actions, verify it's this player's turn
    require!(
        table.current_player == seat.seat_number,
        PokerError::NotPlayersTurn
    );

    // Verify player can act
    require!(seat.can_act(), PokerError::PlayerFolded);

    // Process the action
    match action {
        PokerAction::Fold => process_fold(table, seat)?,
        PokerAction::Check => process_check(table, seat)?,
        PokerAction::Call => process_call(table, seat)?,
        PokerAction::Bet { amount } => process_bet(table, seat, amount)?,
        PokerAction::Raise { amount } => process_raise(table, seat, amount)?,
        PokerAction::AllIn => process_all_in(table, seat)?,
        PokerAction::SitOut | PokerAction::ReturnToPlay | PokerAction::LeaveCashGame | PokerAction::RebuyTopUp { .. } => unreachable!(),
    }

    // Update last action time + reset auto-fold counter (player is active)
    seat.last_action_slot = clock.slot;
    seat.auto_fold_count = 0;
    seat.time_bank_active = false; // Reset so player can use time bank again on next turn
    table.last_action_slot = clock.unix_timestamp as u64;
    table.action_nonce = table.action_nonce.wrapping_add(1);

    emit!(PlayerActed {
        table: table.key(),
        player: seat.wallet,
        seat_number: seat.seat_number,
        action: action.clone(),
        pot_after: table.pot,
    });

    // Advance to next player or next phase
    advance_action(table)?;

    // Auto-schedule timeout for the next player via MagicBlock ScheduleTask CPI.
    // Timeout scheduling handled by external crank service on L1.

    Ok(())
}

fn process_fold(table: &mut Table, seat: &mut PlayerSeat) -> Result<()> {
    seat.status = SeatStatus::Folded;
    // Mark seat as folded in bitmask for turn skipping
    table.seats_folded |= 1 << seat.seat_number;
    msg!("Player {} folded", seat.seat_number);
    
    // Check if only one player remains (they win)
    // For heads-up, if one folds, the other wins immediately
    // This will be handled by checking active players after the action
    Ok(())
}

fn process_check(table: &Table, seat: &PlayerSeat) -> Result<()> {
    // Can only check if no bet to call
    let amount_to_call = table.min_bet.saturating_sub(seat.bet_this_round);
    require!(amount_to_call == 0, PokerError::CannotCheck);
    msg!("Player {} checked", seat.seat_number);
    Ok(())
}

fn process_call(table: &mut Table, seat: &mut PlayerSeat) -> Result<()> {
    let amount_to_call = table.min_bet.saturating_sub(seat.bet_this_round);
    require!(amount_to_call > 0, PokerError::NothingToCall);

    let call_amount = amount_to_call.min(seat.chips);
    
    seat.chips = seat.chips.saturating_sub(call_amount);
    seat.bet_this_round += call_amount;
    seat.total_bet_this_hand += call_amount;
    table.pot += call_amount;

    if seat.chips == 0 {
        seat.status = SeatStatus::AllIn;
        // Mark seat as all-in in bitmask for runout detection
        table.seats_allin |= 1 << seat.seat_number;
    }

    // NOTE: Don't reset min_bet here - other players may still need to call
    // Round completion is checked in advance_action

    msg!("Player {} called {}", seat.seat_number, call_amount);
    Ok(())
}

fn process_bet(table: &mut Table, seat: &mut PlayerSeat, amount: u64) -> Result<()> {
    // Can only bet if no current bet
    require!(table.min_bet == 0, PokerError::InvalidBetAmount);
    
    // GI-003: Reject zero-chip bets (defense-in-depth — big_blind check covers this too)
    require!(amount > 0, PokerError::BetBelowMinimum);
    // Minimum bet is the big blind
    require!(amount >= table.big_blind, PokerError::BetBelowMinimum);
    require!(amount <= seat.chips, PokerError::InsufficientChips);

    seat.chips = seat.chips.saturating_sub(amount);
    seat.bet_this_round = amount;
    seat.total_bet_this_hand += amount;
    table.pot += amount;
    table.min_bet = amount;
    
    // Reset action counter - everyone needs to respond to a bet
    table.actions_this_round = 0;

    if seat.chips == 0 {
        seat.status = SeatStatus::AllIn;
        table.seats_allin |= 1 << seat.seat_number;
    }

    msg!("Player {} bet {}", seat.seat_number, amount);
    Ok(())
}

fn process_raise(table: &mut Table, seat: &mut PlayerSeat, amount: u64) -> Result<()> {
    // GI-002: Reject zero-amount raises — when min_bet == 0, min_raise == 0 and
    // amount >= 0 passes, allowing free action_counter resets (infinite loop exploit)
    require!(amount > 0, PokerError::RaiseTooSmall);

    let current_bet = table.min_bet;
    let amount_to_call = current_bet.saturating_sub(seat.bet_this_round);
    
    // Raise must be at least the current bet (2x total)
    let min_raise = current_bet;
    require!(amount >= min_raise, PokerError::RaiseTooSmall);
    
    let total_bet = amount_to_call + amount;
    require!(total_bet <= seat.chips, PokerError::InsufficientChips);

    seat.chips = seat.chips.saturating_sub(total_bet);
    seat.bet_this_round += total_bet;
    seat.total_bet_this_hand += total_bet;
    table.pot += total_bet;
    table.min_bet = seat.bet_this_round;
    
    // Reset action counter - everyone needs to act again after a raise
    table.actions_this_round = 0;

    if seat.chips == 0 {
        seat.status = SeatStatus::AllIn;
        table.seats_allin |= 1 << seat.seat_number;
    }

    msg!("Player {} raised to {}", seat.seat_number, seat.bet_this_round);
    Ok(())
}

fn process_all_in(table: &mut Table, seat: &mut PlayerSeat) -> Result<()> {
    let all_in_amount = seat.chips;
    
    seat.bet_this_round += all_in_amount;
    seat.total_bet_this_hand += all_in_amount;
    table.pot += all_in_amount;
    seat.chips = 0;
    seat.status = SeatStatus::AllIn;
    
    // Mark seat as all-in in bitmask for runout detection
    table.seats_allin |= 1 << seat.seat_number;

    // If all-in exceeds min_bet, it's effectively a raise — everyone must respond
    if seat.bet_this_round > table.min_bet {
        table.min_bet = seat.bet_this_round;
        table.actions_this_round = 0; // Reset so all other players must act
    }

    msg!("Player {} went all-in for {}", seat.seat_number, all_in_amount);
    Ok(())
}

fn process_sit_out(table: &mut Table, seat: &mut PlayerSeat, slot: u64) -> Result<()> {
    // CRITICAL: Never overwrite Leaving status — it would destroy the cashout snapshot.
    // This matches the guard in sit_out.rs. Without it, SitOut after LeaveCashGame
    // creates zombie seats (cashout snapshot lost, player stuck forever).
    if seat.status == SeatStatus::Leaving || seat.status == SeatStatus::SittingOut {
        return Ok(());
    }

    // Can sit out anytime except when it's your turn to act in an active hand
    // If it's your turn, you must fold first (or the action will timeout)
    if table.phase != GamePhase::Waiting && table.phase != GamePhase::Complete {
        // During active hand
        if table.current_player == seat.seat_number && seat.status == SeatStatus::Active {
            // Player's turn - they must fold or act first
            return Err(PokerError::CannotSitOutDuringTurn.into());
        }
    }
    
    // Mark player as sitting out
    seat.status = SeatStatus::SittingOut;
    seat.last_action_slot = slot;
    // Record sit-out timestamp — crank uses this to auto-remove after 5 minutes
    let clock = Clock::get()?;
    seat.sit_out_timestamp = clock.unix_timestamp;
    
    // Track missed blinds based on position relative to dealer
    // They'll need to post when returning
    seat.missed_sb = true;
    seat.missed_bb = true;
    
    // NOTE: Do NOT clear seats_occupied here. The seat is still physically occupied.
    // start_game already excludes SittingOut from active_mask and marks them folded.
    // Clearing the bitmask breaks settle_hand (crank only passes PDAs for occupied seats).
    
    // FIX: During an active hand, immediately mark seated-out player as folded in the
    // bitmask so advance_action / set_postflop_current_player skip them.
    // Without this, the SittingOut player appears "active" in bitmask logic and gets
    // assigned as current_player — but can't act (can_act()=false), freezing the game
    // until the crank's 20s timeout fires. In HU this caused permanent table deadlocks.
    if table.phase != GamePhase::Waiting && table.phase != GamePhase::Complete {
        table.seats_folded |= 1 << seat.seat_number;
        msg!("Seat {} folded in bitmask (sat out mid-hand)", seat.seat_number);
    }
    
    msg!("Player {} is now sitting out", seat.seat_number);
    Ok(())
}

fn process_return_to_play(table: &mut Table, seat: &mut PlayerSeat, slot: u64) -> Result<()> {
    // Can only return if currently sitting out — never if Leaving (cashout in progress)
    if seat.status == SeatStatus::Leaving {
        return Ok(());
    }
    require!(seat.status == SeatStatus::SittingOut, PokerError::NotSittingOut);
    
    // Mark player as waiting for next hand
    // They won't be dealt into current hand if one is in progress
    if table.phase == GamePhase::Waiting {
        // No hand in progress - can return immediately
        seat.status = SeatStatus::Active;
        // FIX: Do NOT clear missed_sb/missed_bb here — that bypasses the blind
        // payment enforced by sit_in_handler. The missed blind flags persist so
        // start_game can properly require blind posting or waiting for BB position.
    } else {
        // Hand in progress - will join next hand
        // Keep status as SittingOut but clear the waiting_for_bb flag
        // The deal logic will pick them up for the next hand
        seat.waiting_for_bb = false;
    }
    
    seat.last_action_slot = slot;
    // Clear sit-out timer — player is back
    seat.sit_out_timestamp = 0;
    
    // Re-add to occupied seats
    table.seats_occupied |= 1 << seat.seat_number;
    
    msg!("Player {} is returning to play", seat.seat_number);
    Ok(())
}

fn process_leave_cash_game(table: &mut Table, seat: &mut PlayerSeat, slot: u64, table_pubkey: Pubkey) -> Result<()> {
    // Cash games only
    require!(table.game_type == GameType::CashGame, PokerError::InvalidGameType);

    // Already leaving
    if seat.status == SeatStatus::Leaving {
        return Ok(());
    }

    // Player can mark Leaving at ANY time — even mid-hand, even during their turn.
    // If mid-hand, the crank's handle_timeout (15-20s) will auto-fold them.
    // settle.rs will then snapshot their cashout after the hand completes.

    // Mark as Leaving
    seat.status = SeatStatus::Leaving;
    seat.last_action_slot = slot;

    // Two-path snapshot:
    // - Waiting/Complete phase: snapshot immediately (no hand in progress)
    // - In-hand: just set Leaving, settle.rs will snapshot after hand completes
    let total_owed = seat.chips.checked_add(seat.vault_reserve).unwrap_or(seat.chips);

    if table.phase == GamePhase::Waiting || table.phase == GamePhase::Complete {
        // Snapshot immediately — no active hand
        seat.cashout_chips = total_owed;
        seat.cashout_nonce = seat.cashout_nonce.wrapping_add(1);
        seat.chips = 0;
        seat.vault_reserve = 0;
        // Remove from active masks immediately
        let mask = 1u16 << seat.seat_number;
        table.seats_occupied &= !mask;
        table.current_players = table.current_players.saturating_sub(1);
        msg!("Leaving snapshot (Waiting): cashout_chips={}, nonce={}", seat.cashout_chips, seat.cashout_nonce);
    } else {
        // Hand in progress: settle.rs will snapshot after the hand completes.
        // Don't zero chips yet — player may still be in the hand (all-in, etc.)
        
        let is_allin = seat.status == SeatStatus::AllIn
            || (table.seats_allin & (1u16 << seat.seat_number)) != 0;

        if is_allin {
            // All-in player leaving: they stay POT-ELIGIBLE for this hand.
            // Don't fold them — their chips are already committed.
            // settle.rs will pay out winnings, then snapshot the cashout.
            // They just won't participate in the NEXT hand.
            msg!("Seat {} is all-in — stays pot-eligible, will leave after settle", seat.seat_number);
        } else {
            // Active/non-all-in player leaving: fold them so the hand can continue.
            // Mark as folded in bitmask so advance_action / set_postflop_current_player
            // skip this player. Without this, the Leaving player appears "active" and
            // gets assigned as current_player — but can't act, freezing the game.
            table.seats_folded |= 1 << seat.seat_number;
            msg!("Seat {} folded in bitmask (leaving mid-hand)", seat.seat_number);
            
            // If this player IS the current player, advance the action immediately
            // so the game doesn't freeze waiting for a 20s crank timeout.
            if table.current_player == seat.seat_number {
                msg!("Current player left — advancing action immediately");
                advance_action(table)?;
            }
        }
        
        msg!("Leaving requested mid-hand. settle.rs will snapshot after hand completes.");
    }

    emit!(crate::events::PlayerLeft {
        table: table_pubkey,
        player: seat.wallet,
        seat_number: seat.seat_number,
        chips_cashed_out: total_owed,
    });

    msg!(
        "Player {} marked as Leaving cash game. {} chips + {} reserve = {} total",
        seat.wallet,
        seat.chips,
        seat.vault_reserve,
        total_owed
    );
    Ok(())
}

fn process_rebuy_topup(table: &mut Table, seat: &mut PlayerSeat, amount: u64) -> Result<()> {
    // Cash games only
    require!(table.game_type == GameType::CashGame, PokerError::InvalidGameType);

    // Can only rebuy/top-up between hands
    require!(table.phase == GamePhase::Waiting, PokerError::NotWaitingPhase);

    // Must be seated (SittingOut for rebuy, or Active/SittingOut for top-up)
    require!(
        seat.status == SeatStatus::SittingOut || seat.status == SeatStatus::Active,
        PokerError::InvalidSeatState
    );

    // Calculate table max buy-in
    let (_, max_bb): (u64, u64) = if table.buy_in_type == 1 { (50, 250) } else { (20, 100) };
    let max_buy_in = table.big_blind.checked_mul(max_bb).unwrap_or(u64::MAX);
    let min_buy_in = table.big_blind.checked_mul(if table.buy_in_type == 1 { 50 } else { 20 }).unwrap_or(0);

    // Can't exceed max buy-in
    require!(
        seat.chips.checked_add(amount).unwrap_or(u64::MAX) <= max_buy_in,
        PokerError::TopUpExceedsMax
    );

    // Must have enough reserve
    require!(seat.vault_reserve >= amount, PokerError::InsufficientReserve);

    // For rebuy (0 chips), enforce minimum buy-in
    if seat.chips == 0 {
        require!(amount >= min_buy_in, PokerError::RebuyBelowMin);
    }

    // Move from reserve to chips
    seat.vault_reserve -= amount;
    seat.chips += amount;

    // If was sitting out with 0 chips (busted), auto-return to active
    if seat.status == SeatStatus::SittingOut && seat.chips > 0 {
        seat.status = SeatStatus::Active;
        // Ensure in occupied mask
        table.seats_occupied |= 1 << seat.seat_number;
    }

    msg!(
        "RebuyTopUp: seat {} added {} chips (now {}), reserve remaining: {}",
        seat.seat_number,
        amount,
        seat.chips,
        seat.vault_reserve
    );
    Ok(())
}

pub(crate) fn advance_action(table: &mut Table) -> Result<()> {
    // Only count this action toward round completion if the player is still active
    // (not folded or all-in after their action). This prevents premature round closure
    // when a raise/bet/all-in removes the aggressor from active_count.
    let current_mask = 1u16 << table.current_player;
    let still_active = (table.seats_occupied & current_mask) != 0
        && (table.seats_folded & current_mask) == 0
        && (table.seats_allin & current_mask) == 0;
    if still_active {
        table.actions_this_round += 1;
    }
    
    // Find next active player - use max_players for seat cycling (seats may be non-contiguous after eliminations)
    let max_seats = table.max_players;
    if max_seats == 0 {
        return Ok(());
    }
    
    let mut next = (table.current_player + 1) % max_seats;
    let start = next;
    loop {
        // Check if this seat is active (not folded, not all-in)
        let seat_mask = 1u16 << next;
        let is_folded = (table.seats_folded & seat_mask) != 0;
        let is_allin = (table.seats_allin & seat_mask) != 0;
        let is_occupied = (table.seats_occupied & seat_mask) != 0;
        
        if is_occupied && !is_folded && !is_allin {
            break; // Found an active player
        }
        
        next = (next + 1) % max_seats;
        if next == start {
            break; // Went full circle, no active players
        }
    }
    table.current_player = next;
    
    // Count active players (not folded, not all-in) and non-folded players
    let mut active_count = 0u8;
    let mut non_folded_count = 0u8;
    for i in 0..max_seats {
        let seat_mask = 1u16 << i;
        let is_occupied = (table.seats_occupied & seat_mask) != 0;
        let is_folded = (table.seats_folded & seat_mask) != 0;
        let is_allin = (table.seats_allin & seat_mask) != 0;
        
        if is_occupied && !is_folded {
            non_folded_count += 1;
            if !is_allin {
                active_count += 1;
            }
        }
    }
    
    // Check if all-in runout is needed (all non-folded players are all-in)
    let all_in_runout = table.seats_allin > 0 && active_count == 0;
    
    // Use active_count (players who CAN act) for round completion
    // Raise/bet/all-in handlers reset actions_this_round to 0, so betting_closed
    // only becomes true after all active players respond to the latest aggression.
    let min_actions_for_round = if active_count > 0 { active_count } else { 1 };
    let betting_closed = table.actions_this_round >= min_actions_for_round;
    
    // Only 1 non-folded player means everyone else folded - hand is over
    let only_one_remaining = non_folded_count <= 1;
    
    // Round completes when:
    // - All active players have acted since the last raise/bet (betting_closed)
    // - OR all non-folded players are all-in (runout)
    // - OR only one player remains (everyone else folded)
    let round_complete = betting_closed || all_in_runout || only_one_remaining;
    
    msg!("advance_action: actions={}, min_bet={}, allin={}, round_complete={}", 
         table.actions_this_round, table.min_bet, table.seats_allin, round_complete);
    
    if round_complete {
        // If only one player remains (everyone else folded), skip straight to showdown
        // No need to deal community cards - the remaining player wins uncontested
        if only_one_remaining {
            table.phase = GamePhase::Showdown;
            msg!("All opponents folded - advancing to Showdown");
        } else {
            // Move to VRF reveal-pending state; a permissionless crank requests reveal randomness.
            table.phase = match table.phase {
                GamePhase::Preflop => {
                    msg!("Betting closed at Preflop — awaiting VRF flop reveal");
                    GamePhase::FlopRevealPending
                }
                GamePhase::Flop => {
                    msg!("Betting closed at Flop — awaiting VRF turn reveal");
                    GamePhase::TurnRevealPending
                }
                GamePhase::Turn => {
                    msg!("Betting closed at Turn — awaiting VRF river reveal");
                    GamePhase::RiverRevealPending
                }
                GamePhase::River => {
                    msg!("Betting closed at River — advancing to Showdown");
                    GamePhase::Showdown
                }
                _ => table.phase,
            };

            // Freeze action flow until reveal callback sets the next betting player.
            table.actions_this_round = 0;
            table.min_bet = 0;
            table.current_player = 255;
        } // end else (not only_one_remaining)
    }
    
    Ok(())
}

// Community cards are now revealed via VRF callbacks in deal_vrf.rs.
