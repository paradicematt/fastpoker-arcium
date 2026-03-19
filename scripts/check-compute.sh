#!/bin/bash
LOG=$(ls -t /tmp/poker-arc-workspace/artifacts/arx_node_logs/*_0.log 2>/dev/null | head -1)
if [ -z "$LOG" ]; then
    echo "No node log found"
    exit 1
fi
echo "Log: $LOG"
echo "Lines: $(wc -l < "$LOG")"
echo ""
echo "=== Computation-related entries ==="
grep -i 'comput\|preprocessing\|executing\|success\|fail\|error\|cancel' "$LOG" 2>/dev/null | tail -15 || echo "none found"
echo ""
echo "=== Last 5 lines ==="
tail -5 "$LOG"
