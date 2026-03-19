use steel::*;

#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, PartialEq, TryFromPrimitive)]
pub enum PokerInstruction {
    /// Initialize the staking pool
    /// Accounts:
    /// 0. [signer] Authority
    /// 1. [writable] Pool account (PDA)
    /// 2. [] POKER token mint
    /// 3. [] System program
    Initialize = 0,

    /// Burn POKER tokens to stake (permanent, no unstake)
    /// Accounts:
    /// 0. [signer] Staker
    /// 1. [writable] Stake account (PDA)
    /// 2. [writable] Pool account
    /// 3. [writable] Staker's POKER token account
    /// 4. [writable] POKER token mint (for burning)
    /// 5. [] Token program
    BurnStake = 1,

    /// Deposit SOL buy-in revenue - IMMEDIATE distribution
    /// Called when players buy into cash games with SOL
    /// Accounts:
    /// 0. [signer] Authority (game server)
    /// 1. [writable] Pool account
    /// 2. [writable] Treasury account
    /// 3. [writable] Revenue source (SOL)
    /// 4. [] System program
    DepositRevenue = 2,

    /// Claim staker's share of SOL + POKER rewards (real-time)
    /// Accounts:
    /// 0. [signer] Staker
    /// 1. [writable] Stake account
    /// 2. [writable] Pool account
    /// 3. [writable] Staker's POKER token account
    /// 4. [writable] Pool's POKER token account (source)
    /// 5. [] Token program
    /// 6. [] System program
    ClaimStakeRewards = 3,

    /// Mint unrefined POKER rewards for tournament winner
    /// Accounts:
    /// 0. [signer] Authority (game server)
    /// 1. [writable] Unrefined rewards account (PDA for winner)
    /// 2. [writable] Pool account
    /// 3. [writable] POKER token mint
    /// 4. [] Mint authority (PDA)
    /// 5. [] Token program
    MintUnrefined = 4,

    /// Claim refined rewards (pay 10% tax, get 90%)
    /// Tax redistributed to other unclaimed rewards
    /// Accounts:
    /// 0. [signer] Winner
    /// 1. [writable] Unrefined rewards account
    /// 2. [writable] Pool account (holds refined pool)
    /// 3. [writable] Winner's POKER token account
    /// 4. [writable] POKER token mint
    /// 5. [] Mint authority (PDA)
    /// 6. [] Token program
    ClaimRefined = 5,

    /// Claim all (unrefined + refined) at once
    /// Accounts: same as ClaimRefined
    ClaimAll = 6,

    /// Advance epoch - distribute accumulated rake to stakers
    /// Called by backend every X hours (e.g., every 6 hours)
    /// Distributes all rake from current epoch, then starts new epoch
    /// Accounts:
    /// 0. [signer] Authority (backend)
    /// 1. [writable] Current epoch account
    /// 2. [writable] New epoch account (PDA)
    /// 3. [writable] Pool account
    /// 4. [] System program
    AdvanceEpoch = 7,

    /// Deposit cash game rake - ACCUMULATED for epoch distribution
    /// Called after each hand with rake collected
    /// Treasury gets 50% immediately, stakers get 50% at epoch end
    /// Accounts:
    /// 0. [signer] Authority (game server)
    /// 1. [writable] Current epoch account
    /// 2. [writable] Pool account
    /// 3. [writable] Treasury account
    /// 4. [writable] Revenue source (SOL)
    /// 5. [] System program
    DepositRake = 8,

    // === MagicBlock Table Instructions ===

    /// Create a new poker table
    /// Accounts:
    /// 0. [signer] Authority
    /// 1. [writable] Table account (PDA)
    /// 2. [] Pool account
    /// 3. [] System program
    CreateTable = 9,

    /// Join table with buy-in (creates PlayerSeat)
    /// Accounts:
    /// 0. [signer] Player
    /// 1. [writable] Table account
    /// 2. [writable] PlayerSeat account (PDA)
    /// 3. [writable] Player's SOL/token source
    /// 4. [] System program
    JoinTable = 10,

    /// Leave table and cash out
    /// Accounts:
    /// 0. [signer] Player
    /// 1. [writable] Table account
    /// 2. [writable] PlayerSeat account
    /// 3. [writable] Player's destination wallet
    /// 4. [] System program
    LeaveTable = 11,

    /// Cancel buy-in (only if game hasn't started)
    /// Accounts: same as LeaveTable
    CancelBuyin = 12,

    /// Player action (fold/check/call/raise/all-in)
    /// Accounts:
    /// 0. [signer] Player
    /// 1. [writable] Table account
    /// 2. [writable] PlayerSeat account
    PlayerAction = 13,

