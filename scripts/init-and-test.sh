#!/bin/bash
export PATH="/root/.nvm/versions/node/v20.20.1/bin:/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:/usr/bin:/bin"
cd /mnt/j/Poker-Arc/backend

# Step 1: Init circuits
echo "=== INIT CIRCUITS ==="
ARCIUM_CLUSTER_OFFSET=0 node -e "require('ts-node/register'); require('./init-circuits')" 2>&1
echo "CIRCUITS_DONE"

# Step 2: Bootstrap (Pool PDA, token tiers, etc.)
echo "=== BOOTSTRAP ==="
ARCIUM_CLUSTER_OFFSET=0 node -e "require('ts-node/register'); require('./localnet-bootstrap')" 2>&1
echo "BOOTSTRAP_DONE"
