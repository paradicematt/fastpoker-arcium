use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;
use crate::events::PhaseChanged;
use crate::constants::*;

// Card privacy is now handled by Arcium MPC encryption (not TEE permissions).
// start_game validates seats + posts blinds. arcium_deal handles card dealing.

#[derive(Accounts)]
pub struct StartGame<'info> {
    /// CHECK: Permissionless - anyone/scheduler can start when ready
    pub initiator: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
        constraint = table.phase == GamePhase::Waiting @ PokerError::InvalidActionForPhase,
    )]
    pub table: Account<'info, Table>,

    /// CHECK: DeckState PDA — must be writable.
    /// Required so arcium_deal can write encrypted card data after MPC callback.
    #[account(
        mut,
        seeds = [DECK_STATE_SEED, table.key().as_ref()],
        bump,
    )]
    pub deck_state: AccountInfo<'info>,
}

fn validate_remaining_seat_accounts(
    table_key: &Pubkey,
    max_players: u8,
    accounts: &[AccountInfo],
    _expected_mask: u16, // Accept any valid seats for self-heal
) -> Result<u16> {
    let mut seen_mask: u16 = 0;
    let seat_num_offset: usize = 226;

    for seat_info in accounts.iter() {
        // Stop at first non-seat account (CrankTallyER, TipJar, etc.)
        // Seats are owned by this program and have PlayerSeat::SIZE
        if seat_info.owner != &crate::ID {
            break;
        }
        let data = seat_info.try_borrow_data()?;
        if data.len() < PlayerSeat::SIZE {
            break; // Not a seat account (CrankTally=197, TipJar=67, Seat=256+)
        }

        require!(seat_info.is_writable, PokerError::InvalidAccountData);

        let seat_num = data[seat_num_offset];
        require!(seat_num < max_players, PokerError::InvalidAccountData);

        let (expected_seat_pda, _) = Pubkey::find_program_address(
            &[SEAT_SEED, table_key.as_ref(), &[seat_num]],
            &crate::ID,
        );
        require_keys_eq!(seat_info.key(), expected_seat_pda, PokerError::SeatNotAtTable);

        let bit = 1u16 << seat_num;
        require!((seen_mask & bit) == 0, PokerError::InvalidAccountCount);
        seen_mask |= bit;
    }

    Ok(seen_mask)
}

