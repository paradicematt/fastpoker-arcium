# STEEL ↔ FastPoker CPI Flow

## Program IDs

| Program | ID | Source |
|---|---|---|
| FastPoker | `BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N` | `programs/fastpoker/src/lib.rs` declare_id! |
| STEEL | `9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6` | `contracts/api/src/lib.rs` declare_id! |

## Cross-References

### FastPoker → STEEL (CPI calls FROM FastPoker TO STEEL)
- **constants.rs:** `STEEL_PROGRAM_BYTES` / `STEEL_PROGRAM_ID` = `9qHC57...`
- Used by: `register.rs`, `distribute_prizes.rs`, `process_rake_distribution.rs`, `place_bid.rs`, `create_user_table.rs`, `join_table.rs`

### STEEL → FastPoker (authorization check)
- **contracts/api/src/consts.rs:** `FASTPOKER_PROGRAM_ID` = `BGyLYz...` (updated for Poker-Arc)
- Used by: `notify_pool_sol_deposit.rs`, `credit_unrefined_from_program.rs`
- These validate that the CPI caller's PDA was derived from the authorized FastPoker program

## CPI Flows

### 1. Player Registration (FastPoker → STEEL)
```
register_player → CPI register_player (disc=21) → STEEL creates player PDA
                → CPI init_unrefined (disc=24) → STEEL creates unrefined rewards PDA
```
**Files:** `instructions/register.rs`

### 2. SNG Fee Distribution (FastPoker → STEEL)
```
distribute_prizes → CPI credit_unrefined_from_program (disc=27) → STEEL credits POKER rewards
                  → CPI notify_pool_sol_deposit (disc=28) → STEEL updates pool accounting
```
**Files:** `instructions/distribute_prizes.rs`
**Auth:** `prize_authority` PDA (seeds: `["prize_authority"]`, program: FastPoker)

### 3. Cash Game Rake Distribution (FastPoker → STEEL)
```
process_rake_distribution → CPI deposit_public_revenue (disc=25) → STEEL deposits to pool
```
**Files:** `instructions/process_rake_distribution.rs`

### 4. Table Creation Fee (FastPoker → STEEL)
```
create_user_table → CPI deposit_revenue (disc=2) → STEEL deposits creation fee
```
**Files:** `instructions/create_user_table.rs`

### 5. SNG Join / Bid (FastPoker → STEEL)
```
join_table (SNG) → CPI deposit_revenue (disc=2) → STEEL deposits entry fee
place_bid → CPI deposit_revenue (disc=2) → STEEL deposits bid amount
```
**Files:** `instructions/join_table.rs`, `instructions/place_bid.rs`

## STEEL Authorization Model

The STEEL program validates CPI callers via PDA derivation:
```rust
// In notify_pool_sol_deposit.rs and credit_unrefined_from_program.rs:
let poker_program_id = Pubkey::new_from_array(FASTPOKER_PROGRAM_ID);
let (expected_pda, _bump) = Pubkey::find_program_address(
    &[PRIZE_AUTHORITY_SEED],  // b"prize_authority"
    &poker_program_id,
);
require!(program_signer == expected_pda);  // CPI signer must be this PDA
```

This means only the FastPoker program (at the hardcoded ID) can sign as `prize_authority`.

## Critical: Updating Program IDs

When deploying to a new environment with different program IDs:
1. Update `contracts/api/src/consts.rs` → `FASTPOKER_PROGRAM_ID` bytes
2. Rebuild STEEL: `cargo-build-sbf --manifest-path contracts/program/Cargo.toml`
3. FastPoker's `STEEL_PROGRAM_ID` in `constants.rs` must match STEEL's `declare_id!`
4. Load STEEL `.so` at its `declare_id!` address (not a different keypair address)
