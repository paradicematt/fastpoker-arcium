use anchor_lang::prelude::*;

#[error_code]
pub enum PokerError {
    // Table Errors (6000-6099)
    #[msg("Table is full")]
    TableFull,
    #[msg("Table is empty")]
    TableEmpty,
    #[msg("Table is not in waiting phase")]
    TableNotWaiting,
    #[msg("Table is already delegated")]
    TableAlreadyDelegated,
    #[msg("Table is not delegated")]
    TableNotDelegated,
    #[msg("Not enough players to start")]
    NotEnoughPlayers,
    #[msg("Invalid table configuration")]
    InvalidTableConfig,
    #[msg("Table is in active hand")]
    HandInProgress,
    #[msg("Invalid game type for this operation")]
    InvalidGameType,
    #[msg("Invalid session token PDA")]
    InvalidSessionToken,

    // Player/Seat Errors (6100-6199)
    #[msg("Player not registered - must pay 0.5 SOL registration fee")]
    PlayerNotRegistered,
    #[msg("Player not found at table")]
    PlayerNotFound,
    #[msg("Player already seated")]
    PlayerAlreadySeated,
    #[msg("Seat is occupied")]
    SeatOccupied,
    #[msg("Seat is empty")]
    SeatEmpty,
    #[msg("Seat is not empty — cannot reset permission while occupied")]
    SeatNotEmpty,
    #[msg("Not the owner of this seat")]
    NotSeatOwner,
    #[msg("Invalid seat number")]
    InvalidSeatNumber,
    #[msg("Insufficient chips")]
    InsufficientChips,
    #[msg("Invalid buy-in amount")]
    InvalidBuyIn,
    #[msg("Player has folded")]
    PlayerFolded,
    #[msg("Player is all-in")]
    PlayerAllIn,

    // Action Errors (6200-6299)
    #[msg("Invalid action for current phase")]
    InvalidActionForPhase,
    #[msg("Not player's turn")]
    NotPlayersTurn,
    #[msg("Invalid bet amount")]
    InvalidBetAmount,
    #[msg("Bet below minimum")]
    BetBelowMinimum,
    #[msg("Cannot check - must call or fold")]
    CannotCheck,
    #[msg("Cannot call - no bet to call")]
    NothingToCall,
    #[msg("Raise must be at least 2x previous bet")]
    RaiseTooSmall,
    #[msg("Action timeout")]
    ActionTimeout,
    #[msg("Cannot sit out during your turn - fold or act first")]
    CannotSitOutDuringTurn,
    #[msg("Player is not sitting out")]
    NotSittingOut,
    #[msg("Seat does not belong to this table")]
    SeatNotAtTable,

    // Session Key Errors (6300-6399)
    #[msg("Session key expired")]
    SessionExpired,
    #[msg("Session key not authorized for this action")]
    SessionNotAuthorized,
    #[msg("Invalid session key")]
    InvalidSessionKey,
    #[msg("Session already exists")]
    SessionAlreadyExists,
    #[msg("Session not found")]
    SessionNotFound,

    // Authorization Errors (6400-6499)
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid authority")]
    InvalidAuthority,
    #[msg("Invalid signer")]
    InvalidSigner,

    // Delegation Errors (6500-6599)
    #[msg("Delegation failed")]
    DelegationFailed,
    #[msg("Undelegation failed")]
    UndelegationFailed,
    #[msg("Invalid delegation program")]
    InvalidDelegationProgram,

    // VRF/Randomness Errors (6600-6699)
    #[msg("Invalid VRF proof")]
    InvalidVRFProof,
    #[msg("VRF not requested")]
    VRFNotRequested,
    #[msg("Deck already shuffled")]
    DeckAlreadyShuffled,
    #[msg("Not enough accounts provided for all players")]
    InvalidAccountCount,
    #[msg("Seat cards account has invalid/empty data (delegation may have failed)")]
    InvalidSeatCardsAccount,
    #[msg("Deck exhausted - not enough cards to deal")]
    DeckExhausted,

    // Tokenomics Errors (6700-6799)
    #[msg("Rake deposit failed")]
    RakeDepositFailed,
    #[msg("Reward minting failed")]
    RewardMintFailed,
    #[msg("Invalid pool account")]
    InvalidPool,
    #[msg("Invalid card reveal - commitment mismatch")]
    InvalidCardReveal,

    // Crank/Removal Errors (6800-6849)
    #[msg("Player is not sitting out")]
    PlayerNotSittingOut,
    #[msg("Player does not meet removal criteria (3 orbits or 3 hands bust)")]
    PlayerNotRemovable,
    #[msg("No rake to distribute")]
    NoRakeToDistribute,
    #[msg("Invalid creator account")]
    InvalidCreator,

    // Creator/User Table Errors (6850-6869)
    #[msg("Not a user-created table")]
    NotUserCreatedTable,
    #[msg("Not the table creator")]
    NotTableCreator,
    #[msg("No rake to claim")]
    NoRakeToClaim,
    #[msg("Insufficient funds in escrow")]
    InsufficientFunds,

    // Tournament Prize Errors (6870-6889)
    #[msg("Game is not complete")]
    GameNotComplete,
    #[msg("Prizes have already been distributed")]
    PrizesAlreadyDistributed,
    #[msg("Invalid finish order")]
    InvalidFinishOrder,
    #[msg("Not a tournament table")]
    NotTournament,

