# FAST POKER — V2 Frontend Architecture

**Last Updated:** February 7, 2026

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **State**: Zustand
- **Styling**: Tailwind CSS (crypto-native dark theme)
- **Wallet**: @solana/wallet-adapter-react
- **On-chain**: Raw Solana web3.js instructions (no Anchor client)
- **ER/TEE**: MagicBlock Ephemeral Rollups + TEE for card privacy

## Programs

| Program | ID | Purpose |
|---------|-----|----------|
| Anchor Poker | `4MLbuVZzXpzWcaZaqxHDkm5JuigZzovsVd6VPNDXnyiB` | Core poker logic |
| Steel Tokenomics | `BaYBb2JtaVffVnQYk1TwDUwZskgdnZcnNawfVzj3YvkH` | $POKER mint, staking, pool |
| MagicBlock Permission | `ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1` | SeatCards read-access |
| MagicBlock VRF | `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz` | Verifiable random card dealing |

## Directory Structure

```
client-v2/src/
├── app/
│   ├── layout.tsx             # Root layout + WalletProvider
│   ├── page.tsx               # Lobby + GameView (main SPA)
│   ├── globals.css            # Crypto-native dark theme
│   ├── test/page.tsx          # On-chain diagnostic console
│   ├── profile/page.tsx       # Player profile
│   ├── staking/page.tsx       # Staking dashboard
│   ├── my-tables/             # Cash game management
│   └── api/                   # Server-side routes
│       ├── registration/      # register_player
│       ├── tables/            # create_table
│       ├── sitngos/           # Queue + join + ready + deal + action
│       ├── showdown/          # settle_hand
│       └── debug/             # Account inspection
│
├── components/
│   ├── layout/
│   │   └── Navbar.tsx         # Top nav with wallet + balances
│   └── game/
│       ├── PokerTable.tsx     # Main table (HU / 6-max / 9-max layouts)
│       ├── Table.tsx          # Zustand-connected table wrapper
│       ├── Seat.tsx           # Individual seat component
│       ├── Card.tsx           # Card + CardPair + CommunityCards
│       ├── BettingControls.tsx
│       └── ShowdownControls.tsx
│
├── hooks/
│   ├── usePlayer.ts           # Player PDA read + register
│   ├── useSession.ts          # Session key create/revoke/top-up
│   ├── useJoinTable.ts        # join_table with retry
│   ├── useOnChainGame.ts      # ER/L1 game state subscription + sendAction
│   ├── useTableList.ts        # Lobby: getProgramAccounts on ER + L1 fallback
│   └── useCards.ts            # Read SeatCards (card1=73, card2=74) from ER
│
├── lib/
│   ├── constants.ts           # Program IDs, RPC URLs, seeds, offsets
│   ├── onchain-game.ts        # All instruction builders + PDA helpers
│   ├── pda.ts                 # PDA derivation (table, seat, seat_cards, player, session)
│   ├── api.ts                 # Backend API client (queues, etc.)
│   └── utils.ts               # cn(), formatChips, shortenAddress
│
└── store/
    └── gameStore.ts           # Zustand game state
```

## Key Byte Offsets (verified from Rust structs)

### Table Account
| Field | Offset | Size | Notes |
|-------|--------|------|-------|
| pot | 131 | 8 | |
| small_blind | 139 | 8 | |
| big_blind | 147 | 8 | |
| community_cards | 155–159 | 5 | 255=hidden |
| phase | 160 | 1 | |
| current_player | 161 | 1 | |
| dealer_button | 162 | 1 | |
| revealed_hands | 175–192 | 18 | 9×2 cards (showdown only) |
| hand_results | 193–201 | 9 | Hand rank per seat |
| pre_community | 202–206 | 5 | TEE protected |
| deck_seed | 207–238 | 32 | Zeroed after VRF deal |

### Seat Account
| Field | Offset | Size |
|-------|--------|------|
| chips | 104 | 8 |
| bet_this_round | 112 | 8 |
| hole_cards | 224–225 | 2 |
| status | 227 | 1 |

