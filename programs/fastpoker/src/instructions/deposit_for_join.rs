use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token;
use crate::state::*;
use crate::state::player::{PlayerAccount, PLAYER_SEED};
use crate::state::player_table_marker::PLAYER_TABLE_MARKER_SEED;
use crate::errors::PokerError;
use crate::constants::*;

/// Step 1 of the two-step join for delegated cash game tables.
/// Runs on L1 where the vault lives. The table may be delegation-owned (unreadable),
/// so we use UncheckedAccount for it and derive vault PDA from the table pubkey.
///
/// For SOL tables: deposits SOL to the vault PDA.
/// For SPL token tables: transfers tokens to the table's token escrow ATA.
/// The vault.token_mint field (set at table creation) determines which path to take.
///
/// Player creates receipt + marker + deposit_proof PDAs.
/// The crank/API then delegates deposit_proof to ER and calls `seat_player`.

#[derive(Accounts)]
#[instruction(seat_index: u8, buy_in: u64, reserve: u64)]
pub struct DepositForJoin<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    /// Player account — must be registered
    #[account(
        mut,
        seeds = [PLAYER_SEED, player.key().as_ref()],
        bump = player_account.bump,
        constraint = player_account.is_registered @ PokerError::PlayerNotRegistered,
    )]
    pub player_account: Account<'info, PlayerAccount>,

    /// CHECK: Table pubkey — may be delegation-owned on L1.
    /// Only used for PDA derivation; we don't read its data.
    pub table: UncheckedAccount<'info>,

    /// Vault PDA — L1 source of truth for token_mint. Never delegated.
    #[account(
        mut,
        seeds = [VAULT_SEED, table.key().as_ref()],
        bump = vault.bump,
        constraint = vault.table == table.key() @ PokerError::InvalidAccountData,
    )]
    pub vault: Account<'info, TableVault>,

    /// CashoutReceipt — idempotent cashout tracking per seat.
    #[account(
        init_if_needed,
        payer = player,
        space = CashoutReceipt::SIZE,
        seeds = [RECEIPT_SEED, table.key().as_ref(), &[seat_index]],
        bump
    )]
    pub receipt: Account<'info, CashoutReceipt>,

    /// PlayerTableMarker — prevents same player joining multiple seats.
    #[account(
        init_if_needed,
        payer = player,
        space = PlayerTableMarker::SIZE,
        seeds = [PLAYER_TABLE_MARKER_SEED, player.key().as_ref(), table.key().as_ref()],
        bump
    )]
    pub player_table_marker: Account<'info, PlayerTableMarker>,

    /// DepositProof — stores deposit amounts for on-chain validation by seat_player on ER.
    /// Delegated to ER after creation so seat_player can read it.
    #[account(
        init_if_needed,
        payer = player,
        space = DepositProof::SIZE,
        seeds = [DEPOSIT_PROOF_SEED, table.key().as_ref(), &[seat_index]],
        bump
    )]
    pub deposit_proof: Account<'info, DepositProof>,

    /// Player's token account — pass program_id placeholder for SOL tables.
    /// CHECK: Validated when used for SPL transfer; mint checked against vault.token_mint.
    #[account(mut)]
    pub player_token_account: Option<UncheckedAccount<'info>>,

    /// Table's token escrow ATA — pass program_id placeholder for SOL tables.
    /// CHECK: Validated when used for SPL transfer; mint checked against vault.token_mint.
    #[account(mut)]
    pub table_token_account: Option<UncheckedAccount<'info>>,

    /// CHECK: SPL Token program — pass program_id placeholder for SOL tables.
    pub token_program: Option<UncheckedAccount<'info>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<DepositForJoin>, seat_index: u8, buy_in: u64, reserve: u64) -> Result<()> {
    let player = &ctx.accounts.player;
    let vault = &mut ctx.accounts.vault;
    let receipt = &mut ctx.accounts.receipt;
    let marker = &mut ctx.accounts.player_table_marker;
    let proof = &mut ctx.accounts.deposit_proof;
    let table_key = ctx.accounts.table.key();

    // Prevent double-join: if marker already has a player set, this player is already seated
    if marker.player != Pubkey::default() && marker.player != player.key() {
        return Err(PokerError::PlayerAlreadySeated.into());
    }

    // Prevent overfill: if receipt already has a depositor (different player), reject.
    // This stops a second player from depositing to an already-occupied seat,
    // which would leave their funds stuck with no way to cashout.
    if receipt.depositor != Pubkey::default() && receipt.depositor != player.key() {
        return Err(PokerError::SeatOccupied.into());
    }

    // ── Anti-ratholing enforcement ──
    // If the same player previously left this table within CHIP_LOCK_DURATION (12h),
    // they must buy in with at least as many chips as they left with.
    // This prevents "ratholing" — leaving after a big win and re-joining with min buy-in.
    // Uses unix_timestamp for TEE compatibility (Clock::slot doesn't advance on ER).
    {
        // Read chip lock from raw marker bytes (trailing fields not in Anchor struct)
        let marker_info = marker.to_account_info();
        let marker_data = marker_info.try_borrow_data()?;
        if marker_data.len() >= PlayerTableMarker::CHIP_LOCK_TIME_OFFSET + 8 {
            let lock_chips = u64::from_le_bytes(
                marker_data[PlayerTableMarker::CHIP_LOCK_CHIPS_OFFSET..PlayerTableMarker::CHIP_LOCK_CHIPS_OFFSET + 8]
                    .try_into().unwrap_or([0; 8])
            );
            let lock_time = i64::from_le_bytes(
                marker_data[PlayerTableMarker::CHIP_LOCK_TIME_OFFSET..PlayerTableMarker::CHIP_LOCK_TIME_OFFSET + 8]
                    .try_into().unwrap_or([0; 8])
            );
            drop(marker_data);

            if lock_chips > 0 && lock_time > 0 {
                let clock = Clock::get()?;
                let elapsed = clock.unix_timestamp.saturating_sub(lock_time);
                if elapsed < PlayerTableMarker::CHIP_LOCK_DURATION {
                    // Lock still active — enforce minimum buy-in
                    require!(
                        buy_in >= lock_chips,
                        PokerError::RatholingBuyInTooLow
                    );
                    msg!(
                        "Anti-rathole: player left with {} chips {}s ago, buying in with {} (min={})",
                        lock_chips, elapsed, buy_in, lock_chips
                    );
                }
                // Lock expired — normal buy-in rules apply
            }
        } else {
            drop(marker_data);
        }
    }

    let total_deposit = buy_in.checked_add(reserve).ok_or(PokerError::Overflow)?;
    let is_sol_table = vault.token_mint == Pubkey::default();

    // Idempotent re-deposit: if same player already deposited to this seat and proof
    // is not yet consumed (seating hasn't happened), skip the SOL/SPL transfer.
    // The vault already holds their funds — just update proof fields below.
    let is_redeposit = proof.depositor == player.key()
        && !proof.consumed
        && proof.buy_in > 0;

    if is_redeposit {
        msg!(
            "Re-deposit detected: player {} already deposited {} for seat {} — skipping transfer, updating proof",
            player.key(), proof.buy_in + proof.reserve, seat_index
        );
    }

    if total_deposit > 0 && !is_redeposit {
        if is_sol_table {
            // ── SOL table: transfer lamports to vault PDA ──
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: player.to_account_info(),
                        to: vault.to_account_info(),
                    },
                ),
                total_deposit,
            )?;
            msg!("Deposited {} lamports to vault", total_deposit);
        } else {
            // ── SPL token table: transfer tokens to table's escrow ATA ──
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

            // Validate player token account mint matches vault.token_mint
            let player_data = player_token.try_borrow_data()?;
            require!(player_data.len() >= 64, PokerError::InvalidTokenAccount);
            let player_mint = Pubkey::try_from(&player_data[0..32])
                .map_err(|_| PokerError::InvalidTokenAccount)?;
            require!(
                player_mint == vault.token_mint,
                PokerError::InvalidTokenMint
            );
            drop(player_data);

            // Validate table token account mint AND owner matches table PDA.
            // CT-1 FIX: Without owner check, attacker could deposit to their own ATA
            // (same mint) and get seated with chips backed by nothing in the escrow.
            // SPL Token Account layout: [0..32] = mint, [32..64] = owner.
            let table_data = table_token.try_borrow_data()?;
            require!(table_data.len() >= 64, PokerError::InvalidTokenAccount);
            let table_mint = Pubkey::try_from(&table_data[0..32])
                .map_err(|_| PokerError::InvalidTokenAccount)?;
            require!(
                table_mint == vault.token_mint,
                PokerError::InvalidTokenMint
            );
            let table_token_owner = Pubkey::try_from(&table_data[32..64])
                .map_err(|_| PokerError::InvalidTokenAccount)?;
            require!(
                table_token_owner == table_key,
                PokerError::InvalidEscrow
            );
            drop(table_data);

            token::transfer(
                CpiContext::new(
                    token_prog.to_account_info(),
                    token::Transfer {
                        from: player_token.to_account_info(),
                        to: table_token.to_account_info(),
                        authority: player.to_account_info(),
                    },
                ),
                total_deposit,
            )?;
            msg!("Deposited {} tokens (mint {}) to table escrow", total_deposit, vault.token_mint);
        }

        vault.total_deposited = vault.total_deposited
            .checked_add(total_deposit)
            .ok_or(PokerError::Overflow)?;
    }

    // Init/update receipt
    receipt.table = table_key;
    receipt.seat_index = seat_index;
    receipt.depositor = player.key();
    if receipt.last_processed_nonce == 0 && receipt.bump == 0 {
        receipt.bump = ctx.bumps.receipt;
    }
    // FIX (RC-NONCE): Do NOT reset last_processed_nonce.
    // Race condition: if deposit_for_join runs before clear_leaving_seat on TEE,
    // resetting nonce to 0 breaks the clear check (receipt.nonce >= seat.nonce),
    // permanently sticking the seat in Leaving status.
    // Safe: seat.cashout_nonce is monotonically increasing (never zeroed),
    // so new cashouts always exceed receipt.last_processed_nonce regardless.

    // Init/update deposit proof (for on-chain validation by seat_player)
    proof.table = table_key;
    proof.seat_index = seat_index;
    proof.depositor = player.key();
    proof.buy_in = buy_in;
    proof.reserve = reserve;
    proof.consumed = false;
    proof.deposit_timestamp = Clock::get()?.unix_timestamp;
    if proof.bump == 0 {
        proof.bump = ctx.bumps.deposit_proof;
    }

    // Init/update marker
    marker.player = player.key();
    marker.table = table_key;
    marker.seat_number = seat_index;
    if marker.bump == 0 {
        marker.bump = ctx.bumps.player_table_marker;
    }

    msg!(
        "Player {} deposited {} (buy_in={}, reserve={}) for seat {} at table {} ({})",
        player.key(), total_deposit, buy_in, reserve, seat_index, table_key,
        if is_sol_table { "SOL" } else { "SPL" }
    );

    Ok(())
}
