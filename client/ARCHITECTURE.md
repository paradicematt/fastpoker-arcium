# FAST POKER — Frontend Architecture (Arcium MPC)

**Last Updated:** March 19, 2026

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **State**: Zustand
- **Styling**: Tailwind CSS (crypto-native dark theme)
- **Wallet**: @solana/wallet-adapter-react
- **On-chain**: Raw Solana web3.js instructions (no Anchor client)
- **Card Privacy**: Arcium MPC (x25519 key exchange + Rescue cipher)
- **All game state on Solana L1** — no TEE, no Ephemeral Rollups

## Programs

| Program | ID | Purpose |
|---------|-----|----------|
| Anchor Poker | `BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N` | Core poker logic + MPC callbacks |
| Steel Tokenomics | `9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6` | $POKER mint, staking, pool |
| Arcium | (system) | MPC computation, BLS verification |

## Directory Structure

```
client/src/
├── app/
│   ├── layout.tsx             # Root layout + WalletProvider
│   ├── page.tsx               # Lobby (balances, queues, active games)
│   ├── globals.css            # Crypto-native dark theme
│   ├── providers.tsx          # WalletProvider (dynamic import for SSR)
│   ├── game/[id]/page.tsx     # Individual game page (cash + SNG)
│   ├── profile/page.tsx       # Player stats, pending claims
│   ├── staking/page.tsx       # Stake/unstake $POKER
│   ├── my-tables/             # Cash game management + create
│   ├── dealer/                # Dealer license + crank dashboard
│   ├── admin/page.tsx         # Admin controls
│   └── api/                   # Server-side routes (RPC proxy, SNG queue)
│
├── components/
│   ├── game/
│   │   ├── PokerTable.tsx     # Main table (HU / 6-max / 9-max layouts)
│   │   ├── Table.tsx          # Zustand-connected table wrapper
│   │   ├── Seat.tsx           # Individual seat component
│   │   ├── Card.tsx           # Card rendering (CSS, no image assets)
│   │   ├── BettingControls.tsx
│   │   └── ShowdownControls.tsx
│   ├── layout/
│   │   ├── Navbar.tsx         # Top nav with wallet + balances
│   │   ├── ActiveTableBar.tsx # Persistent bar for active game
│   │   ├── SessionBar.tsx     # Session key status
│   │   └── Footer.tsx
│   └── lobby/
│       └── Lobby.tsx          # Table listings + SNG queues
│
├── hooks/
│   ├── usePlayer.ts           # Player PDA read + register
│   ├── useSession.tsx         # Session key create/revoke/top-up (L1)
│   ├── useJoinTable.ts        # join_table with retry
│   ├── useOnChainGame.ts      # L1 game state polling + sendAction
│   ├── useArciumCards.ts      # Decrypt encrypted hole cards via Rescue cipher
│   ├── useCards.ts            # Read plaintext SeatCards (showdown fallback)
│   ├── useTableList.ts        # Lobby: getProgramAccounts on L1
│   └── useSoundEffects.ts     # Audio feedback
│
├── lib/
│   ├── constants.ts           # Program IDs, RPC, seeds, byte offsets
│   ├── onchain-game.ts        # Instruction builders + account parsers + PDA helpers
│   ├── arcium-keys.ts         # x25519 key derivation from wallet signature
│   ├── pda.ts                 # PDA derivation helpers
│   ├── cards.ts               # Card display utilities
│   ├── hand-evaluator.ts      # Client-side hand ranking
│   ├── api.ts                 # Backend API client
│   └── utils.ts               # cn(), formatChips, shortenAddress
│
└── store/
    └── gameStore.ts           # Zustand game state
```

## Key Byte Offsets (verified from Rust structs)

### Table Account (SIZE = 437)
| Field | Offset | Size | Notes |
|-------|--------|------|-------|
| table_id | 8 | 32 | |
| authority | 40 | 32 | |
| game_type | 104 | 1 | 0=SNG-HU, 1=SNG-6, 2=SNG-9, 3=Cash |
| small_blind | 105 | 8 | u64 LE |
| big_blind | 113 | 8 | u64 LE |
| max_players | 121 | 1 | |
| pot | 131 | 8 | u64 LE |
| community_cards | 155 | 5 | 255=hidden |
| phase | 160 | 1 | See GamePhase enum below |
| current_player | 161 | 1 | |
| dealer_button | 163 | 1 | |
| revealed_hands | 175 | 18 | 9x2 cards (showdown only) |
| hand_results | 193 | 9 | Hand rank per seat |
| seats_occupied | 250 | 2 | u16 bitmask |
| seats_allin | 252 | 2 | u16 bitmask |
| seats_folded | 254 | 2 | u16 bitmask |
| token_mint | 385 | 32 | Pubkey (default=SOL) |

