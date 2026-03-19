#!/bin/bash
echo "=== All node 0 log files ==="
for f in /tmp/poker-arc-workspace/artifacts/arx_node_logs/*_0.log; do
    LINES=$(wc -l < "$f")
    COMPUTES=$(grep -c "Computation\|comput" "$f" 2>/dev/null || echo 0)
    ERRORS=$(grep -c "error\|Error\|ERROR" "$f" 2>/dev/null || echo 0)
    echo "  $(basename "$f"): ${LINES} lines, ${COMPUTES} compute mentions, ${ERRORS} errors"
done

echo ""
echo "=== Container restart counts ==="
for c in artifacts-arx-node-0-1 artifacts-arx-node-1-1 artifacts-arx-node-2-1 artifacts-arx-node-3-1 artifacts-arcium-trusted-dealer-1; do
    RC=$(docker inspect --format '{{.RestartCount}}' "$c" 2>/dev/null || echo "?")
    UP=$(docker inspect --format '{{.State.StartedAt}}' "$c" 2>/dev/null || echo "?")
    echo "  $c: restarts=$RC started=$UP"
done

echo ""
echo "=== First log (original nodes) — computation lines ==="
FIRST_LOG=$(ls /tmp/poker-arc-workspace/artifacts/arx_node_logs/*_0.log 2>/dev/null | head -1)
if [ -n "$FIRST_LOG" ]; then
    echo "File: $(basename "$FIRST_LOG")"
    grep -i "comput\|fetch\|execut\|callback\|success\|fail" "$FIRST_LOG" | head -20
fi

echo ""
echo "=== Node health ==="
for port in 9091 9092 9093 9094; do
    STATUS=$(curl -s http://localhost:$port/health 2>/dev/null || echo "NOT_OK")
    echo "  Port $port: $STATUS"
done
