use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use crate::state::{Table, TableVault, GamePhase, GameType};
use crate::state::player::PLAYER_SEED;
use crate::errors::PokerError;
use crate::constants::PayoutStructure;
use crate::constants::*;
use crate::events::PrizesDistributed;

/// Wallet offset inside PlayerSeat account data (after 8-byte discriminator)
const SEAT_WALLET_OFFSET: usize = 8;
/// Table pubkey offset inside PlayerSeat account data
const SEAT_TABLE_OFFSET: usize = 8 + 32 + 32;
/// Seat number offset inside PlayerSeat account data
const SEAT_NUMBER_OFFSET: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 64 + 32 + 2;

/// PlayerAccount data offsets for raw read/write
/// 8 (disc) + 32 (wallet) + 1 (is_registered) + 1 (free_entries) + 8 (hands_played)
/// + 8 (hands_won) + 8 (total_winnings) + 8 (total_losses) + 4 (tournaments_played)
/// + 4 (tournaments_won) + 8 (registered_at) + 1 (bump) = 91
const PLAYER_TOURNAMENTS_PLAYED_OFFSET: usize = 74;
const PLAYER_TOURNAMENTS_WON_OFFSET: usize = 78;
const PLAYER_BUMP_OFFSET: usize = 90;
const PLAYER_CLAIMABLE_SOL_OFFSET: usize = 91;

const CREDIT_UNREFINED_DISC: u8 = 27;
const NOTIFY_POOL_SOL_DEPOSIT_DISC: u8 = 28;
const PRIZE_AUTHORITY_SEED: &[u8] = b"prize_authority";

#[derive(Accounts)]
pub struct DistributePrizes<'info> {
    /// Permissionless trigger account
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
        constraint = table.phase == GamePhase::Complete @ PokerError::GameNotComplete,
        constraint = !table.prizes_distributed @ PokerError::PrizesAlreadyDistributed,
        constraint = table.is_sit_and_go() @ PokerError::NotTournament,
    )]
    pub table: Account<'info, Table>,

    /// CHECK: Steel program for credit_unrefined CPI
    #[account(address = STEEL_PROGRAM_ID)]
    pub steel_program: AccountInfo<'info>,

    /// CHECK: Program signer PDA used for Steel CPI
    #[account(seeds = [PRIZE_AUTHORITY_SEED], bump)]
    pub prize_authority: AccountInfo<'info>,

    /// CHECK: Steel pool account; must match table.pool
    #[account(
        mut,
        constraint = steel_pool.key() == table.pool @ PokerError::InvalidPool,
    )]
    pub steel_pool: AccountInfo<'info>,

    /// CHECK: Treasury wallet
    #[account(
        mut,
        constraint = treasury.key() == TREASURY @ PokerError::InvalidTableConfig,
    )]
    pub treasury: AccountInfo<'info>,

    /// Vault PDA — receives crank_cut so distribute_crank_rewards can pay operators.
    #[account(
        mut,
        seeds = [VAULT_SEED, table.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, TableVault>,

    pub system_program: Program<'info, System>,

    // Remaining accounts:
    //   [seat_0..seat_{max-1}]                — validated seat PDAs (wallet source)
    //   [player_pda_1st, player_pda_2nd, ...] — ITM Player PDAs
    //   [unrefined_pda_1st, ...]              — ITM Steel unrefined PDAs (mandatory)
}