### PlayerSeat Account (SIZE = 281)
| Field | Offset | Size | Notes |
|-------|--------|------|-------|
| wallet | 8 | 32 | |
| session_key | 40 | 32 | |
| chips | 104 | 8 | u64 LE |
| bet_this_round | 112 | 8 | u64 LE |
| x25519_pubkey | 192 | 32 | Repurposed hole_cards_commitment |
| hole_cards | 224 | 2 | 255=hidden |
| status | 227 | 1 | See SeatStatus enum |

### SeatCards Account (SIZE = 156)
| Field | Offset | Size | Notes |
|-------|--------|------|-------|
| card1 | 73 | 1 | Plaintext (255 during play, set at showdown) |
| card2 | 74 | 1 | Plaintext (255 during play, set at showdown) |
| enc_card1 | 76 | 32 | Rescue ciphertext (packed u16: card1*256+card2) |
| enc_card2 | 108 | 32 | Raw nonce slot (diagnostic only) |
| nonce | 140 | 16 | Decryption nonce (output_nonce from MPC) |

## GamePhase Enum (on-chain byte values)

| Value | Phase | Description |
|-------|-------|-------------|
| 0 | Waiting | Waiting for players |
| 1 | Starting | Blinds posted |
| 2 | AwaitingDeal | MPC shuffle queued, waiting callback |
| 3 | Preflop | Hole cards dealt |
| 4 | Flop | 3 community cards |
| 5 | Turn | 4th community card |
| 6 | River | 5th community card |
| 7 | Showdown | Reveal cards |
| 8 | AwaitingShowdown | MPC reveal queued |
| 9 | Complete | Hand finished |
| 10 | FlopRevealPending | MPC flop reveal queued |
| 11 | TurnRevealPending | MPC turn reveal queued |
| 12 | RiverRevealPending | MPC river reveal queued |

## Game Flow (Arcium MPC)

### Hand Lifecycle
```
1. start_game (permissionless) → phase: Starting → AwaitingDeal
2. Crank calls arcium_deal → queues MPC shuffle_and_deal
3. MPC callback writes encrypted cards to SeatCards + DeckState
   → phase: Preflop
4. Players act: player_action (fold/check/call/raise/allin)
5. Betting round ends → phase: FlopRevealPending
6. Crank calls arcium_reveal_queue → queues MPC reveal_community
7. MPC callback writes plaintext community cards to Table
   → phase: Flop (then Turn, River similarly)
8. After River betting → phase: Showdown
9. Crank calls arcium_showdown_queue → queues MPC reveal_all_showdown
10. MPC callback writes revealed_hands + hand_results
    → phase: Complete
11. settle_hand: distribute pot, update chips
12. Next hand: back to step 1
```

### Card Privacy (Arcium MPC — no TEE)
```
- Each player derives a deterministic x25519 keypair from wallet signature
- Public key stored on-chain via set_x25519_key instruction
- MPC encrypts hole cards: Enc<Shared, u16> per player (Rescue cipher)
- Encrypted ciphertext stored in SeatCards.enc_card1 (32 bytes at offset 76)
- Frontend decrypts client-side:
  1. Read enc_card1 (32B) + nonce (16B) from SeatCards account
  2. x25519 shared secret = ECDH(playerSecretKey, mxePublicKey)
  3. RescueCipher(sharedSecret).decrypt([ct], nonce) → packed u16
  4. card1 = (u16 >> 8) & 0xFF, card2 = u16 & 0xFF
- At showdown: MPC reveals all active hands → plaintext in card1/card2
- Folded cards NEVER revealed (stay encrypted forever)
```

### Session Keys
```
- gum-sdk session keys work on Solana L1
- Created on first game join, persisted in localStorage
- Enable gasless gameplay (~0.01 SOL = ~2000 TXs)
- Auto-top-up when low balance detected
```

## Environment Variables

```env
NEXT_PUBLIC_RPC_URL=http://localhost:8899           # Solana RPC
NEXT_PUBLIC_POKER_MINT=<mint_pubkey>                # POKER token mint
NEXT_PUBLIC_MXE_X25519_PUBKEY=<64_hex_chars>        # MXE public key for card decrypt
```

## UI Design: Crypto-Native / Web3

- **Dark background**: gray-950 base
- **Accent colors**: cyan-400 (primary), emerald-400 (success), amber-400 (warning)
- **Glass effects**: `glass-card` class with backdrop-blur + subtle borders
- **Neon glows**: `glow-cyan`, `glow-emerald`, `text-glow-cyan`
- **Typography**: Inter font, tabular-nums for numbers
- **Poker table**: Dark emerald felt gradient with subtle inner rail
- **Cards**: CSS-rendered (no image assets), light on dark with card-shadow
- **Seat layouts**: HU (2), 6-max, 9-max — absolute positioned around oval

## Pages

| Route | Purpose |
|-------|---------|
| `/` | Lobby (balances, queues, active games) |
| `/game/[id]` | Individual game table (cash + SNG) |
| `/profile` | Player stats, registration, pending claims |
| `/staking` | Stake/unstake $POKER, claim rewards |
| `/my-tables` | Cash game management + create |
| `/dealer` | Dealer license + crank dashboard |
| `/test` | On-chain diagnostic console |
