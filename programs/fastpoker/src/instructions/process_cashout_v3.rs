use anchor_lang::prelude::*;
use anchor_spl::token;
use crate::state::*;
use crate::state::player_table_marker::PLAYER_TABLE_MARKER_SEED;
use crate::errors::PokerError;
use crate::events::PlayerLeft;
use crate::constants::*;

/// Unified L1 cashout for cash game players.
///
/// Combines the best of v1 (seat clearing) and v2 (vault-based transfer + nonce safety):
///   1. Reads cashout_chips/nonce from Anchor-deserialized seat (no raw byte offsets)
///   2. Transfers SOL from vault PDA (where join_table deposited) — NOT table PDA
///   3. Uses CashoutReceipt nonce to prevent double cashout
///   4. Clears the seat fully (status → Empty, masks updated)
///   5. Writes chip lock + kick tracking to PlayerTableMarker (anti-ratholing)
///   6. SPL token support via optional accounts
///
/// No ER/delegation assumptions. All accounts are program-owned on L1.
/// PERMISSIONLESS — anyone can call. Amounts are contract-determined from seat state.

#[derive(Accounts)]
#[instruction(seat_index: u8)]
pub struct ProcessCashoutV3<'info> {
    /// Crank or anyone paying for the TX
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Table PDA — needed for vault/seat seed derivation + mask updates.
    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
        constraint = table.game_type == GameType::CashGame @ PokerError::InvalidGameType,
    )]
    pub table: Account<'info, Table>,

    /// Seat PDA — must be Leaving with cashout snapshot set.
    #[account(
        mut,
        seeds = [SEAT_SEED, table.key().as_ref(), &[seat_index]],
        bump = seat.bump,
        constraint = seat.table == table.key() @ PokerError::SeatNotAtTable,
        constraint = seat.status == SeatStatus::Leaving @ PokerError::SeatNotLeaving,
    )]
    pub seat: Account<'info, PlayerSeat>,

    /// TableVault PDA — holds player SOL for cash games. Source of funds.
    #[account(
        mut,
        seeds = [VAULT_SEED, table.key().as_ref()],
        bump = vault.bump,
        constraint = vault.table == table.key() @ PokerError::InvalidAccountData,
    )]
    pub vault: Account<'info, TableVault>,

    /// CashoutReceipt PDA — nonce-based idempotency.
    #[account(
        mut,
        seeds = [RECEIPT_SEED, table.key().as_ref(), &[seat_index]],
        bump = receipt.bump,
    )]
    pub receipt: Account<'info, CashoutReceipt>,

    /// Player's wallet — receives SOL. Validated against seat.wallet.
    /// CHECK: Validated by constraint below.
    #[account(
        mut,
        constraint = player_wallet.key() == seat.wallet @ PokerError::InvalidAccountData,
    )]
    pub player_wallet: AccountInfo<'info>,

    /// PlayerTableMarker PDA — chip lock + kick tracking (anti-ratholing).
    /// CHECK: Validated by seeds. May not exist for old tables.
    #[account(
        mut,
        seeds = [PLAYER_TABLE_MARKER_SEED, player_wallet.key().as_ref(), table.key().as_ref()],
        bump,
    )]
    pub marker: Option<AccountInfo<'info>>,

    /// Player's token account — receives SPL tokens (SPL tables only).
    /// CHECK: Validated mint against vault.token_mint when used.
    #[account(mut)]
    pub player_token_account: Option<AccountInfo<'info>>,

    /// Table's token escrow ATA — source of SPL tokens (SPL tables only).
    /// CHECK: Validated mint against vault.token_mint when used.
    #[account(mut)]
    pub table_token_account: Option<AccountInfo<'info>>,

    /// CHECK: SPL Token program (SPL tables only).
    pub token_program: Option<AccountInfo<'info>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ProcessCashoutV3>, seat_index: u8) -> Result<()> {
    let table = &mut ctx.accounts.table;
    let seat = &mut ctx.accounts.seat;
    let vault = &mut ctx.accounts.vault;
    let receipt = &mut ctx.accounts.receipt;

    // === Read cashout values from Anchor-deserialized seat ===
    let cashout_chips = seat.cashout_chips;
    let cashout_nonce = seat.cashout_nonce;
    let player_wallet_key = seat.wallet;
    let seat_num = seat.seat_number;

    // === Nonce check — prevent double cashout ===
    require!(
        cashout_nonce > receipt.last_processed_nonce,
        PokerError::NonceAlreadyProcessed
    );

    let is_sol_table = vault.token_mint == Pubkey::default();

    // === Transfer funds from vault to player ===
    if cashout_chips > 0 {
        if is_sol_table {
            // SOL table: transfer lamports from vault PDA to player wallet
            let vault_lamports = vault.to_account_info().lamports();
            let rent = Rent::get()?;
            let vault_rent = rent.minimum_balance(TableVault::SIZE);
            require!(
                vault_lamports >= cashout_chips.checked_add(vault_rent).unwrap_or(u64::MAX),
                PokerError::VaultInsufficient
            );

            // Handle drained wallets: payer covers rent shortfall
            let wallet_rent = rent.minimum_balance(0);
            let wallet_current = ctx.accounts.player_wallet.lamports();
            let wallet_after = wallet_current.checked_add(cashout_chips).unwrap_or(u64::MAX);
            if wallet_after < wallet_rent {
                let shortfall = wallet_rent.saturating_sub(wallet_after);
                anchor_lang::system_program::transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.to_account_info(),
                        anchor_lang::system_program::Transfer {
                            from: ctx.accounts.payer.to_account_info(),
                            to: ctx.accounts.player_wallet.to_account_info(),
                        },
                    ),
                    shortfall,
                )?;
                msg!("Payer topped up wallet rent: {} lamports", shortfall);
            }

            **vault.to_account_info().try_borrow_mut_lamports()? -= cashout_chips;
            **ctx.accounts.player_wallet.try_borrow_mut_lamports()? += cashout_chips;
            msg!("Cashout: {} lamports from vault to wallet", cashout_chips);
        } else {
            // SPL token table: transfer tokens from table escrow to player ATA
            let player_token = ctx.accounts.player_token_account.as_ref()
                .ok_or(PokerError::InvalidTokenAccount)?;
            let table_token = ctx.accounts.table_token_account.as_ref()
                .ok_or(PokerError::InvalidTokenAccount)?;
            let token_prog = ctx.accounts.token_program.as_ref()
                .ok_or(PokerError::InvalidTokenProgram)?;

            require!(
                token_prog.key() == anchor_spl::token::ID,
                PokerError::InvalidTokenProgram
            );

            // Validate player token account: mint + owner
            {
                let pt_data = player_token.try_borrow_data()?;
                require!(pt_data.len() >= 64, PokerError::InvalidTokenAccount);
                let pt_mint = Pubkey::try_from(&pt_data[0..32])
                    .map_err(|_| PokerError::InvalidTokenAccount)?;
                require!(pt_mint == vault.token_mint, PokerError::InvalidTokenMint);
                let pt_owner = Pubkey::try_from(&pt_data[32..64])
                    .map_err(|_| PokerError::InvalidTokenAccount)?;
                require!(pt_owner == player_wallet_key, PokerError::InvalidTokenAccount);
            }

            // Validate table token account: mint + owner (must be table PDA)
            {
                let tt_data = table_token.try_borrow_data()?;
                require!(tt_data.len() >= 64, PokerError::InvalidTokenAccount);
                let tt_mint = Pubkey::try_from(&tt_data[0..32])
                    .map_err(|_| PokerError::InvalidTokenAccount)?;
                require!(tt_mint == vault.token_mint, PokerError::InvalidTokenMint);
                let tt_owner = Pubkey::try_from(&tt_data[32..64])
                    .map_err(|_| PokerError::InvalidTokenAccount)?;
                require!(tt_owner == table.key(), PokerError::InvalidEscrow);
            }

            // Table PDA signs the token transfer
            let table_id = table.table_id;
            let tbl_bump = table.bump;
            let seeds = &[TABLE_SEED, table_id.as_ref(), &[tbl_bump]];
            let signer_seeds = &[&seeds[..]];

            token::transfer(
                CpiContext::new_with_signer(
                    token_prog.to_account_info(),
                    token::Transfer {
                        from: table_token.to_account_info(),
                        to: player_token.to_account_info(),
                        authority: table.to_account_info(),
                    },
                    signer_seeds,
                ),
                cashout_chips,
            )?;
            msg!("Cashout: {} tokens (mint {}) to player ATA", cashout_chips, vault.token_mint);
        }

        vault.total_withdrawn = vault.total_withdrawn
            .checked_add(cashout_chips)
            .ok_or(PokerError::Overflow)?;
    }

    // === Update receipt nonce ===
    receipt.last_processed_nonce = cashout_nonce;
    receipt.depositor = Pubkey::default();

    // === Write chip lock + kick tracking to PlayerTableMarker ===
    if let Some(marker_info) = &ctx.accounts.marker {
        let clock = Clock::get()?;
        let mut marker_data = marker_info.try_borrow_mut_data()?;

        // Write chip lock
        if marker_data.len() >= PlayerTableMarker::CHIP_LOCK_TIME_OFFSET + 8 {
            marker_data[PlayerTableMarker::CHIP_LOCK_CHIPS_OFFSET..PlayerTableMarker::CHIP_LOCK_CHIPS_OFFSET + 8]
                .copy_from_slice(&cashout_chips.to_le_bytes());
            marker_data[PlayerTableMarker::CHIP_LOCK_TIME_OFFSET..PlayerTableMarker::CHIP_LOCK_TIME_OFFSET + 8]
                .copy_from_slice(&clock.unix_timestamp.to_le_bytes());
            // Clear player field so marker doesn't block rejoining
            marker_data[8..40].copy_from_slice(&Pubkey::default().to_bytes());
            msg!("Chip lock: {} chips, 12h window", cashout_chips);
        }

        // Anti-abuse: detect kick (sit_out_button_count >= 3 or hands_since_bust >= 3)
        if marker_data.len() >= PlayerTableMarker::KICK_REASON_OFFSET + 1 {
            let was_kicked = seat.sit_out_button_count >= 3 || seat.hands_since_bust >= 3;
            if was_kicked {
                marker_data[PlayerTableMarker::KICK_TIME_OFFSET..PlayerTableMarker::KICK_TIME_OFFSET + 8]
                    .copy_from_slice(&clock.unix_timestamp.to_le_bytes());
                marker_data[PlayerTableMarker::KICK_REASON_OFFSET] = 1;
                msg!("Kick recorded: 30 min penalty window");
            } else {
                marker_data[PlayerTableMarker::KICK_TIME_OFFSET..PlayerTableMarker::KICK_TIME_OFFSET + 8]
                    .copy_from_slice(&0i64.to_le_bytes());
                marker_data[PlayerTableMarker::KICK_REASON_OFFSET] = 0;
            }
        }
    }

    // === Clear seat fully (from v1) ===
    seat.wallet = Pubkey::default();
    seat.session_key = Pubkey::default();
    seat.chips = 0;
    seat.bet_this_round = 0;
    seat.total_bet_this_hand = 0;
    seat.hole_cards_encrypted = [0; 64];
    seat.hole_cards_commitment = [0; 32];
    seat.hole_cards = [255, 255];
    seat.status = SeatStatus::Empty;
    seat.last_action_slot = 0;
    seat.missed_sb = false;
    seat.missed_bb = false;
    seat.posted_blind = false;
    seat.waiting_for_bb = false;
    seat.sit_out_button_count = 0;
    seat.hands_since_bust = 0;
    seat.auto_fold_count = 0;
    seat.missed_bb_count = 0;
    seat.paid_entry = false;
    seat.cashout_chips = 0;
    // DO NOT zero cashout_nonce — monotonically increasing per seat PDA
    seat.vault_reserve = 0;
    seat.sit_out_timestamp = 0;
    seat.time_bank_seconds = 0;
    seat.time_bank_active = false;

    // === Update table masks ===
    let mask = 1u16 << seat_num;
    if (table.seats_occupied & mask) != 0 {
        table.seats_occupied &= !mask;
        table.current_players = table.current_players.saturating_sub(1);
    }
    table.seats_folded &= !mask;
    table.seats_allin &= !mask;

    emit!(PlayerLeft {
        table: table.key(),
        player: player_wallet_key,
        seat_number: seat_num,
        chips_cashed_out: cashout_chips,
    });

    msg!(
        "Cashout v3: seat {} → {} {} to wallet {}. Nonce: {}. Seat cleared.",
        seat_index,
        cashout_chips,
        if is_sol_table { "lamports" } else { "tokens" },
        player_wallet_key,
        cashout_nonce
    );

    Ok(())
}
