# Crank / Dealer Economics

## Dealer Operator Key Model

Same as current `CrankOperator` PDA model — no structural change. Operators register on-chain, earn rewards based on weighted action tracking.

- **PDA seeds:** `["crank_operator", operator_wallet]`
- **Requirement:** Operator must have a registered `CrankOperator` PDA to earn rewards
- **Permissionless cranking:** Anyone CAN call game instructions. But only registered operators accumulate tally rewards. Unregistered crankers advance the game for free (fallback safety).
- **Guard:** `try_record_crank_action()` checks for valid `CrankOperator` PDA. If present → record. If absent → skip (game still advances).

## Revenue Splits

### SNG Fee Split (Implemented)
| Recipient | Constant | % |
|---|---|---|
| Treasury | `SNG_TREASURY_BPS = 1000` | 10% |
| Stakers | `SNG_STAKERS_BPS = 4500` | 45% |
| Dealers (Cranks) | `SNG_DEALER_BPS = 4500` | 45% |

### Cash Game Rake — User-Created Tables (Implemented)
| Recipient | Constant | % |
|---|---|---|
| Table Creator | `RAKE_CREATOR_BPS = 5000` | 50% |
| Treasury | `RAKE_TREASURY_USER_TABLE_BPS = 500` | 5% |
| Stakers | `RAKE_STAKERS_USER_TABLE_BPS = 2500` | 25% |
| Dealers (Cranks) | `RAKE_DEALER_BPS = 2500` | 25% |

### Cash Game Rake — System Tables (Implemented)
| Recipient | Constant | % |
|---|---|---|
| Treasury | `RAKE_TREASURY_BPS = 500` | 5% |
| Stakers | `RAKE_STAKERS_BPS = 5000` | 50% |
| Dealers (Cranks) | `RAKE_DEALER_SYSTEM_BPS = 4500` | 45% |

## Tally System

