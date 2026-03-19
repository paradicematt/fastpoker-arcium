#!/bin/bash
# Manually restart node containers after crash
# Docker's automatic restart doesn't properly reinitialize

echo "=== Stopping all node containers ==="
for c in artifacts-arx-node-0-1 artifacts-arx-node-1-1 artifacts-arx-node-2-1 artifacts-arx-node-3-1; do
    docker stop "$c" 2>/dev/null && echo "  Stopped $c" || echo "  $c already stopped"
done

echo ""
echo "=== Waiting 5s ==="
sleep 5

echo ""
echo "=== Starting all node containers ==="
for c in artifacts-arx-node-0-1 artifacts-arx-node-1-1 artifacts-arx-node-2-1 artifacts-arx-node-3-1; do
    docker start "$c" 2>/dev/null && echo "  Started $c" || echo "  Failed to start $c"
done

echo ""
echo "=== Reconnecting bridge ==="
sleep 3
for c in artifacts-arx-node-0-1 artifacts-arx-node-1-1 artifacts-arx-node-2-1 artifacts-arx-node-3-1 artifacts-arcium-trusted-dealer-1; do
    docker network disconnect bridge "$c" 2>/dev/null
    sleep 0.5
    docker network connect bridge "$c" 2>/dev/null && echo "  $c → bridge ✓" || echo "  $c → bridge (skip)"
done

echo ""
echo "=== Waiting 15s for stabilization ==="
sleep 15

echo ""
echo "=== Verification ==="
docker ps --format '  {{.Names}}: {{.Status}}'
echo ""
echo "Node health:"
for port in 9091 9092 9093 9094; do
    STATUS=$(curl -s http://localhost:$port/health 2>/dev/null || echo "NOT_OK")
    echo "  Port $port: $STATUS"
done

echo ""
echo "=== Latest node 0 log ==="
LOG=$(ls -t /tmp/poker-arc-workspace/artifacts/arx_node_logs/*_0.log 2>/dev/null | head -1)
if [ -n "$LOG" ]; then
    echo "  File: $(basename "$LOG") ($(wc -l < "$LOG") lines)"
    grep -c "comput\|Computation" "$LOG" | xargs -I{} echo "  Computation mentions: {}"
fi
