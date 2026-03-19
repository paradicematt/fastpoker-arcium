#!/bin/bash
source ~/.cargo/env 2>/dev/null || true
export PATH="$HOME/.local/share/solana/install/releases/2.1.21/solana-release/bin:$HOME/.cargo/bin:$PATH"

RPC="http://localhost:8899"

echo "=== Validator health ==="
curl -s $RPC -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null
echo ""

echo ""
echo "=== Arcium program (arcm3GFBH8FfG8TG1ddxF7dRhKEyD28RnxaXXoGRecJY) ==="
solana program show arcm3GFBH8FfG8TG1ddxF7dRhKEyD28RnxaXXoGRecJY -u $RPC 2>&1

echo ""
echo "=== Missing account 1: 6ujv8... ==="
solana account 6ujv8vAQMpTmmPiqZWYphrSuroFhfrtDNdvBPidP5pqb -u $RPC 2>&1

echo ""
echo "=== Missing account 2: 7TME... ==="
solana account 7TMENQXqfug9pgcCmuZzn5dgpnYPDmnNUHHjBMPHdwjF -u $RPC 2>&1

echo ""
echo "=== All programs on validator ==="
solana program show --programs -u $RPC 2>&1

echo ""
echo "=== Check if arcium localnet created any accounts ==="
# Get the payer/owner pubkey used by arcium localnet
OWNER=$(cat /tmp/poker-arc-workspace/artifacts/localnet/node_0.json 2>/dev/null | python3 -c "import sys,json; kp=json.load(sys.stdin); print('keypair loaded')" 2>/dev/null)
echo "node_0 keypair: $OWNER"

echo ""
echo "=== arcium localnet output (last 30 lines from background) ==="
# Check the arcium localnet stderr/stdout for errors
ARCLOG=$(find /tmp/poker-arc-workspace -name "*.log" -newer /tmp/poker-arc-workspace/artifacts/docker-compose-arx-env.yml 2>/dev/null | head -5)
echo "Recent logs: $ARCLOG"
