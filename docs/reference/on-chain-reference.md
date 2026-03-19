# Fast Poker — On-Chain Reference

> **Program ID (Anchor):** `BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N`
> **Program ID (Steel):** `9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6`
> **Last updated:** 2026-03-15

---

## 1. Account Sizes (including 8-byte Anchor discriminator)

| Account | SIZE (bytes) | dataSize filter | Source file |
|---------|-------------|-----------------|-------------|
| **Table** | 437 | 437 | `state/table.rs` |
| **PlayerSeat** | 281 | 281 | `state/seat.rs` |
| **SeatCards** | 156 (8+148) | 156 | `state/seat_cards.rs` |
| **DeckState** | 876 | 876 | `state/deck_state.rs` |
| **PlayerAccount** | 115 (8+93+14pad) | 115 | `state/player.rs` |
| **PlayerTableMarker** | 99 (74+16+9) | 99 | `state/player_table_marker.rs` |
| **SessionToken** | 131 (8+107+16pad) | 131 | `state/session.rs` |
| **TableVault** | 113 | 113 | `state/table_vault.rs` |
| **CashoutReceipt** | 82 | 82 | `state/cashout_receipt.rs` |
| **UnclaimedBalance** | 105 (8+81+16pad) | 105 | `state/unclaimed_balance.rs` |
| **CrankTally** | 197 | 197 | `state/crank_tally.rs` |
| **CrankOperator** | 82 | 82 | `state/crank_operator.rs` |
| **TipJar** | 67 | 67 | `state/tip_jar.rs` |
| **DealerRegistry** | 53 | 53 | `state/dealer_license.rs` |
| **DealerLicense** | 61 | 61 | `state/dealer_license.rs` |
| **RakeVault** | 105 | 105 | `state/rake_vault.rs` |
| **StakerClaim** | 89 | 89 | `state/rake_vault.rs` |
| **TokenTierConfig** | 230 | 230 | `state/token_tier_config.rs` |
| **DepositProof** | 99 | 99 | `state/deposit_proof.rs` |
| **AuctionConfig** | 41 | 41 | `state/auction.rs` |
| **AuctionState** | 76 | 76 | `state/auction.rs` |
| **TokenBid** | 61 | 61 | `state/auction.rs` |
| **BidContribution** | 89 | 89 | `state/auction.rs` |
| **GlobalTokenBid** | 53 | 53 | `state/auction.rs` |
| **GlobalBidContribution** | 90 | 90 | `state/auction.rs` |

---

## 2. PDA Seeds

| PDA | Seeds | Program |
|-----|-------|---------|
| **Table** | `["table", table_id(32)]` | Anchor |
| **PlayerSeat** | `["seat", table_pda, &[seat_index]]` | Anchor |
| **SeatCards** | `["seat_cards", table_pda, &[seat_index]]` | Anchor |
| **DeckState** | `["deck_state", table_pda]` | Anchor |
| **PlayerAccount** | `["player", wallet]` | Anchor |
| **PlayerTableMarker** | `["player_table", player_wallet, table_pda]` | Anchor |
| **SessionToken** | `["session", owner_wallet]` | Anchor |
| **TableVault** | `["vault", table_pda]` | Anchor |
| **CashoutReceipt** | `["receipt", table_pda, &[seat_index]]` | Anchor |
| **UnclaimedBalance** | `["unclaimed", table_pda, player_wallet]` | Anchor |
| **CrankTallyER** | `["crank_tally_er", table_pda]` | Anchor |
| **CrankTallyL1** | `["crank_tally_l1", table_pda]` | Anchor |
| **CrankOperator** | `["crank", authority]` | Anchor |
| **TipJar** | `["tip_jar", table_pda]` | Anchor |
| **DealerRegistry** | `["dealer_registry"]` | Anchor (singleton) |
| **DealerLicense** | `["dealer_license", wallet]` | Anchor |
| **RakeVault** | `["rake_vault", token_mint]` | Anchor |
| **StakerClaim** | `["staker_claim", rake_vault, staker]` | Anchor |
| **TokenTierConfig** | `["tier_config", token_mint]` | Anchor |
| **DepositProof** | `["deposit_proof", table_pda, &[seat_index]]` | Anchor |
| **AuctionConfig** | `["auction_config"]` | Anchor (singleton) |
| **AuctionState** | `["auction", &epoch.to_le_bytes()]` | Anchor |
| **TokenBid** | `["token_bid", auction_state, token_mint]` | Anchor |
| **BidContribution** | `["bid_contrib", auction_state, token_mint, bidder]` | Anchor |
| **GlobalTokenBid** | `["global_bid", token_mint]` | Anchor |
| **GlobalBidContribution** | `["global_contrib", token_mint, bidder]` | Anchor |
| **Pool** (Steel) | `["pool"]` | Steel |
| **Unrefined** (Steel) | `["unrefined", wallet]` | Steel |

