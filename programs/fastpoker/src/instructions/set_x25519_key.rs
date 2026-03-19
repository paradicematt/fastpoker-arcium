use anchor_lang::prelude::*;
use crate::state::*;
use crate::constants::*;

/// Set the player's x25519 public key for Arcium MPC card encryption.
///
/// The x25519 pubkey is stored in PlayerSeat.hole_cards_commitment (32 bytes, repurposed).
/// The crank reads this when building the arcium_deal instruction so that MPC encrypts
/// the player's hole cards to their key. The player's frontend holds the corresponding
/// x25519 secret key and uses it with RescueCipher to decrypt enc_card1 from SeatCards.
///
/// Must be called after join_table and before the game starts (phase == Waiting).
/// Can be called again to update the key (e.g., new browser session).

#[derive(Accounts)]
#[instruction(x25519_pubkey: [u8; 32])]
pub struct SetX25519Key<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(
        seeds = [TABLE_SEED, table.table_id.as_ref()],
        bump = table.bump,
    )]
    pub table: Account<'info, Table>,

    #[account(
        mut,
        seeds = [SEAT_SEED, table.key().as_ref(), &[seat.seat_number]],
        bump = seat.bump,
        constraint = seat.wallet == player.key() @ crate::errors::PokerError::NotPlayersTurn,
    )]
    pub seat: Account<'info, PlayerSeat>,
}

pub fn handler(ctx: Context<SetX25519Key>, x25519_pubkey: [u8; 32]) -> Result<()> {
    let seat = &mut ctx.accounts.seat;

    // Validate non-zero pubkey (Arcium MPC nodes reject [0;32] as invalid curve point)
    require!(
        x25519_pubkey != [0u8; 32],
        crate::errors::PokerError::InvalidPlayerCount // reuse existing error
    );

    // Store x25519 pubkey in hole_cards_commitment (repurposed, 32 bytes)
    seat.hole_cards_commitment = x25519_pubkey;

    msg!(
        "Player {} set x25519 pubkey for seat {} (first 4 bytes: {:02x}{:02x}{:02x}{:02x})",
        seat.wallet,
        seat.seat_number,
        x25519_pubkey[0], x25519_pubkey[1], x25519_pubkey[2], x25519_pubkey[3],
    );

    Ok(())
}
