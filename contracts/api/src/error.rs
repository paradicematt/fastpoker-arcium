use steel::*;

#[repr(u32)]
#[derive(Debug, Error, Clone, Copy, PartialEq, Eq, IntoPrimitive)]
pub enum PokerError {
    #[error("Invalid authority")]
    InvalidAuthority = 0,
    
    #[error("Invalid stake amount")]
    InvalidStakeAmount = 1,
    
    #[error("Insufficient balance")]
    InsufficientBalance = 2,
    
    #[error("Nothing to claim")]
    NothingToClaim = 3,
    
    #[error("Invalid token mint")]
    InvalidTokenMint = 4,
    
    #[error("Arithmetic overflow")]
    Overflow = 5,
    
    #[error("Invalid pool state")]
    InvalidPoolState = 6,
    
    #[error("Epoch not ended")]
    EpochNotEnded = 7,
    
    #[error("Already claimed this epoch")]
    AlreadyClaimed = 8,
    
    // Table errors
    #[error("Invalid amount")]
    InvalidAmount = 9,
    
    #[error("Invalid seat number")]
    InvalidSeat = 10,
    
    #[error("Game is in progress")]
    GameInProgress = 11,
    
    #[error("Seat is occupied")]
    SeatOccupied = 12,
    
    #[error("Not your seat")]
    NotYourSeat = 13,
    
    #[error("No chips to withdraw")]
    NoChips = 14,
    
    #[error("Not your turn")]
    NotYourTurn = 15,
    
    #[error("Invalid action")]
    InvalidAction = 16,
    
    #[error("Table is delegated to ER")]
    TableDelegated = 17,
    
    #[error("Table is not delegated")]
    TableNotDelegated = 18,
    
    #[error("Invalid account")]
    InvalidAccount = 19,
    
    #[error("Player not registered")]
    NotRegistered = 20,
    
    #[error("No free entries remaining")]
    NoFreeEntries = 21,
}

error!(PokerError);