/// Distribute tournament prizes — PERMISSIONLESS + ATOMIC.
///
/// All prizes (SOL + POKER) are distributed in a single transaction:
/// 1. Phase must be Complete
/// 2. prizes_distributed must be false (idempotency)
/// 3. Elimination order from table.eliminated_seats
/// 4. POKER prizes: CPI into Steel credit_unrefined_from_program (atomic)
/// 5. SOL prizes: table PDA → each ITM Player PDA (claimable_sol)
/// 6. Fees: table PDA → pool + treasury (contract-determined split)
/// 7. Marks prizes_distributed = true
pub fn distribute_prizes_handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, DistributePrizes<'info>>,
) -> Result<()> {
    let table = &mut ctx.accounts.table;
    let remaining = &ctx.remaining_accounts;
    let program_id = ctx.program_id;

    // --- Get payout structure ---
    let payout_structure = match table.game_type {
        GameType::SitAndGoHeadsUp => PayoutStructure::heads_up(),
        GameType::SitAndGo6Max => PayoutStructure::six_max(),
        GameType::SitAndGo9Max => PayoutStructure::nine_max(),
        _ => return Err(PokerError::NotTournament.into()),
    };

    let max = table.max_players as usize;
    let num_itm = payout_structure.payouts.len();
    let has_sol_prizes = table.prize_pool > 0;

    // Remaining accounts layout:
    //   [0..max)                   = seat PDAs
    //   [max..max+itm)             = ITM Player PDAs
    //   [max+itm..max+itm+itm)     = ITM unrefined PDAs
    let player_pda_offset = max;
    let unrefined_offset = player_pda_offset + num_itm;
    let min_required = unrefined_offset + num_itm;
    require!(remaining.len() >= min_required, PokerError::InvalidAccountData);

    // --- Read wallet addresses from seat PDAs ---
    let mut seat_wallets: Vec<Pubkey> = Vec::with_capacity(max);
    for i in 0..max {
        let seat_info = &remaining[i];
        let seat_index = i as u8;

        let (expected_seat_pda, _) = Pubkey::find_program_address(
            &[SEAT_SEED, table.key().as_ref(), &[seat_index]],
            program_id,
        );
        require!(seat_info.key() == expected_seat_pda, PokerError::InvalidAccountData);
        require!(seat_info.owner == program_id, PokerError::InvalidAccountData);

        let data = seat_info.try_borrow_data()?;
        require!(data.len() >= SEAT_NUMBER_OFFSET + 1, PokerError::InvalidAccountData);

        let seat_table = Pubkey::try_from(&data[SEAT_TABLE_OFFSET..SEAT_TABLE_OFFSET + 32])
            .map_err(|_| PokerError::InvalidAccountData)?;
        require!(seat_table == table.key(), PokerError::SeatNotAtTable);
        require!(data[SEAT_NUMBER_OFFSET] == seat_index, PokerError::InvalidSeatNumber);

        let wallet = Pubkey::try_from(&data[SEAT_WALLET_OFFSET..SEAT_WALLET_OFFSET + 32])
            .map_err(|_| PokerError::InvalidAccountData)?;
        seat_wallets.push(wallet);
    }

    // --- Build finish order from on-chain eliminated_seats ---
    let elim_count = table.eliminated_count as usize;
    let expected = table.max_players.saturating_sub(1) as usize;
    require!(elim_count == expected, PokerError::InvalidFinishOrder);

    let eliminated_set: Vec<u8> = table.eliminated_seats[..elim_count].to_vec();
    let winner_seat = (0..max as u8)
        .find(|s| !eliminated_set.contains(s) && seat_wallets[*s as usize] != Pubkey::default())
        .ok_or(PokerError::InvalidFinishOrder)?;

    // Build ordered finish: 1st = winner, 2nd = last eliminated, etc.
    let mut finish_wallets: Vec<Pubkey> = Vec::with_capacity(num_itm + 1);
    finish_wallets.push(seat_wallets[winner_seat as usize]);
    for i in (0..elim_count).rev() {
        finish_wallets.push(seat_wallets[table.eliminated_seats[i] as usize]);
    }

    // =========================================================
    // POKER PRIZE CALCULATION (+ mandatory CPI CREDIT)
    // =========================================================
    let poker_buy_in: u64 = 100_000_000; // 100 POKER per player (6 decimals)
    let poker_pool = poker_buy_in * (table.max_players as u64);

    let num_payouts = num_itm.min(finish_wallets.len());
    require!(num_payouts > 0, PokerError::InvalidFinishOrder);
    let mut poker_amounts: Vec<u64> = Vec::with_capacity(num_payouts);
    let mut prize_winners: Vec<Pubkey> = Vec::with_capacity(num_payouts);

    // Calculate POKER amounts for all ITM positions (used in event regardless of CPI)
    for (pos, payout_bps) in payout_structure.payouts.iter().enumerate().take(num_payouts) {
        let amount = (poker_pool as u128 * *payout_bps as u128 / 10000) as u64;
        let wallet = finish_wallets[pos];
        poker_amounts.push(amount);
        prize_winners.push(wallet);
    }

    let signer_seeds: &[&[u8]] = &[PRIZE_AUTHORITY_SEED, &[ctx.bumps.prize_authority]];

    for pos in 0..num_payouts {
        let amount = poker_amounts[pos];
        let wallet = prize_winners[pos];
        if amount == 0 { continue; }

        let unrefined_info = &remaining[unrefined_offset + pos];
        let (expected_unrefined, _) = Pubkey::find_program_address(
            &[b"unrefined", wallet.as_ref()],
            &STEEL_PROGRAM_ID,
        );
        require!(unrefined_info.key() == expected_unrefined, PokerError::InvalidAccountData);

        // Build CPI data: disc(1) + amount(8) + winner(32) = 41 bytes
        let mut cpi_data = vec![CREDIT_UNREFINED_DISC];
        cpi_data.extend_from_slice(&amount.to_le_bytes());
        cpi_data.extend_from_slice(wallet.as_ref());

        let cpi_ix = Instruction {
            program_id: STEEL_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(ctx.accounts.prize_authority.key(), true),
                AccountMeta::new(unrefined_info.key(), false),
                AccountMeta::new(ctx.accounts.steel_pool.key(), false),
            ],
            data: cpi_data,
        };

        invoke_signed(
            &cpi_ix,
            &[
                ctx.accounts.steel_program.to_account_info(),
                ctx.accounts.prize_authority.to_account_info(),
                unrefined_info.to_account_info(),
                ctx.accounts.steel_pool.to_account_info(),
            ],
            &[signer_seeds],
        ).map_err(|e| {
            msg!("CPI credit_unrefined failed for pos {}: {:?}", pos + 1, e);
            PokerError::InvalidAccountData
        })?;

        msg!("🏆 Position {} → {} — {} POKER via CPI", pos + 1, wallet, amount);
    }

    // =========================================================
    // SOL PRIZE DISTRIBUTION (skip for Micro / zero pool)
    // =========================================================
    let sol_prize_pool = table.prize_pool;
    let fee_total = table.entry_fees_escrowed.saturating_sub(sol_prize_pool);
    if has_sol_prizes {
        let mut total_sol_distributed: u64 = 0;

        for pos in 0..num_payouts {
            let payout_bps = payout_structure.payouts[pos] as u128;
            let sol_share = (sol_prize_pool as u128 * payout_bps / 10000) as u64;

            if sol_share == 0 {
                continue;
            }

            let winner_wallet = finish_wallets[pos];
            let player_pda_info = &remaining[player_pda_offset + pos];

            // --- Validate Player PDA ---
            require!(
                player_pda_info.owner == program_id,
                PokerError::InvalidAccountData
            );

            let (stored_bump, current_claimable) = {
                let pda_data = player_pda_info.try_borrow_data()?;
                require!(
                    pda_data.len() >= PLAYER_CLAIMABLE_SOL_OFFSET + 8,
                    PokerError::InvalidAccountData
                );
                let bump = pda_data[PLAYER_BUMP_OFFSET];
                let claimable = u64::from_le_bytes(
                    pda_data[PLAYER_CLAIMABLE_SOL_OFFSET..PLAYER_CLAIMABLE_SOL_OFFSET + 8]
                        .try_into()
                        .map_err(|_| PokerError::InvalidAccountData)?
                );
                (bump, claimable)
            };

            let expected_pda = Pubkey::create_program_address(
                &[PLAYER_SEED, winner_wallet.as_ref(), &[stored_bump]],
                program_id,
            ).map_err(|_| PokerError::InvalidAccountData)?;

            require!(
                player_pda_info.key() == expected_pda,
                PokerError::InvalidAccountData
            );

            let new_claimable = current_claimable
                .checked_add(sol_share)
                .ok_or(PokerError::Overflow)?;

            {
                let mut pda_data = player_pda_info.try_borrow_mut_data()?;
                pda_data[PLAYER_CLAIMABLE_SOL_OFFSET..PLAYER_CLAIMABLE_SOL_OFFSET + 8]
                    .copy_from_slice(&new_claimable.to_le_bytes());
            }

            **table.to_account_info().try_borrow_mut_lamports()? -= sol_share;
            **player_pda_info.try_borrow_mut_lamports()? += sol_share;

            total_sol_distributed += sol_share;

            msg!(
                "💰 Position {} — {} lamports SOL to Player PDA (wallet: {})",
                pos + 1,
                sol_share,
                winner_wallet
            );
        }

        table.prize_pool = sol_prize_pool.saturating_sub(total_sol_distributed);
        msg!("SOL prizes distributed: {} lamports to {} winners", total_sol_distributed, num_payouts);
    }

    // =========================================================
    // TOURNAMENT STAT TRACKING (all ITM player PDAs)
    // =========================================================
    for pos in 0..num_payouts {
        let winner_wallet = finish_wallets[pos];
        let player_pda_info = &remaining[player_pda_offset + pos];

        // Validate Player PDA ownership + derivation
        if player_pda_info.owner != program_id {
            msg!("⚠️ Skipping stats for pos {} — PDA not owned by program", pos + 1);
            continue;
        }

        let pda_data = player_pda_info.try_borrow_data()?;
        if pda_data.len() < PLAYER_CLAIMABLE_SOL_OFFSET + 8 {
            msg!("⚠️ Skipping stats for pos {} — PDA too small", pos + 1);
            continue;
        }
        let stored_bump = pda_data[PLAYER_BUMP_OFFSET];
        let current_tp = u32::from_le_bytes(
            pda_data[PLAYER_TOURNAMENTS_PLAYED_OFFSET..PLAYER_TOURNAMENTS_PLAYED_OFFSET + 4]
                .try_into().unwrap_or([0; 4])
        );
        let current_tw = u32::from_le_bytes(
            pda_data[PLAYER_TOURNAMENTS_WON_OFFSET..PLAYER_TOURNAMENTS_WON_OFFSET + 4]
                .try_into().unwrap_or([0; 4])
        );
        drop(pda_data);

        // Verify PDA derivation
        let expected_pda = Pubkey::create_program_address(
            &[PLAYER_SEED, winner_wallet.as_ref(), &[stored_bump]],
            program_id,
        );
        if expected_pda.is_err() || expected_pda.unwrap() != player_pda_info.key() {
            msg!("⚠️ Skipping stats for pos {} — PDA mismatch", pos + 1);
            continue;
        }

        let mut pda_data = player_pda_info.try_borrow_mut_data()?;

        // Increment tournaments_played for all ITM players
        let new_tp = current_tp.saturating_add(1);
        pda_data[PLAYER_TOURNAMENTS_PLAYED_OFFSET..PLAYER_TOURNAMENTS_PLAYED_OFFSET + 4]
            .copy_from_slice(&new_tp.to_le_bytes());

        // Increment tournaments_won for 1st place only
        if pos == 0 {
            let new_tw = current_tw.saturating_add(1);
            pda_data[PLAYER_TOURNAMENTS_WON_OFFSET..PLAYER_TOURNAMENTS_WON_OFFSET + 4]
                .copy_from_slice(&new_tw.to_le_bytes());
            msg!("📊 1st place stats: tournaments_played={}, tournaments_won={}", new_tp, new_tw);
        } else {
            msg!("📊 Pos {} stats: tournaments_played={}", pos + 1, new_tp);
        }
    }

    // =========================================================
    // FEE TRANSFER — direct lamport transfers + pool accounting CPI
    // =========================================================
    if fee_total > 0 {
        // SNG fee split: 10% treasury, 45% stakers, 45% dealers
        let crank_cut = fee_total * SNG_DEALER_BPS / 10000;
        let staker_share = fee_total * SNG_STAKERS_BPS / 10000;
        let treasury_share = fee_total - crank_cut - staker_share; // remainder to treasury

        table.crank_pool_accumulated = table.crank_pool_accumulated.saturating_add(crank_cut);
        msg!("SNG fee split: {} total → treasury(10%): {}, stakers(45%): {}, dealers(45%): {}", 
            fee_total, treasury_share, staker_share, crank_cut);

        // CPI FIRST (data-only accounting) — before lamport transfers.
        // Solana's runtime CPI balance check compares pre/post lamports for
        // accounts in the CPI. If we modify pool lamports before CPI, the
        // runtime sees a mismatch → UnbalancedInstruction.
        if staker_share > 0 {
            let mut notify_data = vec![NOTIFY_POOL_SOL_DEPOSIT_DISC];
            notify_data.extend_from_slice(&staker_share.to_le_bytes());

            let notify_ix = Instruction {
                program_id: STEEL_PROGRAM_ID,
                accounts: vec![
                    AccountMeta::new(ctx.accounts.prize_authority.key(), true),
                    AccountMeta::new(ctx.accounts.steel_pool.key(), false),
                ],
                data: notify_data,
            };

            let prize_auth_bump = ctx.bumps.prize_authority;
            let prize_auth_seeds: &[&[u8]] = &[PRIZE_AUTHORITY_SEED, &[prize_auth_bump]];

            invoke_signed(
                &notify_ix,
                &[
                    ctx.accounts.prize_authority.to_account_info(),
                    ctx.accounts.steel_pool.to_account_info(),
                ],
                &[prize_auth_seeds],
            ).map_err(|e| {
                msg!("CPI notify_pool_sol_deposit failed: {:?}", e);
                PokerError::InvalidAccountData
            })?;
        }

        // Direct lamport transfers AFTER CPI (fastpoker owns table PDA).
        // Debit fee_total from table. crank_cut goes to vault (for distribute_crank_rewards).
        **table.to_account_info().try_borrow_mut_lamports()? -= fee_total;
        **ctx.accounts.treasury.to_account_info().try_borrow_mut_lamports()? += treasury_share;
        **ctx.accounts.steel_pool.to_account_info().try_borrow_mut_lamports()? += staker_share;
        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? += crank_cut;

        table.entry_fees_escrowed = 0;
        msg!("Fee {} lamports: treasury={}, pool={}, vault crank_cut={}", fee_total, treasury_share, staker_share, crank_cut);
    }

    table.prizes_distributed = true;

    // --- Emit event for off-chain indexing ---
    emit!(PrizesDistributed {
        table: table.key(),
        table_id: table.table_id,
        game_type: table.game_type as u8,
        winner: prize_winners[0],
        prize_pool: poker_pool,
        payouts: prize_winners.iter().zip(poker_amounts.iter())
            .map(|(w, a)| PrizeEntry { wallet: *w, amount: *a })
            .collect(),
    });

    msg!("✅ Prizes distributed ({} positions, POKER={}, SOL={}, fees={})",
        num_payouts, poker_pool, sol_prize_pool, fee_total);
    Ok(())
}

/// Single prize entry for the PrizesDistributed event
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PrizeEntry {
    pub wallet: Pubkey,
    pub amount: u64,
}