---

## 3. Table Account — Field-by-Field Byte Offsets

Total SIZE = 437 bytes (including 8-byte discriminator).

| Offset | Size | Field | Type | Notes |
|--------|------|-------|------|-------|
| 0 | 8 | discriminator | `[u8;8]` | Anchor account discriminator |
| 8 | 32 | `table_id` | `[u8;32]` | Unique table identifier |
| 40 | 32 | `authority` | `Pubkey` | Table manager |
| 72 | 32 | `pool` | `Pubkey` | Steel pool PDA for rake |
| 104 | 1 | `game_type` | `GameType` | 0=SNG_HU, 1=SNG_6, 2=SNG_9, 3=Cash |
| 105 | 8 | `small_blind` | `u64 LE` | |
| 113 | 8 | `big_blind` | `u64 LE` | |
| 121 | 1 | `max_players` | `u8` | 2, 6, or 9 |
| 122 | 1 | `current_players` | `u8` | Seated count |
| 123 | 8 | `hand_number` | `u64 LE` | |
| 131 | 8 | `pot` | `u64 LE` | |
| 139 | 8 | `min_bet` | `u64 LE` | |
| 147 | 8 | `rake_accumulated` | `u64 LE` | |
| 155 | 5 | `community_cards` | `[u8;5]` | 255=not dealt |
| 160 | 1 | `phase` | `GamePhase` | See enum below |
| 161 | 1 | `current_player` | `u8` | Seat index, 255=none |
| 162 | 1 | `actions_this_round` | `u8` | |
| 163 | 1 | `dealer_button` | `u8` | Seat index |
| 164 | 1 | `small_blind_seat` | `u8` | |
| 165 | 1 | `big_blind_seat` | `u8` | |
| 166 | 8 | `last_action_slot` | `u64 LE` | For timeout |
| 174 | 1 | `is_delegated` | `bool` | DEPRECATED, always false |
| 175 | 18 | `revealed_hands` | `[u8;18]` | 9 seats × 2 cards, 255=hidden |
| 193 | 9 | `hand_results` | `[u8;9]` | 0=none, 1=high..10=royal |
| 202 | 5 | `pre_community` | `[u8;5]` | Legacy, zeroed |
| 207 | 32 | `deck_seed` | `[u8;32]` | Card-usage bitmask |
| 239 | 1 | `deck_index` | `u8` | Cards consumed |
| 240 | 1 | `stakes_level` | `u8` | |
| 241 | 1 | `blind_level` | `u8` | SNG blind level 0-9 |
| 242 | 8 | `tournament_start_slot` | `u64 LE` | Unix timestamp for SNG |
| 250 | 2 | `seats_occupied` | `u16 LE` | Bitmask |
| 252 | 2 | `seats_allin` | `u16 LE` | Bitmask |
| 254 | 2 | `seats_folded` | `u16 LE` | Bitmask |
| 256 | 1 | `dead_button` | `bool` | |
| 257 | 1 | `flop_reached` | `bool` | Reset by settle |
| 258 | 32 | `token_escrow` | `Pubkey` | SPL escrow PDA |
| 290 | 32 | `creator` | `Pubkey` | |
| 322 | 1 | `is_user_created` | `bool` | |
| 323 | 8 | `creator_rake_total` | `u64 LE` | |
| 331 | 8 | `last_rake_epoch` | `u64 LE` | |
| 339 | 1 | `prizes_distributed` | `bool` | |
| 340 | 1 | `unclaimed_balance_count` | `u8` | |
| 341 | 1 | `bump` | `u8` | PDA bump |
| 342 | 9 | `eliminated_seats` | `[u8;9]` | Elimination order |
| 351 | 1 | `eliminated_count` | `u8` | |
| 352 | 8 | `entry_fees_escrowed` | `u64 LE` | |
| 360 | 1 | `tier` | `SnGTier` | 0=Micro..5=Diamond |
| 361 | 8 | `entry_amount` | `u64 LE` | |
| 369 | 8 | `fee_amount` | `u64 LE` | |
| 377 | 8 | `prize_pool` | `u64 LE` | |
| 385 | 32 | `token_mint` | `Pubkey` | Default=SOL |
| 417 | 1 | `buy_in_type` | `u8` | 0=Normal, 1=Deep |
| 418 | 8 | `rake_cap` | `u64 LE` | |
| 426 | 1 | `is_private` | `bool` | |
| 427 | 8 | `crank_pool_accumulated` | `u64 LE` | |
| 435 | 2 | `action_nonce` | `u16 LE` | Timeout race protection |

