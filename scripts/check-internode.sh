#!/bin/bash
WS="/tmp/poker-arc-workspace"

echo "=== Health endpoints ==="
for port in 9091 9092 9093 9094; do
    H=$(curl -s -m 1 "http://localhost:$port/health" 2>/dev/null)
    [ -n "$H" ] && echo "  :$port = $H" || echo "  :$port = (none)"
done

echo ""
echo "=== Container IPs ==="
for C in artifacts-arx-node-0-1 artifacts-arx-node-1-1 artifacts-arx-node-2-1 artifacts-arx-node-3-1; do
    IP=$(docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}' "$C" 2>/dev/null)
    echo "  $C: $IP"
done

echo ""
echo "=== Test TCP between containers (from node 0 to node 1 port 8001) ==="
docker exec artifacts-arx-node-0-1 bash -c "
    timeout 3 bash -c 'echo > /dev/tcp/172.20.0.101/8001' 2>&1 && echo 'TCP to 101:8001 OK' || echo 'TCP to 101:8001 FAIL'
    timeout 3 bash -c 'echo > /dev/tcp/172.20.0.102/8001' 2>&1 && echo 'TCP to 102:8001 OK' || echo 'TCP to 102:8001 FAIL'
    timeout 3 bash -c 'echo > /dev/tcp/172.20.0.103/8001' 2>&1 && echo 'TCP to 103:8001 OK' || echo 'TCP to 103:8001 FAIL'
    timeout 3 bash -c 'echo > /dev/tcp/172.20.0.99/8001' 2>&1 && echo 'TCP to 99:8001 (TD) OK' || echo 'TCP to 99:8001 (TD) FAIL'
" 2>/dev/null || echo "EXEC FAILED"

echo ""
echo "=== Node 0 grep for key events ==="
LATEST=$(ls -t "$WS/artifacts/arx_node_logs/"*_0.log 2>/dev/null | head -1)
[ -n "$LATEST" ] && grep -i -E "dkg|keygen|health|ready|complete|preprocessing|error|failed" "$LATEST" | head -15

echo ""
echo "=== TD grep for key events ==="
LATEST_TD=$(ls -t "$WS/artifacts/trusted_dealer_logs/"*.log 2>/dev/null | head -1)
[ -n "$LATEST_TD" ] && grep -i -E "dkg|keygen|health|ready|complete|preprocessing|error|failed|dealing" "$LATEST_TD" | head -15

echo ""
echo "=== Node log size progression ==="
wc -c "$WS/artifacts/arx_node_logs/"*_0.log 2>/dev/null | tail -3
