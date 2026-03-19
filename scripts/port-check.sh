#!/bin/bash
echo "=== Docker container port mappings ==="
docker ps --format "{{.Names}}\t{{.Ports}}" 2>/dev/null

echo ""
echo "=== Host listening on 9091-9094? ==="
ss -tlnp 2>/dev/null | grep -E "909[1-4]" || echo "No listeners on 9091-9094"

echo ""
echo "=== Node 0 log file size and last modified ==="
ls -la /tmp/poker-arc-workspace/artifacts/arx_node_logs/*_0.log 2>/dev/null | tail -1

echo ""
echo "=== Node 0 last 5 lines (any module) ==="
LATEST=$(ls -t /tmp/poker-arc-workspace/artifacts/arx_node_logs/*_0.log 2>/dev/null | head -1)
[ -n "$LATEST" ] && tail -5 "$LATEST" | cut -c1-200

echo ""
echo "=== Is there ongoing TD activity? ==="
LATEST_TD=$(ls -t /tmp/poker-arc-workspace/artifacts/trusted_dealer_logs/*.log 2>/dev/null | head -1)
[ -n "$LATEST_TD" ] && wc -c "$LATEST_TD" && tail -3 "$LATEST_TD" | cut -c1-200