---

## 4. PlayerSeat Account — Field-by-Field Byte Offsets

Total SIZE = 281 bytes.

| Offset | Size | Field | Type |
|--------|------|-------|------|
| 0 | 8 | discriminator | `[u8;8]` |
| 8 | 32 | `wallet` | `Pubkey` |
| 40 | 32 | `session_key` | `Pubkey` |
| 72 | 32 | `table` | `Pubkey` |
| 104 | 8 | `chips` | `u64 LE` |
| 112 | 8 | `bet_this_round` | `u64 LE` |
| 120 | 8 | `total_bet_this_hand` | `u64 LE` |
| 128 | 64 | `hole_cards_encrypted` | `[u8;64]` |
| 192 | 32 | `hole_cards_commitment` | `[u8;32]` |
| 224 | 2 | `hole_cards` | `[u8;2]` | 255=hidden |
| 226 | 1 | `seat_number` | `u8` |
| 227 | 1 | `status` | `SeatStatus` |
| 228 | 8 | `last_action_slot` | `u64 LE` |
| 236 | 1 | `missed_sb` | `bool` |
| 237 | 1 | `missed_bb` | `bool` |
| 238 | 1 | `posted_blind` | `bool` |
| 239 | 1 | `waiting_for_bb` | `bool` |
| 240 | 1 | `sit_out_button_count` | `u8` |
| 241 | 1 | `hands_since_bust` | `u8` |
| 242 | 1 | `auto_fold_count` | `u8` |
| 243 | 1 | `missed_bb_count` | `u8` |
| 244 | 1 | `bump` | `u8` |
| 245 | 1 | `paid_entry` | `bool` |
| 246 | 8 | `cashout_chips` | `u64 LE` |
| 254 | 8 | `cashout_nonce` | `u64 LE` |
| 262 | 8 | `vault_reserve` | `u64 LE` | DEPRECATED, always 0 |
| 270 | 8 | `sit_out_timestamp` | `i64 LE` |
| 278 | 2 | `time_bank_seconds` | `u16 LE` |
| 280 | 1 | `time_bank_active` | `bool` |

---

## 5. SeatCards Account — Field-by-Field Byte Offsets

Total SIZE = 156 bytes (8 disc + 148 data).

| Offset | Size | Field | Type | Notes |
|--------|------|-------|------|-------|
| 0 | 8 | discriminator | `[u8;8]` | |
| 8 | 32 | `table` | `Pubkey` | |
| 40 | 1 | `seat_index` | `u8` | |
| 41 | 32 | `player` | `Pubkey` | |
| 73 | 1 | `card1` | `u8` | Plaintext at showdown, 255=hidden |
| 74 | 1 | `card2` | `u8` | Plaintext at showdown, 255=hidden |
| 75 | 1 | `bump` | `u8` | |
| 76 | 32 | `enc_card1` | `[u8;32]` | Rescue ciphertext (packed u16) |
| 108 | 32 | `enc_card2` | `[u8;32]` | Zeroed (packed uses single ct) |
| 140 | 16 | `nonce` | `[u8;16]` | For Rescue cipher decryption |

