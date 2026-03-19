#!/bin/bash
LOG=$(ls -t /tmp/poker-arc-workspace/artifacts/arx_node_logs/*_0.log 2>/dev/null | head -1)
echo "Log: $LOG"
echo "Lines: $(wc -l < "$LOG")"

echo ""
echo "=== All InstructionError entries ==="
grep "InstructionError" "$LOG"

echo ""
echo "=== All 'success outputs' ==="
grep "success outputs" "$LOG"

echo ""
echo "=== First callback attempt ==="
grep -i "callback\|Sent.*callback\|Failed.*callback" "$LOG" | head -15

echo ""
echo "=== Node restart count ==="
docker inspect --format '{{.RestartCount}}' artifacts-arx-node-0-1 2>/dev/null

echo ""
echo "=== Node health ==="
curl -s http://localhost:9091/health 2>/dev/null || echo "NOT_OK"
