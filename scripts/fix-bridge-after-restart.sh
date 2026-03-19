#!/bin/bash
# Fix bridge network after Docker container restart.
# After nodes crash and restart, the bridge connection becomes stale.
# Force-disconnect and reconnect to fix routing.

echo "=== Current restart counts ==="
for c in artifacts-arx-node-0-1 artifacts-arx-node-1-1 artifacts-arx-node-2-1 artifacts-arx-node-3-1 artifacts-arcium-trusted-dealer-1; do
    RC=$(docker inspect --format '{{.RestartCount}}' "$c" 2>/dev/null || echo "?")
    echo "  $c: restarts=$RC"
done

echo ""
echo "=== Force-reconnecting bridge network ==="
for c in artifacts-arx-node-0-1 artifacts-arx-node-1-1 artifacts-arx-node-2-1 artifacts-arx-node-3-1 artifacts-arcium-trusted-dealer-1; do
    docker network disconnect bridge "$c" 2>/dev/null
    sleep 0.5
    docker network connect bridge "$c" 2>/dev/null && echo "  $c → bridge ✓" || echo "  $c → bridge FAILED"
done

echo ""
echo "Waiting 5s for nodes to stabilize..."
sleep 5

echo ""
echo "=== Verification ==="
echo "Node health ports:"
for port in 9091 9092 9093 9094; do
    STATUS=$(curl -s http://localhost:$port/health 2>/dev/null || echo "NOT_OK")
    echo "  Port $port: $STATUS"
done
echo "Validator: $(solana cluster-version 2>/dev/null || echo 'not running')"
