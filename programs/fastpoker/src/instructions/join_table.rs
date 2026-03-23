use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::state::*;
use crate::state::player::{PlayerAccount, PLAYER_SEED};
use crate::errors::PokerError;
use crate::events::{PlayerJoined, FreeEntryUsed};
use crate::constants::*;

#[derive(Accounts)]
#[instruction(buy_in: u64, seat_number: u8, reserve: u64)]
pub struct JoinTable<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    /// Player account - must be registered
    #[account(
        mut,
        seeds = [PLAYER_SEED, player.key().as_ref()],
        bump = player_account.bump,
        constraint = player_account.is_registered @ PokerError::PlayerNotRegistered,
    )]
    pub player_account: Box<Account<'info, PlayerAccount>>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
        constraint = table.current_players < table.max_players @ PokerError::TableFull,
        constraint = table.phase == GamePhase::Waiting @ PokerError::HandInProgress,
    )]
    pub table: Box<Account<'info, Table>>,

    #[account(
        init_if_needed,
        payer = player,
        space = PlayerSeat::SIZE,
        seeds = [SEAT_SEED, table.key().as_ref(), &[seat_number]],
        bump
    )]
    pub seat: Box<Account<'info, PlayerSeat>>,

    /// Player-Table position marker - prevents same player joining multiple seats
    /// This PDA is unique per player+table combo. If it exists, player is already seated.
    #[account(
        init_if_needed,
        payer = player,
        space = PlayerTableMarker::SIZE,
        seeds = [b"player_table", player.key().as_ref(), table.key().as_ref()],
        bump
    )]
    pub player_table_marker: Box<Account<'info, PlayerTableMarker>>,

    /// TableVault PDA — holds all player SOL for cash games. Never delegated.
    #[account(
        mut,
        seeds = [VAULT_SEED, table.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Option<Account<'info, TableVault>>,

    /// CashoutReceipt PDA — idempotent cashout tracking per seat.
    #[account(
        init_if_needed,
        payer = player,
        space = CashoutReceipt::SIZE,
        seeds = [RECEIPT_SEED, table.key().as_ref(), &[seat_number]],
        bump
    )]
    pub receipt: Option<Account<'info, CashoutReceipt>>,

    /// Treasury for entry fees (Sit & Go) - receives 50%
    /// CHECK: Treasury account
    #[account(mut)]
    pub treasury: Option<AccountInfo<'info>>,

    /// Pool PDA for stakers (Sit & Go) - receives 50%
    /// CHECK: Steel program pool PDA
    #[account(mut)]
    pub pool: Option<AccountInfo<'info>>,

    /// CHECK: Player's token account for buy-in (for cash games)
    #[account(mut)]
    pub player_token_account: Option<UncheckedAccount<'info>>,

    /// CHECK: Table's token escrow (for cash games)
    #[account(mut)]
    pub table_token_account: Option<UncheckedAccount<'info>>,

    /// Optional: Unclaimed balance from previous session at this table
    /// If exists and has funds, auto-use for buy-in (player rejoining)
    #[account(
        mut,
        seeds = [UNCLAIMED_SEED, table.key().as_ref(), player.key().as_ref()],
        bump,
    )]
    pub unclaimed_balance: Option<Account<'info, UnclaimedBalance>>,

    pub token_program: Option<Program<'info, anchor_spl::token::Token>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<JoinTable>, buy_in: u64, seat_number: u8, reserve: u64) -> Result<()> {
    let table = &mut ctx.accounts.table;
    let seat = &mut ctx.accounts.seat;
    let player_account = &mut ctx.accounts.player_account;
    let player_table_marker = &mut ctx.accounts.player_table_marker;
    let player_wallet = ctx.accounts.player.key();
    let clock = Clock::get()?;

    // Seat reuse check: init_if_needed allows existing accounts, so verify seat is empty
    require!(
        seat.status == SeatStatus::Empty,
        PokerError::SeatOccupied
    );

    // Duplicate player check: if marker already has a valid player, reject.
    // leave_table closes the marker PDA, so a proper leave+rejoin always sees a fresh
    // marker (player == default). Any non-default marker means the player is still seated.
    // (init_if_needed won't fail on existing accounts)
    if player_table_marker.player != Pubkey::default() {
        return Err(PokerError::PlayerAlreadySeated.into());
    }

    // Private table whitelist check: if table is private, verify player is whitelisted.
    // WhitelistEntry PDA must be passed as the LAST remaining_account.
    // Creator is always implicitly whitelisted (no PDA needed).
    if table.is_private && player_wallet != table.creator {
        let table_key = table.key();
        let (expected_wl, _) = Pubkey::find_program_address(
            &[crate::state::WHITELIST_SEED, table_key.as_ref(), player_wallet.as_ref()],
            &crate::ID,
        );
        let has_whitelist = ctx.remaining_accounts.iter().any(|a| {
            a.key() == expected_wl && a.owner == &crate::ID
        });
        require!(has_whitelist, PokerError::Unauthorized);
    }

    // Initialize the player-table marker (proves this player is at this table)
    player_table_marker.player = player_wallet;
    player_table_marker.table = table.key();
    player_table_marker.seat_number = seat_number;
    player_table_marker.bump = ctx.bumps.player_table_marker;

    // Chip lock: read from trailing bytes (offsets 74-89) of marker PDA.
    // If player left this table within 12 hours, they must return with at least
    // the same chip amount (prevents ratholing). Only applies to cash games.
    let marker_info = player_table_marker.to_account_info();
    let chip_lock_min: u64 = if table.game_type == GameType::CashGame {
        let marker_data = marker_info.try_borrow_data()?;
        if marker_data.len() >= PlayerTableMarker::CHIP_LOCK_TIME_OFFSET + 8 {
            let leave_time = i64::from_le_bytes(
                marker_data[PlayerTableMarker::CHIP_LOCK_TIME_OFFSET..PlayerTableMarker::CHIP_LOCK_TIME_OFFSET + 8]
                    .try_into().unwrap_or([0; 8])
            );
            if leave_time > 0 {
                let elapsed = clock.unix_timestamp.saturating_sub(leave_time);
                if elapsed < PlayerTableMarker::CHIP_LOCK_DURATION {
                    let locked = u64::from_le_bytes(
                        marker_data[PlayerTableMarker::CHIP_LOCK_CHIPS_OFFSET..PlayerTableMarker::CHIP_LOCK_CHIPS_OFFSET + 8]
                            .try_into().unwrap_or([0; 8])
                    );
                    msg!("Chip lock active: left with {} chips {}s ago (12h lock)", locked, elapsed);
                    locked
                } else { 0 }
            } else { 0 }
        } else { 0 } // Old 74-byte marker — no chip lock data
    } else { 0 };
    // Anti-abuse: read kick_time from marker trailing bytes (offsets 90-98).
    // If kicked within 30 min, add +1 BB penalty to minimum buy-in.
    let kick_penalty: u64 = if table.game_type == GameType::CashGame {
        let marker_info2 = player_table_marker.to_account_info();
        let marker_data2 = marker_info2.try_borrow_data()?;
        if marker_data2.len() >= PlayerTableMarker::KICK_REASON_OFFSET + 1 {
            let kick_time = i64::from_le_bytes(
                marker_data2[PlayerTableMarker::KICK_TIME_OFFSET..PlayerTableMarker::KICK_TIME_OFFSET + 8]
                    .try_into().unwrap_or([0; 8])
            );
            let kick_reason = marker_data2[PlayerTableMarker::KICK_REASON_OFFSET];
            drop(marker_data2);
            if kick_reason > 0 && kick_time > 0 {
                let elapsed = clock.unix_timestamp.saturating_sub(kick_time);
                if elapsed < PlayerTableMarker::KICK_PENALTY_DURATION {
                    msg!("Kick penalty active: kicked {}s ago (30 min window), +1 BB penalty", elapsed);
                    table.big_blind
                } else { 0 }
            } else { 0 }
        } else {
            drop(marker_data2);
            0
        }
    } else { 0 };

    // Clear chip lock + kick data on rejoin (raw write to trailing bytes)
    // Must drop the immutable borrow first
    drop(marker_info);
    {
        let marker_info_mut = player_table_marker.to_account_info();
        let mut marker_data = marker_info_mut.try_borrow_mut_data()?;
        if marker_data.len() >= PlayerTableMarker::CHIP_LOCK_TIME_OFFSET + 8 {
            marker_data[PlayerTableMarker::CHIP_LOCK_CHIPS_OFFSET..PlayerTableMarker::CHIP_LOCK_CHIPS_OFFSET + 8]
                .copy_from_slice(&0u64.to_le_bytes());
            marker_data[PlayerTableMarker::CHIP_LOCK_TIME_OFFSET..PlayerTableMarker::CHIP_LOCK_TIME_OFFSET + 8]
                .copy_from_slice(&0i64.to_le_bytes());
        }
        // Clear kick data
        if marker_data.len() >= PlayerTableMarker::KICK_REASON_OFFSET + 1 {
            marker_data[PlayerTableMarker::KICK_TIME_OFFSET..PlayerTableMarker::KICK_TIME_OFFSET + 8]
                .copy_from_slice(&0i64.to_le_bytes());
            marker_data[PlayerTableMarker::KICK_REASON_OFFSET] = 0;
        }
    }

    // seat_number is already passed from instruction and validated by PDA derivation
    require!(seat_number < table.max_players, PokerError::TableFull);


    // Track total chips for cash games (includes unclaimed + new buy-in)
    let mut cash_game_total_chips: u64 = 0;

    // Handle entry fee based on game type
    match table.game_type {
        GameType::CashGame => {
            // Check for unclaimed balance from previous session
            let mut unclaimed_amount: u64 = 0;
            if let Some(unclaimed) = &mut ctx.accounts.unclaimed_balance {
                if unclaimed.amount > 0 && unclaimed.player == player_wallet {
                    unclaimed_amount = unclaimed.amount;
                    unclaimed.amount = 0; // Clear the unclaimed balance
                    // Decrement count since we consumed this unclaimed balance
                    table.unclaimed_balance_count = table.unclaimed_balance_count.saturating_sub(1);
                    msg!("Using {} unclaimed POKER from previous session", unclaimed_amount);
                }
            }

            // Calculate total buy-in (new + unclaimed)
            cash_game_total_chips = unclaimed_amount.saturating_add(buy_in);

            // Validate total buy-in range based on buy_in_type
            // Normal (0): 20-100 BB, Deep Stack (1): 50-250 BB
            let (min_bb, max_bb): (u64, u64) = if table.buy_in_type == 1 { (50, 250) } else { (20, 100) };
            let min_buy_in = table.big_blind * min_bb;
            let max_buy_in = table.big_blind * max_bb;

            // Chip lock: if returning within 12h, minimum is the higher of
            // normal min_buy_in and chips_at_leave (capped at max_buy_in)
            let base_min = if chip_lock_min > min_buy_in {
                // Cap at max so the lock doesn't make it impossible to rejoin
                std::cmp::min(chip_lock_min, max_buy_in)
            } else {
                min_buy_in
            };
            // Anti-abuse: +1 BB penalty for kicked players rejoining within 30 min
            let effective_min = base_min.saturating_add(kick_penalty).min(max_buy_in);

            require!(
                cash_game_total_chips >= effective_min && cash_game_total_chips <= max_buy_in,
                PokerError::InvalidBuyIn
            );

            if chip_lock_min > 0 {
                msg!("Chip lock enforced: min={}, bought={}", effective_min, cash_game_total_chips);
            }
            
            // Transfer buy-in + reserve from player to vault (SOL) or escrow (SPL)
            let total_deposit = buy_in.checked_add(reserve).ok_or(PokerError::Overflow)?;
            if total_deposit > 0 {
                if table.token_mint == Pubkey::default() {
                    // SOL table: transfer to TableVault PDA (never delegated)
                    let vault = ctx.accounts.vault.as_mut()
                        .ok_or(PokerError::InvalidAccountData)?;
                    system_program::transfer(
                        CpiContext::new(
                            ctx.accounts.system_program.to_account_info(),
                            system_program::Transfer {
                                from: ctx.accounts.player.to_account_info(),
                                to: vault.to_account_info(),
                            },
                        ),
                        total_deposit,
                    )?;
                    vault.total_deposited = vault.total_deposited
                        .checked_add(total_deposit)
                        .ok_or(PokerError::Overflow)?;
                    msg!("Transferred {} lamports to vault (buy_in={}, reserve={})", total_deposit, buy_in, reserve);
                } else if let (Some(player_token), Some(table_token), Some(token_prog)) = (
                    ctx.accounts.player_token_account.as_ref(),
                    ctx.accounts.table_token_account.as_ref(),
                    ctx.accounts.token_program.as_ref(),
                ) {
                    // SPL token table: transfer tokens via token program
                    // Strict mint validation: verify both token accounts match table.token_mint
                    require!(
                        token_prog.key() == anchor_spl::token::ID,
                        PokerError::InvalidTokenProgram
                    );
                    {
                        let pt_data = player_token.try_borrow_data()?;
                        require!(pt_data.len() >= 32, PokerError::InvalidTokenAccount);
                        let pt_mint = Pubkey::try_from(&pt_data[0..32])
                            .map_err(|_| PokerError::InvalidTokenAccount)?;
                        require!(pt_mint == table.token_mint, PokerError::InvalidTokenMint);
                    }
                    {
                        // CT-2 FIX: Validate mint AND owner of table token account.
                        // Without owner check, attacker could deposit to their own ATA.
                        // SPL Token Account layout: [0..32] = mint, [32..64] = owner.
                        let tt_data = table_token.try_borrow_data()?;
                        require!(tt_data.len() >= 64, PokerError::InvalidTokenAccount);
                        let tt_mint = Pubkey::try_from(&tt_data[0..32])
                            .map_err(|_| PokerError::InvalidTokenAccount)?;
                        require!(tt_mint == table.token_mint, PokerError::InvalidTokenMint);
                        let tt_owner = Pubkey::try_from(&tt_data[32..64])
                            .map_err(|_| PokerError::InvalidTokenAccount)?;
                        require!(tt_owner == table.key(), PokerError::InvalidEscrow);
                    }

                    anchor_spl::token::transfer(
                        CpiContext::new(
                            token_prog.to_account_info(),
                            anchor_spl::token::Transfer {
                                from: player_token.to_account_info(),
                                to: table_token.to_account_info(),
                                authority: ctx.accounts.player.to_account_info(),
                            },
                        ),
                        total_deposit,
                    )?;
                    msg!("Transferred {} tokens (mint {}) to table escrow", total_deposit, table.token_mint);
                }
            }

            // Initialize/reset CashoutReceipt for this seat
            // Always reset nonce to 0 so new occupant's first leave (nonce=1) passes
            if let Some(receipt) = ctx.accounts.receipt.as_mut() {
                receipt.table = table.key();
                receipt.seat_index = seat_number;
                receipt.depositor = ctx.accounts.player.key();
                receipt.last_processed_nonce = 0;
                if receipt.bump == 0 {
                    receipt.bump = ctx.bumps.receipt.unwrap_or(0);
                }
            }
        }
        GameType::SitAndGoHeadsUp | GameType::SitAndGo6Max | GameType::SitAndGo9Max => {
            // Tiered SNG: buy-in = entry_amount (→ prize pool) + fee_amount (→ Steel)
            let entry_amt = table.entry_amount;
            let fee_amt = table.fee_amount;
            let total_buy_in = entry_amt.checked_add(fee_amt).ok_or(PokerError::InvalidBuyIn)?;

            // Free entries only valid for Micro tier
            let use_free = player_account.has_free_entry()
                && table.tier == crate::constants::SnGTier::Micro;

            if use_free {
                // Use free entry — no SOL charged, seat.paid_entry stays false
                player_account.use_free_entry();
                
                emit!(FreeEntryUsed {
                    player: ctx.accounts.player.key(),
                    entries_remaining: player_account.free_entries,
                    table: table.key(),
                });
                
                msg!("Used free entry (Micro tier). {} entries remaining.", player_account.free_entries);
            } else {
                // Transfer full buy-in (entry + fee) from player to table PDA
                // Everything stays escrowed until distribute_prizes
                require!(total_buy_in > 0, PokerError::InvalidBuyIn);

                system_program::transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.to_account_info(),
                        system_program::Transfer {
                            from: ctx.accounts.player.to_account_info(),
                            to: table.to_account_info(),
                        },
                    ),
                    total_buy_in,
                )?;
                
                // Track total escrowed (entry + fee)
                table.entry_fees_escrowed = table.entry_fees_escrowed
                    .checked_add(total_buy_in)
                    .ok_or(PokerError::InvalidBuyIn)?;
                
                // Track entry portion separately for prize distribution
                table.prize_pool = table.prize_pool
                    .checked_add(entry_amt)
                    .ok_or(PokerError::InvalidBuyIn)?;
                
                // Mark seat so we know to refund on leave
                seat.paid_entry = true;
                
                msg!("Buy-in {} (entry={}, fee={}) escrowed. Prize pool: {}, Total escrowed: {}",
                    total_buy_in, entry_amt, fee_amt, table.prize_pool, table.entry_fees_escrowed);
            }
            
            // Track tournament participation
            player_account.tournaments_played += 1;
        }
    }

    // Initialize seat
    seat.wallet = ctx.accounts.player.key();
    seat.session_key = Pubkey::default(); // No session key yet
    seat.table = table.key();
    
    // Set starting chips based on game type
    seat.chips = match table.game_type {
        // Cash games: use total (unclaimed + new buy-in) calculated above
        GameType::CashGame => cash_game_total_chips,
        // Tournament starting stacks
        GameType::SitAndGoHeadsUp | GameType::SitAndGo6Max | GameType::SitAndGo9Max => 1500,
    };
    seat.bet_this_round = 0;
    seat.total_bet_this_hand = 0;
    seat.hole_cards_encrypted = [0; 64];
    seat.hole_cards_commitment = [0; 32];
    seat.hole_cards = [CARD_NOT_DEALT, CARD_NOT_DEALT];
    seat.seat_number = seat_number;
    seat.last_action_slot = clock.slot;
    seat.missed_sb = false;
    seat.missed_bb = false;
    seat.posted_blind = false;
    seat.bump = ctx.bumps.seat;

    // Cash game join: since join_table requires phase==Waiting, there's no active hand.
    // All joiners start Active — blind rotation in start_game handles fairness.
    // (waiting_for_bb is only meaningful mid-game on ER, which uses a different flow)
    seat.waiting_for_bb = false;
    seat.status = SeatStatus::Active;

    // Vault fields: set reserve, zero cashout (but NOT nonce — monotonically increasing per seat PDA)
    seat.vault_reserve = reserve;
    seat.cashout_chips = 0;
    // DO NOT zero cashout_nonce — new occupant inherits nonce so their first leave
    // increments past receipt.last_processed_nonce.
    seat.sit_out_timestamp = 0;

    // Time bank: start with full 60 seconds
    seat.time_bank_seconds = crate::constants::TIME_BANK_MAX_SECONDS;
    seat.time_bank_active = false;

    // Update table
    table.current_players += 1;
    table.occupy_seat(seat_number);

    emit!(PlayerJoined {
        table: table.key(),
        player: seat.wallet,
        seat_number,
        buy_in,
    });

    msg!("Player {} joined table at seat {}", seat.wallet, seat_number);
    Ok(())
}

// Add seat_number as instruction argument
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct JoinTableArgs {
    pub buy_in: u64,
    pub seat_number: u8,
}
