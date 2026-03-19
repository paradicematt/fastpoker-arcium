#!/bin/bash
set -e
source ~/.cargo/env
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

RPC="https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df"

echo "=== Balance before ==="
solana balance -u "$RPC"

echo "=== Closing orphaned buffers ==="
solana program close --buffers -u "$RPC" || true

echo "=== Balance after close ==="
solana balance -u "$RPC"

echo "=== Deploying ==="
solana program deploy /mnt/j/Poker/target/deploy/fastpoker.so \
  --program-id FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR \
  -u "$RPC" \
  -v

echo "=== Done ==="
solana program show FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR -u "$RPC"
