mod initialize;
mod burn_stake;
mod deposit_revenue;
mod claim_stake_rewards;
mod mint_unrefined;
mod claim_refined;
mod claim_all;
mod advance_epoch;
mod deposit_rake;
mod join_table;
mod cancel_buyin;
mod claim_pending_withdrawal;
mod trigger_timeout;
mod create_table;
mod leave_table;
mod player_action;
mod deal_cards;
mod settle_hand;
mod delegate_table;
mod create_pending_withdrawal;
mod register_player;
mod join_table_free;
mod transfer_mint_authority;
mod init_unrefined;
mod deposit_public_revenue;
mod record_poker_rake;
mod credit_unrefined_from_program;
mod notify_pool_sol_deposit;

use initialize::*;
use burn_stake::*;
use deposit_revenue::*;
use claim_stake_rewards::*;
use mint_unrefined::*;
use claim_refined::*;
use claim_all::*;
use advance_epoch::*;
use deposit_rake::*;
use join_table::*;
use cancel_buyin::*;
use claim_pending_withdrawal::*;
use trigger_timeout::*;
use create_table::*;
use leave_table::*;
use player_action::*;
use deal_cards::*;
use settle_hand::*;
use delegate_table::*;
use create_pending_withdrawal::*;
use register_player::*;
use join_table_free::*;
use transfer_mint_authority::*;
use init_unrefined::*;
use deposit_public_revenue::*;
use record_poker_rake::*;
use credit_unrefined_from_program::*;
use notify_pool_sol_deposit::*;

use poker_api::prelude::*;
use steel::*;
use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    pubkey::Pubkey,
    program_error::ProgramError,
};

// Use native Solana entrypoint instead of Steel's
entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    // Verify program ID manually
    if *program_id != poker_api::ID {
        msg!("Program ID mismatch: expected {}, got {}", poker_api::ID, program_id);
        return Err(ProgramError::IncorrectProgramId);
    }

    // Parse instruction discriminator manually
    if data.is_empty() {
        msg!("No instruction data");
        return Err(ProgramError::InvalidInstructionData);
    }

    let discriminator = data[0];
    let ix_data = &data[1..];
    
    msg!("Processing instruction: {}", discriminator);

    match discriminator {
        0 => process_initialize(accounts, ix_data)?,
        1 => process_burn_stake(accounts, ix_data)?,
        2 => process_deposit_revenue(accounts, ix_data)?,
        3 => process_claim_stake_rewards(accounts, ix_data)?,
        4 => process_mint_unrefined(accounts, ix_data)?,
        5 => process_claim_refined(accounts, ix_data)?,
        6 => process_claim_all(accounts, ix_data)?,
        7 => process_advance_epoch(accounts, ix_data)?,
        8 => process_deposit_rake(accounts, ix_data)?,
        9 => process_create_table(accounts, ix_data)?,
        10 => process_join_table(accounts, ix_data)?,
        11 => process_leave_table(accounts, ix_data)?,
        12 => process_cancel_buyin(accounts, ix_data)?,
        13 => process_player_action(accounts, ix_data)?,
        14 => process_deal_cards(accounts, ix_data)?,
        15 => process_settle_hand(accounts, ix_data)?,
        16 => process_delegate_table(accounts, ix_data)?,
        17 => process_undelegate_table(accounts, ix_data)?,
        18 => process_create_pending_withdrawal(accounts, ix_data)?,
        19 => process_claim_pending_withdrawal(accounts, ix_data)?,
        20 => process_trigger_timeout(accounts, ix_data)?,
        21 => process_register_player(accounts, ix_data)?,
        22 => process_join_table_free(accounts, ix_data)?,
        23 => process_transfer_mint_authority(accounts, ix_data)?,
        24 => process_init_unrefined(accounts, ix_data)?,
        25 => process_deposit_public_revenue(accounts, ix_data)?,
        26 => process_record_poker_rake(accounts, ix_data)?,
        27 => process_credit_unrefined_from_program(accounts, ix_data)?,
        28 => process_notify_pool_sol_deposit(accounts, ix_data)?,
        _ => {
            msg!("Unknown instruction: {}", discriminator);
            return Err(ProgramError::InvalidInstructionData);
        }
    }

    Ok(())
}
