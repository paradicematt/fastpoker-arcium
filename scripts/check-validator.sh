#!/bin/bash
echo "=== Checking validator ==="
ps aux | grep solana-test-validator | grep -v grep || echo "No validator process found"

echo ""
echo "=== Checking RPC ==="
curl -s http://127.0.0.1:8899 -X POST \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' 2>/dev/null || echo "RPC not responding"

echo ""
echo "=== Node health ==="
curl -s http://localhost:9091/health 2>/dev/null || echo "Node 0 health not responding"

echo ""
echo "=== Node logs (last 10 lines) ==="
LOG=$(ls -t /tmp/poker-arc-workspace/artifacts/arx_node_logs/*_0.log 2>/dev/null | head -1)
if [ -n "$LOG" ]; then
    tail -10 "$LOG"
else
    echo "No node logs found"
fi

echo ""
echo "=== Docker containers ==="
docker ps --format 'table {{.Names}}\t{{.Status}}'
