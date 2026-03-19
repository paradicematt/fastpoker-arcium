use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;
use crate::events::HandSettled;
use crate::constants::*;
use crate::side_pots::{PlayerContribution, calculate_side_pots, distribute_pots, determine_pot_winners};
use crate::hand_eval::{EvaluatedHand, evaluate_hand, CARD_NOT_DEALT};

#[derive(Accounts)]
pub struct SettleHand<'info> {
    /// CHECK: Permissionless - anyone/scheduler can trigger settle
    pub settler: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
        constraint = table.phase == GamePhase::Showdown @ PokerError::InvalidActionForPhase,
    )]
    pub table: Account<'info, Table>,

    /// DeckState PDA — reset used-card mask at end of hand
    #[account(
        mut,
        seeds = [DECK_STATE_SEED, table.key().as_ref()],
        bump = deck_state.bump,
        constraint = deck_state.table == table.key() @ PokerError::InvalidAccountData,
    )]
    pub deck_state: Box<Account<'info, DeckState>>,
    // Remaining accounts layout:
    // [seat0, seat1, ..., seatN, seat_cards0, seat_cards1, ..., seat_cardsN]
    // First half = seat PDAs (for chip balances, bets, status)
    // Second half = seat_cards PDAs (for hole cards - to compute hands ON-CHAIN)
}

#[allow(dead_code)]
fn only_one_player_remaining(seats: &[AccountInfo]) -> bool {
    // Check if only one player hasn't folded
    let mut active_count = 0;
    for seat_info in seats {
        if let Ok(data) = seat_info.try_borrow_data() {
            // Check status byte (simplified offset check)
            if data.len() > 8 + 32 + 32 + 32 + 8 + 8 + 8 + 64 + 32 + 2 {
                let status_offset = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 64 + 32 + 2 + 1;
                if status_offset < data.len() {
                    let status = data[status_offset];
                    // SeatStatus::Active = 1, SeatStatus::AllIn = 3
                    if status == 1 || status == 3 {
                        active_count += 1;
                    }
                }
            }
        }
    }
    active_count == 1
}

