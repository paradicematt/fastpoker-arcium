use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::PokerError;

/// Initialize CrankTallyER for a table (delegated to TEE with the table).
/// Called once per table BEFORE delegation. Creator or admin pays rent.
///
/// Seeds: ["crank_tally_er", table]
#[derive(Accounts)]
pub struct InitCrankTallyEr<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The table this tally belongs to
    pub table: Account<'info, Table>,

    #[account(
        init,
        payer = payer,
        space = CrankTally::SIZE,
        seeds = [CRANK_TALLY_ER_SEED, table.key().as_ref()],
        bump,
    )]
    pub crank_tally_er: Account<'info, CrankTally>,

    pub system_program: Program<'info, System>,
}

pub fn init_er_handler(ctx: Context<InitCrankTallyEr>) -> Result<()> {
    let tally = &mut ctx.accounts.crank_tally_er;
    tally.table = ctx.accounts.table.key();
    tally.operators = [Pubkey::default(); MAX_CRANK_OPERATORS];
    tally.action_count = [0; MAX_CRANK_OPERATORS];
    tally.total_actions = 0;
    tally.last_hand = 0;
    tally.bump = ctx.bumps.crank_tally_er;

    msg!("CrankTallyER initialized for table {}", tally.table);
    Ok(())
}

/// Initialize CrankTallyL1 for a table (NEVER delegated — stays on L1).
/// Called once per table. Creator or admin pays rent.
///
/// Seeds: ["crank_tally_l1", table]
#[derive(Accounts)]
pub struct InitCrankTallyL1<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The table this tally belongs to
    pub table: Account<'info, Table>,

    #[account(
        init,
        payer = payer,
        space = CrankTally::SIZE,
        seeds = [CRANK_TALLY_L1_SEED, table.key().as_ref()],
        bump,
    )]
    pub crank_tally_l1: Account<'info, CrankTally>,

    pub system_program: Program<'info, System>,
}

pub fn init_l1_handler(ctx: Context<InitCrankTallyL1>) -> Result<()> {
    let tally = &mut ctx.accounts.crank_tally_l1;
    tally.table = ctx.accounts.table.key();
    tally.operators = [Pubkey::default(); MAX_CRANK_OPERATORS];
    tally.action_count = [0; MAX_CRANK_OPERATORS];
    tally.total_actions = 0;
    tally.last_hand = 0;
    tally.bump = ctx.bumps.crank_tally_l1;

    msg!("CrankTallyL1 initialized for table {}", tally.table);
    Ok(())
}

/// Initialize TipJar for a table (delegated with table to TEE).
/// Called once per table BEFORE delegation. Anyone can create.
///
/// Seeds: ["tip_jar", table]
#[derive(Accounts)]
pub struct InitTipJar<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: We only read the key for PDA derivation
    pub table: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = TipJar::SIZE,
        seeds = [TIP_JAR_SEED, table.key().as_ref()],
        bump,
    )]
    pub tip_jar: Account<'info, TipJar>,

    pub system_program: Program<'info, System>,
}

pub fn init_tip_jar_handler(ctx: Context<InitTipJar>) -> Result<()> {
    let jar = &mut ctx.accounts.tip_jar;
    jar.table = ctx.accounts.table.key();
    jar.balance = 0;
    jar.hands_remaining = 0;
    jar.total_deposited = 0;
    jar.total_tipped = 0;
    jar.bump = ctx.bumps.tip_jar;

    msg!("TipJar initialized for table {}", jar.table);
    Ok(())
}
