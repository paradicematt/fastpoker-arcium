#!/bin/bash
source ~/.cargo/env 2>/dev/null || true
export PATH="$HOME/.local/share/solana/install/releases/2.1.21/solana-release/bin:$HOME/.cargo/bin:$PATH"

echo "=== Missing accounts from node logs ==="
solana account 6ujv8vAQMpTmmPiqZWYphrSuroFhfrtDNdvBPidP5pqb -u localhost 2>&1
echo "---"
solana account 7TMENQXqfug9pgcCmuZzn5dgpnYPDmnNUHHjBMPHdwjF -u localhost 2>&1

echo ""
echo "=== Arcium program ==="
# Check if the Arcium program exists
solana program show arcm3GFBH8FfG8TG1ddxF7dRhKEyD28RnxaXXoGRecJY -u localhost 2>&1

echo ""
echo "=== First 30 lines of node 0 log ==="
head -30 /tmp/poker-arc-workspace/artifacts/arx_node_logs/*_0.log 2>/dev/null

echo ""
echo "=== Node config ==="
cat /tmp/poker-arc-workspace/artifacts/node_config_0.toml 2>/dev/null
