# FAST POKER - V2 Frontend

## ✅ Completed
- [x] Comprehensive E2E test (12/14 passing)
- [x] TEE privacy verified (hole cards + community cards)
- [x] Cross-player blocking verified
- [x] Folder structure created
- [x] Architecture documented
- [x] Core lib files: constants, cards, pda, utils
- [x] useTeeConnection hook
- [x] gameStore (Zustand)
- [x] package.json with dependencies (+ mongodb)
- [x] Game components: Card, Table, Seat, BettingControls
- [x] App layout, providers, globals.css
- [x] **Renamed to FAST POKER** ⚡
- [x] **Real token balances** (POKER, Staked, Unrefined, Refined)
- [x] **Profile page** with username, avatar, MongoDB API
- [x] **Staking page** with burn-to-earn explanation
- [x] **My Tables page** with shareable links
- [x] **Create Table page**
- [x] **Pending claims** for DC'd players in profile
- [x] No fake/placeholder data - real chain queries

## 🔧 To Run
```bash
cd client-v2
npm install
npm run dev
```

## ✅ Decisions Made

### 1. Hole Cards Viewing (Own Cards)
**Decision:** AUTOMATIC with TEE auth token
- Player connects wallet → gets TEE auth token
- Frontend reads SeatCards from TEE → shows cards
- No user action needed to see own cards
- Other players always see "??" (face down)

### 2. Showdown Reveal
**Decision:** SMART REVEAL
- Winner's cards auto-revealed by crank
- Losers get "Show" or "Muck" button
- If muck: cards stay hidden forever
- If show: `reveal_cards_with_permission` called

### 3. Session Key Duration
**Decision:** UNLIMITED
- Session never expires
- Revoke manually if needed

### 4. Crank Service
**Decision:** CENTRAL SERVER (open-source)
- We run centrally for reliability
- Code is open-source, anyone CAN run it
- Handles: phase advances, timeouts, settlements

### 5. Rake Distribution
**Decision:** PER-HAND (optimized for gas)
- Distribute after each hand
- Batch multiple small distributions if needed
- Need to optimize transaction costs

### 6. Unrefined → Refined Flow
**Decision:** INSTANT
- Win Sit & Go → get Unrefined tokens
- When anyone claims their Unrefined:
  - They get Refined based on their % of total Unrefined pool
  - Distribution happens instantly
- No lockup period

### 7. Tech Stack
**Decision:** CONFIRMED
- Next.js 14 (App Router)
- Tailwind CSS
- shadcn/ui components
- Zustand for state
- CSS-based card rendering (no image assets needed)

---

## 📋 Next Steps

1. ✅ Game components created
2. ✅ Main page with real token balances
3. ✅ Profile page with MongoDB
4. ✅ Staking page with burn-to-earn
5. ✅ My Tables page with share links
6. ✅ Create Table page
7. Wire up player_action to TEE
8. Add useCards hook (read from TEE)
9. Build crank service
10. Add showdown reveal UI (Show/Muck buttons)
11. Real-time state polling
12. Integration testing

## 🏗️ Current File Structure

```
client-v2/
├── package.json
├── tsconfig.json
├── tailwind.config.ts
├── postcss.config.js
├── next.config.js
├── ARCHITECTURE.md
├── TODO.md
└── src/
    ├── app/
    │   ├── layout.tsx           ✅
    │   ├── page.tsx             ✅ (Lobby + Game + Token Balances)
    │   ├── globals.css          ✅
    │   ├── providers.tsx        ✅ (dynamic import for SSR fix)
    │   ├── profile/
    │   │   └── page.tsx         ✅ (Username, Avatar, Pending Claims)
    │   ├── staking/
    │   │   └── page.tsx         ✅ (Burn to Earn)
    │   ├── my-tables/
    │   │   ├── page.tsx         ✅ (Table Management)
    │   │   └── create/
    │   │       └── page.tsx     ✅ (Create Table)
    │   └── api/
    │       └── profile/
    │           └── route.ts     ✅ (MongoDB API)
    ├── components/
    │   └── game/
    │       ├── Card.tsx         ✅
    │       ├── Table.tsx        ✅
    │       ├── Seat.tsx         ✅
    │       └── BettingControls.tsx ✅
    ├── hooks/
    │   └── useTeeConnection.ts  ✅
    ├── lib/
    │   ├── constants.ts         ✅ (+ STEEL_PROGRAM_ID, POKER_MINT, POOL_PDA)
    │   ├── cards.ts             ✅
    │   ├── pda.ts               ✅
    │   ├── utils.ts             ✅
    │   └── mongodb.ts           ✅
    └── store/
        └── gameStore.ts         ✅
```

## 🔧 Environment Variables Needed

```env
MONGODB_URI=mongodb+srv://...
MONGODB_DB=fastpoker
```
