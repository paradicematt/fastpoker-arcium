# Frontend Audit & Rework Plan

> **Date:** 2026-03-13
> **Source:** `J:\Poker\client-v2` (Next.js 14, Tailwind, Zustand, gum-sdk sessions)
> **Target:** `J:\Poker-Arc\frontend` (copy + adapt for Arcium L1 architecture)

---

## 1. Source Codebase Summary

The old frontend at `J:\Poker\client-v2` is a **functional Next.js 14 app** with:
- Crypto-native dark theme (Tailwind)
- Wallet connect (Phantom/Solflare via wallet-adapter)
- Zustand game state store
- Gum-sdk session keys (gasless play)
- PokerTable with HU/6-max/9-max seat layouts
- Lobby with SNG queue + cash game tables
- Profile, Staking, My Tables, Dealer License pages
- Sound effects, XP levels, time bank

### File Inventory (~87k lines total)

| Directory | Key Files | Size |
|-----------|-----------|------|
| `src/app/` | `page.tsx` (70k lobby+game), `layout.tsx`, `providers.tsx`, `globals.css` | ~78k |
| `src/components/game/` | `PokerTable.tsx` (64k), `Card.tsx`, `Seat.tsx`, `BettingControls.tsx`, `ShowdownControls.tsx`, `Table.tsx` | ~84k |
| `src/components/layout/` | `Navbar.tsx`, `SessionBar.tsx`, `SessionModal.tsx`, `Footer.tsx`, `ActiveTableBar.tsx` | ~47k |
| `src/components/lobby/` | `Lobby.tsx` (47k) | ~47k |
| `src/components/admin/` | `CrankDashboard.tsx` (28k) | ~28k |
| `src/hooks/` | `useOnChainGame.ts` (35k), `useSession.ts` (31k), `useGameAuth.tsx` (21k), `useTeeAuth.ts` (9k), `useCards.ts` (6k), `usePlayer.ts` (8k), `useJoinTable.ts` (6k), `useTableList.ts` (3k), `useSoundEffects.ts` (5k) | ~124k |
| `src/lib/` | `onchain-game.ts` (87k), `constants.ts` (11k), `crank.ts` (8k), `hand-evaluator.ts` (8k), `cards.ts` (3k), `pda.ts` (2k), others | ~134k |
| `src/store/` | `gameStore.ts` (6k) | ~6k |

---

## 2. Per-File Audit: Keep / Update / Remove

### ✅ KEEP AS-IS (no TEE/ER references, pure UI/logic)

| File | Reason |
|------|--------|
| `src/app/layout.tsx` | Root layout — just update metadata text |
| `src/app/globals.css` | Crypto-native dark theme — fully reusable |
| `src/components/game/Card.tsx` | Pure CSS card rendering — no chain logic |
| `src/components/game/Seat.tsx` | Pure seat display component |
| `src/components/game/BettingControls.tsx` | Action buttons/slider — pure UI |
| `src/components/game/ShowdownControls.tsx` | Show/Muck buttons — pure UI |
| `src/components/game/Table.tsx` | Zustand-connected table wrapper |
| `src/components/layout/Navbar.tsx` | Nav + wallet button |
| `src/components/layout/Footer.tsx` | Static footer |
| `src/components/layout/LayoutShell.tsx` | Layout wrapper |
| `src/lib/cards.ts` | Card parsing (rank/suit from 0-51) — correct encoding |
| `src/lib/utils.ts` | cn(), formatChips — pure helpers |
| `src/lib/avatars.ts` | Avatar generation |
| `src/lib/hand-evaluator.ts` | Client-side hand eval for display |
| `src/lib/poker-sounds.ts` | Sound effects |
| `src/hooks/useSoundEffects.ts` | Sound hook |
| `src/hooks/useTokenLogo.ts` | Token logo resolver |
| `src/store/gameStore.ts` | Zustand store — phase map needs `AwaitingDeal`/`AwaitingShowdown` |

### 🟡 UPDATE (TEE/ER references to remove, program ID to change, offsets to verify)

