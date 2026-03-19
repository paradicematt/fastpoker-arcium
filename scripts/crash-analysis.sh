#!/bin/bash
FIRST_LOG=$(ls /tmp/poker-arc-workspace/artifacts/arx_node_logs/*_0.log 2>/dev/null | head -1)
echo "=== Last 30 lines of first log (before crash) ==="
tail -30 "$FIRST_LOG"

echo ""
echo "=== Error/warning lines ==="
grep -i "error\|warn\|fail\|panic\|deactivat\|shutdown" "$FIRST_LOG" | tail -20

echo ""
echo "=== Computation execution summary ==="
grep -i "Computation ready\|success output\|Executing comp\|callback" "$FIRST_LOG" | tail -20
