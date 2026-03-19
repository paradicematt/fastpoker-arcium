# FAST POKER — Frontend (Arcium MPC)

**Last Updated:** March 19, 2026

## ✅ Completed

### Core Infrastructure
- [x] Next.js 14 app with Tailwind CSS, Zustand, wallet-adapter
- [x] Webpack fallbacks for @arcium-hq/client (fs, net, tls stubs)
- [x] Build passes clean (only harmless pino-pretty warning)
- [x] ARCHITECTURE.md updated for Arcium MPC

### Game Logic
- [x] `onchain-game.ts` — All instruction builders + account parsers
- [x] `constants.ts` — Correct byte offsets, GamePhase enum (13 phases)
- [x] `useOnChainGame.ts` — L1 polling with phase-aware delays
- [x] `useArciumCards.ts` — Rescue cipher card decryption (x25519 + MXE pubkey)
- [x] `arcium-keys.ts` — Deterministic x25519 keypair from wallet signature
- [x] `game/[id]/page.tsx` — Arcium card decrypt wired in:
  - Auto-load cached x25519 keypair on mount
  - MXE pubkey from NEXT_PUBLIC_MXE_X25519_PUBKEY env var
  - Merge decrypted cards into displayState.myCards
  - Store keypair after confirmBuyIn
- [x] Session keys on L1 (gum-sdk)
- [x] `buildSetX25519KeyInstruction` — Set player encryption key after join

### Pages
- [x] `/` — Lobby with balances, SNG queues, active games
- [x] `/game/[id]` — Cash game + SNG with full betting controls
- [x] `/profile` — Player stats, pending claims
- [x] `/staking` — Stake/unstake $POKER
- [x] `/my-tables` — Cash game management + create
- [x] `/dealer` — Dealer license + crank dashboard
- [x] `/admin` — Admin controls
- [x] `/test` — On-chain diagnostic console

## 🔧 To Run

```bash
cd client
npm install
npm run dev
```

### Environment Variables (`.env.local`)
```env
NEXT_PUBLIC_RPC_URL=http://localhost:8899
NEXT_PUBLIC_POKER_MINT=2xsKGbqshEscemWoj3YjW2yFV4bf2M6XajDYydqYjCfv
NEXT_PUBLIC_MXE_X25519_PUBKEY=<64_hex_chars>
```

Fetch MXE pubkey from localnet:
```bash
cd backend
npx ts-node --transpile-only -e "..." # see scripts/get-mxe-pubkey.ts
```

## 📋 Remaining TODO

### HIGH Priority
- [ ] **E2E browser test** — Connect wallet, join table, verify card decrypt works
- [ ] **Devnet `.env`** — RPC URL + MXE pubkey for devnet Arcium cluster

### MEDIUM Priority
- [ ] **Clean up stale TEE comments** — 112 references across 19 files (cosmetic, no runtime impact)
- [ ] **Client TODO.md cleanup** — Remove old TEE/VRF decisions section
- [ ] **Sound effects** — Wire useSoundEffects to game events
- [ ] **Hand history persistence** — Save past hands to localStorage

### LOW Priority
- [ ] **Mobile responsive** — PokerTable layout for small screens
- [ ] **Animations** — Card deal, chip toss, phase transitions
- [ ] **Spectator mode** — View table without sitting
