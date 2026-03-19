#!/bin/bash
set -e

# Source NVM for WSL Node.js
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Ensure WSL node is used, not Windows
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ | head -1)/bin:$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

echo "Node: $(node --version)"
echo "npx: $(which npx)"

cd /tmp/poker-arc-workspace

# Install dependencies if needed
if [ ! -d "/mnt/j/Poker-Arc/backend/node_modules" ]; then
    echo "Installing backend dependencies..."
    cd /mnt/j/Poker-Arc/backend
    npm install
    cd /tmp/poker-arc-workspace
fi

# Install ts-node globally if not available
if ! command -v ts-node &>/dev/null; then
    echo "Installing ts-node globally..."
    npm install -g ts-node typescript
fi

echo "Initializing circuits..."
ARCIUM_CLUSTER_OFFSET=0 \
CIRCUIT_BUILD_DIR=/mnt/j/Poker-Arc/build \
ts-node --transpile-only /mnt/j/Poker-Arc/backend/arcium-init-circuits.ts 2>&1
