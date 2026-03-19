use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use crate::state::*;
use crate::errors::PokerError;
use crate::events::TableClosed;
use crate::constants::*;

// PlayerSeat byte offsets (includes 8-byte Anchor discriminator)
const SEAT_OFF_STATUS: usize = 227;
const SEAT_OFF_CASHOUT_CHIPS: usize = 246;

// TableVault byte offsets (includes 8-byte Anchor discriminator)
const VAULT_OFF_TABLE: usize = 8;
const VAULT_OFF_TOTAL_RAKE_DISTRIBUTED: usize = 65;

// TipJar byte offsets (includes 8-byte Anchor discriminator)
const TIP_JAR_OFF_TABLE: usize = 8;
const TIP_JAR_OFF_BALANCE: usize = 40;

#[derive(Accounts)]
pub struct CloseTable<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        close = creator,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
    )]
    pub table: Account<'info, Table>,

    /// CHECK: Validated against table.creator — receives table rent back
    #[account(mut, constraint = creator.key() == table.creator @ PokerError::InvalidAuthority)]
    pub creator: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Close a program-owned account and transfer its rent to destination.
/// Mirrors Anchor's own close pattern: transfer lamports + zero data.
/// Returns false (no-op) if the account isn't owned by our program.
fn close_account_to<'info>(
    account: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    program_id: &Pubkey,
) -> Result<bool> {
    if account.owner != program_id || account.lamports() == 0 {
        return Ok(false);
    }
    let lamports = account.lamports();
    let dest_lamports = destination.lamports();
    **account.try_borrow_mut_lamports()? = 0;
    **destination.try_borrow_mut_lamports()? = dest_lamports
        .checked_add(lamports)
        .ok_or(PokerError::Overflow)?;
    // Zero discriminator + data to prevent resurrection attacks
    account.try_borrow_mut_data()?.fill(0);
    Ok(true)
}