    /// Deal cards using VRF (called by ER validator)
    /// Accounts:
    /// 0. [signer] Authority/VRF oracle
    /// 1. [writable] Table account
    /// 2..N. [writable] PlayerSeat accounts
    DealCards = 14,

    /// Settle hand and distribute pot
    /// Accounts:
    /// 0. [signer] Authority
    /// 1. [writable] Table account
    /// 2. [writable] Pool account (for rake)
    /// 3..N. [writable] PlayerSeat accounts
    SettleHand = 15,

    /// Delegate table to Ephemeral Rollup
    /// Accounts:
    /// 0. [signer] Authority
    /// 1. [writable] Table account
    /// 2. [] Delegation program
    /// 3. [] ER validator
    DelegateTable = 16,

    /// Undelegate table from ER (commit final state)
    /// Accounts:
    /// 0. [signer] Authority
    /// 1. [writable] Table account
    /// 2. [writable] Pool account (commit rake)
    /// 3. [] Delegation program
    UndelegateTable = 17,

    /// Create pending withdrawal for disconnected player
    /// Accounts:
    /// 0. [signer] Authority
    /// 1. [writable] PendingWithdrawal account (PDA)
    /// 2. [writable] Table escrow token account
    /// 3. [writable] PlayerSeat account
    /// 4. [] Player wallet (owner)
    /// 5. [] System program
    CreatePendingWithdrawal = 18,

    /// Claim pending withdrawal
    /// Accounts:
    /// 0. [signer] Player
    /// 1. [writable] PendingWithdrawal account
    /// 2. [writable] Player's POKER token account
    /// 3. [writable] Pending escrow token account
    /// 4. [] Token program
    ClaimPendingWithdrawal = 19,

    /// Trigger timeout for inactive player (anyone can call)
    /// Accounts:
    /// 0. [signer] Caller (any player or crank)
    /// 1. [writable] Table account
    /// 2. [writable] Timed-out PlayerSeat account
    TriggerTimeout = 20,

    /// Register player account (pay 0.5 SOL, get 5 free entries)
    /// Accounts:
    /// 0. [signer, writable] Player wallet
    /// 1. [writable] Player account (PDA)
    /// 2. [writable] Treasury wallet
    /// 3. [] System program
    RegisterPlayer = 21,

    /// Use free entry to join tournament (decrements free_entries)
    /// Accounts:
    /// 0. [signer] Player
    /// 1. [writable] Player account (PDA)
    /// 2. [writable] Table account
    /// 3. [writable] PlayerSeat account (PDA)
    /// 4. [] System program
    JoinTableFree = 22,

    /// Refund free entry when leaving before tournament starts
    /// Accounts:
    /// 0. [signer] Player
    /// 1. [writable] Player account (PDA)
    /// 2. [writable] Table account
    /// 3. [writable] PlayerSeat account
    RefundFreeEntry = 23,

    /// Initialize unrefined rewards PDA for a player (called during registration)
    /// User pays rent. Must be called before mint_unrefined can write to this PDA.
    /// Accounts:
    /// 0. [signer, writable] Player wallet (pays rent)
    /// 1. [writable] Unrefined account (PDA: ["unrefined", player])
    /// 2. [] System program
    InitUnrefined = 24,

    /// Deposit SOL revenue (public - anyone can call)
    /// Splits 50/50 between treasury and stakers with proper pool accounting.
    /// Used by Anchor program CPI during registration, SNG entry, etc.
    /// Accounts:
    /// 0. [signer, writable] Payer (source of SOL)
    /// 1. [writable] Pool account
    /// 2. [writable] Treasury account
    /// 3. [] System program
    DepositPublicRevenue = 25,

    /// Record POKER rake for staker rewards (with token balance proof).
    /// Called by crank after Anchor distribute_rake moves POKER to pool's token account.
    /// Updates pool.poker_rewards_available and accumulated_poker_per_token.
    /// SECURITY: Verifies pool's POKER ATA balance >= poker_rewards_available + amount.
    /// Accounts:
    /// 0. [signer] Authority (pool authority)
    /// 1. [writable] Pool account
    /// 2. [] Pool's POKER token account (ATA — balance proof)
    RecordPokerRake = 26,

    /// Credit unrefined POKER rewards via CPI from authorized poker program.
    /// The poker program's PDA signs (seeds: ["prize_authority"], program_id = FASTPOKER).
    /// No pool authority needed — authorization is by PDA derivation from known program.
    /// Winner pubkey is passed in instruction data (not as an account) for CPI convenience.
    /// Accounts:
    /// 0. [signer] Prize authority PDA (derived from CQ-Poker program)
    /// 1. [writable] Unrefined rewards account (PDA for winner)
    /// 2. [writable] Pool account
    CreditUnrefinedFromProgram = 27,