### Client Decryption Flow
1. Read `enc_card1` (32 bytes at offset 76) and `nonce` (16 bytes at offset 140)
2. Derive shared secret: `x25519.getSharedSecret(playerSecretKey, mxePublicKey)`
3. `new RescueCipher(sharedSecret).decrypt([ctArray], nonce)` → packed `u16`
4. `card1 = (u16 >> 8) & 0xFF`, `card2 = u16 & 0xFF`

---

## 6. Enums

### GamePhase (1 byte)
| Value | Name | Description |
|-------|------|-------------|
| 0 | `Waiting` | Waiting for players |
| 1 | `Starting` | Blinds posted, awaiting deal |
| 2 | `AwaitingDeal` | MPC shuffle queued |
| 3 | `Preflop` | First betting round |
| 4 | `Flop` | Second betting round |
| 5 | `Turn` | Third betting round |
| 6 | `River` | Final betting round |
| 7 | `Showdown` | Reveal cards |
| 8 | `AwaitingShowdown` | MPC reveal queued |
| 9 | `Complete` | Hand finished |
| 10 | `FlopRevealPending` | MPC flop reveal queued |
| 11 | `TurnRevealPending` | MPC turn reveal queued |
| 12 | `RiverRevealPending` | MPC river reveal queued |

### SeatStatus (1 byte)
| Value | Name |
|-------|------|
| 0 | `Empty` |
| 1 | `Active` |
| 2 | `Folded` |
| 3 | `AllIn` |
| 4 | `SittingOut` |
| 5 | `Busted` |
| 6 | `Leaving` |

### GameType (1 byte)
| Value | Name |
|-------|------|
| 0 | `SitAndGoHeadsUp` |
| 1 | `SitAndGo6Max` |
| 2 | `SitAndGo9Max` |
| 3 | `CashGame` |

### PokerAction (Borsh enum, variable size)
| Variant | Discriminant | Extra data |
|---------|-------------|------------|
| `Fold` | 0 | — |
| `Check` | 1 | — |
| `Call` | 2 | — |
| `Bet` | 3 | `amount: u64` (8 bytes) |
| `Raise` | 4 | `amount: u64` (8 bytes) |
| `AllIn` | 5 | — |
| `SitOut` | 6 | — |
| `ReturnToPlay` | 7 | — |
| `LeaveCashGame` | 8 | — |
| `RebuyTopUp` | 9 | `amount: u64` (DEPRECATED) |

### SnGTier (1 byte)
| Value | Name | Entry (devnet) | Fee (devnet) | Total |
|-------|------|---------------|-------------|-------|
| 0 | `Micro` | 0 | 0.01 SOL | 0.01 SOL |
| 1 | `Bronze` | 0.01875 | 0.00625 | 0.025 SOL |
| 2 | `Silver` | 0.0375 | 0.0125 | 0.05 SOL |
| 3 | `Gold` | 0.075 | 0.025 | 0.10 SOL |
| 4 | `Platinum` | 0.15 | 0.05 | 0.20 SOL |
| 5 | `Diamond` | 0.375 | 0.125 | 0.50 SOL |

---

## 7. Instruction Discriminators

Anchor discriminators = first 8 bytes of `sha256("global:<ix_name>")`.

