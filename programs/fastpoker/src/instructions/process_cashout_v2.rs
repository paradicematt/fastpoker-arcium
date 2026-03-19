use anchor_lang::prelude::*;
use anchor_spl::token;
use crate::state::*;
use crate::errors::PokerError;
use crate::constants::*;

// Seat account byte offsets (includes 8-byte Anchor discriminator)
const SEAT_OFF_WALLET: usize = 8;
const SEAT_OFF_TABLE: usize = 72;
const SEAT_OFF_STATUS: usize = 227;
const SEAT_OFF_CASHOUT_CHIPS: usize = 246;
const SEAT_OFF_CASHOUT_NONCE: usize = 254;

/// Process cashout for a Leaving player — runs on L1.
/// Reads ALL values from committed seat account data — NO caller-provided amounts.
/// Requires ER CommitState before calling to sync seat data to L1.
///
/// For SOL tables: transfers lamports from vault to player wallet.
/// For SPL token tables: transfers tokens from table escrow to player's token account.
/// The vault.token_mint field determines which path to take.
///
/// Security (100% contract-level, zero frontend dependency):
/// 1. cashout_chips/nonce READ from seat account — caller CANNOT inflate.
/// 2. player_wallet validated against seat.wallet field.
/// 3. seat.status must be Leaving (6).
/// 4. CashoutReceipt nonce prevents double cashout.
/// 5. Vault balance check prevents overspending (SOL) / escrow balance check (SPL).
/// 6. SPL mint validated against vault.token_mint — prevents wrong-token withdrawal.
/// 7. Permissionless — anyone can trigger, amounts are contract-determined.