| File | What Changes |
|------|-------------|
| `src/app/providers.tsx` | Remove `GameAuthProvider` (TEE), remove `SessionProvider` import from gum-sdk → replace with Arcium-compatible session. Keep wallet + connection providers. |
| `src/app/page.tsx` (70k) | Remove TEE auth gating. Update game state subscription to use L1 polling. Remove `/api/game-state` cache fetch. Keep lobby UI + game view layout. |
| `src/components/game/PokerTable.tsx` (64k) | Remove TEE connection refs. Update card reading to use Arcium decryption or plaintext. Keep all seat layout, animations, UI. |
| `src/components/lobby/Lobby.tsx` (47k) | Remove ER/TEE references. Keep table listing, SNG queue UI, cash table browsing. |
| `src/components/layout/SessionBar.tsx` | Remove gum-sdk TEE session display. Update to show Arcium session status. |
| `src/components/layout/SessionModal.tsx` | Remove gum-sdk TEE session creation. Update for L1 session keys. |
| `src/components/layout/ActiveTableBar.tsx` | Remove TEE connection status. Keep active table indicator. |
| `src/hooks/useOnChainGame.ts` (35k) | **MAJOR REWORK:** Remove TEE connection, ER fallback, `/api/game-state` cache. Simplify to L1-only polling via `getAccountInfo`. Add `AwaitingDeal`/`AwaitingShowdown` phases. Keep player state parsing, action sending. |
| `src/hooks/useSession.ts` (31k) | Remove gum-sdk `SessionTokenManager` import. Keep `deriveSessionKeypair()` (reusable). Update session creation to use L1 program directly (no ER delegation). |
| `src/hooks/useCards.ts` (6k) | **REWORK:** Replace TEE/ER card reading with: (1) plaintext from SeatCards offset 73/74 for mock mode, (2) Arcium decryption from enc_card1+nonce for MPC mode. Use `shared/crypto/arcium-cards.ts`. |
| `src/hooks/usePlayer.ts` | Remove TEE references. Update to L1-only `getAccountInfo`. |
| `src/hooks/useJoinTable.ts` | Remove ER deposit/delegation flow. Simplify to L1 `join_table` only. |
| `src/hooks/useTableList.ts` | Remove ER fallback. L1-only `getProgramAccounts`. |
| `src/lib/constants.ts` | **Update program ID** `4MLbu...` → `BGyLY...`. Remove `PERMISSION_PROGRAM_ID`, `TEE_RPC_URL`, `ER_RPC`, `MAGIC_ROUTER_RPC`, `CRANK_PUBKEY`. Add `AwaitingDeal=2`, `AwaitingShowdown=8` to phase enum. Update `SEAT_CARDS_OFFSETS` for new layout (enc_card1 at 76, nonce at 140). |
| `src/lib/onchain-game.ts` (87k) | **MAJOR REWORK:** Remove all `delegate*`, `permission*`, `commitAndUndelegate*` instruction builders. Remove `DELEGATION_PROGRAM_ID`, `MAGIC_PROGRAM_ID`. Update phase enum (add AwaitingDeal=2, AwaitingShowdown=8, shift others). Update `parseTableState`/`parseSeatState` for new offsets. Add `devnet_bypass_deal` discriminator. Keep PDA helpers, action builders. |
| `src/lib/pda.ts` | Update `ANCHOR_PROGRAM_ID` import. Keep all PDA derivations (correct seeds). |
| `src/lib/crank.ts` | Update for Arcium crank (different deal/reveal flow). |
| `src/store/gameStore.ts` | Add `AwaitingDeal`, `AwaitingShowdown` to PHASE_MAP. |

### ❌ REMOVE (TEE/ER-specific, dead code)

| File | Reason |
|------|--------|
| `src/hooks/useTeeAuth.ts` | TEE challenge/login auth — replaced by Arcium x25519 decryption |
| `src/hooks/useGameAuth.tsx` | TEE + multi-validator auth orchestration — not needed on L1 |
| `src/lib/tee-auth-server.ts` | TEE server-side auth — deleted |
| `src/lib/validator-registry.ts` | MagicBlock validator discovery — deleted |
| `src/lib/broken-tables.ts` | Hardcoded broken table list — stale |
| `src/lib/queue-events.ts` | SNG queue event emitter (backend API) — stale |
| `src/lib/mongodb.ts` | MongoDB connection for profiles — replace with on-chain PlayerAccount |
| `src/app/api/` (all) | Server-side API routes (registration, tables, sitngos, showdown, debug, tee, profile, game-state) — all replaced by direct on-chain interactions |
| `src/app/test/` | TEE diagnostic console — stale |

### 🆕 ADD (new for Arcium)

| File | Purpose |
|------|--------|
| `src/hooks/useArciumCards.ts` | Wraps `ArciumCardDecryptor` from `shared/crypto/arcium-cards.ts`. Derives x25519 key from wallet signature, decrypts packed u16 hole cards. |
| `src/hooks/useArciumSession.ts` | x25519 key derivation + session management for Arcium. Replaces TEE auth flow. |
| `src/app/dealer/page.tsx` | Dealer license purchase page (bonding curve) — exists in old app but may need update |

---

## 3. Architecture Changes Summary

| Aspect | Old (TEE/ER) | New (Arcium L1) |
|--------|-------------|------------------|
| **Card reading** | TEE auth token + `getAccountInfo` on ER | L1 `getAccountInfo` + client-side Rescue cipher decrypt |
| **Game state** | TEE polling + `/api/game-state` cache | L1 polling only (2s active, 5s idle) |
| **Actions** | Session key signs on ER | Session key signs on L1 |
| **Delegation** | Table+seats delegated to ER | No delegation — all on L1 |
| **API routes** | `/api/sitngos/*`, `/api/tables/*`, etc. | None — fully static frontend |
| **Profile** | MongoDB server API | On-chain `PlayerAccount` PDA |
| **Phase enum** | 11 phases (Preflop=2) | 13 phases (AwaitingDeal=2, Preflop=3) — see mapping below |

### Phase Enum Mapping (CRITICAL — every comparison breaks)

