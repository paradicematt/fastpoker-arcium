use anchor_lang::prelude::*;
use anchor_lang::solana_program;
use crate::state::player::{PlayerAccount, PLAYER_SEED};
use crate::constants::{REGISTRATION_COST, FREE_ENTRIES_ON_REGISTER, STEEL_PROGRAM_ID};
#[allow(unused_imports)]
use crate::errors::PokerError;
use crate::events::PlayerRegistered;

#[derive(Accounts)]
pub struct RegisterPlayer<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(
        init,
        payer = player,
        space = PlayerAccount::SIZE,
        seeds = [PLAYER_SEED, player.key().as_ref()],
        bump
    )]
    pub player_account: Account<'info, PlayerAccount>,

    /// Treasury account to receive 50% of registration fee
    /// CHECK: This is the program treasury, validated by address
    #[account(mut)]
    pub treasury: AccountInfo<'info>,

    /// Pool PDA (Steel staking program) to receive 50% for stakers
    /// CHECK: Validated by Steel program during CPI
    #[account(mut)]
    pub pool: AccountInfo<'info>,

    /// Player's Steel Unrefined PDA (rewards account)
    /// CHECK: PDA derivation is validated in handler before CPI
    #[account(mut)]
    pub unrefined: AccountInfo<'info>,

    /// Steel staking program for CPI
    /// CHECK: Validated by address constraint
    #[account(address = STEEL_PROGRAM_ID)]
    pub steel_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn register_handler(ctx: Context<RegisterPlayer>) -> Result<()> {
    let player = &ctx.accounts.player;
    let player_account = &mut ctx.accounts.player_account;
    let clock = Clock::get()?;

    // CPI into Steel's DepositPublicRevenue — only if registration costs SOL
    if REGISTRATION_COST > 0 {
        let mut ix_data = vec![25u8]; // discriminator for DepositPublicRevenue
        ix_data.extend_from_slice(&REGISTRATION_COST.to_le_bytes());

        let ix = solana_program::instruction::Instruction {
            program_id: STEEL_PROGRAM_ID,
            accounts: vec![
                solana_program::instruction::AccountMeta::new(player.key(), true),
                solana_program::instruction::AccountMeta::new(ctx.accounts.pool.key(), false),
                solana_program::instruction::AccountMeta::new(ctx.accounts.treasury.key(), false),
                solana_program::instruction::AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            ],
            data: ix_data,
        };

        solana_program::program::invoke(
            &ix,
            &[
                player.to_account_info(),
                ctx.accounts.pool.to_account_info(),
                ctx.accounts.treasury.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
        msg!("Registration fee {} deposited via Steel (50/50 split)", REGISTRATION_COST);
    }

    // Atomically ensure Steel Unrefined PDA exists for this player.
    // This guarantees tournament reward accounts are ready at registration time.
    let (expected_unrefined, _) = Pubkey::find_program_address(
        &[b"unrefined", player.key().as_ref()],
        &STEEL_PROGRAM_ID,
    );
    require_keys_eq!(
        ctx.accounts.unrefined.key(),
        expected_unrefined,
        PokerError::InvalidAccountData,
    );

    // Steel init_unrefined — skip if PDA already exists (idempotent registration)
    let unrefined_lamports = ctx.accounts.unrefined.lamports();
    if unrefined_lamports == 0 {
        let init_unrefined_ix = solana_program::instruction::Instruction {
            program_id: STEEL_PROGRAM_ID,
            accounts: vec![
                solana_program::instruction::AccountMeta::new(player.key(), true),
                solana_program::instruction::AccountMeta::new(ctx.accounts.unrefined.key(), false),
                solana_program::instruction::AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            ],
            data: vec![24u8],
        };

        solana_program::program::invoke(
            &init_unrefined_ix,
            &[
                player.to_account_info(),
                ctx.accounts.unrefined.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
        msg!("Steel Unrefined PDA initialized for {}", player.key());
    } else {
        msg!("Steel Unrefined PDA already exists — skipping init");
    }

    // Initialize player account
    player_account.wallet = player.key();
    player_account.is_registered = true;
    player_account.free_entries = FREE_ENTRIES_ON_REGISTER;
    player_account.hands_played = 0;
    player_account.hands_won = 0;
    player_account.total_winnings = 0;
    player_account.total_losses = 0;
    player_account.tournaments_played = 0;
    player_account.tournaments_won = 0;
    player_account.registered_at = clock.unix_timestamp;
    player_account.bump = ctx.bumps.player_account;

    emit!(PlayerRegistered {
        player: player.key(),
        free_entries: FREE_ENTRIES_ON_REGISTER,
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "Player {} registered with {} free entries",
        player.key(),
        FREE_ENTRIES_ON_REGISTER
    );

    Ok(())
}

#[derive(Accounts)]
pub struct GetPlayerAccount<'info> {
    pub player: Signer<'info>,

    #[account(
        seeds = [PLAYER_SEED, player.key().as_ref()],
        bump = player_account.bump,
    )]
    pub player_account: Account<'info, PlayerAccount>,
}

/// Check if player is registered (view function)
pub fn is_registered_handler(ctx: Context<GetPlayerAccount>) -> Result<bool> {
    Ok(ctx.accounts.player_account.is_registered)
}

/// Get player's remaining free entries (view function)
pub fn get_free_entries_handler(ctx: Context<GetPlayerAccount>) -> Result<u8> {
    Ok(ctx.accounts.player_account.free_entries)
}