pub fn handler(ctx: Context<StartGame>) -> Result<()> {
    let table = &mut ctx.accounts.table;
    let table_key = table.key();
    let clock = Clock::get()?;

    // remaining_accounts: [seats..., ?crank_tally_er, ?tip_jar] — occupied seats + optional dealer PDAs.
    // NO seatCards (crank must never reference them — see design doc above).
    // Existence guaranteed by init_table_seat + delegation.
    // Extra accounts (CrankTallyER, TipJar) are safely skipped by seat loops
    // because their account size (197, 67) is < seat_num_offset (226).
    let stored_mask = table.seats_occupied;
    let is_sng = table.is_sit_and_go();
    // Accept any valid seats (0xFFFF) for self-heal — don't require exact match.
    // The crank sends all seats it knows about; we rebuild the real mask from on-chain data.
    let provided_mask = validate_remaining_seat_accounts(
        &table_key,
        table.max_players,
        ctx.remaining_accounts,
        0xFFFF,
    )?;
    // Self-heal: rebuild seats_occupied from actual seat data.
    // Fixes drift from settle/leave/clear_leaving_seat race conditions.
    if provided_mask != stored_mask {
        msg!("seats_occupied drift: stored=0b{:06b} -> actual=0b{:06b}", stored_mask, provided_mask);
        table.seats_occupied = provided_mask;
    }
    let recalc = provided_mask.count_ones() as u8;
    if table.current_players != recalc {
        msg!("current_players drift: {} -> {} (from seats_occupied)", table.current_players, recalc);
        table.current_players = recalc;
    }

    // Start requirements differ by mode:
    // - Cash: 2+ players can start
    // - Sit & Go: first hand of each tournament must start full.
    //   Use tournament_start_slot (reset to 0 by reset_sng_table) as the marker,
    //   not hand_number, which may be carried across table reuse.
    if table.is_sit_and_go() {
        if table.tournament_start_slot == 0 {
            require!(
                table.current_players == table.max_players,
                PokerError::NotEnoughPlayers
            );
        }
    } else {
        require!(table.current_players >= 2, PokerError::NotEnoughPlayers);
    }

    // Byte offsets in PlayerSeat account data
    let chips_offset: usize = 8 + 32 + 32 + 32; // 104
    let seat_num_offset: usize = 226; // seat.seat_number

    // For Sit & Go: Check if any player has 0 chips (game over)
    // This is checked via remaining_accounts which should contain seat PDAs
    if table.is_sit_and_go() && ctx.remaining_accounts.len() >= 2 {
        let mut players_with_chips = 0u8;
        let mut winner_seat: Option<u8> = None;
        let mut zero_chip_seats: Vec<u8> = Vec::new();
        
        for seat_info in ctx.remaining_accounts.iter() {
            if let Ok(data) = seat_info.try_borrow_data() {
                let status_off = 227usize;
                if data.len() > seat_num_offset {
                    let seat_num = data[seat_num_offset];
                    let status = data[status_off];
                    if status != 0 && status != 5 && status != 6 { // Not Empty, not Busted, not Leaving (A7)
                        if chips_offset + 8 <= data.len() {
                            let chips = u64::from_le_bytes(
                                data[chips_offset..chips_offset + 8].try_into().unwrap_or([0; 8])
                            );
                            if chips > 0 {
                                players_with_chips += 1;
                                winner_seat = Some(seat_num);
                            } else {
                                zero_chip_seats.push(seat_num);
                            }
                        }
                    }
                }
            }
        }
        
        // Bust any 0-chip players (set status to Busted, update bitmasks)
        for seat_info in ctx.remaining_accounts.iter() {
            if let Ok(mut data) = seat_info.try_borrow_mut_data() {
                if data.len() > seat_num_offset && chips_offset + 8 <= data.len() {
                    let seat_num = data[seat_num_offset];
                    let status = data[227];
                    if status != 0 && status != 5 { // Not Empty, not already Busted
                        let chips = u64::from_le_bytes(
                            data[chips_offset..chips_offset + 8].try_into().unwrap_or([0; 8])
                        );
                        if chips == 0 {
                            data[227] = 5; // SeatStatus::Busted
                            table.seats_folded |= 1 << seat_num;
                            table.seats_occupied &= !(1 << seat_num);
                            table.current_players = table.current_players.saturating_sub(1);
                            msg!("Seat {} busted (0 chips) - eliminated", seat_num);
                        }
                    }
                }
            }
        }

        // If only 1 player has chips, game is over - don't start new hand.
        // This check now runs AFTER bust reconciliation so state reflects eliminations.
        if players_with_chips <= 1 {
            table.phase = GamePhase::Complete;
            msg!(
                "Sit & Go complete after bust reconciliation! Winner: seat {} (zero-chip seats busted: {:?})",
                winner_seat.unwrap_or(0),
                zero_chip_seats
            );
            return Ok(());
        }
    }

    // NOTE: Auto-activate waiting_for_bb was deliberately removed (TEE OPEN-4).
    // It let timed-out players bypass missed blind charges on sit-in.
    // Players must use sit_in instruction to properly post missed blinds.
    let status_offset: usize = 227;
    let is_cash = table.game_type == GameType::CashGame;

    // === Cash game: increment sit-out counters for SittingOut players ===
    // deal_vrf only receives seat_cards PDAs (not seat PDAs), so it can't track this.
    // We do it here in start_game which has all seat PDAs as remaining_accounts.
    let sit_out_count_offset: usize = 240; // sit_out_button_count
    let hands_since_bust_offset: usize = 241; // hands_since_bust
    
    if is_cash && !ctx.remaining_accounts.is_empty() {
        for seat_info in ctx.remaining_accounts.iter() {
            if let Ok(mut data) = seat_info.try_borrow_mut_data() {
                if data.len() > hands_since_bust_offset {
                    let status = data[status_offset];
                    let sn = data[seat_num_offset];
                    // SittingOut (4) → increment sit_out_button_count
                    if status == 4 {
                        let count = data[sit_out_count_offset];
                        if count < 255 {
                            data[sit_out_count_offset] = count + 1;
                            msg!("Seat {} sit-out count: {}", sn, count + 1);
                        }
                        // Also track hands since bust (0 chips while sitting out)
                        if chips_offset + 8 <= data.len() {
                            let chips = u64::from_le_bytes(
                                data[chips_offset..chips_offset + 8].try_into().unwrap_or([0; 8])
                            );
                            if chips == 0 {
                                let bust = data[hands_since_bust_offset];
                                if bust < 255 {
                                    data[hands_since_bust_offset] = bust + 1;
                                    msg!("Seat {} bust count: {}", sn, bust + 1);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // === Time Bank: regen + reset for active players ===
    // Active players get +5s time bank per hand (capped at 60s).
    // time_bank_active is reset to false so they can use it again next action.
    let time_bank_offset: usize = 278; // time_bank_seconds (u16 LE)
    let time_bank_active_offset: usize = 280; // time_bank_active (bool)
    if is_cash && !ctx.remaining_accounts.is_empty() {
        for seat_info in ctx.remaining_accounts.iter() {
            if let Ok(mut data) = seat_info.try_borrow_mut_data() {
                if data.len() > time_bank_active_offset {
                    let status = data[status_offset];
                    // Only regen for Active (1) or AllIn (3) players
                    if status == 1 || status == 3 {
                        let current = u16::from_le_bytes(
                            data[time_bank_offset..time_bank_offset + 2].try_into().unwrap_or([0; 2])
                        );
                        let new_val = current.saturating_add(TIME_BANK_REGEN_SECONDS).min(TIME_BANK_MAX_SECONDS);
                        data[time_bank_offset..time_bank_offset + 2].copy_from_slice(&new_val.to_le_bytes());
                        data[time_bank_active_offset] = 0; // Reset active flag
                    }
                }
            }
        }
    }

    // === A3 fix: Auto-sitout 0-chip Active/AllIn players in cash games ===
    // Without this, a busted player stays Active → gets dealt in → posts 0 blind → degenerate hand.
    // Also catches AllIn players who busted — they should not stay in AllIn state with 0 chips.
    // SNG has its own bust reconciliation above; cash games need this separate check.
    if is_cash && !ctx.remaining_accounts.is_empty() {
        let sit_out_ts_offset: usize = 242; // sit_out_timestamp (i64, 8 bytes)
        for seat_info in ctx.remaining_accounts.iter() {
            if let Ok(mut data) = seat_info.try_borrow_mut_data() {
                if data.len() > status_offset && chips_offset + 8 <= data.len() {
                    let status = data[status_offset];
                    // Active (1) or AllIn (3) with 0 chips → force SittingOut
                    if status == 1 || status == 3 {
                        let chips = u64::from_le_bytes(
                            data[chips_offset..chips_offset + 8].try_into().unwrap_or([0; 8])
                        );
                        if chips == 0 {
                            let sn = data[seat_num_offset];
                            data[status_offset] = 4; // SittingOut
                            // Set sit_out_timestamp for crank kick timer
                            if sit_out_ts_offset + 8 <= data.len() {
                                let ts = clock.unix_timestamp.to_le_bytes();
                                data[sit_out_ts_offset..sit_out_ts_offset + 8].copy_from_slice(&ts);
                            }
                            // A6: mark missed SB so sit_in charges dead SB on return.
                            // missed_bb is set by OPEN-2 when natural BB passes this seat.
                            let missed_sb_off: usize = 236;
                            if data.len() > missed_sb_off {
                                data[missed_sb_off] = 1;
                            }
                            msg!("A3: Seat {} auto-sat-out (0 chips, was status {}, cash game)", sn, status);
                        }
                    }
                }
            }
        }
    }

    // === Leaving players are handled by settle_hand (snapshot + removal). ===
    // start_game just excludes them from active_mask below.
    // If a player left during Waiting phase, player_action already did the
    // immediate snapshot and removal. No duplicate processing needed here.

    // === Build active_mask using actual seat_number from each remaining_account ===
    // Cash games may have sparse seats (e.g. seats 0,3 in a 6-max).
    // We read seat_number (offset 226) from each account instead of using enumerate index.
    
    let active_mask = if !ctx.remaining_accounts.is_empty() {
        let mut mask = 0u16;
        for seat_info in ctx.remaining_accounts.iter() {
            if let Ok(data) = seat_info.try_borrow_data() {
                if data.len() > seat_num_offset {
                    let seat_num = data[seat_num_offset];
                    let status = data[status_offset];
                    if is_cash {
                        // Cash: 1=Active, 3=AllIn — include; 4=SittingOut etc — exclude
                        if status == 1 || status == 3 {
                            mask |= 1 << seat_num;
                        }
                    } else {
                        // SNG: all non-empty, non-busted seats are active
                        if status != 0 && status != 5 {
                            mask |= 1 << seat_num;
                        }
                    }
                }
            }
        }
        mask
    } else {
        table.seats_occupied
    };
    
    let active_count = active_mask.count_ones() as u8;
    
    // Cash games: if < 2 active players after filtering, don't start
    if active_count < 2 {
        msg!("Not enough active players ({}) to start hand, staying in Waiting", active_count);
        // Don't change phase — stay in Waiting
        return Ok(());
    }

    // Transition to Starting phase
    table.phase = GamePhase::Starting;
    table.hand_number += 1;
    table.last_action_slot = clock.unix_timestamp as u64;
    table.action_nonce = table.action_nonce.wrapping_add(1);
    
    // For Sit & Go, set tournament start time on first hand (unix_timestamp for wall-clock accuracy on ER)
    if table.is_sit_and_go() && table.tournament_start_slot == 0 {
        table.tournament_start_slot = clock.unix_timestamp as u64;
        table.blind_level = 0;
    }
    
    // Update blinds for Sit & Go based on elapsed wall-clock time
    if table.is_sit_and_go() {
        let ts = clock.unix_timestamp as u64;
        let (sb, bb) = table.get_sng_blinds(ts);
        table.small_blind = sb;
        table.big_blind = bb;
        table.blind_level = table.calculate_sng_blind_level(ts);
    }
    
    // Reset community cards and bitmasks for new hand
    table.community_cards = [255; 5];
    table.pot = 0;
    table.min_bet = 0;
    table.seats_folded = 0;
    table.seats_allin = 0;
    table.actions_this_round = 0;
    
    // Set blind positions using active_mask (excludes SittingOut for cash games)
    let dealer_button = table.dealer_button;
    let (sb_seat, bb_seat) = if active_count == 2 {
        // Heads-up: dealer is SB
        // In HU, if dealer is not in active_mask, find first active seat for SB
        let sb = if (active_mask & (1 << dealer_button)) != 0 {
            dealer_button
        } else {
            table.next_seat_in_mask(dealer_button, active_mask).unwrap_or(dealer_button)
        };
        let bb = table.next_seat_in_mask(sb, active_mask).unwrap_or(sb);
        (sb, bb)
    } else {
        // Multi-way: SB left of dealer, BB left of SB
        let sb = table.next_seat_in_mask(dealer_button, active_mask).unwrap_or(0);
        let bb = table.next_seat_in_mask(sb, active_mask).unwrap_or(0);
        (sb, bb)
    };
    table.small_blind_seat = sb_seat;
    table.big_blind_seat = bb_seat;
    
    msg!("Blind positions set (active_mask={:#06x}): SB={}, BB={}", active_mask, sb_seat, bb_seat);

    // === OPEN-2 fix: Mark missed blinds for SittingOut players ===
    // Find natural blind positions using ALL occupied seats (not just active).
    // If a SittingOut player is at the natural SB/BB position, mark them as missed.
    if is_cash && !ctx.remaining_accounts.is_empty() {
        let natural_sb = table.next_seat_in_mask(dealer_button, table.seats_occupied)
            .unwrap_or(sb_seat);
        let natural_bb = table.next_seat_in_mask(natural_sb, table.seats_occupied)
            .unwrap_or(bb_seat);

        let missed_sb_off: usize = 236;
        let missed_bb_off: usize = 237;

        for seat_info in ctx.remaining_accounts.iter() {
            if let Ok(mut data) = seat_info.try_borrow_mut_data() {
                if data.len() > missed_bb_off {
                    let sn = data[seat_num_offset];
                    let status = data[status_offset];
                    if status == 4 { // SittingOut
                        if sn == natural_sb {
                            data[missed_sb_off] = 1;
                            msg!("Seat {} missed SB (sitting out)", sn);
                        }
                        if sn == natural_bb {
                            data[missed_bb_off] = 1;
                            msg!("Seat {} missed BB (sitting out)", sn);
                        }
                    }
                }
            }
        }
    }

    // === Vault reserve → chips conversion (mid-hand top-up safety net) ===
    // If a player deposited via rebuy during a hand, funds went to vault_reserve.
    // Convert all pending reserves to chips now, respecting max buy-in.
    if is_cash && !ctx.remaining_accounts.is_empty() {
        let vault_reserve_offset: usize = 262;
        let (_, max_bb): (u64, u64) = if table.buy_in_type == 1 { (50, 250) } else { (20, 100) };
        let max_buy_in = table.big_blind.saturating_mul(max_bb);

        for seat_info in ctx.remaining_accounts.iter() {
            if let Ok(mut data) = seat_info.try_borrow_mut_data() {
                if data.len() >= vault_reserve_offset + 8 && data.len() > status_offset {
                    let status = data[status_offset];
                    // Active(1), SittingOut(4) — convert reserve to chips
                    if status == 1 || status == 4 {
                        let reserve = u64::from_le_bytes(
                            data[vault_reserve_offset..vault_reserve_offset + 8].try_into().unwrap_or([0; 8])
                        );
                        if reserve > 0 {
                            let chips = u64::from_le_bytes(
                                data[chips_offset..chips_offset + 8].try_into().unwrap_or([0; 8])
                            );
                            let room = max_buy_in.saturating_sub(chips);
                            let to_chips = reserve.min(room);
                            let remaining = reserve - to_chips;
                            let new_chips = chips + to_chips;

                            data[chips_offset..chips_offset + 8].copy_from_slice(&new_chips.to_le_bytes());
                            data[vault_reserve_offset..vault_reserve_offset + 8].copy_from_slice(&remaining.to_le_bytes());

                            let sn = data[seat_num_offset];
                            msg!("Vault reserve convert: seat {} reserve={} -> chips +{} (now {}), leftover={}",
                                sn, reserve, to_chips, new_chips, remaining);

                            // Auto-activate SittingOut player who now has chips
                            if status == 4 && new_chips > 0 && chips == 0 {
                                data[status_offset] = 1; // Active
                                // Set waiting_for_bb (offset 239)
                                if data.len() > 239 {
                                    data[239] = 1;
                                }
                                table.seats_occupied |= 1 << sn;
                                msg!("Auto-activated seat {} after vault_reserve conversion", sn);
                            }
                        }
                    }
                }
            }
        }
    }

    // === POST BLINDS from remaining_accounts ===
    // Find correct remaining_account by seat_number (not by index — seats may be sparse)
    if !ctx.remaining_accounts.is_empty() {
        let small_blind = table.small_blind;
        let big_blind = table.big_blind;
        let bet_offset = chips_offset + 8; // 112
        
        // Helper: find remaining_account index whose seat_number matches target
        let find_seat = |target: u8| -> Option<usize> {
            for (idx, info) in ctx.remaining_accounts.iter().enumerate() {
                if let Ok(d) = info.try_borrow_data() {
                    if d.len() > seat_num_offset && d[seat_num_offset] == target {
                        return Some(idx);
                    }
                }
            }
            None
        };
        
        // GI-008 fix: posted_blind offset (238) — if sit_in_handler already charged,
        // don't deduct chips again. Just add the pre-charged amount to pot.
        let posted_blind_offset: usize = 238;
        let total_bet_offset = bet_offset + 8; // 120

        // Post SB
        if let Some(sb_idx) = find_seat(sb_seat) {
            let seat_info = &ctx.remaining_accounts[sb_idx];
            if let Ok(mut data) = seat_info.try_borrow_mut_data() {
                if chips_offset + 8 <= data.len() && bet_offset + 8 <= data.len() {
                    let already_posted = posted_blind_offset < data.len() && data[posted_blind_offset] == 1;
                    if already_posted {
                        // sit_in_handler already deducted chips — just add to pot
                        let existing_bet = u64::from_le_bytes(data[bet_offset..bet_offset+8].try_into().unwrap_or([0;8]));
                        let existing_total = u64::from_le_bytes(data[total_bet_offset..total_bet_offset+8].try_into().unwrap_or([0;8]));
                        table.pot += existing_total; // full amount (live + dead) goes to pot
                        if existing_bet > table.min_bet { table.min_bet = existing_bet; }
                        data[posted_blind_offset] = 0; // clear flag
                        let current_chips = u64::from_le_bytes(data[chips_offset..chips_offset+8].try_into().unwrap_or([0;8]));
                        if current_chips == 0 && existing_total > 0 && status_offset < data.len() {
                            data[status_offset] = 3; // AllIn
                            table.seats_allin |= 1 << sb_seat;
                        }
                        msg!("SB seat {} already posted {} (live={}, chips={})", sb_seat, existing_total, existing_bet, current_chips);
                    } else {
                        let current_chips = u64::from_le_bytes(data[chips_offset..chips_offset+8].try_into().unwrap_or([0;8]));
                        let actual_sb = current_chips.min(small_blind);
                        let new_chips = current_chips.saturating_sub(actual_sb);
                        
                        data[chips_offset..chips_offset+8].copy_from_slice(&new_chips.to_le_bytes());
                        data[bet_offset..bet_offset+8].copy_from_slice(&actual_sb.to_le_bytes());
                        data[total_bet_offset..total_bet_offset+8].copy_from_slice(&actual_sb.to_le_bytes());
                        table.pot += actual_sb;
                        
                        if actual_sb > table.min_bet { table.min_bet = actual_sb; }
                        if new_chips == 0 && actual_sb > 0 && status_offset < data.len() {
                            data[status_offset] = 3; // AllIn
                            table.seats_allin |= 1 << sb_seat;
                        }
                        msg!("SB seat {} posts {} (chips: {} -> {})", sb_seat, actual_sb, current_chips, new_chips);
                    }
                }
            }
        }
        
        // Post BB
        if let Some(bb_idx) = find_seat(bb_seat) {
            let seat_info = &ctx.remaining_accounts[bb_idx];
            if let Ok(mut data) = seat_info.try_borrow_mut_data() {
                if chips_offset + 8 <= data.len() && bet_offset + 8 <= data.len() {
                    let already_posted = posted_blind_offset < data.len() && data[posted_blind_offset] == 1;
                    if already_posted {
                        let existing_bet = u64::from_le_bytes(data[bet_offset..bet_offset+8].try_into().unwrap_or([0;8]));
                        let existing_total = u64::from_le_bytes(data[total_bet_offset..total_bet_offset+8].try_into().unwrap_or([0;8]));
                        table.pot += existing_total;
                        if existing_bet > table.min_bet { table.min_bet = existing_bet; }
                        data[posted_blind_offset] = 0;
                        let current_chips = u64::from_le_bytes(data[chips_offset..chips_offset+8].try_into().unwrap_or([0;8]));
                        if current_chips == 0 && existing_total > 0 && status_offset < data.len() {
                            data[status_offset] = 3; // AllIn
                            table.seats_allin |= 1 << bb_seat;
                        }
                        msg!("BB seat {} already posted {} (live={}, chips={})", bb_seat, existing_total, existing_bet, current_chips);
                    } else {
                        let current_chips = u64::from_le_bytes(data[chips_offset..chips_offset+8].try_into().unwrap_or([0;8]));
                        let actual_bb = current_chips.min(big_blind);
                        let new_chips = current_chips.saturating_sub(actual_bb);
                        
                        data[chips_offset..chips_offset+8].copy_from_slice(&new_chips.to_le_bytes());
                        data[bet_offset..bet_offset+8].copy_from_slice(&actual_bb.to_le_bytes());
                        data[total_bet_offset..total_bet_offset+8].copy_from_slice(&actual_bb.to_le_bytes());
                        table.pot += actual_bb;
                        if actual_bb > table.min_bet { table.min_bet = actual_bb; }
                        
                        if new_chips == 0 && actual_bb > 0 && status_offset < data.len() {
                            data[status_offset] = 3; // AllIn
                            table.seats_allin |= 1 << bb_seat;
                        }
                        msg!("BB seat {} posts {} (chips: {} -> {})", bb_seat, actual_bb, current_chips, new_chips);
                    }
                }
            }
        }
        
        // Mark SittingOut seats as folded for this hand so they're excluded from deal/settle
        if is_cash {
            for seat_info in ctx.remaining_accounts.iter() {
                if let Ok(data) = seat_info.try_borrow_data() {
                    if data.len() > seat_num_offset {
                        let sn = data[seat_num_offset] as u16;
                        if sn < 16 && (active_mask & (1 << sn)) == 0 && (table.seats_occupied & (1 << sn)) != 0 {
                            table.seats_folded |= 1 << sn;
                            msg!("Seat {} sitting out, marked folded for this hand", sn);
                        }
                    }
                }
            }
        }
        
        msg!("Blinds posted: pot = {}", table.pot);
    }

    emit!(PhaseChanged {
        table: table.key(),
        hand_number: table.hand_number,
        new_phase: table.phase,
    });

    // === Dealer Service: record action + deduct tip ===
    // Optional CrankTallyER and TipJar may be appended after seat accounts.
    // Validated by PDA seeds — if wrong accounts are passed, they're silently skipped.
    let extra_start = provided_mask.count_ones() as usize;
    let extras = &ctx.remaining_accounts[extra_start..];
    let caller_key = ctx.accounts.initiator.key();

    for extra in extras.iter() {
        // Check if this is CrankTallyER
        let (expected_tally, _) = Pubkey::find_program_address(
            &[CRANK_TALLY_ER_SEED, table_key.as_ref()],
            &crate::ID,
        );
        if extra.key() == expected_tally && extra.owner == &crate::ID && extra.is_writable {
            if let Ok(mut data) = extra.try_borrow_mut_data() {
                if data.len() >= CrankTally::SIZE {
                    // Find or register operator, increment action count
                    // Operators at offset 40, action_counts at 40 + 128 = 168
                    let mut recorded = false;
                    for i in 0..MAX_CRANK_OPERATORS {
                        let pk_start = 40 + (i * 32);
                        let count_start = 168 + (i * 4);
                        let pk = Pubkey::try_from(&data[pk_start..pk_start + 32]).unwrap_or_default();
                        if pk == caller_key {
                            let count = u32::from_le_bytes(data[count_start..count_start + 4].try_into().unwrap_or([0; 4]));
                            data[count_start..count_start + 4].copy_from_slice(&(count.saturating_add(1)).to_le_bytes());
                            recorded = true;
                            break;
                        }
                        if pk == Pubkey::default() {
                            data[pk_start..pk_start + 32].copy_from_slice(caller_key.as_ref());
                            data[count_start..count_start + 4].copy_from_slice(&1u32.to_le_bytes());
                            recorded = true;
                            break;
                        }
                    }
                    // Increment total_actions at offset 168 + 16 = 184
                    if recorded || true {
                        let ta_off = 184;
                        let ta = u32::from_le_bytes(data[ta_off..ta_off + 4].try_into().unwrap_or([0; 4]));
                        data[ta_off..ta_off + 4].copy_from_slice(&(ta.saturating_add(1)).to_le_bytes());
                    }
                    // Update last_hand at offset 188
                    let lh_off = 188;
                    data[lh_off..lh_off + 8].copy_from_slice(&table.hand_number.to_le_bytes());
                    msg!("Dealer {} recorded action (hand #{})", caller_key, table.hand_number);
                }
            }
            continue;
        }

        // NOTE: TipJar is NOT delegated (stays on L1 for deposit_tip writes).
        // Tip payouts happen on L1 via distribute_crank_rewards.
    }

    msg!("Game started! Hand #{} ready for dealing", table.hand_number);
    Ok(())
}