| Instruction | Discriminator (hex) | Discriminator (decimal array) |
|-------------|--------------------|-----------------------------|
| `register_player` | compute from `global:register_player` | |
| `create_table` | compute from `global:create_table` | |
| `join_table` | `0e7554335f92ab46` | `[14,117,84,51,95,146,171,70]` |
| `leave_table` | `a3995ac2136a7120` | `[163,153,94,194,19,106,113,32]` |
| `player_action` | `25551987c8746065` | `[37,85,25,135,200,116,96,101]` |
| `start_game` | `f92ffcacb8a2f50e` | `[249,47,252,172,184,162,245,14]` |
| `settle_hand` | compute from `global:settle_hand` | |
| `handle_timeout` | compute from `global:handle_timeout` | |
| `devnet_bypass_deal` | compute from `global:devnet_bypass_deal` | |
| `devnet_bypass_reveal` | compute from `global:devnet_bypass_reveal` | |
| `arcium_deal` | compute from `global:arcium_deal` | |
| `process_cashout_v3` | compute from `global:process_cashout_v3` | |
| `process_rake_distribution` | compute from `global:process_rake_distribution` | |
| `distribute_crank_rewards` | compute from `global:distribute_crank_rewards` | |
| `distribute_prizes` | compute from `global:distribute_prizes` | |
| `crank_remove_player` | compute from `global:crank_remove_player` | |
| `crank_kick_inactive` | compute from `global:crank_kick_inactive` | |
| `rebuy` | compute from `global:rebuy` | |

To compute any discriminator:
```bash
node -e "console.log([...require('crypto').createHash('sha256').update('global:IX_NAME').digest().slice(0,8)])"
```

---

## 8. Key Constants

| Constant | Value | Notes |
|----------|-------|-------|
| `TIMEOUT_SECONDS` | 15 | Unix-time minimum for handle_timeout |
| `RAKE_BPS` | 500 | 5% rake |
| `CASH_MIN_BUY_IN_BB` | 20 | Min buy-in multiplier |
| `CASH_MAX_BUY_IN_BB` | 100 | Max buy-in multiplier |
| `SNG_STARTING_CHIPS` | 1500 | Per-player starting stack |
| `SNG_BLIND_INTERVAL_SECONDS` | 300 | 5 min per blind level |
| `TIME_BANK_MAX_SECONDS` | 60 | Max time bank |
| `TIME_BANK_CHUNK_SECONDS` | 15 | Per-activation chunk |
| `MISSED_BB_REMOVAL_COUNT` | 3 | Auto-remove threshold |
| `AUTO_FOLD_SIT_OUT_COUNT` | 3 | Auto-sitout threshold |
| `UNCLAIMED_EXPIRY_SECONDS` | 8,640,000 | 100 days |
| `CHIP_LOCK_DURATION` | 43,200 | 12 hours (anti-rathole) |
| `KICK_PENALTY_DURATION` | 1,800 | 30 min rejoin penalty |

### Rake Distribution (basis points, 10000 = 100%)
| Split | System Tables | User-Created Tables | SNG Fees |
|-------|--------------|--------------------| ---------|
| Treasury | 500 (5%) | 500 (5%) | 1000 (10%) |
| Stakers | 5000 (50%) | 2500 (25%) | 4500 (45%) |
| Dealers | 4500 (45%) | 2500 (25%) | 4500 (45%) |
| Creator | — | 5000 (50%) | — |

### Dealer License Bonding Curve
```
price = 0.001 SOL + total_sold × 0.001 SOL
price = min(price, 9.9 SOL)
```
Purchase split: 50% treasury, 50% staker pool.

---

## 9. Key Pubkeys

| Name | Pubkey |
|------|--------|
| Anchor Program | `BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N` |
| Steel Program | `9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6` |
| Treasury | `4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3` |
| POKER Mint | `DiJC3FVReapYYDwRnPMrCRH7aYyeJ47Nu81MemTaHZWX` |
| Super Admin | `GkfdM1vqRYrU2LJ4ipwCJ3vsr2PGYLpdtdKK121ZkQZg` |
| Pool (Steel) | `FSKrGq26FxhMUSK85ksv2AykL5Am2HS9iXJwuVoQQvLY` |

---

## 10. Error Codes (Anchor: 6000 + offset)

