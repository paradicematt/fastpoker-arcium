#!/bin/bash
# Check if Docker containers can reach the validator
echo "=== Container bridge network status ==="
for c in artifacts-arx-node-0-1 artifacts-arx-node-1-1 artifacts-arx-node-2-1 artifacts-arx-node-3-1; do
    BRIDGE=$(docker inspect "$c" --format '{{json .NetworkSettings.Networks}}' 2>/dev/null | grep -o '"bridge"' || echo "")
    if [ -n "$BRIDGE" ]; then
        echo "  $c: bridge=YES"
    else
        echo "  $c: bridge=NO ← needs reconnect!"
        docker network connect bridge "$c" 2>/dev/null && echo "    → connected" || echo "    → failed"
    fi
done

echo ""
echo "=== Testing RPC from node-0 ==="
docker exec artifacts-arx-node-0-1 wget -q -O- --post-data='{"jsonrpc":"2.0","id":1,"method":"getSlot"}' --header='Content-Type: application/json' http://host.docker.internal:8899 2>/dev/null || echo "UNREACHABLE from container"

echo ""
echo "=== Node health ==="
curl -s http://localhost:9091/health 2>/dev/null || echo "Node 0 health: NOT OK"

echo ""
echo "=== Node log lines ==="
LOG=$(ls -t /tmp/poker-arc-workspace/artifacts/arx_node_logs/*_0.log 2>/dev/null | head -1)
if [ -n "$LOG" ]; then
    echo "  File: $LOG ($(wc -l < "$LOG") lines)"
    grep -c "computation\|Computation" "$LOG" 2>/dev/null | xargs -I{} echo "  Computation mentions: {}"
fi
