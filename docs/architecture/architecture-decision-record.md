# Architecture Decision Record — FastPoker Arcium Migration

## ADR-001: Replace TEE with Arcium MPC for Card Privacy

**Status:** Accepted  
**Date:** 2026-03-11

### Context
FastPoker uses MagicBlock TEE (Trusted Execution Environment) with Permission Program for card privacy. The TEE's L1 finalization channel is unstable. Cards are protected via RPC access-control (Permission PDAs), not cryptographic encryption.

### Decision
Replace TEE with Arcium MPC (Multi-Party Computation). Cards are encrypted using Rescue cipher with x25519 key exchange. Each player's hole cards encrypted to their unique x25519 public key. Community cards encrypted to MXE (only decryptable via MPC callback).

### Consequences
- **Privacy upgraded:** Cryptographic encryption > access-control. Even with full account read access, cards are ciphertext.
- **TEE dependency eliminated:** No Permission Program, no TEE auth tokens, no TEE validator endpoints.
- **Deal latency increased:** ~15-25s per hand (MPC computation) vs ~400ms (TEE).
- **New dependency:** Arcium MPC network (local Docker for dev, Arcium devnet/mainnet for production).

---

## ADR-002: Drop MagicBlock ER for v1, Use Solana L1

**Status:** Accepted  
**Date:** 2026-03-11

### Context
MagicBlock ER provides ~50-100ms finality and zero TX fees. Without TEE, ER has no privacy benefit. ER adds delegation/undelegation complexity that conflicts with async MPC calls.

### Decision
Run all game logic on Solana L1 for v1. Session keys (gum-sdk) provide 1-click gameplay on L1. TX cost monitoring tracks per-hand fees for future ER decision.

### Consequences
- **Simpler architecture:** No delegation cycles. MPC calls directly on L1.
- **TX costs:** ~$0.01-0.03/hand on devnet. Mainnet priority fees may spike — monitored via HandCostLog.
- **ER preserved as Phase 2 option:** If mainnet costs exceed $0.10/hand threshold, ER integration prioritized.

---

## ADR-003: One MPC Call Per Hand (Pre-Deal All Cards)

**Status:** Accepted  
**Date:** 2026-03-11

### Context
Two options: (A) Pre-deal all cards in one MPC call, (B) Per-street MPC calls. Option B adds 60-120s dead time per hand.

### Decision
Option A. Single `shuffle_and_deal` MPC call produces all cards. Community card reveals use small MPC calls (~1-3s each) to decrypt pre-dealt cards.

### Consequences
- Total MPC latency: ~25-40s/hand (deal + 3 reveals + showdown).
- Betting rounds are instant on-chain.
- Community cards stored as `Enc<Mxe, u8>` — unreadable until reveal MPC fires.

---

## ADR-004: Clean-Slate Deployment

**Status:** Accepted  
**Date:** 2026-03-11

### Decision
New program ID, new tables, no migration of existing TEE-era tables. STEEL contract integrated as-is.
