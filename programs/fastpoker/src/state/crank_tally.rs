use anchor_lang::prelude::*;

pub const CRANK_TALLY_ER_SEED: &[u8] = b"crank_tally_er";
pub const CRANK_TALLY_L1_SEED: &[u8] = b"crank_tally_l1";

/// Maximum number of distinct operators tracked per tally PDA.
/// If a 5th+ operator acts, their actions increment total_actions but
/// don't get individual credit (proportional share goes to tracked operators).
pub const MAX_CRANK_OPERATORS: usize = 4;

/// Crank action tally — tracks which operators performed actions on a table.
/// Two instances per table:
///   CrankTallyER ["crank_tally_er", table] — delegated with table (TEE writes)
///   CrankTallyL1 ["crank_tally_l1", table] — never delegated (L1 writes, 2× weight)
///
/// All counters are CUMULATIVE and NEVER reset. Distribution uses
/// monotonic SOL delta (vault.total_crank_distributed) to prevent double-claim.
/// See protocol-economics plan "Double-Claim Prevention" section.
#[account]
pub struct CrankTally {
    /// Table this tally belongs to
    pub table: Pubkey,
    /// Operator pubkeys (up to 4). Pubkey::default() = empty slot.
    pub operators: [Pubkey; MAX_CRANK_OPERATORS],
    /// Per-operator cumulative action count (u32 = 4B capacity, ~14M hours at 40 hands/hr)
    pub action_count: [u32; MAX_CRANK_OPERATORS],
    /// Total actions across ALL operators (including untracked 5th+ operators)
    pub total_actions: u32,
    /// Last hand number when this tally was updated (for debugging/monitoring)
    pub last_hand: u64,
    /// PDA bump
    pub bump: u8,
}

impl CrankTally {
    pub const SIZE: usize = 8 +  // discriminator
        32 +                      // table
        (32 * MAX_CRANK_OPERATORS) + // operators: 4 × 32 = 128
        (4 * MAX_CRANK_OPERATORS) +  // action_count: 4 × 4 = 16
        4 +                       // total_actions
        8 +                       // last_hand
        1;                        // bump
    // = 8 + 32 + 128 + 16 + 4 + 8 + 1 = 197 bytes

    /// Record a crank action for the given operator.
    /// If operator is already tracked, increments their count.
    /// If operator is new and there's an empty slot, registers them.
    /// If all 4 slots are full, only increments total_actions (no individual credit).
    pub fn record_action(&mut self, operator: &Pubkey) {
        // Check if operator already tracked
        for i in 0..MAX_CRANK_OPERATORS {
            if self.operators[i] == *operator {
                self.action_count[i] = self.action_count[i].saturating_add(1);
                self.total_actions = self.total_actions.saturating_add(1);
                return;
            }
        }
        // Try to register in empty slot
        for i in 0..MAX_CRANK_OPERATORS {
            if self.operators[i] == Pubkey::default() {
                self.operators[i] = *operator;
                self.action_count[i] = 1;
                self.total_actions = self.total_actions.saturating_add(1);
                return;
            }
        }
        // All slots full — increment total only (no individual credit for 5th+ operator)
        self.total_actions = self.total_actions.saturating_add(1);
    }
}

/// Try to record a crank action in CrankTallyER from remaining_accounts.
/// Scans remaining_accounts for the CrankTallyER PDA matching this table.
/// Used by all permissionless crank instructions (start_game, tee_deal, tee_reveal, settle, timeout).
/// Returns true if the tally was found and updated.
pub fn try_record_crank_action(
    remaining_accounts: &[AccountInfo],
    table_key: &Pubkey,
    caller_key: &Pubkey,
    hand_number: u64,
) -> bool {
    let (expected_tally, _) = Pubkey::find_program_address(
        &[CRANK_TALLY_ER_SEED, table_key.as_ref()],
        &crate::ID,
    );
    for account in remaining_accounts.iter() {
        if account.key() != expected_tally || account.owner != &crate::ID || !account.is_writable {
            continue;
        }
        if let Ok(mut data) = account.try_borrow_mut_data() {
            if data.len() < CrankTally::SIZE {
                return false;
            }
            let mut recorded = false;
            for i in 0..MAX_CRANK_OPERATORS {
                let pk_start = 40 + (i * 32);
                let count_start = 168 + (i * 4);
                let pk = Pubkey::try_from(&data[pk_start..pk_start + 32]).unwrap_or_default();
                if pk == *caller_key {
                    let count = u32::from_le_bytes(data[count_start..count_start + 4].try_into().unwrap_or([0; 4]));
                    data[count_start..count_start + 4].copy_from_slice(&(count.saturating_add(1)).to_le_bytes());
                    recorded = true;
                    break;
                }
                if pk == Pubkey::default() {
                    data[pk_start..pk_start + 32].copy_from_slice(caller_key.as_ref());
                    data[count_start..count_start + 4].copy_from_slice(&1u32.to_le_bytes());
                    recorded = true;
                    break;
                }
            }
            let ta_off = 184;
            let ta = u32::from_le_bytes(data[ta_off..ta_off + 4].try_into().unwrap_or([0; 4]));
            data[ta_off..ta_off + 4].copy_from_slice(&(ta.saturating_add(1)).to_le_bytes());
            data[188..196].copy_from_slice(&hand_number.to_le_bytes());
            if recorded {
                msg!("Dealer {} recorded action (hand #{})", caller_key, hand_number);
            }
            return true;
        }
        return false;
    }
    false
}
