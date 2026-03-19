#!/bin/bash
echo "=== Processes ==="
ps aux | grep -E 'solana-test|arcium' | grep -v grep | head -5 || echo "none"

echo ""
echo "=== Docker ==="
docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null || echo "docker not running"

echo ""
echo "=== RPC ==="
curl -s -m 3 http://127.0.0.1:8899 -X POST \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' 2>/dev/null || echo "RPC down"

echo ""
echo "=== Node health ==="
curl -s http://localhost:9091/health 2>/dev/null || echo "NOT_OK"
