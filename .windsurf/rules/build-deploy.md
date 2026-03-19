---
trigger: always_on
---
---
description: How to build and deploy the Solana programs (Anchor fastpoker and Steel)
---

## Build

The build runs in WSL (Windows Subsystem for Linux). It uses Rust 1.86.0 and Solana CLI 2.1.x.

// turbo
1. Build the Anchor program (fastpoker):
```bash
wsl bash /mnt/j/Poker/build-anchor.sh
```

This will:
- Use Rust 1.86.0 (WSL-compatible)
- Pin problematic crate versions
- Run `cargo-build-sbf` in `programs/fastpoker`
- Copy the output `.so` to `target/deploy/fastpoker.so`

## Deploy

Deploy runs in WSL. Uses the deployer keypairs in `contracts/auth/deployers/`.

2. Deploy Anchor program only (devnet):
```bash
wsl bash /mnt/j/Poker/deploy.sh anchor
```

3. Deploy Steel program only (devnet):
```bash
wsl bash /mnt/j/Poker/deploy.sh steel
```

4. Deploy both programs (devnet):
```bash
wsl bash /mnt/j/Poker/deploy.sh both
```

### Key paths:
- **Anchor .so**: `target/deploy/fastpoker.so`
- **Anchor program ID**: `4MLbuVZzXpzWcaZaqxHDkm5JuigZzovsVd6VPNDXnyiB`
- **Anchor deployer keypair**: `contracts/auth/deployers/anchor-mini-game-deployer-keypair.json`
- **Steel .so**: `contracts/target/deploy/poker_program.so`
- **Steel program ID**: `9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6`
- **RPC**: `https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df`

### Quick build (no crate pinning, faster for iterative changes):
```bash
wsl bash /mnt/j/Poker/programs/build-quick.sh
```

