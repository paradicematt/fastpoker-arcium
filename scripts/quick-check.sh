#!/bin/bash
echo "=== Containers ==="
docker ps --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null

echo ""
echo "=== Health ==="
for p in 9091 9092; do
    RESP=$(curl -s -m 2 "http://localhost:$p/health" 2>/dev/null)
    echo "  $p: ${RESP:-no-response}"
done

echo ""
echo "=== TD Log ==="
TD=$(ls -t /tmp/poker-arc-workspace/artifacts/trusted_dealer_logs/*.log 2>/dev/null | head -1)
if [ -n "$TD" ]; then
    CONN=$(grep -c 'Connections established' "$TD" 2>/dev/null || echo 0)
    echo "  connections_established=$CONN"
    echo "  Last 5 INFO lines:"
    grep "INFO" "$TD" | tail -5
fi

echo ""
echo "=== Node 0 Log ==="
N0=$(ls -t /tmp/poker-arc-workspace/artifacts/arx_node_logs/*_0.log 2>/dev/null | head -1)
if [ -n "$N0" ]; then
    echo "  size=$(wc -c < "$N0") bytes"
    echo "  Last 3 INFO lines:"
    grep "INFO" "$N0" | tail -3
fi

echo ""
echo "=== Inter-container test ==="
docker run --rm --network artifacts_arx_network alpine sh -c \
    'nc -z -w1 172.20.0.100 8001 && echo "8001:OPEN" || echo "8001:CLOSED"' 2>/dev/null