#[derive(Accounts)]
#[instruction(seat_index: u8)]
pub struct ProcessCashoutV2<'info> {
    /// Crank or anyone paying for the TX
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Table PDA — needed for vault/receipt/seat seed derivation.
    /// Also serves as CPI signer for SPL token transfers (table owns escrow).
    /// CHECK: Validated by seed derivation of vault and receipt.
    pub table: UncheckedAccount<'info>,

    /// Seat PDA — read-only. Contains wallet, status, cashout_chips, cashout_nonce.
    /// May be owned by Delegation Program during delegation — that's OK, we only read.
    /// CHECK: Validated by PDA seed derivation.
    #[account(
        seeds = [SEAT_SEED, table.key().as_ref(), &[seat_index]],
        bump,
    )]
    pub seat: UncheckedAccount<'info>,

    /// TableVault PDA — holds SOL (for SOL tables), tracks deposits/withdrawals.
    /// Also L1 source of truth for token_mint. Never delegated.
    #[account(
        mut,
        seeds = [VAULT_SEED, table.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, TableVault>,

    /// CashoutReceipt PDA — nonce-based idempotency
    #[account(
        mut,
        seeds = [RECEIPT_SEED, table.key().as_ref(), &[seat_index]],
        bump = receipt.bump,
    )]
    pub receipt: Account<'info, CashoutReceipt>,

    /// Player's wallet — receives SOL directly (SOL tables).
    /// CHECK: Validated against seat.wallet field.
    #[account(mut)]
    pub player_wallet: AccountInfo<'info>,

    /// PlayerTableMarker PDA — for chip lock (anti-ratholing)
    /// CHECK: Validated by seeds. May not exist if old table — that's OK.
    #[account(
        mut,
        seeds = [PLAYER_TABLE_MARKER_SEED, player_wallet.key().as_ref(), table.key().as_ref()],
        bump,
    )]
    pub marker: Option<AccountInfo<'info>>,

    /// Player's token account — receives SPL tokens (SPL tables).
    /// CHECK: Validated mint against vault.token_mint when used.
    #[account(mut)]
    pub player_token_account: Option<AccountInfo<'info>>,

    /// Table's token escrow ATA — source of SPL tokens (SPL tables).
    /// CHECK: Validated mint against vault.token_mint when used.
    #[account(mut)]
    pub table_token_account: Option<AccountInfo<'info>>,

    /// CHECK: SPL Token program.
    pub token_program: Option<AccountInfo<'info>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ProcessCashoutV2>, seat_index: u8) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let receipt = &mut ctx.accounts.receipt;

    // === Read ALL values from seat account bytes — NO trusted parameters ===
    let seat_data = ctx.accounts.seat.try_borrow_data()?;
    require!(
        seat_data.len() >= SEAT_OFF_CASHOUT_NONCE + 8,
        PokerError::InvalidAccountData
    );

    // Verify seat belongs to this table
    let seat_table = Pubkey::try_from(&seat_data[SEAT_OFF_TABLE..SEAT_OFF_TABLE + 32])
        .map_err(|_| PokerError::InvalidAccountData)?;
    require!(
        seat_table == ctx.accounts.table.key(),
        PokerError::SeatNotAtTable
    );

    // Read status — must be Leaving (6) or SittingOut (4) with pending cashout.
    // SittingOut can have cashout_chips set when crank_remove_player or settle
    // snapshots chips before the status transitions through to Leaving.
    // The nonce check below prevents double cashout regardless of status.
    let status = seat_data[SEAT_OFF_STATUS];
    require!(status == 6 || status == 4, PokerError::SeatNotLeaving); // 6=Leaving, 4=SittingOut

    // Read wallet — validate against player_wallet account
    let seat_wallet = Pubkey::try_from(&seat_data[SEAT_OFF_WALLET..SEAT_OFF_WALLET + 32])
        .map_err(|_| PokerError::InvalidAccountData)?;
    require!(
        ctx.accounts.player_wallet.key() == seat_wallet,
        PokerError::InvalidAccountData
    );

    // Read cashout values from committed seat data
    let cashout_chips = u64::from_le_bytes(
        seat_data[SEAT_OFF_CASHOUT_CHIPS..SEAT_OFF_CASHOUT_CHIPS + 8]
            .try_into()
            .map_err(|_| PokerError::InvalidAccountData)?
    );
    let cashout_nonce = u64::from_le_bytes(
        seat_data[SEAT_OFF_CASHOUT_NONCE..SEAT_OFF_CASHOUT_NONCE + 8]
            .try_into()
            .map_err(|_| PokerError::InvalidAccountData)?
    );

    drop(seat_data);

    // === Nonce check — prevent double cashout ===
    require!(
        cashout_nonce > receipt.last_processed_nonce,
        PokerError::NonceAlreadyProcessed
    );

    let is_sol_table = vault.token_mint == Pubkey::default();

    // === Transfer funds to player ===
    if cashout_chips > 0 {
        if is_sol_table {
            // ── SOL table: transfer lamports from vault to player wallet ──
            let vault_lamports = vault.to_account_info().lamports();
            let rent = Rent::get()?;
            let vault_rent = rent.minimum_balance(TableVault::SIZE);
            require!(
                vault_lamports >= cashout_chips.checked_add(vault_rent).unwrap_or(u64::MAX),
                PokerError::VaultInsufficient
            );

            // If the player wallet doesn't exist or would end up below rent-exempt
            // for a 0-byte system account after receiving cashout_chips, the payer
            // covers the shortfall. This prevents InsufficientFundsForRent when
            // wallets have been drained/closed and the cashout is small.
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
            msg!("Cashout: {} lamports to wallet", cashout_chips);
        } else {
            // ── SPL token table: transfer tokens from table escrow to player ATA ──
            let player_token = ctx.accounts.player_token_account.as_ref()
                .ok_or(PokerError::InvalidTokenAccount)?;
            let table_token = ctx.accounts.table_token_account.as_ref()
                .ok_or(PokerError::InvalidTokenAccount)?;
            let token_prog = ctx.accounts.token_program.as_ref()
                .ok_or(PokerError::InvalidTokenProgram)?;

            // Strict validation: token program must be real SPL Token
            require!(
                token_prog.key() == anchor_spl::token::ID,
                PokerError::InvalidTokenProgram
            );

            // Validate player token account: mint matches AND owned by seat.wallet.
            // CT-1c FIX: Without owner check, permissionless caller could redirect
            // cashout tokens to any ATA with the right mint.
            // SPL Token Account layout: [0..32] = mint, [32..64] = owner.
            let player_data = player_token.try_borrow_data()?;
            require!(player_data.len() >= 64, PokerError::InvalidTokenAccount);
            let player_mint = Pubkey::try_from(&player_data[0..32])
                .map_err(|_| PokerError::InvalidTokenAccount)?;
            require!(player_mint == vault.token_mint, PokerError::InvalidTokenMint);
            let player_token_owner = Pubkey::try_from(&player_data[32..64])
                .map_err(|_| PokerError::InvalidTokenAccount)?;
            require!(player_token_owner == seat_wallet, PokerError::InvalidTokenAccount);
            drop(player_data);

            // Validate table token account: mint matches AND owned by table PDA.
            let table_data = table_token.try_borrow_data()?;
            require!(table_data.len() >= 64, PokerError::InvalidTokenAccount);
            let table_mint = Pubkey::try_from(&table_data[0..32])
                .map_err(|_| PokerError::InvalidTokenAccount)?;
            require!(table_mint == vault.token_mint, PokerError::InvalidTokenMint);
            let table_token_owner = Pubkey::try_from(&table_data[32..64])
                .map_err(|_| PokerError::InvalidTokenAccount)?;
            require!(table_token_owner == ctx.accounts.table.key(), PokerError::InvalidEscrow);
            drop(table_data);

            // Read table_id from vault's table reference to derive signer seeds.
            // We need the table's seeds to sign the token transfer.
            // The table account data may be a delegation stub, so we read table_id
            // from the vault which stores it indirectly via the table key.
            // The table PDA is derived as ["table", table_id] — we need table_id.
            // Since we can't read it from the delegation stub, we require it as
            // part of the seat data or use the table key itself.
            // WORKAROUND: Use the table AccountInfo directly and let the CPI
            // validate the signer. The table PDA owns the escrow ATA.
            let table_info = ctx.accounts.table.to_account_info();
            
            // Read table_id from table account if it has full data (421 bytes),
            // otherwise fall back to reading from vault (table PDA is the authority).
            let table_data_ref = table_info.try_borrow_data()?;
            if table_data_ref.len() >= 40 {
                // Full table data: discriminator(8) + table_id(32)
                let mut table_id = [0u8; 32];
                table_id.copy_from_slice(&table_data_ref[8..40]);
                let table_bump_offset = 341; // Table::bump offset
                let tbl_bump = if table_data_ref.len() > table_bump_offset {
                    table_data_ref[table_bump_offset]
                } else {
                    // Derive bump
                    let (_, bump) = Pubkey::find_program_address(
                        &[TABLE_SEED, table_id.as_ref()],
                        &crate::ID,
                    );
                    bump
                };
                drop(table_data_ref);

                let seeds = &[TABLE_SEED, table_id.as_ref(), &[tbl_bump]];
                let signer_seeds = &[&seeds[..]];

                token::transfer(
                    CpiContext::new_with_signer(
                        token_prog.to_account_info(),
                        token::Transfer {
                            from: table_token.to_account_info(),
                            to: player_token.to_account_info(),
                            authority: ctx.accounts.table.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    cashout_chips,
                )?;
            } else {
                // Delegation stub — cannot derive signer seeds. Abort.
                msg!("Table is delegation stub ({} bytes) — cannot sign SPL transfer. Undelegate table first.", table_data_ref.len());
                return Err(PokerError::InvalidAccountData.into());
            }

            msg!("Cashout: {} tokens (mint {}) to player ATA", cashout_chips, vault.token_mint);
        }

        vault.total_withdrawn = vault.total_withdrawn
            .checked_add(cashout_chips)
            .ok_or(PokerError::Overflow)?;
    }

    // === Update receipt nonce and clear depositor ===
    receipt.last_processed_nonce = cashout_nonce;
    receipt.depositor = Pubkey::default();

    // === Write chip lock + kick tracking to PlayerTableMarker ===
    if let Some(marker_info) = &ctx.accounts.marker {
        let mut marker_data = marker_info.try_borrow_mut_data()?;
        if marker_data.len() >= PlayerTableMarker::CHIP_LOCK_TIME_OFFSET + 8 {
            marker_data[PlayerTableMarker::CHIP_LOCK_CHIPS_OFFSET..PlayerTableMarker::CHIP_LOCK_CHIPS_OFFSET + 8]
                .copy_from_slice(&cashout_chips.to_le_bytes());
            let clock = Clock::get()?;
            marker_data[PlayerTableMarker::CHIP_LOCK_TIME_OFFSET..PlayerTableMarker::CHIP_LOCK_TIME_OFFSET + 8]
                .copy_from_slice(&clock.unix_timestamp.to_le_bytes());
            marker_data[8..40].copy_from_slice(&Pubkey::default().to_bytes());
            msg!("Chip lock written: {} chips at time {}", cashout_chips, clock.unix_timestamp);

            // Anti-abuse: detect if this was a kick (sit_out_button_count >= 3 or hands_since_bust >= 3)
            // These are the same conditions crank_kick_inactive uses on TEE.
            if marker_data.len() >= PlayerTableMarker::KICK_REASON_OFFSET + 1 {
                let seat_data = ctx.accounts.seat.try_borrow_data()?;
                let was_kicked = if seat_data.len() > 242 {
                    let sit_out_count = seat_data[240]; // sit_out_button_count
                    let bust_count = seat_data[241]; // hands_since_bust
                    sit_out_count >= 3 || bust_count >= 3
                } else {
                    false
                };
                drop(seat_data);

                if was_kicked {
                    marker_data[PlayerTableMarker::KICK_TIME_OFFSET..PlayerTableMarker::KICK_TIME_OFFSET + 8]
                        .copy_from_slice(&clock.unix_timestamp.to_le_bytes());
                    marker_data[PlayerTableMarker::KICK_REASON_OFFSET] = 1; // kicked
                    msg!("Kick recorded: player was auto-removed (penalty window: 30 min)");
                } else {
                    // Clear kick data for voluntary leaves
                    marker_data[PlayerTableMarker::KICK_TIME_OFFSET..PlayerTableMarker::KICK_TIME_OFFSET + 8]
                        .copy_from_slice(&0i64.to_le_bytes());
                    marker_data[PlayerTableMarker::KICK_REASON_OFFSET] = 0;
                }
            }
        }
    }

    msg!(
        "Cashout processed: seat {} -> {} {} to wallet {}. Nonce: {}",
        seat_index,
        cashout_chips,
        if is_sol_table { "lamports" } else { "tokens" },
        ctx.accounts.player_wallet.key(),
        cashout_nonce
    );

    Ok(())
}
