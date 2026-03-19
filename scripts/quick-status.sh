#!/bin/bash
echo "=== Validator ==="
curl -s -m 2 http://127.0.0.1:8899 -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null || echo "DOWN"

echo ""
echo "=== Validator PID ==="
pgrep -a solana-test-val

echo ""
echo "=== Bridge interfaces ==="
ip addr show | grep -E "br-|docker0|172\\.20" | head -10

echo ""
echo "=== Docker containers ==="
docker ps -a --format "table {{.Names}}\t{{.Status}}" 2>/dev/null

echo ""
echo "=== arcium localnet process ==="
pgrep -a arcium