### SeatCards Account
| Field | Offset | Size |
|-------|--------|------|
| card1 | 73 | 1 |
| card2 | 74 | 1 |

## Instruction Builders (onchain-game.ts)

| Builder | Data Size | Notes |
|---------|-----------|-------|
| `buildCreateTableInstruction` | 43 bytes | disc(8) + table_id(32) + game_type(1) + stakes(1) + max_players(1) |
| `buildJoinTableInstruction` | 17 bytes | disc(8) + buy_in(8) + seat_index(1) |
| `buildPlayerActionInstruction` | 17 bytes | disc(8) + action_type(1) + amount(8) — always 17 bytes |
| `buildDealInstruction` | 8 bytes | disc only, seats+seat_cards as remaining_accounts |
| `buildInitSeatCardsInstruction` | 9 bytes | disc(8) + seat_index(1) |
| `buildLeaveTableInstruction` | 8 bytes | disc only, closes seat + marker PDAs |
| `buildWithdrawBalanceInstruction` | 8 bytes | disc only, cash games, transfers from escrow |

## Game Flow

### Sit & Go Tournament (VRF Flow)
```
1. User connects wallet → reads Player PDA
2. User joins queue (backend API) → backend creates on-chain table
3. join_table instruction (with PlayerTableMarker PDA)
4. /api/sitngos/ready:
   a. init_seat_cards (empty, cards=255) on L1
   b. start_game on L1 (phase → Starting)
   c. post_game_blinds on L1 (SB/BB deducted, pot set)
   d. delegate table + seats + seat_cards to ER
   e. request_deal_vrf on ER → VRF oracle callback deals cards
5. Game plays on ER (gasless via session keys)
   - player_action: fold/check/call/raise/allin
   - Phase advances: Preflop → Flop → Turn → River → Showdown
   - Community cards copied from pre_community at each transition
6. settle_hand: on-chain hand eval, writes revealed_hands + hand_results
7. Repeat hands until one player busts (phase=Complete)
8. distribute_prizes mints $POKER via Steel CPI
```

### Card Privacy (TEE + VRF)
```
- SeatCards PDA created on L1 with MagicBlock Permission
- Permission restricts reads to owning player only (TEE enforced)
- Cards dealt via VRF on ER (consume_deal_randomness callback)
- deck_seed ZEROED immediately after deal (no deck reconstruction)
- Frontend reads card1 (offset 73) and card2 (offset 74) from seat_cards
- At showdown: revealed_hands (offset 175-192) + hand_results (offset 193-201)
- Community cards pre-stored in pre_community (offset 202-206, TEE protected)
- Copied to community_cards (offset 155-159) at phase transitions
- No card values in msg! logs or events (tx logs are public)
```

### Session Keys
```
- Created on first game join (bundled with join_table tx)
- Persisted in localStorage
- Enable gasless transactions on ER
- Auto-top-up when low balance detected
- Revoked on disconnect
```

## UI Design: Crypto-Native / Web3

- **Dark background**: gray-950 base
- **Accent colors**: cyan-400 (primary), emerald-400 (success), amber-400 (warning)
- **Glass effects**: `glass-card` class with backdrop-blur + subtle borders
- **Neon glows**: `glow-cyan`, `glow-emerald`, `text-glow-cyan`
- **Typography**: Inter font, tabular-nums for numbers
- **Poker table**: Dark emerald felt gradient with subtle inner rail
- **Cards**: Light cards on dark bg with card-shadow
- **Seat layouts**: HU (2), 6-max, 9-max — absolute positioned around oval

## Pages

| Route | Purpose |
|-------|---------|
| `/` | Lobby (balances, queues, active games) + GameView |
| `/profile` | Player stats, registration status |
| `/staking` | Stake/unstake $POKER, claim rewards |
| `/my-tables` | Cash game management |
| `/test` | On-chain diagnostic console |