pub fn handler<'info>(ctx: Context<'_, '_, 'info, 'info, CloseTable<'info>>) -> Result<()> {
    let table = &ctx.accounts.table;
    let table_key = table.key();
    let creator_info = ctx.accounts.creator.to_account_info();
    let program_id = ctx.program_id;

    if table.is_sit_and_go() {
        // SNG: must be Complete with prizes distributed
        require!(
            table.phase == GamePhase::Complete,
            PokerError::GameNotComplete
        );
        require!(
            table.prizes_distributed,
            PokerError::PrizesNotDistributed
        );
    } else {
        // Cash game: no players, no unclaimed balances
        require!(
            table.current_players == 0,
            PokerError::TableNotWaiting
        );
        require!(
            table.unclaimed_balance_count == 0,
            PokerError::UnclaimedBalancesExist
        );
    }

    // Close seat-related PDAs passed as remaining_accounts.
    // Layout: groups of 4 per seat:
    //   [player_wallet, seat_pda, seat_cards_pda, marker_pda]
    //
    // - seat_pda (PlayerSeat) rent → player_wallet
    // - seat_cards_pda (SeatCards) rent → authority (deployer paid for these)
    // - marker_pda (PlayerTableMarker) rent → player_wallet
    //
    // Accounts that don't exist (owner != program) are silently skipped.
    let remaining = ctx.remaining_accounts;
    let mut seats_closed: u8 = 0;

    for chunk in remaining.chunks(4) {
        if chunk.len() < 4 { break; }

        let player_wallet = &chunk[0];
        let seat_info = &chunk[1];
        let seat_cards_info = &chunk[2];
        let marker_info = &chunk[3];

        // Validate seat belongs to this table (table pubkey at offset 72 in PlayerSeat)
        if seat_info.owner == program_id {
            let data = seat_info.try_borrow_data()?;
            if data.len() >= 104 {
                let table_in_seat = Pubkey::try_from(&data[72..104]).unwrap_or_default();
                let wallet_in_seat = Pubkey::try_from(&data[8..40]).unwrap_or_default();

                // SAFETY: Check for pending cashouts before allowing seat closure
                if data.len() > SEAT_OFF_CASHOUT_CHIPS + 8 {
                    let status = data[SEAT_OFF_STATUS];
                    let cashout_chips = u64::from_le_bytes(
                        data[SEAT_OFF_CASHOUT_CHIPS..SEAT_OFF_CASHOUT_CHIPS + 8]
                            .try_into().unwrap_or([0; 8])
                    );
                    if status == 6 || cashout_chips > 0 {
                        msg!("BLOCKED: seat has pending cashout (status={}, cashout_chips={})", status, cashout_chips);
                        return Err(PokerError::SeatHasPendingCashout.into());
                    }
                }

                drop(data);

                if table_in_seat != table_key {
                    msg!("Skipping seat: wrong table");
                    continue;
                }
                // Verify player_wallet matches the seat's wallet
                if wallet_in_seat != player_wallet.key() {
                    msg!("Skipping seat: player_wallet mismatch");
                    continue;
                }

                // Close seat → rent to player
                if close_account_to(seat_info, player_wallet, program_id)? {
                    msg!("Closed PlayerSeat, rent → {}", player_wallet.key());
                }
            }
        }

        // Validate seat_cards belongs to this table (table pubkey at offset 8 in SeatCards)
        if seat_cards_info.owner == program_id {
            let data = seat_cards_info.try_borrow_data()?;
            if data.len() >= 40 {
                let table_in_sc = Pubkey::try_from(&data[8..40]).unwrap_or_default();
                drop(data);

                if table_in_sc == table_key {
                    // Close seat_cards → rent to creator (who paid for table creation)
                    if close_account_to(seat_cards_info, &creator_info, program_id)? {
                        msg!("Closed SeatCards, rent → creator");
                    }
                }
            }
        }

        // Validate marker belongs to this table (table pubkey at offset 40 in PlayerTableMarker)
        if marker_info.owner == program_id {
            let data = marker_info.try_borrow_data()?;
            if data.len() >= 72 {
                let table_in_marker = Pubkey::try_from(&data[40..72]).unwrap_or_default();
                drop(data);

                if table_in_marker == table_key {
                    // Close marker → rent to player
                    if close_account_to(marker_info, player_wallet, program_id)? {
                        msg!("Closed PlayerTableMarker, rent → {}", player_wallet.key());
                    }
                }
            }
        }

        seats_closed += 1;
    }

    // Close vault and receipt PDAs for cash games.
    // Any remaining_accounts beyond the seat chunks (groups of 4) are vault/receipt PDAs.
    // Their rent goes to the creator.
    //
    // SAFETY: Before closing vault, verify it has no player funds or undistributed rake.
    let seat_accounts_used = (seats_closed as usize) * 4;
    if remaining.len() > seat_accounts_used {
        for extra in &remaining[seat_accounts_used..] {
            if extra.owner != program_id || extra.lamports() == 0 {
                continue;
            }

            // Check if this is a vault PDA by reading its discriminator + table field
            let is_vault = {
                let data = extra.try_borrow_data()?;
                let has_vault_disc = data.len() >= 8 && data[..8] == TableVault::DISCRIMINATOR[..];
                let matches_table = data.len() >= VAULT_OFF_TABLE + 32
                    && Pubkey::try_from(&data[VAULT_OFF_TABLE..VAULT_OFF_TABLE + 32]).unwrap_or_default() == table_key;
                has_vault_disc && matches_table
            };

            if is_vault {
                // Verify vault PDA derivation
                let (expected_vault, _) = Pubkey::find_program_address(
                    &[VAULT_SEED, table_key.as_ref()],
                    program_id,
                );
                require!(
                    extra.key() == expected_vault,
                    PokerError::InvalidAccountData
                );

                let rent = Rent::get()?;
                let vault_rent = rent.minimum_balance(extra.data_len());
                let vault_balance = extra.lamports();
                let excess = vault_balance.saturating_sub(vault_rent);

                if excess > 0 {
                    // Read total_rake_distributed from vault data
                    let total_rake_distributed = {
                        let data = extra.try_borrow_data()?;
                        if data.len() >= VAULT_OFF_TOTAL_RAKE_DISTRIBUTED + 8 {
                            u64::from_le_bytes(
                                data[VAULT_OFF_TOTAL_RAKE_DISTRIBUTED..VAULT_OFF_TOTAL_RAKE_DISTRIBUTED + 8]
                                    .try_into().unwrap_or([0; 8])
                            )
                        } else {
                            0u64
                        }
                    };

                    let undistributed_rake = table.rake_accumulated
                        .saturating_sub(total_rake_distributed);

                    // Check for undistributed rake
                    if undistributed_rake > 0 {
                        msg!("BLOCKED: vault has {} undistributed rake (accumulated={}, distributed={})",
                             undistributed_rake, table.rake_accumulated, total_rake_distributed);
                        return Err(PokerError::UndistributedRakeExists.into());
                    }

                    // Check for remaining player funds
                    let player_funds = excess.saturating_sub(undistributed_rake);
                    if player_funds > 0 {
                        msg!("BLOCKED: vault has {} player funds remaining (excess={}, rake={})",
                             player_funds, excess, undistributed_rake);
                        return Err(PokerError::VaultHasPlayerFunds.into());
                    }
                }
            }

            // Check if this is a TipJar PDA — refund remaining tip balance to creator
            let is_tip_jar = {
                let data = extra.try_borrow_data()?;
                let has_tj_disc = data.len() >= 8 && data[..8] == TipJar::DISCRIMINATOR[..];
                let matches_table = data.len() >= TIP_JAR_OFF_TABLE + 32
                    && Pubkey::try_from(&data[TIP_JAR_OFF_TABLE..TIP_JAR_OFF_TABLE + 32]).unwrap_or_default() == table_key;
                has_tj_disc && matches_table
            };

            if is_tip_jar {
                // Verify TipJar PDA derivation
                let (expected_tj, _) = Pubkey::find_program_address(
                    &[TIP_JAR_SEED, table_key.as_ref()],
                    program_id,
                );
                require!(
                    extra.key() == expected_tj,
                    PokerError::InvalidAccountData
                );

                // Log remaining tip balance being refunded
                let tip_balance = {
                    let data = extra.try_borrow_data()?;
                    if data.len() >= TIP_JAR_OFF_BALANCE + 8 {
                        u64::from_le_bytes(
                            data[TIP_JAR_OFF_BALANCE..TIP_JAR_OFF_BALANCE + 8]
                                .try_into().unwrap_or([0; 8])
                        )
                    } else { 0u64 }
                };
                if tip_balance > 0 {
                    msg!("TipJar refund: {} lamports → creator", tip_balance);
                }
            }

            // Safe to close — vault has only rent, tip jar balance → creator, or receipt PDA
            if close_account_to(extra, &creator_info, program_id)? {
                if is_tip_jar {
                    msg!("Closed TipJar, balance + rent → creator");
                } else {
                    msg!("Closed vault/receipt PDA, rent → creator");
                }
            }
        }
    }

    emit!(TableClosed {
        table: table.key(),
        final_rake: table.rake_accumulated,
    });

    msg!("Table closed: {:?} ({} seats cleaned up)", table.key(), seats_closed);
    Ok(())
}
