#!/bin/bash
echo "=== Verbose curl to health from inside container ==="
docker exec artifacts-arx-node-0-1 bash -c '
curl -v -m 3 http://127.0.0.1:9091/health 2>&1
echo "---"
curl -v -m 3 http://127.0.0.1:9091/metrics 2>&1
' 2>/dev/null

echo ""
echo "=== /proc/net/tcp FULL listing inside container ==="
docker exec artifacts-arx-node-0-1 bash -c 'cat /proc/net/tcp' 2>/dev/null

echo ""
echo "=== /proc/net/udp (QUIC ports) ==="
docker exec artifacts-arx-node-0-1 bash -c 'cat /proc/net/udp' 2>/dev/null | head -10

echo ""
echo "=== Node 0 config: health/metrics port ==="
grep -i "health\|metric\|http\|api\|port\|9091" /tmp/poker-arc-workspace/artifacts/node_config_0.toml 2>/dev/null

echo ""
echo "=== Node 0: WARN and ERROR messages ==="
LATEST=$(ls -t /tmp/poker-arc-workspace/artifacts/arx_node_logs/*_0.log 2>/dev/null | head -1)
[ -n "$LATEST" ] && grep -E "WARN|ERROR" "$LATEST" | tail -10 | cut -c1-250
