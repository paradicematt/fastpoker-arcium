#!/bin/bash
LOG=$(ls -t /tmp/poker-arc-workspace/artifacts/arx_node_logs/*_0.log 2>/dev/null | head -1)

echo "=== HuqTBRAX (reveal_player_cards comp_def) ==="
grep "HuqTBRAX" "$LOG" | wc -l
grep "HuqTBRAX" "$LOG" | head -5

echo ""
echo "=== Computation execution (all) ==="
grep -c "Executing computation\|Computation ready" "$LOG"
grep "Executing computation\|Computation ready" "$LOG"

echo ""
echo "=== Success outputs (all) ==="
grep "success outputs of len" "$LOG" | sed 's/.*Computation offset /offset /' | sed 's/ with.*//' | sort -u

echo ""
echo "=== First 5 InstructionError ==="
grep "InstructionError" "$LOG" | head -5 | sed 's/.*kind: //' | sed 's/).*//' 

echo ""
echo "=== Validator logs for showdown callback ==="
# Check validator logs for the actual error
grep -i "reveal_showdown\|showdown_callback\|TableFull\|AwaitingShowdown" /tmp/poker-arc-workspace/.anchor/test-ledger/validator.log 2>/dev/null | tail -10
