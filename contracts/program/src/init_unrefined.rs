use poker_api::prelude::*;
use solana_program::{msg, program::invoke_signed, system_instruction, rent::Rent, sysvar::Sysvar};
use steel::*;

/// Initialize an Unrefined rewards PDA for a player.
/// Called during registration — user pays rent.
/// Must exist before mint_unrefined can write to it.
pub fn process_init_unrefined(accounts: &[AccountInfo<'_>], _data: &[u8]) -> ProgramResult {
    let [player_info, unrefined_info, system_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // User must sign (they pay rent)
    player_info.is_signer()?;
    system_program.is_program(&system_program::ID)?;

    // Derive and validate unrefined PDA
    let (unrefined_pda, unrefined_bump) = unrefined_pda(player_info.key);
    unrefined_info.has_address(&unrefined_pda)?;

    // Check if already initialized
    if unrefined_info.lamports() > 0 {
        // Already exists — no-op (idempotent)
        return Ok(());
    }

    // Create the account — user pays rent
    let space = std::mem::size_of::<Unrefined>() + 8;
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(space);

    invoke_signed(
        &system_instruction::create_account(
            player_info.key,
            unrefined_info.key,
            lamports,
            space as u64,
            &poker_api::ID,
        ),
        &[player_info.clone(), unrefined_info.clone(), system_program.clone()],
        &[&[UNREFINED, player_info.key.as_ref(), &[unrefined_bump]]],
    )?;

    // Write discriminator
    let mut data = unrefined_info.try_borrow_mut_data()?;
    data[0] = PokerAccount::Unrefined as u8;
    drop(data);

    // Initialize fields
    let unrefined = unrefined_info.as_account_mut::<Unrefined>(&poker_api::ID)?;
    unrefined.owner = *player_info.key;
    unrefined.unrefined_amount = 0;
    unrefined.refined_amount = 0;
    unrefined.refined_debt = 0;
    unrefined.bump = unrefined_bump;

    Ok(())
}
