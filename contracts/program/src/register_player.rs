use poker_api::prelude::*;
use solana_program::{
    account_info::AccountInfo, entrypoint::ProgramResult, program::invoke_signed,
    program_error::ProgramError, pubkey::Pubkey, system_instruction,
};
use steel::*;

/// Process RegisterPlayer instruction
/// Creates a player account PDA and transfers 0.5 SOL to treasury
/// Grants 5 free tournament entries
pub fn process_register_player(accounts: &[AccountInfo], _data: &[u8]) -> ProgramResult {
    let [player_info, player_account_info, treasury_info, system_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Verify player is signer
    player_info.is_signer()?;

    // Derive player account PDA
    let (player_pda, player_bump) = Pubkey::find_program_address(
        &[PLAYER, player_info.key.as_ref()],
        &poker_api::ID,
    );

    // Verify PDA matches
    if player_pda != *player_account_info.key {
        return Err(ProgramError::InvalidSeeds);
    }

    // Check if already registered
    if player_account_info.lamports() > 0 {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    // Transfer registration cost (0.5 SOL) to treasury
    invoke_signed(
        &system_instruction::transfer(
            player_info.key,
            treasury_info.key,
            REGISTRATION_COST,
        ),
        &[player_info.clone(), treasury_info.clone(), system_program.clone()],
        &[],
    )?;

    // Create player account
    let space = 8 + std::mem::size_of::<Player>();
    let lamports = solana_program::rent::Rent::default().minimum_balance(space);

    invoke_signed(
        &system_instruction::create_account(
            player_info.key,
            player_account_info.key,
            lamports,
            space as u64,
            &poker_api::ID,
        ),
        &[player_info.clone(), player_account_info.clone(), system_program.clone()],
        &[&[PLAYER, player_info.key.as_ref(), &[player_bump]]],
    )?;

    // Initialize player account data
    let mut data = player_account_info.try_borrow_mut_data()?;
    data[0] = PokerAccount::Player as u8;
    drop(data);

    let player = player_account_info.as_account_mut::<Player>(&poker_api::ID)?;
    player.wallet = *player_info.key;
    player.free_entries = FREE_ENTRIES_ON_REGISTER;
    player.is_registered = 1;
    player.tournaments_played = 0;
    player.tournaments_won = 0;
    player.bump = player_bump;

    Ok(())
}
