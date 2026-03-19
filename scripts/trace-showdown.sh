#!/bin/bash
LOG=$(ls -t /tmp/poker-arc-workspace/artifacts/arx_node_logs/*_0.log 2>/dev/null | head -1)
echo "Log: $LOG ($(wc -l < "$LOG") lines)"

echo ""
echo "=== reveal_player_cards comp_def (HuqTBRAX) mentions ==="
grep "HuqTBRAX" "$LOG"

echo ""
echo "=== All computation execution entries ==="
grep "Executing computation\|Computation ready for execution\|Processing queued computation\|Processing set index" "$LOG" | tail -20

echo ""
echo "=== All success outputs ==="
grep "success outputs" "$LOG"

echo ""
echo "=== All InstructionError (first 10) ==="
grep "InstructionError" "$LOG" | head -10

echo ""
echo "=== All callback send attempts ==="
grep "Sent versioned callback\|callback.*already sent\|Failed to send.*callback\|Processing callback" "$LOG" | tail -20

echo ""
echo "=== Container restart count ==="
docker inspect --format '{{.RestartCount}}' artifacts-arx-node-0-1 2>/dev/null

echo ""
echo "=== Node health ==="
curl -s http://localhost:9091/health 2>/dev/null || echo "NOT_OK"