### Changes from Current
- `CrankTallyER` + `CrankTallyL1` → merged into single `CrankTally` (no ER distinction since we're on L1)
- Same weighted action tracking per operator pubkey
- Payout timing: end of hand (cash games) or end of tournament (SNGs)

### Action Weights
Preserved from current system:
- `deal` action (highest weight — most critical)
- `reveal` actions (flop/turn/river)
- `showdown` action
- `settle` action
- Each action type has a configurable weight that determines share of rewards

### Payout Flow
1. During hand: `try_record_crank_action()` called in each game instruction
2. At hand end (cash) or tournament end (SNG): `distribute_crank_rewards` reads tally
3. Merges all operator entries, computes action-weighted share
4. Transfers SOL from vault's crank pool to each operator wallet

## Arcium MPC Cost Model

### Who Pays?
- **The crank operator pays ALL Arcium MPC costs.** The crank's wallet signs `arcium_deal`, `arcium_reveal`, and `arcium_showdown` transactions. These include:
  - Solana base TX fees (~5000 lamports per TX)
  - MPC computation fees (paid to Arcium MXE via `queue_computation`)
  - Optional priority fees (for faster inclusion)
- **Players never pay MPC fees.** Players pay only `join_table` deposit + session key funding.

### Crank Priority Fee Flexibility
- Crank service should support configurable priority fees:
  - `PRIORITY_FEE_LAMPORTS` env var (default: 0 for localnet, ~1000-5000 for devnet/mainnet)
  - Higher priority = faster TX inclusion = lower perceived latency
  - Trade-off: higher fees eat into crank reward share
- **Compute unit budget:** `arcium_deal` CPI is expensive (~400K CU). Set `setComputeUnitLimit` appropriately.

### Per-Hand Cost Breakdown (Estimated)
| Action | TXs | ~Cost (SOL) |
|---|---|---|
| `arcium_deal` (queue MPC) | 1 | 0.00001 + MPC fee |
| MPC callback (from nodes) | 1 | 0 (nodes pay) |
| `arcium_reveal` × 3 streets | 3 | 0.00003 + MPC fees |
| `arcium_showdown` | 1 | 0.00001 + MPC fee |
| `settle` + `distribute_rewards` | 2 | 0.00002 |
| **Total per hand** | ~8 | **~0.0001 SOL + MPC fees** |

MPC computation fees on devnet/mainnet TBD — depends on Arcium pricing model.

### Break-Even Analysis
For a crank to be profitable, reward share must exceed per-hand costs:
- **Cash game (25% of rake):** If pot = 0.1 SOL, rake = 5% = 0.005 SOL → crank share = 0.00125 SOL
- **SNG (45% of fee):** If fee pool = 0.05 SOL → crank share = 0.0225 SOL per tournament
- At current localnet estimates, crank is profitable even at micro stakes

## TX Cost Monitoring

### HandCostLog
- Tracks per-hand TX costs for ER decision data
- Fields: `hand_number`, `num_players`, `total_txs`, `total_fees_lamports`, `avg_priority_fee`
- Crank records costs after `settle_hand`
- Dashboard shows: avg cost/hand, cost/player, cost trend
- **Decision trigger:** If avg cost > $0.10/hand on mainnet → prioritize ER integration
- **TODO:** Extend to track MPC computation fees separately

---

## Dealer License System

### Overview

The Dealer License system gates crank reward distribution behind a purchasable, non-transferable on-chain license. Without a valid license, crank operators still process game actions but their reward share is zeroed and redistributed to licensed operators.

### Accounts

| Account | Seeds | Type | Description |
|---------|-------|------|-------------|
| **DealerRegistry** | `["dealer_registry"]` | Singleton PDA | Tracks `total_sold`, `total_revenue`, `authority`, `bump` |
| **DealerLicense** | `["dealer_license", wallet]` | Per-wallet PDA | Stores `wallet`, `license_number`, `purchased_at`, `price_paid`, `bump` |

### Instructions

| Instruction | Access | Description |
|-------------|--------|-------------|
| `init_dealer_registry` | Admin only (SUPER_ADMIN) | Creates the singleton registry. Called once. |
| `grant_dealer_license` | Admin only | Grants a free license to a wallet. Used for license #0 (crank). |
| `purchase_dealer_license` | Permissionless | Anyone can buy. Buyer signs + pays, beneficiary receives the license PDA. |

### Bonding Curve Pricing

```
price = BASE_PRICE + total_sold × INCREMENT
price = min(price, MAX_PRICE)
```

| Constant | Value |
|----------|-------|
| `BASE_PRICE` | 0.001 SOL (1,000,000 lamports) |
| `INCREMENT` | 0.001 SOL per license sold |
| `MAX_PRICE` | ~9.9 SOL (at license #9,900) |

### Purchase SOL Split

50/50:
- **50% → Treasury** (`4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3`)
- **50% → Staker Pool** (`FSKrGq26FxhMUSK85ksv2AykL5Am2HS9iXJwuVoQQvLY`)

### Beneficiary Model

The `purchase_dealer_license` instruction accepts a **buyer** (signer/payer) and a separate **beneficiary**. License PDA is derived from beneficiary's pubkey — non-transferable, permanently bound.

### License Enforcement (distribute_crank_rewards)

1. Reads CrankTally to get operator pubkeys + action weights
2. For each operator, checks `remaining_accounts` for valid `DealerLicense` PDA
3. **Licensed operators** keep their weight
4. **Unlicensed operators** → weight = 0 (share redistributes to licensed operators)

### Implementation Status
- **Rust accounts/instructions:** NOT YET IMPLEMENTED (need `dealer_license.rs`, `state/dealer_license.rs`)
- **Constants:** Need `BASE_PRICE`, `INCREMENT`, `MAX_PRICE`, `DEALER_REGISTRY_SEED`, `DEALER_LICENSE_SEED`
- **distribute_crank_rewards update:** Need to add license check logic
- **E2E test:** `smoke-test-crank-rewards.ts` does NOT exist in this repo (was in old Poker repo)
- **Frontend:** `/dealer/license` page spec exists (see design doc)
