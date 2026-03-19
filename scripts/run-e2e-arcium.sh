#!/bin/bash
set -e

# Source NVM for WSL Node.js
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ | head -1)/bin:$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

echo "Node: $(node --version)"
echo "Solana RPC: $(solana cluster-version 2>/dev/null || echo 'not reachable')"

cd /mnt/j/Poker-Arc/backend

# Install deps if needed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

echo ""
echo "=== Running E2E Arcium Cards Test ==="
ARCIUM_CLUSTER_OFFSET=0 ts-node --transpile-only e2e-arcium-cards.ts 2>&1