| Code | Name | Category |
|------|------|----------|
| 6000 | `TableFull` | Table |
| 6001 | `TableEmpty` | Table |
| 6002 | `TableNotWaiting` | Table |
| 6005 | `NotEnoughPlayers` | Table |
| 6007 | `HandInProgress` | Table |
| 6010 | `PlayerNotRegistered` | Player |
| 6012 | `PlayerAlreadySeated` | Player |
| 6013 | `SeatOccupied` | Player |
| 6018 | `InsufficientChips` | Player |
| 6019 | `InvalidBuyIn` | Player |
| 6022 | `NotPlayersTurn` | Action |
| 6027 | `NothingToCall` | Action (BB must CHECK not call) |
| 6061 | `InsufficientFunds` | Economics |
| 6070 | `InvalidPlayerCount` | Arcium MPC |
| 6071 | `ArciumComputationPending` | Arcium MPC |
| 6072 | `ArciumCallbackInvalid` | Arcium MPC |
| 6073 | `ArciumComputationTimeout` | Arcium MPC (error 6110 in logs) |
| Custom:0 | Already initialized | Anchor `init` constraint |
| Custom:101 | InstructionFallbackNotFound | IX missing from binary |
| Custom:102 | InstructionDidNotDeserialize | **Wrong `HasSize::SIZE`** — #1 callback failure. See SIZE table in §11. |
| 6000 (Arcium) | InvalidAuthority | Often a red herring on callback retries (computation already claimed). Check FIRST error in node logs. |
| 6001 (Arcium) | BLSSignatureVerificationFailed | Known localnet issue — use CPI context validation workaround |
| Custom:3008 | AccountNotInitialized | Missing init_table_seat |

---

## 11. Arcium MPC — Circuit Output Format

### HasSize::SIZE — Output-Type-Specific (CRITICAL)

**`HasSize::SIZE` varies by MPC output type — NOT always `count × 32`!**

| Output Type | Bytes/ea | Circuit | SIZE |
|-------------|----------|---------|------|
| `Output::Ciphertext` (Enc<T,V>) | 32 | shuffle_and_deal (10 ct) | **320** |
| `Output::PlaintextU8` | 1 | reveal_community (5 u8) | **5** |
| `Output::PlaintextU16` | 2 | reveal_showdown (9 u16) | **18** |
| `Output::PlaintextU64` | 8 | — | — |
| `Output::PlaintextU128` | 16 | — | — |

**Wrong SIZE → Anchor error 102 (InstructionDidNotDeserialize).** This is the #1 callback failure.

### shuffle_and_deal (10 Ciphertext outputs, SIZE=320)

**HasSize::SIZE = 320** (10 outputs × 32 bytes). Covers HU (2 players).

Raw MPC ciphertext output uses **stride=3** per encrypted value: `[nonce, ct1, ct2]`.
With 10 declared outputs, MPC sends 10 raw 32-byte slots:

```
Slot  0: Mxe nonce  (value = 0x01, zero-padded to 32)
Slot  1: Mxe ct1    (packed community ciphertext) ← MXE_CT_SLOT
Slot  2: Mxe ct2    (unused Rescue block)
Slot  3: P0 nonce   (output nonce for player 0)
Slot  4: P0 ct1     ← FIRST_PLAYER_SLOT (hole card ciphertext)
Slot  5: P0 ct2     (unused)
Slot  6: P1 nonce
Slot  7: P1 ct1     ← hole card ciphertext
Slot  8: P1 ct2     (unused)
Slot  9: P2 nonce   (truncated — no ct within SIZE window)
```

**Callback constants:** `MXE_CT_SLOT=1`, `FIRST_PLAYER_SLOT=4`, `PLAYER_STRIDE=3`.
**Stride=3:** `player_ct_offset(i) = (4 + i*3) * 32`, `player_nonce_offset(i) = (3 + i*3) * 32`

**Card packing:** `u16 = card1 * 256 + card2`. Client: `card1 = u16 >> 8, card2 = u16 & 0xFF`.

**Community cards cannot be decrypted client-side** — they use `Shared::new()` which creates a different encryption context. Revealed via `reveal_community` MPC circuit.

### reveal_community (5 PlaintextU8 outputs, SIZE=5)

**HasSize::SIZE = 5** (5 × 1 byte). Plaintext outputs are native-sized, NO stride/padding.
Raw output: 5 consecutive bytes, each a card index (0-51, 255=not revealed).
Parse: `cards[i] = raw_bytes[i]` for i in 0..5.

### reveal_showdown (9 PlaintextU16 outputs, SIZE=18)

