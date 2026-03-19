#!/bin/bash
set -e
source "$HOME/.cargo/env"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.arcium/bin:$PATH"

echo "=== Current Arcium version ==="
arcium --version

echo ""
echo "=== Installing Arcium 0.9.2 ==="
arcup install 0.9.2

echo ""
echo "=== New Arcium version ==="
arcium --version

echo ""
echo "=== Docker images ==="
docker images | grep -E "arx-node|trusted-dealer" | head -5
