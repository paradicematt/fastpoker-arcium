# Poker Staking Program

Solana program for POKER token staking and tournament rewards using the Steel Framework.

## Features

### Burn-Stake Mechanism
- Users burn POKER tokens permanently to stake
- No unstaking - burns are permanent
- Stakers earn 50% of:
  - Table rake (SOL)
  - Sit & Go buy-ins (SOL)
- Weight can be diluted by new burns
- Real-time claiming

### Refined/Unrefined Rewards (ORE-style)
- Tournament winners receive "unrefined" POKER tokens
- Claiming costs 10% tax
- Tax is redistributed to other unclaimed rewards as "refined"
- Claim All option to get both unrefined (minus tax) + refined

### Cash Game Epochs
- Daily epochs for rake collection
- Rake distributed to stakers in real-time

## Deployer Wallet
```
EbsKHps5s55rXpXPwhDssL1ZdAdwBXLESLLdpb2xEp58
```

## Build

```bash
cargo build-sbf
```

## Deploy

```bash
solana config set --url devnet
solana program deploy target/deploy/poker_program.so
```

## Instructions

| Instruction | Description |
|-------------|-------------|
| `Initialize` | Initialize the staking pool |
| `BurnStake` | Burn POKER to stake permanently |
| `DepositRevenue` | Deposit SOL revenue (buy-ins) |
| `ClaimStakeRewards` | Claim SOL rewards |
| `MintUnrefined` | Award unrefined POKER to winner |
| `ClaimRefined` | Claim with 10% tax |
| `ClaimAll` | Claim unrefined + refined together |
| `AdvanceEpoch` | Start new daily epoch |
| `DepositRake` | Deposit cash game rake |