    // Cash Game Errors (6890-6919)
    #[msg("Invalid blind configuration")]
    InvalidBlinds,
    #[msg("Invalid escrow account")]
    InvalidEscrow,
    #[msg("Invalid token account")]
    InvalidTokenAccount,
    #[msg("Nothing to withdraw")]
    NothingToWithdraw,
    #[msg("Rebuy amount too small (minimum 1 BB)")]
    RebuyTooSmall,
    #[msg("Rebuy would exceed max buy-in (100 BB)")]
    RebuyExceedsMax,
    #[msg("Invalid seat state for this operation")]
    InvalidSeatState,
    #[msg("Unclaimed balance has expired - player can no longer claim")]
    UnclaimedExpired,
    #[msg("Unclaimed balance has not expired yet - creator cannot reclaim")]
    UnclaimedNotExpired,
    #[msg("Cannot close table - unclaimed balances exist (wait for expiry or players to claim)")]
    UnclaimedBalancesExist,

    // Settle Safety Errors (6890+)
    #[msg("Community cards not dealt - cannot evaluate hands at showdown")]
    CommunityCardsNotDealt,

    #[msg("Cannot close SNG table - prizes not yet distributed")]
    PrizesNotDistributed,

    #[msg("No SOL winnings to claim")]
    NothingToClaim,

    // Token/Denomination Errors (6920-6939)
    #[msg("Token mint is not a premium token and not auction-listed")]
    InvalidTokenMint,
    #[msg("Invalid token program")]
    InvalidTokenProgram,

    // Auction Errors (6940-6959)
    #[msg("Auction is not active")]
    AuctionNotActive,
    #[msg("Auction has not ended yet")]
    AuctionNotEnded,
    #[msg("Auction has already ended")]
    AuctionAlreadyEnded,
    #[msg("Bid amount must be greater than zero")]
    ZeroBidAmount,
    #[msg("No bids placed in this auction")]
    NoBids,
    #[msg("Computed anchor vote does not match on-chain verification")]
    AnchorVoteMismatch,
    #[msg("Candidate mint is not a valid SPL token")]
    NotValidMint,
    #[msg("Token has freeze authority — not allowed for poker tables")]
    MintHasFreezeAuthority,
    #[msg("Token-2022 mints are not currently supported")]
    Token2022NotSupported,

    // RakeVault Errors (6960-6979)
    #[msg("Nothing to claim — no new rake since last claim")]
    NoRakeRewardToClaim,
    #[msg("Vault epoch has not advanced")]
    VaultEpochNotAdvanced,

    // Vault Cash Game Errors (6960-6979)
    #[msg("Insufficient vault reserve for rebuy/top-up")]
    InsufficientReserve,
    #[msg("Rebuy/top-up would exceed table max buy-in")]
    TopUpExceedsMax,
    #[msg("Rebuy amount below table minimum buy-in")]
    RebuyBelowMin,
    #[msg("Vault has insufficient SOL for cashout")]
    VaultInsufficient,
    #[msg("Cashout nonce already processed")]
    NonceAlreadyProcessed,
    #[msg("Rake distribution nonce mismatch — stale or duplicate call")]
    StaleNonce,
    #[msg("Seat is not in Leaving status")]
    SeatNotLeaving,
    #[msg("Invalid seat data in committed account")]
    InvalidCommittedSeat,
    #[msg("Player wallet does not match seat wallet")]
    WalletMismatch,
    #[msg("Can only rebuy/top-up between hands (Waiting phase)")]
    NotWaitingPhase,
    #[msg("Cashout not yet processed on L1 — cannot clear seat")]
    CashoutNotProcessed,
    #[msg("Cannot close table — vault still holds player funds (pending cashouts)")]
    VaultHasPlayerFunds,
    #[msg("Cannot close table — undistributed rake exists (distribute rake first)")]
    UndistributedRakeExists,
    #[msg("Cannot close table — seat has pending cashout (status=Leaving)")]
    SeatHasPendingCashout,
    #[msg("Anti-ratholing: buy-in too low — must buy in with at least as many chips as you left with (12h lock)")]
    RatholingBuyInTooLow,

    // Arcium MPC Errors (6970-6979)
    #[msg("Invalid player count for MPC deal (must be 2-6)")]
    InvalidPlayerCount,
    #[msg("MPC computation pending — wait for callback")]
    ArciumComputationPending,
    #[msg("MPC callback invalid or verification failed")]
    ArciumCallbackInvalid,
    #[msg("MPC computation timed out — misdeal")]
    ArciumComputationTimeout,
    #[msg("Shuffle not complete — cards not yet dealt")]
    ShuffleNotComplete,

    // General Errors (6980-6999)
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Invalid account data")]
    InvalidAccountData,
    #[msg("Account not initialized")]
    AccountNotInitialized,
    #[msg("Cannot delegate table — seats must be initialized first (call init_table_seat)")]
    SeatsNotInitialized,
    #[msg("Cannot delegate table — all seats, permissions, and deck state must be created first")]
    SetupIncomplete,
    #[msg("Delegation target must be the expected TEE validator")]
    InvalidValidator,
    #[msg("Cannot delegate — table is already Complete (zombie guard)")]
    TableAlreadyComplete,
}
