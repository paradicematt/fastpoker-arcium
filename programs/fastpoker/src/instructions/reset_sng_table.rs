use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;
use crate::constants::*;
use crate::state::table_vault::TableVault;
use crate::hand_eval::CARD_NOT_DEALT;

/// Reset a completed SNG table for reuse. Zeros all seats, clears player-table
/// marker PDAs, and resets table state to Waiting phase so new players can join
/// without re-provisioning.
///
/// PERMISSIONLESS — anyone can call after prizes are distributed.
/// Table must be on L1 (not delegated) for Anchor to deserialize it.
///
/// remaining_accounts layout:
///   [0..max_players]              = seat PDAs (writable)
///   [max_players..2*max_players]  = marker PDAs (writable) — one per seat, derived
///                                   from the wallet that occupied that seat.
///                                   For empty seats, pass any valid program-owned PDA.

#[derive(Accounts)]
pub struct ResetSngTable<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
        constraint = table.phase == GamePhase::Complete @ PokerError::InvalidActionForPhase,
        constraint = table.prizes_distributed @ PokerError::PrizesNotDistributed,
        constraint = table.is_sit_and_go() @ PokerError::NotTournament,
    )]
    pub table: Account<'info, Table>,

    /// Vault PDA — verified by seeds. Crank reward check removed for SNG reset:
    /// SNG crank pools are tiny (micro-stakes) and distribute_crank_rewards often
    /// skips when the amount rounds to 0. The handler zeros crank_pool_accumulated
    /// on reset so the next tournament starts clean.
    #[account(
        seeds = [VAULT_SEED, table.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, TableVault>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, ResetSngTable<'info>>,
) -> Result<()> {
    let table = &mut ctx.accounts.table;
    let table_key = table.key();
    let max_players = table.max_players;
    let remaining = &ctx.remaining_accounts;

    // Require exactly 2*max_players remaining accounts: seats + markers
    require!(
        remaining.len() == (max_players as usize) * 2,
        PokerError::InvalidAccountCount
    );

    // --- Zero each seat PDA + clear corresponding marker PDA ---
    // Byte offsets in PlayerSeat account data
    let wallet_offset: usize = 8;                     // 8 disc + 0
    let session_key_offset: usize = 8 + 32;           // 40
    let table_ref_offset: usize = 8 + 32 + 32;        // 72 (table pubkey — keep)
    let chips_offset: usize = 8 + 32 + 32 + 32;       // 104
    let bet_offset: usize = chips_offset + 8;          // 112
    let total_bet_offset: usize = bet_offset + 8;      // 120
    let encrypted_offset: usize = total_bet_offset + 8; // 128 (64 bytes)
    let commitment_offset: usize = encrypted_offset + 64; // 192 (32 bytes)
    let hole_cards_offset: usize = commitment_offset + 32; // 224 (2 bytes)
    let seat_num_offset: usize = hole_cards_offset + 2;    // 226
    let status_offset: usize = seat_num_offset + 1;        // 227
    let paid_entry_offset: usize = 238;                    // after misc flags

    // Marker PDA: player field at offset 8 (after 8-byte discriminator)
    let marker_player_offset: usize = 8;

    for i in 0..max_players {
        let seat_info = &remaining[i as usize];
        let marker_info = &remaining[(max_players as usize) + (i as usize)];

        // Validate seat PDA derivation
        let (expected_pda, _) = Pubkey::find_program_address(
            &[SEAT_SEED, table_key.as_ref(), &[i]],
            &crate::ID,
        );
        require!(seat_info.key() == expected_pda, PokerError::SeatNotAtTable);
        require!(seat_info.is_writable, PokerError::InvalidAccountData);
        require!(seat_info.owner == &crate::ID, PokerError::InvalidAccountData);

        // Read the wallet from the seat BEFORE zeroing (need it for marker PDA validation)
        let seat_wallet: Pubkey = {
            let data = seat_info.try_borrow_data()?;
            require!(data.len() >= PlayerSeat::SIZE, PokerError::InvalidAccountData);
            Pubkey::try_from(&data[wallet_offset..wallet_offset + 32]).unwrap_or_default()
        };

        // Zero seat data
        {
            let mut data = seat_info.try_borrow_mut_data()?;

            // Zero wallet (32 bytes at offset 8)
            data[wallet_offset..wallet_offset + 32].copy_from_slice(&[0u8; 32]);
            // Zero session key
            data[session_key_offset..session_key_offset + 32].copy_from_slice(&[0u8; 32]);
            // Keep table reference (offset 72..104) — seat still belongs to this table
            // Zero chips
            data[chips_offset..chips_offset + 8].copy_from_slice(&0u64.to_le_bytes());
            // Zero bet_this_round
            data[bet_offset..bet_offset + 8].copy_from_slice(&0u64.to_le_bytes());
            // Zero total_bet_this_hand
            data[total_bet_offset..total_bet_offset + 8].copy_from_slice(&0u64.to_le_bytes());
            // Zero encrypted cards
            data[encrypted_offset..encrypted_offset + 64].copy_from_slice(&[0u8; 64]);
            // Zero commitment
            data[commitment_offset..commitment_offset + 32].copy_from_slice(&[0u8; 32]);
            // Set hole cards to NOT_DEALT
            data[hole_cards_offset] = CARD_NOT_DEALT;
            data[hole_cards_offset + 1] = CARD_NOT_DEALT;
            // Keep seat_number (offset 226) — position is fixed
            // Set status to Empty (0)
            data[status_offset] = 0; // SeatStatus::Empty

            // Zero remaining per-hand fields (after status through end of known fields)
            // paid_entry = false
            if paid_entry_offset < data.len() {
                data[paid_entry_offset] = 0;
            }
        }

        // Zero the marker PDA if seat had a player
        if seat_wallet != Pubkey::default() {
            // Validate marker PDA derivation: seeds = ["player_table", wallet, table]
            let (expected_marker, _) = Pubkey::find_program_address(
                &[b"player_table", seat_wallet.as_ref(), table_key.as_ref()],
                &crate::ID,
            );
            require!(marker_info.key() == expected_marker, PokerError::InvalidAccountData);
            require!(marker_info.is_writable, PokerError::InvalidAccountData);
            require!(marker_info.owner == &crate::ID, PokerError::InvalidAccountData);

            // Zero the player field in the marker (offset 8, 32 bytes)
            // This allows join_table's init_if_needed to treat it as a fresh marker
            let mut marker_data = marker_info.try_borrow_mut_data()?;
            if marker_data.len() > marker_player_offset + 32 {
                marker_data[marker_player_offset..marker_player_offset + 32]
                    .copy_from_slice(&[0u8; 32]);
            }
            msg!("Reset marker for seat {} (player={})", i, seat_wallet);
        }

        msg!("Reset seat {} to Empty", i);
    }

    // --- Reset table state ---
    table.phase = GamePhase::Waiting;
    table.current_players = 0;
    table.pot = 0;
    table.min_bet = 0;
    table.community_cards = [CARD_NOT_DEALT; 5];
    table.prize_pool = 0;
    table.entry_fees_escrowed = 0;
    table.prizes_distributed = false;
    table.crank_pool_accumulated = 0; // Zero for next tournament (SNG crank rewards are best-effort)
    table.eliminated_count = 0;
    table.eliminated_seats = [0; 9];
    table.seats_occupied = 0;
    table.seats_folded = 0;
    table.seats_allin = 0;
    table.revealed_hands = [255; 18];
    table.hand_results = [0; 9];
    table.pre_community = [255; 5];
    table.deck_seed = [0; 32];
    table.deck_index = 0;
    table.actions_this_round = 0;
    table.flop_reached = false;

    // Reset blind level for next tournament
    table.blind_level = 0;
    table.tournament_start_slot = 0;

    // Advance dealer button for fairness across games
    table.dealer_button = (table.dealer_button + 1) % max_players;

    msg!(
        "✅ SNG table reset to Waiting (hand_number={}, next_dealer={})",
        table.hand_number,
        table.dealer_button
    );
    Ok(())
}
