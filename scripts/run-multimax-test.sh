#!/bin/bash
set -e
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ | head -1)/bin:$PATH"

cd /mnt/j/Poker-Arc/backend

echo "Node: $(node --version)"
echo "Running Multi-Player Arcium MPC Test (6-Max / 9-Max)..."
echo ""

ARCIUM_CLUSTER_OFFSET=0 npx ts-node --transpile-only e2e-arcium-multimax.ts 2>&1
