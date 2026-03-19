# E2E Test Checklist — Arcium L1 Frontend

## Testing Approach
- **No Phantom extension needed** — uses wallet-standard mock injection
- **Multi-wallet**: each `createPlayerPage(browser, wallets[N])` gets its own browser context + injected wallet
- **Devnet**: deterministic keypairs funded by deployer keypair
- **Session keys**: deterministic per-wallet, pre-funded, injected into localStorage

## Tier 1: Page Rendering (no wallet needed for most)
- [ ] `/` — Lobby loads, nav bar visible, no console errors
- [ ] `/staking` — Staking page loads
- [ ] `/auctions` — Auctions page loads
- [ ] `/how-to-play` — How to Play loads with content
- [ ] `/my-tables` — My Tables page loads (needs wallet)
- [ ] `/my-tables/create` — Create Table form renders all sections
- [ ] `/listings` — Listings page loads
- [ ] `/dealer` — Dealer page loads
- [ ] `/dealer/license` — Dealer License page loads
- [ ] `/game/[id]` — Game page loads with table view

## Tier 2: Lobby Interactions (wallet connected)
- [ ] Wallet connects and shows truncated address
- [ ] Sit & Go tab shows tier buttons (Micro→Diamond)
- [ ] Tier buttons update prize info
- [ ] Cash Games tab loads table list
- [ ] Cash Games has "+ Create" link
- [ ] Session bar shows status (no "expired" or "TEE" references)
- [ ] No TEE/ER references anywhere in UI

## Tier 3: Create Table Flow (wallet connected)
- [ ] Form renders: Token, Blinds, Buy-in Type, Table Size, Access
- [ ] Token switch updates blinds
- [ ] Blind selection updates summary
- [ ] Table size changes rent estimate (no delegation rent)
- [ ] Private access shows whitelist notice
- [ ] Deep stack shows 2x fee
- [ ] Listed tokens tab exists
- [ ] Create button triggers Phase 1+2 only (no Phase 3 delegation)

## Tier 4: Multi-Player Game Flow (2+ wallets)
- [ ] Player 1 creates table or finds open table
- [ ] Player 1 navigates to table, sees SIT buttons
- [ ] Player 1 sits down (buy-in modal → confirm)
- [ ] Player 2 navigates to same table
- [ ] Player 2 sits down
- [ ] Game starts (hand #1)
- [ ] Players can check/call/fold
- [ ] Hand completes, new hand starts
- [ ] Players can leave table

## Tier 5: Arcium-Specific Checks
- [ ] No "TEE" text anywhere in UI (except maybe old test data)
- [ ] No "Delegat" text in create-table flow
- [ ] Session bar shows "L1" or "Active" (not "TEE" or "Expired")
- [ ] Create table completes without Phase 3
- [ ] Rent estimate doesn't include delegation rent
- [ ] Footer doesn't show TEE status

## Known Limitations
- MPC deal takes 2-10s on localnet, 10-30s on devnet
- Crank service must be running for game progression
- Multi-player tests need funded wallets on devnet
