# Game Flow & Security Guards — Arcium Architecture

> **No TEE, No Delegation, No Guard Program.** Everything runs on L1 Solana.
> Security comes from PDA constraints, signer checks, phase state machine, and Arcium MPC.

---

## Full Game Lifecycle

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐     ┌──────────────┐
│ register_    │ ──► │ create_table │ ──► │ init_table_  │ ──► │ join_table   │
│ player       │     │              │     │ seat (×N)    │     │ (per player) │
└─────────────┘     └──────────────┘     └─────────────┘     └──────────────┘
                                                                     │
                    ┌──────────────────────────────────────────────────┘
                    ▼
              ┌───────────┐     ┌──────────────┐     ┌──────────────────┐
              │ start_game│ ──► │ arcium_deal  │ ──► │ [MPC callback]   │
              │ (phase:   │     │ (queue MPC)  │     │ shuffle_and_deal │
              │ Starting) │     │ (phase:      │     │ _callback        │
              └───────────┘     │ AwaitingDeal)│     │ (phase: Preflop) │
                                └──────────────┘     └──────────────────┘
                                                              │
              ┌───────────────────────────────────────────────┘
              ▼
        ┌───────────────┐     ┌───────────────┐     ┌───────────────┐
        │ player_action │ ──► │ player_action │ ──► │ player_action │
        │ (Preflop)     │     │ (Flop)        │     │ (Turn/River)  │
        └───────────────┘     └───────────────┘     └───────────────┘
              │                                              │
              │ (between streets: arcium reveal_community)   │
              │                                              ▼
              │                                     ┌──────────────┐
              │                                     │ settle       │
              │                                     │ (phase:      │
              │                                     │ Complete)    │
              └────────────────────────────────────►└──────────────┘
```

---

## Security Guards Per Instruction

### 1. `register_player`
| Guard | Mechanism |
|-------|-----------|
| One account per wallet | PDA: `[PLAYER_SEED, wallet]` — Anchor enforces uniqueness |
| Wallet ownership | `player: Signer<'info>` — must sign TX |

### 2. `create_table`
| Guard | Mechanism |
|-------|-----------|
| Creator recorded | `table.creator = payer.key()` — immutable after creation |
| Valid config | `max_players ∈ {2,6,9}`, stakes validated, tier checked |
| Unique table ID | PDA: `[TABLE_SEED, table_id]` — random UUID prevents collision |

### 3. `join_table`
| Guard | Mechanism |
|-------|-----------|
| **Can't steal a seat** | `seat.status == SeatStatus::Empty` — checked before seating |
| **Can't sit twice** | `PlayerTableMarker` PDA per player+table — if `marker.player != default`, reject |
| **Private table** | WhitelistEntry PDA checked in `remaining_accounts` |
| **Buy-in range** | `min_buy_in <= amount <= max_buy_in` (20-100 BB normal, 50-250 BB deep) |
| **Anti-ratholing** | Chip lock in marker trailing bytes — if left within 12h, must buy in ≥ chips_at_leave |
| **Anti-abuse** | Kick penalty — +1 BB min buy-in if kicked within 30 min |
| **SNG entry** | Exact tier buy-in (entry + fee) from `SnGTier` constants |
| **Wallet signs** | `player: Signer<'info>` — player must approve TX |

### 4. `start_game`
| Guard | Mechanism |
|-------|-----------|
| **PERMISSIONLESS** | Anyone can call — crank convenience only |
| Phase gate | `table.phase == Waiting` or `Complete` |
| Min players | `current_players >= 2` |
| x25519 check | All active seats must have non-zero `x25519_pubkey` |

### 5. `arcium_deal` (queue MPC)
| Guard | Mechanism |
|-------|-----------|
| **PERMISSIONLESS** | Anyone can call when phase is Starting |
| Phase gate | `table.phase == Starting` |
| Player count | `2 <= num_players <= 9` |
| Valid pubkeys | Non-zero x25519 pubkeys (Arcium rejects all-zero) |
| Computation uniqueness | `computation_offset` → unique computation PDA |