/// Settle hand - FULLY ON-CHAIN
/// No external hand scores needed - reads seat_cards and computes winners on-chain
pub fn handler(
    ctx: Context<SettleHand>,
) -> Result<()> {
    let table = &mut ctx.accounts.table;
    let clock = Clock::get()?;
    
    // remaining_accounts layout: [seats..., seat_cards..., ?crank_tally_er]
    // For cash games with sparse seats, only occupied seats are provided.
    // Optional CrankTallyER may be appended (makes len odd).
    let all_accounts = &ctx.remaining_accounts;

    // Allow even (seats+seat_cards) or odd (seats+seat_cards+tally)
    let has_tally_extra = all_accounts.len() % 2 == 1;
    let pair_count = if has_tally_extra { all_accounts.len() - 1 } else { all_accounts.len() };
    require!(
        pair_count >= 2 && pair_count % 2 == 0,
        PokerError::InvalidAccountData
    );

    let num_seats = pair_count / 2;
    let seats = &all_accounts[..num_seats];
    let seat_cards_accounts = &all_accounts[num_seats..num_seats * 2];

    // SeatCards data offsets: discriminator(8) + table(32) + seat_index(1) + player(32) + card1(1) + card2(1)
    const SEAT_CARDS_CARD1_OFFSET: usize = 8 + 32 + 1 + 32;  // 73
    const SEAT_CARDS_CARD2_OFFSET: usize = SEAT_CARDS_CARD1_OFFSET + 1;  // 74

    // Seat data offsets
    const CHIPS_OFFSET: usize = 8 + 32 + 32 + 32;  // 104
    const TOTAL_BET_OFFSET: usize = CHIPS_OFFSET + 8 + 8;  // 120
    const STATUS_OFFSET: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 64 + 32 + 2 + 1;  // 227
    const SEAT_NUM_OFFSET: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 64 + 32 + 2; // 226

    // === STEP 1: Read player contributions from seat accounts ===
    let mut contributions: Vec<PlayerContribution> = Vec::new();
    // Map real seat_number (0..8) -> account pair index in [seats..., seat_cards...]
    let mut seat_num_to_account_index: [u8; 9] = [255; 9];
    
    let table_key = table.key();
    for (pair_idx, seat_info) in seats.iter().enumerate() {
        let data = seat_info.try_borrow_data()?;
        if data.len() < STATUS_OFFSET + 1 || data.len() <= SEAT_NUM_OFFSET {
            continue;
        }
        let seat_num = data[SEAT_NUM_OFFSET];
        require!(seat_num < table.max_players, PokerError::InvalidAccountData);
        require!((seat_num as usize) < seat_num_to_account_index.len(), PokerError::InvalidAccountData);
        require!(
            seat_num_to_account_index[seat_num as usize] == 255,
            PokerError::InvalidAccountData
        );
        // PDA derivation check: verify seat belongs to THIS table
        let (expected_seat, _) = Pubkey::find_program_address(
            &[SEAT_SEED, table_key.as_ref(), &[seat_num]],
            &crate::ID,
        );
        require!(seat_info.key() == expected_seat, PokerError::SeatNotAtTable);
        // PDA derivation check: verify matching seatCards belongs to THIS table
        if pair_idx < seat_cards_accounts.len() {
            let (expected_sc, _) = Pubkey::find_program_address(
                &[SEAT_CARDS_SEED, table_key.as_ref(), &[seat_num]],
                &crate::ID,
            );
            require!(
                seat_cards_accounts[pair_idx].key() == expected_sc,
                PokerError::InvalidSeatCardsAccount
            );
        }
        seat_num_to_account_index[seat_num as usize] = pair_idx as u8;
        
        let status = data[STATUS_OFFSET];
        // 0=Empty, 1=Active, 2=Folded, 3=AllIn, 4=SittingOut, 5=Busted, 6=Leaving
        if status == 0 {
            continue;  // Skip only truly empty seats
        }
        
        let total_bet = if TOTAL_BET_OFFSET + 8 <= data.len() {
            u64::from_le_bytes(data[TOTAL_BET_OFFSET..TOTAL_BET_OFFSET + 8].try_into().unwrap_or([0; 8]))
        } else {
            0
        };

        // Busted players (status=5) are treated as folded — their bet is dead money
        // in the pot that other players can win. This handles the case where
        // handle_timeout busts a player mid-hand via 3-auto-fold elimination.
        contributions.push(PlayerContribution {
            seat_index: seat_num,
            total_bet,
            is_all_in: status == 3,
            // Leaving (6) is only folded if they're in the seats_folded bitmask.
            // All-in players who called LeaveCashGame stay pot-eligible.
            is_folded: status == 2 || status == 4 || status == 5
                || (status == 6 && (table.seats_folded & (1u16 << seat_num)) != 0), // Leaving+folded = dead money; Leaving+allin = pot-eligible
        });
    }
    
    msg!("Contributions: {:?}", contributions.iter().map(|c| (c.seat_index, c.total_bet, c.is_folded)).collect::<Vec<_>>());

    // === STEP 2: Calculate side pots ON-CHAIN ===
    let pots = calculate_side_pots(&contributions);
    
    msg!("Calculated {} pots on-chain", pots.len());
    for (i, (amount, eligible)) in pots.iter().enumerate() {
        msg!("  Pot {}: {} chips, eligible seats: {:?}", i, amount, eligible);
    }

    // === HANDLE POT=0 OR ALL-FOLDED CASE ===
    let total_pot = table.pot;
    if total_pot == 0 || pots.is_empty() {
        // FIX: When pots is empty but pot > 0, ALL players folded (sit-out + leave
        // in same hand). Refund each player's total_bet_this_hand back to their chips
        // so blind bets don't evaporate. Without this, SB+BB chips are permanently lost.
        if total_pot > 0 && pots.is_empty() {
            msg!("All players folded — refunding pot ({}) to contributors", total_pot);
            let mut total_refunded: u64 = 0;
            for seat_info in seats.iter() {
                let mut seat_data = seat_info.try_borrow_mut_data()?;
                if seat_data.len() < STATUS_OFFSET + 1 { continue; }
                let status = seat_data[STATUS_OFFSET];
                if status == 0 { continue; } // skip empty
                let total_bet = u64::from_le_bytes(
                    seat_data[TOTAL_BET_OFFSET..TOTAL_BET_OFFSET + 8].try_into().unwrap_or([0; 8])
                );
                if total_bet > 0 {
                    let chips = u64::from_le_bytes(
                        seat_data[CHIPS_OFFSET..CHIPS_OFFSET + 8].try_into().unwrap_or([0; 8])
                    );
                    let new_chips = chips.saturating_add(total_bet);
                    seat_data[CHIPS_OFFSET..CHIPS_OFFSET + 8].copy_from_slice(&new_chips.to_le_bytes());
                    total_refunded += total_bet;
                    let sn = if seat_data.len() > SEAT_NUM_OFFSET { seat_data[SEAT_NUM_OFFSET] } else { 255 };
                    msg!("  Refunded {} to seat {} ({} -> {})", total_bet, sn, chips, new_chips);
                }
            }
            msg!("Total refunded: {} (pot was {})", total_refunded, total_pot);
        } else {
            msg!("Pot is 0, resetting phase only (no distribution)");
        }

        // Skip distribution, just reset table state
        let rake = 0u64;
        let winnings: Vec<(u8, u64)> = Vec::new();
        let winner_pubkeys: Vec<Pubkey> = Vec::new();
        let winner_amounts: Vec<u64> = Vec::new();

        // Jump to reset logic (duplicated below for clarity)
        table.rake_accumulated = table.rake_accumulated.saturating_add(rake);
        table.pot = 0;
        table.min_bet = 0;
        table.community_cards = [CARD_NOT_DEALT; 5];
        table.revealed_hands = [255; 18];
        table.hand_results = [0; 9];
        table.pre_community = [255; 5];
        table.deck_seed = [0; 32];
        table.deck_index = 0;
        // Reset DeckState for next hand (clears all encrypted card data)
        let deck_state = &mut ctx.accounts.deck_state;
        deck_state.reset_for_new_hand();
        table.flop_reached = false;
        table.seats_folded = 0;
        table.seats_allin = 0;
        table.phase = GamePhase::Waiting;
        table.last_action_slot = clock.unix_timestamp as u64;
        table.rotate_button();

        // Reset seats
        for seat_info in seats.iter() {
            let mut seat_data = seat_info.try_borrow_mut_data()?;
            if seat_data.len() > 8 {
                let bet_offset = 8 + 32 + 32 + 32 + 8;
                if bet_offset + 8 <= seat_data.len() {
                    seat_data[bet_offset..bet_offset + 8].copy_from_slice(&0u64.to_le_bytes());
                }
                let total_bet_offset = bet_offset + 8;
                if total_bet_offset + 8 <= seat_data.len() {
                    seat_data[total_bet_offset..total_bet_offset + 8].copy_from_slice(&0u64.to_le_bytes());
                }
                let hole_offset = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 64 + 32;
                if hole_offset + 2 <= seat_data.len() {
                    seat_data[hole_offset..hole_offset + 2].copy_from_slice(&[CARD_NOT_DEALT, CARD_NOT_DEALT]);
                }
                let status_offset = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 64 + 32 + 2 + 1;
                if status_offset < seat_data.len() {
                    let current_status = seat_data[status_offset];

                    // Handle Leaving players even in pot=0 path
                    const CO_CHIPS: usize = 246;
                    const CO_NONCE: usize = 254;
                    const V_RESERVE: usize = 262;

                    if current_status == 6 && seat_data.len() >= V_RESERVE + 8 {
                        const CHIPS_OFF: usize = 8 + 32 + 32 + 32; // 104
                        let chips = u64::from_le_bytes(
                            seat_data[CHIPS_OFF..CHIPS_OFF + 8].try_into().unwrap_or([0; 8])
                        );
                        let vr = u64::from_le_bytes(
                            seat_data[V_RESERVE..V_RESERVE + 8].try_into().unwrap_or([0; 8])
                        );
                        let total = chips.saturating_add(vr);
                        seat_data[CO_CHIPS..CO_CHIPS + 8].copy_from_slice(&total.to_le_bytes());
                        let n = u64::from_le_bytes(
                            seat_data[CO_NONCE..CO_NONCE + 8].try_into().unwrap_or([0; 8])
                        );
                        seat_data[CO_NONCE..CO_NONCE + 8].copy_from_slice(&n.wrapping_add(1).to_le_bytes());
                        seat_data[CHIPS_OFF..CHIPS_OFF + 8].copy_from_slice(&0u64.to_le_bytes());
                        seat_data[V_RESERVE..V_RESERVE + 8].copy_from_slice(&0u64.to_le_bytes());

                        let seat_num_off: usize = 226;
                        if seat_data.len() > seat_num_off {
                            let sn = seat_data[seat_num_off];
                            table.seats_occupied &= !(1u16 << (sn as u16));
                            table.current_players = table.current_players.saturating_sub(1);
                        }
                    } else if current_status != 0 && current_status != 4 && current_status != 5 && current_status != 6 {
                        seat_data[status_offset] = 1;
                    }
                }
            }
        }

        emit!(HandSettled {
            table: table.key(),
            hand_number: table.hand_number,
            winners: winner_pubkeys,
            amounts: winner_amounts,
            rake_collected: rake,
        });
        msg!("Hand #{} settled (pot=0, phase reset)", table.hand_number);
        // Record crank action even for zero-pot settle
        let tkey = table.key();
        let hnum = table.hand_number;
        let ckey = ctx.accounts.settler.key();
        try_record_crank_action(ctx.remaining_accounts, &tkey, &ckey, hnum);
        return Ok(());
    }

    // === FOLD WIN FAST-PATH ===
    // When only 1 non-folded player remains, award pot directly without hand evaluation.
    // Real poker rules: fold winner doesn't need to show cards.
    let non_folded_count = contributions.iter().filter(|c| !c.is_folded).count();
    if non_folded_count <= 1 {
        // Find the sole non-folded player (the winner)
        let winner = contributions.iter().find(|c| !c.is_folded);

        // M4: Take rake on fold wins if flop was reached (standard poker room rules)
        let rake = if table.game_type == GameType::CashGame && table.flop_reached {
            let calculated_rake = total_pot
                .checked_mul(RAKE_PERCENT_BPS)
                .and_then(|r| r.checked_div(10000))
                .unwrap_or(0);
            if table.rake_cap > 0 { calculated_rake.min(table.rake_cap) } else { calculated_rake }
        } else {
            0
        };
        let pot_after_rake = total_pot.saturating_sub(rake);

        let mut winner_pubkeys = Vec::new();
        let mut winner_amounts = Vec::new();

        if let Some(w) = winner {
            let pair_idx = seat_num_to_account_index[w.seat_index as usize];
            if pair_idx != 255 && (pair_idx as usize) < seats.len() {
                let seat_info = &seats[pair_idx as usize];
                let mut seat_data = seat_info.try_borrow_mut_data()?;
                if CHIPS_OFFSET + 8 <= seat_data.len() {
                    let current_chips = u64::from_le_bytes(
                        seat_data[CHIPS_OFFSET..CHIPS_OFFSET + 8].try_into().unwrap_or([0; 8])
                    );
                    let new_chips = current_chips.saturating_add(pot_after_rake);
                    seat_data[CHIPS_OFFSET..CHIPS_OFFSET + 8].copy_from_slice(&new_chips.to_le_bytes());
                    msg!("Fold win: seat {} gets {} (pot={}, rake={})", w.seat_index, pot_after_rake, total_pot, rake);
                }
                if seat_data.len() >= 8 + 32 {
                    let wallet_bytes: [u8; 32] = seat_data[8..8 + 32].try_into().unwrap();
                    winner_pubkeys.push(Pubkey::new_from_array(wallet_bytes));
                    winner_amounts.push(pot_after_rake);
                }
            }
        }

        // Accumulate rake + crank pool (same logic as main showdown path)
        if rake > 0 {
            table.rake_accumulated = table.rake_accumulated.saturating_add(rake);
            if table.is_user_created {
                let creator_share = rake.checked_mul(RAKE_CREATOR_BPS).and_then(|r| r.checked_div(10000)).unwrap_or(0);
                let crank_cut = rake.checked_mul(RAKE_DEALER_BPS).and_then(|r| r.checked_div(10000)).unwrap_or(0);
                table.creator_rake_total = table.creator_rake_total.saturating_add(creator_share);
                table.crank_pool_accumulated = table.crank_pool_accumulated.saturating_add(crank_cut);
            } else {
                let crank_cut = rake.checked_mul(RAKE_DEALER_SYSTEM_BPS).and_then(|r| r.checked_div(10000)).unwrap_or(0);
                table.crank_pool_accumulated = table.crank_pool_accumulated.saturating_add(crank_cut);
            }
        }

        // Reset table for next hand
        table.pot = 0;
        table.min_bet = 0;
        table.community_cards = [CARD_NOT_DEALT; 5];
        table.revealed_hands = [255; 18];
        table.hand_results = [0; 9];
        table.pre_community = [255; 5];
        table.deck_seed = [0; 32];
        table.deck_index = 0;
        let deck_state = &mut ctx.accounts.deck_state;
        deck_state.reset_for_new_hand();
        table.flop_reached = false;
        table.seats_folded = 0;
        table.seats_allin = 0;
        table.phase = GamePhase::Waiting;
        table.last_action_slot = clock.unix_timestamp as u64;
        table.rotate_button();

        // Reset seats + handle Leaving players (cashout snapshot)
        for seat_info in seats.iter() {
            let mut seat_data = seat_info.try_borrow_mut_data()?;
            if seat_data.len() > 8 {
                let bet_offset = 8 + 32 + 32 + 32 + 8;
                if bet_offset + 8 <= seat_data.len() {
                    seat_data[bet_offset..bet_offset + 8].copy_from_slice(&0u64.to_le_bytes());
                }
                let total_bet_offset = bet_offset + 8;
                if total_bet_offset + 8 <= seat_data.len() {
                    seat_data[total_bet_offset..total_bet_offset + 8].copy_from_slice(&0u64.to_le_bytes());
                }
                let hole_offset = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 64 + 32;
                if hole_offset + 2 <= seat_data.len() {
                    seat_data[hole_offset..hole_offset + 2].copy_from_slice(&[CARD_NOT_DEALT, CARD_NOT_DEALT]);
                }
                let status_offset_local = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 64 + 32 + 2 + 1;
                if status_offset_local < seat_data.len() {
                    let current_status = seat_data[status_offset_local];

                    // H1 fix: Handle Leaving players in fold-win path (snapshot cashout)
                    const CO_CHIPS: usize = 246;
                    const CO_NONCE: usize = 254;
                    const V_RESERVE: usize = 262;
                    const CHIPS_OFF: usize = 8 + 32 + 32 + 32; // 104
                    const SEAT_NUM_OFF: usize = 226;

                    if current_status == 6 && seat_data.len() >= V_RESERVE + 8 {
                        let chips = u64::from_le_bytes(
                            seat_data[CHIPS_OFF..CHIPS_OFF + 8].try_into().unwrap_or([0; 8])
                        );
                        let vr = u64::from_le_bytes(
                            seat_data[V_RESERVE..V_RESERVE + 8].try_into().unwrap_or([0; 8])
                        );
                        let total = chips.saturating_add(vr);
                        seat_data[CO_CHIPS..CO_CHIPS + 8].copy_from_slice(&total.to_le_bytes());
                        let n = u64::from_le_bytes(
                            seat_data[CO_NONCE..CO_NONCE + 8].try_into().unwrap_or([0; 8])
                        );
                        seat_data[CO_NONCE..CO_NONCE + 8].copy_from_slice(&n.wrapping_add(1).to_le_bytes());
                        seat_data[CHIPS_OFF..CHIPS_OFF + 8].copy_from_slice(&0u64.to_le_bytes());
                        seat_data[V_RESERVE..V_RESERVE + 8].copy_from_slice(&0u64.to_le_bytes());

                        if seat_data.len() > SEAT_NUM_OFF {
                            let sn = seat_data[SEAT_NUM_OFF];
                            table.seats_occupied &= !(1u16 << (sn as u16));
                            table.current_players = table.current_players.saturating_sub(1);
                            msg!("Fold-win: Leaving seat {} snapshot: cashout={}, nonce={}", sn, total, n.wrapping_add(1));
                        }
                    } else if current_status != 0 && current_status != 4 && current_status != 5 && current_status != 6 {
                        seat_data[status_offset_local] = 1; // Active
                    }
                }
            }
        }

        emit!(HandSettled {
            table: table.key(),
            hand_number: table.hand_number,
            winners: winner_pubkeys,
            amounts: winner_amounts,
            rake_collected: rake,
        });
        msg!("Hand #{} settled (fold win, pot={})", table.hand_number, total_pot);
        let tkey = table.key();
        let hnum = table.hand_number;
        let ckey = ctx.accounts.settler.key();
        try_record_crank_action(ctx.remaining_accounts, &tkey, &ckey, hnum);
        return Ok(());
    }

    // === SAFETY CHECK: Verify community cards exist if multiple players in hand ===
    // Prevents the "everyone gets HighCard" bug when community cards fail to deal
    {
        if non_folded_count > 1 {
            // Multiple players going to showdown — community cards MUST be dealt
            // At minimum, the flop (3 cards) should exist
            let flop_dealt = table.community_cards[0] != CARD_NOT_DEALT
                && table.community_cards[1] != CARD_NOT_DEALT
                && table.community_cards[2] != CARD_NOT_DEALT;
            require!(
                flop_dealt,
                PokerError::CommunityCardsNotDealt
            );
            msg!("Safety check passed: {} non-folded players, community cards present", non_folded_count);
        }
    }

    // === STEP 3: Compute hand rankings ON-CHAIN from seat_cards ===
    // Cards stored in seat_cards accounts by tee_deal (dual-member permission)
    // Clear previous hand's revealed data so busted/skipped players don't show stale results
    table.revealed_hands = [255; 18];
    table.hand_results = [0; 9];
    
    let community = table.community_cards;
    let mut hand_rankings: Vec<(u8, EvaluatedHand)> = Vec::new();
    
    for contrib in contributions.iter() {
        if contrib.is_folded {
            continue;
        }
        
        let seat_num = contrib.seat_index;
        let si = seat_num as usize;
        // Skip folded players - they can't win
        if (seat_num as usize) >= seat_num_to_account_index.len() {
            continue;
        }
        let pair_idx_raw = seat_num_to_account_index[seat_num as usize];
        if pair_idx_raw == 255 || (pair_idx_raw as usize) >= seat_cards_accounts.len() {
            msg!("Seat {} has no seat_cards account", seat_num);
            continue;
        }
        
        // Read hole cards from seat_cards
        let sc_data = seat_cards_accounts[pair_idx_raw as usize].try_borrow_data()?;
        let card1 = if sc_data.len() > SEAT_CARDS_CARD1_OFFSET { sc_data[SEAT_CARDS_CARD1_OFFSET] } else { CARD_NOT_DEALT };
        let card2 = if sc_data.len() > SEAT_CARDS_CARD2_OFFSET { sc_data[SEAT_CARDS_CARD2_OFFSET] } else { CARD_NOT_DEALT };
        
        if card1 == CARD_NOT_DEALT || card2 == CARD_NOT_DEALT {
            msg!("Seat {} has no cards in seat_cards", seat_num);
            continue;
        }
        
        // Evaluate hand ON-CHAIN using hole cards + community cards
        let evaluated = evaluate_hand([card1, card2], community);
        msg!("Seat {} hand: {:?}", seat_num, evaluated.rank);
        
        // === SHOWDOWN REVEAL: Write hole cards to public table field ===
        // Only reveal when 2+ non-folded players (actual showdown).
        // For fold wins (1 non-folded), winner doesn't need to show — real poker rules.
        if (seat_num as usize) < 9 && non_folded_count > 1 {
            table.revealed_hands[(seat_num as usize) * 2] = card1;
            table.revealed_hands[(seat_num as usize) * 2 + 1] = card2;
            table.hand_results[seat_num as usize] = evaluated.rank as u8;
        }
        
        hand_rankings.push((seat_num, evaluated));
    }
    
    msg!("Evaluated {} hands on-chain, cards revealed to table", hand_rankings.len());

    // === STEP 4: Determine winners for each pot ===
    let winners_by_pot = determine_pot_winners(&pots, &hand_rankings);

    // === STEP 5: Calculate total winnings per seat ===
    let winnings = distribute_pots(&pots, &winners_by_pot);
    
    msg!("Distribution: {:?}", winnings);

    // === STEP 6: Calculate rake (5% for cash games if flop reached) ===
    let rake = if table.game_type == GameType::CashGame && table.flop_reached {
        let calculated_rake = total_pot
            .checked_mul(RAKE_PERCENT_BPS)
            .and_then(|r| r.checked_div(10000))
            .ok_or(PokerError::Overflow)?;
        if table.rake_cap > 0 { calculated_rake.min(table.rake_cap) } else { calculated_rake }
    } else {
        0
    };
    
    // Deduct rake from winnings proportionally
    let mut adjusted_winnings = winnings.clone();
    if rake > 0 {
        let total_won: u64 = adjusted_winnings.iter().map(|(_, amt)| *amt).sum();
        if total_won > 0 {
            let mut rake_remaining = rake;
            for (_, amt) in adjusted_winnings.iter_mut() {
                let share_of_rake = ((*amt as u128) * (rake as u128) / (total_won as u128)) as u64;
                let deduction = share_of_rake.min(rake_remaining).min(*amt);
                *amt = amt.saturating_sub(deduction);
                rake_remaining = rake_remaining.saturating_sub(deduction);
            }
            // Any rounding remainder from last winner
            if rake_remaining > 0 {
                if let Some(last) = adjusted_winnings.iter_mut().rev().find(|(_, a)| *a > 0) {
                    last.1 = last.1.saturating_sub(rake_remaining);
                }
            }
        }
    }
    let winnings = adjusted_winnings;

    // Verify total winnings equals pot minus rake
    let total_distributed: u64 = winnings.iter().map(|(_, amt)| *amt).sum();
    let pot_after_rake = total_pot.saturating_sub(rake);
    
    require!(
        total_distributed == pot_after_rake || 
        (rake == 0 && total_distributed == total_pot),
        PokerError::InvalidAccountData
    );

    // === STEP 7: Distribute winnings to seat accounts ===
    let mut winner_pubkeys = Vec::new();
    let mut winner_amounts = Vec::new();
    
    for (seat_num, amount) in winnings.iter() {
        let seat_arr_idx = *seat_num as usize;
        if seat_arr_idx < seat_num_to_account_index.len() {
            let pair_idx_raw = seat_num_to_account_index[seat_arr_idx];
            if pair_idx_raw == 255 {
                continue;
            }
            let pair_idx = pair_idx_raw as usize;
            if pair_idx >= seats.len() {
                continue;
            }
            let seat_info = &seats[pair_idx];
            let mut seat_data = seat_info.try_borrow_mut_data()?;
            
            if CHIPS_OFFSET + 8 <= seat_data.len() {
                let current_chips = u64::from_le_bytes(
                    seat_data[CHIPS_OFFSET..CHIPS_OFFSET + 8].try_into().unwrap()
                );
                let new_chips = current_chips.saturating_add(*amount);
                seat_data[CHIPS_OFFSET..CHIPS_OFFSET + 8].copy_from_slice(&new_chips.to_le_bytes());
                
                msg!("Seat {} wins {}: {} -> {} chips", seat_num, amount, current_chips, new_chips);
            }

            if seat_data.len() >= 8 + 32 {
                let wallet_bytes: [u8; 32] = seat_data[8..8 + 32].try_into().unwrap();
                winner_pubkeys.push(Pubkey::new_from_array(wallet_bytes));
                winner_amounts.push(*amount);
            }
        }
    }

    // Accumulate rake and distribute to creator if user-created table
    table.rake_accumulated = table.rake_accumulated.saturating_add(rake);
    
    // Dealer cut ALWAYS accumulates (both system and user tables)
    if rake > 0 {
        if table.is_user_created {
            // User-created: 50% creator, 5% treasury, 25% stakers, 25% dealers
            let creator_share = rake.checked_mul(RAKE_CREATOR_BPS).and_then(|r| r.checked_div(10000)).unwrap_or(0);
            let crank_cut = rake.checked_mul(RAKE_DEALER_BPS).and_then(|r| r.checked_div(10000)).unwrap_or(0);

            table.creator_rake_total = table.creator_rake_total.saturating_add(creator_share);
            table.crank_pool_accumulated = table.crank_pool_accumulated.saturating_add(crank_cut);

            msg!("Rake: {} total, creator(50%): {}, dealer(25%): {}", rake, creator_share, crank_cut);
        } else {
            // System tables: 5% treasury, 50% stakers, 45% dealers
            let crank_cut = rake.checked_mul(RAKE_DEALER_SYSTEM_BPS).and_then(|r| r.checked_div(10000)).unwrap_or(0);
            table.crank_pool_accumulated = table.crank_pool_accumulated.saturating_add(crank_cut);

            msg!("Rake: {} total, dealer(45%): {}", rake, crank_cut);
        }
    }

    // Reset table for next hand
    // NOTE: Do NOT clear revealed_hands/hand_results here — the frontend needs them
    // during the showdown hold period to display opponent cards. They are cleared
    // by deal_vrf at the start of the next hand's VRF deal.
    table.pot = 0;
    table.min_bet = 0;
    table.community_cards = [CARD_NOT_DEALT; 5];
    table.pre_community = [255; 5];
    table.deck_seed = [0; 32];
    table.deck_index = 0;
    // Reset DeckState for next hand (clears all encrypted card data)
    let deck_state = &mut ctx.accounts.deck_state;
    deck_state.reset_for_new_hand();
    table.flop_reached = false; // Reset for next hand
    table.seats_folded = 0; // Reset folded bitmask
    table.seats_allin = 0; // Reset all-in bitmask
    table.phase = GamePhase::Waiting; // Ready for next hand
    table.last_action_slot = clock.unix_timestamp as u64;

    // NOTE: rotate_button() is called AFTER bust detection below (needs updated seats_occupied)

    // Reset seats for next hand (in remaining accounts)
    // IMPORTANT: Check for busted players BEFORE resetting status
    // Use actual seat_number (offset 226) instead of enumerate index for bitmask ops
    let chips_offset = 8 + 32 + 32 + 32;
    let status_offset = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 64 + 32 + 2 + 1;
    let seat_num_offset: usize = 226;
    let is_sng = table.is_sit_and_go();
    // Collect busted SNG players for fair elimination ordering (sorted by pre-hand chips)
    let mut busted_this_hand: Vec<(u8, u64)> = Vec::new(); // (seat_num, pre_hand_chips)
    
    for seat_info in ctx.remaining_accounts.iter() {
        let mut seat_data = seat_info.try_borrow_mut_data()?;
        if seat_data.len() > seat_num_offset {
            let seat_num = seat_data[seat_num_offset];
            
            // Check if player is busted (0 chips) - do this BEFORE resetting status
            if chips_offset + 8 <= seat_data.len() && status_offset < seat_data.len() {
                let chips = u64::from_le_bytes(
                    seat_data[chips_offset..chips_offset + 8].try_into().unwrap_or([0; 8])
                );
                let current_status = seat_data[status_offset];
                
                // If player was active/all-in but now has 0 chips
                if chips == 0 && (current_status == 1 || current_status == 3 || current_status == 2) {
                    if is_sng {
                        // Tournament: eliminated — remove from table
                        seat_data[status_offset] = 5; // Busted
                        table.current_players = table.current_players.saturating_sub(1);
                        table.seats_occupied &= !(1u16 << (seat_num as u16));
                        
                        // Read total_bet BEFORE zeroing — equals pre-hand chips for busted players
                        let total_bet_off = 8 + 32 + 32 + 32 + 8 + 8; // 120
                        let pre_hand_chips = if total_bet_off + 8 <= seat_data.len() {
                            u64::from_le_bytes(seat_data[total_bet_off..total_bet_off + 8].try_into().unwrap_or([0; 8]))
                        } else { 0 };
                        busted_this_hand.push((seat_num, pre_hand_chips));
                        msg!("Player busted (SNG) seat {} pre-hand chips={}, current_players now: {}", seat_num, pre_hand_chips, table.current_players);
                    } else {
                        // Cash game: sit out with rebuy window — keep seat occupied
                        // NEVER overwrite Leaving (6) — that would destroy the cashout snapshot
                        if current_status != 6 {
                            seat_data[status_offset] = 4; // SittingOut
                        }
                        msg!("Player at seat {} has 0 chips — sitting out (rebuy window)", seat_num);
                    }
                    
                    // Reset bets and hole cards for busted player (prevent stale data in next hand)
                    let bet_offset = 8 + 32 + 32 + 32 + 8;
                    if bet_offset + 8 <= seat_data.len() {
                        seat_data[bet_offset..bet_offset + 8].copy_from_slice(&0u64.to_le_bytes());
                    }
                    let total_bet_offset = bet_offset + 8;
                    if total_bet_offset + 8 <= seat_data.len() {
                        seat_data[total_bet_offset..total_bet_offset + 8].copy_from_slice(&0u64.to_le_bytes());
                    }
                    let hole_offset = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 64 + 32;
                    if hole_offset + 2 <= seat_data.len() {
                        seat_data[hole_offset..hole_offset + 2].copy_from_slice(&[CARD_NOT_DEALT, CARD_NOT_DEALT]);
                    }
                    continue; // Skip further processing for busted player
                }
            }
            
            // Reset bet_this_round (offset after chips)
            let bet_offset = 8 + 32 + 32 + 32 + 8;
            if bet_offset + 8 <= seat_data.len() {
                seat_data[bet_offset..bet_offset + 8].copy_from_slice(&0u64.to_le_bytes());
            }
            // Reset total_bet_this_hand
            let total_bet_offset = bet_offset + 8;
            if total_bet_offset + 8 <= seat_data.len() {
                seat_data[total_bet_offset..total_bet_offset + 8].copy_from_slice(&0u64.to_le_bytes());
            }
            // Reset hole cards
            let hole_offset = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 64 + 32;
            if hole_offset + 2 <= seat_data.len() {
                seat_data[hole_offset..hole_offset + 2].copy_from_slice(&[CARD_NOT_DEALT, CARD_NOT_DEALT]);
            }
            // Handle Leaving players: snapshot chips+vault_reserve for cashout
            // Offsets match PlayerSeat struct layout (includes 8-byte discriminator)
            const CASHOUT_CHIPS_OFFSET: usize = 246;
            const CASHOUT_NONCE_OFFSET: usize = 254;
            const VAULT_RESERVE_OFFSET: usize = 262;

            if status_offset < seat_data.len() {
                let current_status = seat_data[status_offset];

                if current_status == 6 && seat_data.len() >= VAULT_RESERVE_OFFSET + 8 {
                    // Leaving player: snapshot chips + vault_reserve → cashout_chips
                    let chips = u64::from_le_bytes(
                        seat_data[chips_offset..chips_offset + 8].try_into().unwrap_or([0; 8])
                    );
                    let vault_reserve = u64::from_le_bytes(
                        seat_data[VAULT_RESERVE_OFFSET..VAULT_RESERVE_OFFSET + 8].try_into().unwrap_or([0; 8])
                    );
                    let total_owed = chips.saturating_add(vault_reserve);

                    // Write cashout_chips
                    seat_data[CASHOUT_CHIPS_OFFSET..CASHOUT_CHIPS_OFFSET + 8]
                        .copy_from_slice(&total_owed.to_le_bytes());
                    // Increment cashout_nonce
                    let nonce = u64::from_le_bytes(
                        seat_data[CASHOUT_NONCE_OFFSET..CASHOUT_NONCE_OFFSET + 8].try_into().unwrap_or([0; 8])
                    );
                    seat_data[CASHOUT_NONCE_OFFSET..CASHOUT_NONCE_OFFSET + 8]
                        .copy_from_slice(&nonce.wrapping_add(1).to_le_bytes());
                    // Zero chips and vault_reserve
                    seat_data[chips_offset..chips_offset + 8].copy_from_slice(&0u64.to_le_bytes());
                    seat_data[VAULT_RESERVE_OFFSET..VAULT_RESERVE_OFFSET + 8].copy_from_slice(&0u64.to_le_bytes());

                    // Remove from table masks
                    table.seats_occupied &= !(1u16 << (seat_num as u16));
                    table.current_players = table.current_players.saturating_sub(1);

                    msg!("Leaving seat {} snapshot: cashout_chips={}, nonce={}", seat_num, total_owed, nonce.wrapping_add(1));
                } else if current_status != 0 && current_status != 4 && current_status != 5 && current_status != 6 {
                    // 0=Empty, 4=SittingOut, 5=Busted, 6=Leaving — keep as-is
                    seat_data[status_offset] = 1; // Active
                }
            }
        }
    }

    // Fair elimination ordering for SNG: sort busted players by pre-hand chip count.
    // Industry standard (TDA/PokerStars): smaller starting stack = worse finish position.
    // Equal stacks = tie (deterministic by seat number for on-chain reproducibility).
    // busted_this_hand is sorted ascending: smallest stack first = eliminated first (worst place).
    if !busted_this_hand.is_empty() {
        busted_this_hand.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(&b.0)));
        for (seat_num, pre_chips) in busted_this_hand.iter() {
            let elim_idx = table.eliminated_count as usize;
            if elim_idx < 9 {
                table.eliminated_seats[elim_idx] = *seat_num;
                table.eliminated_count += 1;
            }
            msg!("Eliminated seat {} (pre-hand chips={}, position={}th)", seat_num, pre_chips, table.eliminated_count);
        }
    }

    // Move dealer button AFTER bust detection (needs updated seats_occupied)
    table.rotate_button();

    emit!(HandSettled {
        table: table.key(),
        hand_number: table.hand_number,
        winners: winner_pubkeys,
        amounts: winner_amounts.clone(),
        rake_collected: rake,
    });

    msg!(
        "Hand #{} settled. Pot: {}, Rake: {}, Winners: {:?}",
        table.hand_number,
        total_pot,
        rake,
        winnings
    );

    // For Sit & Go: Check if game is over (only 1 player remaining)
    // current_players was decremented above when players busted
    if table.is_sit_and_go() && table.current_players <= 1 {
        table.phase = GamePhase::Complete;
        msg!("🏆 Sit & Go complete! Only {} player(s) remaining", table.current_players);
    }

    // Record crank action in CrankTallyER (if appended after seats+seat_cards)
    let tkey = table.key();
    let hnum = table.hand_number;
    let ckey = ctx.accounts.settler.key();
    try_record_crank_action(ctx.remaining_accounts, &tkey, &ckey, hnum);

    Ok(())
}
