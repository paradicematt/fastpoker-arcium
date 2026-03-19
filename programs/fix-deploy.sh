#!/bin/bash
set -e
source ~/.cargo/env
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

echo "=== Airdropping 2 SOL ==="
solana airdrop 2 -u devnet || echo "Airdrop failed, continuing..."
sleep 3

echo "=== Balance ==="
solana balance -u devnet

echo "=== Closing orphaned buffers ==="
solana program close --buffers -u devnet || echo "No buffers to close"
sleep 2

echo "=== Balance after close ==="
solana balance -u devnet

echo "=== Deploying via Helius RPC ==="
solana program deploy /mnt/j/Poker/target/deploy/fastpoker.so \
  --program-id 4MLbuVZzXpzWcaZaqxHDkm5JuigZzovsVd6VPNDXnyiB \
  -u devnet \
  -v

echo "=== Deploy complete ==="
