#!/bin/bash
echo "=== Validator process ==="
ps aux | grep solana-test-validator | grep -v grep | head -1 || echo "NOT RUNNING"

echo ""
echo "=== RPC test ==="
RESULT=$(curl -s -m 5 http://127.0.0.1:8899 -X POST \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' 2>&1)
echo "Response: $RESULT"

echo ""
echo "=== Solana CLI ==="
solana cluster-version 2>/dev/null || echo "CLI: not reachable"

echo ""
echo "=== Docker containers ==="
docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null

echo ""
echo "=== Node restart counts ==="
for c in artifacts-arx-node-0-1 artifacts-arx-node-1-1 artifacts-arx-node-2-1 artifacts-arx-node-3-1 artifacts-arcium-trusted-dealer-1; do
    RC=$(docker inspect --format '{{.RestartCount}}' "$c" 2>/dev/null || echo "?")
    echo "  $c: $RC"
done
