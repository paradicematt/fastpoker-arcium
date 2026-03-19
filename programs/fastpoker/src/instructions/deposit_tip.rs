use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;

/// Deposit SOL into a table's tip jar for dealer (crank) rewards.
/// Anyone can deposit (typically players at the table).
/// Runs on L1 — tip jar is delegated, so this fills the L1 shadow.
/// After next commit_state, TEE sees the updated balance.
///
/// Grief protection:
/// - New per-hand rate must be >= old per-hand rate (can't dilute)
/// - hands_added capped at TIP_JAR_MAX_HANDS
/// - Minimum deposit: 1000 lamports (prevent dust griefing)
///
/// Seeds: ["tip_jar", table]
#[derive(Accounts)]
pub struct DepositTip<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    /// The table this tip jar belongs to
    /// CHECK: We only read the key, not the data
    pub table: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [TIP_JAR_SEED, table.key().as_ref()],
        bump = tip_jar.bump,
        constraint = tip_jar.table == table.key() @ PokerError::InvalidTableConfig,
    )]
    pub tip_jar: Account<'info, TipJar>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<DepositTip>, amount: u64, hands: u16) -> Result<()> {
    let tip_jar = &mut ctx.accounts.tip_jar;

    // Validation
    require!(amount >= 1000, PokerError::InvalidBlinds); // min 1000 lamports
    require!(hands > 0, PokerError::InvalidTableConfig);
    require!(hands <= TIP_JAR_MAX_HANDS, PokerError::InvalidTableConfig);

    // Grief protection: new per-hand rate must be >= old per-hand rate
    // This prevents someone from depositing 1 lamport for 100 hands to dilute the rate
    let old_per_hand = tip_jar.per_hand_tip();
    let new_balance = tip_jar.balance.saturating_add(amount);
    let new_hands = tip_jar.hands_remaining.saturating_add(hands);
    let new_per_hand = new_balance / (new_hands as u64);

    // Allow first deposit (old_per_hand == 0) or rate must not decrease
    require!(
        old_per_hand == 0 || new_per_hand >= old_per_hand,
        PokerError::InvalidTableConfig
    );

    // Total hands_remaining can't exceed max
    require!(
        new_hands <= TIP_JAR_MAX_HANDS,
        PokerError::InvalidTableConfig
    );

    // Transfer SOL from depositor to tip_jar PDA
    let ix = anchor_lang::solana_program::system_instruction::transfer(
        &ctx.accounts.depositor.key(),
        &tip_jar.key(),
        amount,
    );
    anchor_lang::solana_program::program::invoke(
        &ix,
        &[
            ctx.accounts.depositor.to_account_info(),
            tip_jar.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;

    tip_jar.balance = new_balance;
    tip_jar.hands_remaining = new_hands;
    tip_jar.total_deposited = tip_jar.total_deposited.saturating_add(amount);

    msg!(
        "Tip deposited: {} lamports for {} hands (rate: {} per hand, total balance: {})",
        amount, hands, tip_jar.per_hand_tip(), tip_jar.balance
    );

    Ok(())
}
