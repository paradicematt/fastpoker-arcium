pub mod consts;
pub mod error;
pub mod instruction;
pub mod sdk;
pub mod state;

pub mod prelude {
    pub use crate::consts::*;
    pub use crate::error::*;
    pub use crate::instruction::*;
    pub use crate::sdk::*;
    pub use crate::state::*;
}

use steel::*;

// Steel Program v3 (production - Pool has mint authority)
declare_id!("9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6");