**HasSize::SIZE = 18** (9 × 2 bytes). Packed u16 LE values, one per seat.
Parse: `u16::from_le_bytes([raw_bytes[i*2], raw_bytes[i*2+1]])`.
Unpack: `card1 = u16 >> 8`, `card2 = u16 & 0xFF`. `0xFFFF` = not dealt/folded.

### arcium_deal instruction data layout
```
disc(8) + computation_offset(u64:8) + player_data(Vec<u8>: u32_len:4 + 9×48:432) + num_players(u8:1)
```
player_data per slot: `x25519_pubkey(32) + nonce_le(16)` = 48 bytes.

---

## 12. Instruction Account Lists

### join_table (14 accounts)
```
0  player              (signer, mut)
1  player_account      (mut)
2  table               (mut)
3  seat                (mut, init_if_needed)
4  player_table_marker (mut, init_if_needed)
5  vault               (Opt, mut)         — PROGRAM_ID sentinel for SNG
6  receipt             (Opt, mut, init)    — PROGRAM_ID sentinel for SNG
7  treasury            (Opt, mut)         — PROGRAM_ID sentinel for SNG
8  pool                (Opt, mut)         — PROGRAM_ID sentinel for SNG
9  player_token_account (Opt)             — PROGRAM_ID sentinel for SOL tables
10 table_token_account  (Opt)             — PROGRAM_ID sentinel for SOL tables
11 unclaimed_balance    (Opt, mut)        — PROGRAM_ID sentinel for SNG
12 token_program        (Opt)             — PROGRAM_ID sentinel for SOL tables
13 system_program
```

### leave_table (8 accounts)
```
0  player              (signer, mut)
1  table               (mut)
2  seat                (mut)
3  player_table_marker (mut)
4  player_token_account (Opt)  — PROGRAM_ID for SOL tables
5  table_token_account  (Opt)  — PROGRAM_ID for SOL tables
6  token_program        (Opt)  — PROGRAM_ID for SOL tables
7  system_program
```

### player_action (5 accounts)
```
0  player/session_key  (signer, mut)
1  table               (mut)
2  seat                (mut)
3  session_token       (Opt)  — PROGRAM_ID sentinel if wallet-signed
4  system_program
```

### start_game (2 + 2N accounts)
```
0  authority           (signer, mut)
1  table               (mut)
2..N+1    seat[0..N-1]        (mut)
N+2..2N+1 seat_cards[0..N-1]  (mut)
```

---

## 13. Game Flow (Crank Phase → Action)

```
Waiting (0)       → start_game            (if current_players >= 2)
Starting (1)      → arcium_deal / devnet_bypass_deal
AwaitingDeal (2)  → (wait for MPC callback)
Preflop (3)       → player_action (betting)
FlopRevealPending (10) → arcium_reveal / devnet_bypass_reveal
Flop (4)          → player_action (betting)
TurnRevealPending (11) → arcium_reveal / devnet_bypass_reveal
Turn (5)          → player_action (betting)
RiverRevealPending (12) → arcium_reveal / devnet_bypass_reveal
River (6)         → player_action (betting)
Showdown (7)      → settle_hand
AwaitingShowdown (8) → (wait for MPC callback)
Complete (9)      → (settle done, auto-transitions to Waiting or waits for crank)
```

**Timeout:** Any phase with `current_player != 255` — crank calls `handle_timeout(expected_nonce)` after 15s.

---

## 14. SNG Blind Structure

5-minute levels. `tournament_start_slot` stores unix timestamp.

| Level | SB | BB | Minutes |
|-------|----|----|---------|
| 1 | 10 | 20 | 0-5 |
| 2 | 15 | 30 | 5-10 |
| 3 | 25 | 50 | 10-15 |
| 4 | 50 | 100 | 15-20 |
| 5 | 75 | 150 | 20-25 |
| 6 | 100 | 200 | 25-30 |
| 7 | 150 | 300 | 30-35 |
| 8 | 200 | 400 | 35-40 |
| 9 | 300 | 600 | 40-45 |
| 10 | 500 | 1000 | 45-50 |

Starting chips: 1500 per player.

### Prize Payouts
- **HU:** 100% to winner
- **6-Max:** 65% / 35%
- **9-Max:** 50% / 30% / 20%