    /// Notify pool that SOL was deposited directly (via lamport manipulation).
    /// Only updates pool accounting (sol_rewards_available) — no SOL transfer.
    /// Authorization: prize_authority PDA from CQ-Poker.
    /// Accounts:
    /// 0. [signer] Prize authority PDA
    /// 1. [writable] Pool account
    NotifyPoolSolDeposit = 28,
}

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct Initialize {}

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct BurnStake {
    pub amount: [u8; 8], // u64 as bytes
}

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct DepositRevenue {
    pub amount: [u8; 8], // u64 as bytes (lamports)
    pub source_type: u8, // 0 = buy-in, 1 = rake
}

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct ClaimStakeRewards {}

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct MintUnrefined {
    pub amount: [u8; 8], // u64 as bytes (POKER tokens)
    pub tournament_id: [u8; 32], // Tournament identifier
}

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct ClaimRefined {}

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct ClaimAll {}

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct AdvanceEpoch {}

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct DepositRake {
    pub amount: [u8; 8], // u64 as bytes (lamports)
}

// === Table Management Instructions ===

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct CreateTable {
    pub table_id: [u8; 32],
    pub small_blind: [u8; 8],
    pub big_blind: [u8; 8],
    pub stakes_level: u8,
}

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct JoinTable {
    pub buyin_amount: [u8; 8],
    pub seat_number: u8,
}

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct LeaveTable {}

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct CancelBuyin {}

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct PlayerAction {
    pub action_type: u8,
    pub amount: [u8; 8], // For raise amount
}

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct DealCards {
    pub vrf_seed: [u8; 32],
}

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct SettleHand {
    pub winner_seats: [u8; 9], // Seat numbers of winners (255 = not winner)
    pub amounts: [[u8; 8]; 9], // Win amounts per seat
}

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct DelegateTable {
    pub validator: [u8; 32], // ER validator pubkey
}

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct UndelegateTable {}

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct CreatePendingWithdrawal {
    pub amount: [u8; 8],
    pub reason: u8,
}

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct ClaimPendingWithdrawal {}

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct TriggerTimeout {}

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct RegisterPlayer {}

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct JoinTableFree {
    pub seat_number: u8,
}

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct RefundFreeEntry {}

instruction!(PokerInstruction, Initialize);
instruction!(PokerInstruction, BurnStake);
instruction!(PokerInstruction, DepositRevenue);
instruction!(PokerInstruction, ClaimStakeRewards);
instruction!(PokerInstruction, MintUnrefined);
instruction!(PokerInstruction, ClaimRefined);
instruction!(PokerInstruction, ClaimAll);
instruction!(PokerInstruction, AdvanceEpoch);
instruction!(PokerInstruction, DepositRake);
instruction!(PokerInstruction, CreateTable);
instruction!(PokerInstruction, JoinTable);
instruction!(PokerInstruction, LeaveTable);
instruction!(PokerInstruction, CancelBuyin);
instruction!(PokerInstruction, PlayerAction);
instruction!(PokerInstruction, DealCards);
instruction!(PokerInstruction, SettleHand);
instruction!(PokerInstruction, DelegateTable);
instruction!(PokerInstruction, UndelegateTable);
instruction!(PokerInstruction, CreatePendingWithdrawal);
instruction!(PokerInstruction, ClaimPendingWithdrawal);
instruction!(PokerInstruction, TriggerTimeout);
instruction!(PokerInstruction, RegisterPlayer);
instruction!(PokerInstruction, JoinTableFree);
instruction!(PokerInstruction, RefundFreeEntry);

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct InitUnrefined {}

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct DepositPublicRevenue {
    pub amount: [u8; 8], // u64 as bytes (lamports)
}

instruction!(PokerInstruction, InitUnrefined);
instruction!(PokerInstruction, DepositPublicRevenue);

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct RecordPokerRake {
    pub amount: [u8; 8], // u64 as bytes (POKER token units)
}

instruction!(PokerInstruction, RecordPokerRake);

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct CreditUnrefinedFromProgram {
    pub amount: [u8; 8],  // u64 as bytes (POKER tokens, 6 decimals)
    pub winner: [u8; 32], // Winner wallet pubkey (for unrefined PDA derivation)
}

instruction!(PokerInstruction, CreditUnrefinedFromProgram);

#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct NotifyPoolSolDeposit {
    pub amount: [u8; 8], // u64 as bytes (staker_share lamports)
}

instruction!(PokerInstruction, NotifyPoolSolDeposit);
