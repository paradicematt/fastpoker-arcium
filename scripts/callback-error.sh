#!/bin/bash
WS="/tmp/poker-arc-workspace"

echo "=== Full callback error message ==="
LATEST=$(ls -t "$WS/artifacts/arx_node_logs/"*_0.log 2>/dev/null | head -1)
[ -n "$LATEST" ] && grep -i "Failed to send versioned\|error.*callback\|request.*error\|simulation\|custom program error" "$LATEST" | tail -10

echo ""
echo "=== Node 0: can it still reach validator? ==="
docker exec artifacts-arx-node-0-1 bash -c '
exec 3<>/dev/tcp/172.17.0.1/8899 2>/dev/null && echo "bridge gateway reachable" || echo "bridge gateway UNREACHABLE"
exec 3>&-
' 2>/dev/null

echo ""
echo "=== Check if bridge network still connected ==="
docker inspect --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}: {{$v.IPAddress}} {{end}}' artifacts-arx-node-0-1 2>/dev/null

echo ""
echo "=== Node RPC config ==="
grep "endpoint_rpc" "$WS/artifacts/node_config_0.toml" 2>/dev/null

echo ""
echo "=== Test host.docker.internal from node ==="
docker exec artifacts-arx-node-0-1 bash -c '
exec 3<>/dev/tcp/host.docker.internal/8899 2>/dev/null && echo "host.docker.internal:8899 reachable" || echo "host.docker.internal:8899 UNREACHABLE"
exec 3>&-
' 2>/dev/null

echo ""
echo "=== Computation details (reveal_community) ==="
[ -n "$LATEST" ] && grep -i "reveal_community\|2810956478\|cerberus\|Processing.*Computation\|prefetch\|output\|TOTAL" "$LATEST" | tail -20 | cut -c1-250