| Phase | Old Value | New Value | Notes |
|-------|-----------|-----------|-------|
| Waiting | 0 | 0 | Same |
| Starting | 1 | 1 | Same |
| **AwaitingDeal** | — | **2** | NEW — MPC shuffle queued |
| Preflop | 2 | **3** | SHIFTED +1 |
| Flop | 3 | **4** | SHIFTED +1 |
| Turn | 4 | **5** | SHIFTED +1 |
| River | 5 | **6** | SHIFTED +1 |
| Showdown | 6 | **7** | SHIFTED +1 |
| **AwaitingShowdown** | — | **8** | NEW — MPC reveal queued |
| Complete | 7 | **9** | SHIFTED +2 |
| FlopRevealPending | 8 | **10** | SHIFTED +2 |
| TurnRevealPending | 9 | **11** | SHIFTED +2 |
| RiverRevealPending | 10 | **12** | SHIFTED +2 |
| **Program ID** | `4MLbu...` (old Poker) | `BGyLY...` (Poker-Arc) |
| **SeatCards layout** | card1 at offset 73, card2 at 74 (plaintext) | enc_card1 at 76 (32B ct), nonce at 140 (16B) + card1/card2 at 73/74 (showdown plaintext) |

---

## 4. Implementation Plan

### Phase 1: Copy + Strip TEE/ER (1 day)
- [ ] Copy `J:\Poker\client-v2` → `J:\Poker-Arc\frontend`
- [ ] Delete files marked REMOVE above
- [ ] Delete `node_modules/`, `.next/`
- [ ] Update `package.json`: remove `@magicblock-labs/*`, `mongodb`. Add `@arcium-hq/client`.
- [ ] Update `constants.ts`: new program ID, remove TEE/ER constants, fix phase enum
- [ ] Update `providers.tsx`: remove `GameAuthProvider`, `SessionProvider` → simple wallet+connection
- [ ] `npm install` + verify `npm run build` compiles (fix import errors from deleted files)

### Phase 2: Fix Game State (1-2 days)
- [ ] Rewrite `useOnChainGame.ts`: strip TEE/ER, L1-only polling
- [ ] Update `onchain-game.ts`: fix phase enum, remove delegation builders, fix parseTableState
- [ ] Update `gameStore.ts`: add AwaitingDeal/AwaitingShowdown to PHASE_MAP
- [ ] Verify table + seat parsing against Poker-Arc Rust structs

### Phase 3: Fix Card Reading (1 day)
- [ ] Rewrite `useCards.ts`: mock mode reads plaintext at offset 73/74, Arcium mode uses `ArciumCardDecryptor`
- [ ] Create `useArciumCards.ts`: x25519 key derivation, packed u16 decryption
- [ ] Test card display in PokerTable against localnet mock deal

### Phase 4: Fix Session Keys (1 day)
- [ ] Update `useSession.ts`: remove gum-sdk ER delegation, use L1-only session creation
- [ ] Keep `deriveSessionKeypair()` (identical pattern)
- [ ] Update `buildPlayerActionInstruction` for L1 (pass PROGRAM_ID sentinel for Option<Account> None)

### Phase 5: Fix Lobby + Join (1 day)
- [ ] Update `useTableList.ts`: L1-only `getProgramAccounts`
- [ ] Update `useJoinTable.ts`: remove ER deposit flow, L1-only join
- [ ] Remove `/api/*` routes from page.tsx, use direct on-chain reads

### Phase 6: Verify + Polish (1-2 days)
- [ ] Full game loop against localnet (mock deal mode)
- [ ] Full game loop against localnet (Arcium MPC mode)
- [ ] Fix any UI glitches from phase enum changes
- [ ] Add MPC loading states (AwaitingDeal shimmer, RevealPending spinner)
- [ ] Test dealer license page

---

## 5. Dependencies

### Remove
- `@magicblock-labs/ephemeral-rollups-sdk`
- `@magicblock-labs/gum-react-sdk`
- `@magicblock-labs/gum-sdk`
- `mongodb`

### Add
- `@arcium-hq/client` (x25519 + RescueCipher for card decryption)

### Keep
- `next` 14.1.0
- `react` / `react-dom` 18.x
- `@solana/web3.js` ^1.95
- `@solana/wallet-adapter-*`
- `@coral-xyz/anchor` ^0.29
- `zustand` ^4.5
- `tailwindcss` ^3.4
- `lucide-react`
- `class-variance-authority` + `clsx` + `tailwind-merge`

---

## 6. Risks

| Risk | Mitigation |
|------|------------|
| `onchain-game.ts` (87k) has hundreds of ER-specific code paths | Systematic search-and-replace: grep for `delegate`, `permission`, `TEE`, `ER`, `Magic` |
| `page.tsx` (70k) monolith has TEE auth gating woven throughout | Extract game view into separate component, remove auth gates |
| Phase enum shift (old: Preflop=2; new: AwaitingDeal=2, Preflop=3) | Will break all phase comparisons — must update everywhere |
| `@arcium-hq/client` may not bundle for browser | Test early with Next.js webpack config; if fails, use dynamic import |
| Session key flow differs (gum-sdk vs custom) | `deriveSessionKeypair` pattern is identical — just change the on-chain program call |
