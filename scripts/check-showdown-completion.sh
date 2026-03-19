#!/bin/bash
# Check if reveal_player_cards computation completed before the crash
FIRST_LOG=$(ls /tmp/poker-arc-workspace/artifacts/arx_node_logs/*_0.log 2>/dev/null | head -1)
echo "=== reveal_player_cards (HuqTBRAX) execution timeline ==="
grep -i "HuqTBRAX\|1773703009867000\|1773703013128\|success output\|callback.*BGyLY\|deactivat\|error.*callback\|InstructionError" "$FIRST_LOG" | tail -30

echo ""
echo "=== All callback transactions ==="
grep "callback computation tx\|callback.*sent\|already sent" "$FIRST_LOG" | tail -10

echo ""
echo "=== All 'success outputs' ==="
grep "success outputs" "$FIRST_LOG"