### 6. `shuffle_and_deal_callback` (MPC result)
| Guard | Mechanism |
|-------|-----------|
| **Arcium-only caller** | `validate_arcium_callback_context()` checks preceding IX is Arcium's `callbackComputation` |
| Phase gate | `table.phase == AwaitingDeal` |
| Output validation | `raw_bytes.len() >= 736` (23 × 32 bytes for 9 players) |
| Comp def match | `comp_def_account` address validated via PDA |

### 7. `player_action` (fold/check/call/bet/raise/allin)
| Guard | Mechanism |
|-------|-----------|
| **Identity** | `signer == seat.wallet` OR valid `SessionToken` (session_key == signer, owner == wallet, not expired) |
| **Turn enforcement** | `table.current_player == seat.seat_number` |
| **Phase gate** | Must be Preflop, Flop, Turn, or River |
| **Can act** | `seat.can_act()` — not folded, not all-in, not sitting out |
| **Bet validation** | Min raise rules, pot limit, stack limits enforced in process_bet/raise |

### 8. `settle` (end of hand)
| Guard | Mechanism |
|-------|-----------|
| **PERMISSIONLESS** | Anyone can call |
| Phase gate | `table.phase == Showdown` or `Complete` |
| Hand eval | On-chain `evaluate_hand()` — deterministic, verifiable |
| Pot math | Side pots calculated, winner(s) paid from each pot layer |

### 9. `handle_timeout`
| Guard | Mechanism |
|-------|-----------|
| **PERMISSIONLESS** | Anyone can call after timeout window |
| Time check | `current_slot - seat.last_action_slot > TIMEOUT_SLOTS` |
| Auto-fold | Increments `auto_fold_count`, auto-kicks after threshold |

---

## What Changed from TEE Architecture

| Aspect | Old (TEE/ER) | New (Arcium) |
|--------|-------------|--------------|
| **Execution** | Ephemeral Rollup (MagicBlock) | L1 Solana directly |
| **Delegation** | Table account delegated to ER | No delegation |
| **Guard program** | Custom delegation guard on ER | PDA constraints + phase machine |
| **Card privacy** | TEE encryption inside ER | Arcium MPC (Rescue cipher) |
| **Seat protection** | Guard checked caller identity | PDA seeds + signer checks |
| **Turn enforcement** | Guard prevented out-of-turn | `current_player == seat_number` constraint |
| **Phase gating** | Guard restricted IX by phase | Anchor `constraint = table.phase == X` |
| **Session keys** | gum-sdk on ER | gum-sdk on L1 (same pattern) |
| **Money custody** | TableVault delegated to ER | TableVault on L1 (never delegated) |
| **Latency** | ~50ms (ER) | ~400ms (L1 Solana) |

### Key Insight
The delegation guard was essentially enforcing the same rules that Anchor constraints now enforce natively:
- Phase checks → `constraint = table.phase == X`
- Signer checks → `Signer<'info>` + session key validation
- Seat ownership → PDA derivation from wallet + table
- Turn order → `current_player` field comparison

The guard was needed on ER because ER had write access to all accounts — any ER instruction could write anywhere. On L1, Solana's native account model prevents this: only the program that owns an account can write to it, and PDA derivation ensures accounts belong to specific entities.

---

## Privacy Model (No Peeking)

| Data | On-Chain State | Who Can Read |
|------|---------------|--------------|
| **Hole cards** | `SeatCards.encrypted_card_1/2` = 32-byte Rescue ciphertext | Only the player with matching x25519 secret key |
| **Community (pre-reveal)** | `DeckState.encrypted_community[0..4]` = 32-byte ciphertexts | Nobody — MXE-encrypted, decrypted only via reveal_community MPC |
| **Community (post-reveal)** | `DeckState.community_cards[0..4]` = plaintext u8 | Everyone (public after reveal) |
| **Folded cards** | Stay encrypted forever | Nobody — never revealed |
| **Showdown cards** | Revealed via reveal_showdown MPC | Everyone (after showdown MPC completes) |

### Why You Can't Peek
1. **SeatCards** — anyone can read the account, but they get 32-byte Rescue ciphertext
2. **No private key on-chain** — x25519 secret keys never leave the player's browser
3. **MPC nodes** — they hold secret shares, not the actual values (threshold MPC)
4. **Folded cards** — the reveal_showdown circuit uses `active_mask` bitmask; folded seats output 255
