#!/bin/bash
# Wait for node restart (Arcium 0.8.5 bug: nodes crash ~14min after circuit finalization)
# Then force-reconnect bridge network to restore validator connectivity.

echo "=== Monitoring for node restart ==="
echo "Checking restart count every 30s..."

MAX_WAIT=1200  # 20 minutes max
ELAPSED=0
INITIAL_RC=$(docker inspect --format '{{.RestartCount}}' artifacts-arx-node-0-1 2>/dev/null || echo "0")
echo "  Initial restart count: $INITIAL_RC"

while [ $ELAPSED -lt $MAX_WAIT ]; do
    RC=$(docker inspect --format '{{.RestartCount}}' artifacts-arx-node-0-1 2>/dev/null || echo "0")
    if [ "$RC" != "$INITIAL_RC" ]; then
        echo ""
        echo "  Node restarted! RC: $INITIAL_RC → $RC (after ${ELAPSED}s)"
        echo "  Waiting 10s for all nodes to restart..."
        sleep 10
        break
    fi
    
    # Also check health — if still OK, nodes haven't crashed yet
    HEALTH=$(curl -s http://localhost:9091/health 2>/dev/null || echo "NOT_OK")
    printf "\r  %ds: RC=%s health=%s    " "$ELAPSED" "$RC" "$HEALTH"
    
    sleep 30
    ELAPSED=$((ELAPSED + 30))
done

if [ $ELAPSED -ge $MAX_WAIT ]; then
    echo ""
    echo "  Timeout waiting for restart (${MAX_WAIT}s). Nodes may not have crashed."
    echo "  Proceeding anyway..."
fi

echo ""
echo "=== Force-reconnecting bridge network ==="
for c in artifacts-arx-node-0-1 artifacts-arx-node-1-1 artifacts-arx-node-2-1 artifacts-arx-node-3-1 artifacts-arcium-trusted-dealer-1; do
    docker network disconnect bridge "$c" 2>/dev/null
    sleep 0.5
    docker network connect bridge "$c" 2>/dev/null && echo "  $c → bridge ✓" || echo "  $c → bridge FAILED"
done

echo ""
echo "Waiting 10s for stabilization..."
sleep 10

echo ""
echo "=== Post-fix verification ==="
echo "Restart counts:"
for c in artifacts-arx-node-0-1 artifacts-arx-node-1-1 artifacts-arx-node-2-1 artifacts-arx-node-3-1; do
    RC=$(docker inspect --format '{{.RestartCount}}' "$c" 2>/dev/null)
    echo "  $c: $RC"
done

echo ""
echo "Node health:"
for port in 9091 9092 9093 9094; do
    STATUS=$(curl -s http://localhost:$port/health 2>/dev/null || echo "NOT_OK")
    echo "  Port $port: $STATUS"
done

echo ""
echo "Node 0 log:"
LOG=$(ls -t /tmp/poker-arc-workspace/artifacts/arx_node_logs/*_0.log 2>/dev/null | head -1)
if [ -n "$LOG" ]; then
    echo "  Lines: $(wc -l < "$LOG")"
    grep -c "comput\|Computation" "$LOG" | xargs -I{} echo "  Computation mentions: {}"
fi

echo ""
echo "=== Done ==="
