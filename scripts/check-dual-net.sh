#!/bin/bash
WS="/tmp/poker-arc-workspace"

echo "=== Container networks ==="
for C in artifacts-arx-node-0-1 artifacts-arx-node-1-1 artifacts-arx-node-2-1 artifacts-arx-node-3-1 artifacts-arcium-trusted-dealer-1; do
    NETS=$(docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}:{{$v.IPAddress}} {{end}}' "$C" 2>/dev/null)
    echo "  $C: $NETS"
done

echo ""
echo "=== Validator alive? ==="
curl -s -m 2 http://127.0.0.1:8899 -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' || echo "DOWN"

echo ""
echo "=== Exec into node 0: test connectivity ==="
docker exec artifacts-arx-node-0-1 bash -c "
    echo 'Test 172.17.0.1:8899 (default bridge gateway)...'
    timeout 3 bash -c 'echo > /dev/tcp/172.17.0.1/8899' 2>&1 && echo 'OK' || echo 'FAIL'
    echo 'Test host.docker.internal:8899...'
    timeout 3 bash -c 'echo > /dev/tcp/host.docker.internal/8899' 2>&1 && echo 'OK' || echo 'FAIL'
    echo 'Routing table:'
    cat /proc/net/route
" 2>/dev/null || echo "EXEC FAILED (container restarting?)"

echo ""
echo "=== Latest node 0 log ==="
LATEST=$(ls -t "$WS/artifacts/arx_node_logs/"*_0.log 2>/dev/null | head -1)
[ -n "$LATEST" ] && head -5 "$LATEST"

echo ""
echo "=== Latest TD log ==="
LATEST=$(ls -t "$WS/artifacts/trusted_dealer_logs/"*.log 2>/dev/null | head -1)
[ -n "$LATEST" ] && cat "$LATEST"

echo ""
echo "=== Health endpoints ==="
for port in 9091 9092 9093 9094; do
    H=$(curl -s -m 1 "http://localhost:$port/health" 2>/dev/null)
    [ -n "$H" ] && echo "  :$port = $H"
done
echo "(empty = no health yet)"
