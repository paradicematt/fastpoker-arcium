#!/bin/bash
sleep 10

echo "=== Processes ==="
ps aux | grep -E 'arx/arx|trusted-dealer' | grep -v grep

echo ""
echo "=== UDP ==="
ss -ulnp 2>/dev/null | grep 8001

echo ""
echo "=== Node logs ==="
for i in 0 1 2 3; do
    LOG="/tmp/arx-native/run_node_${i}/node.log"
    BYTES=$(wc -c < "$LOG" 2>/dev/null || echo 0)
    echo "Node $i: $BYTES bytes"
    tail -5 "$LOG" 2>/dev/null
    echo ""
done

echo "=== TD log ==="
TD_LOG="/tmp/arx-native/run_td/td.log"
BYTES=$(wc -c < "$TD_LOG" 2>/dev/null || echo 0)
echo "TD: $BYTES bytes"
tail -10 "$TD_LOG" 2>/dev/null

echo ""
echo "=== Health checks ==="
for port in 9091 9092 9093 9094; do
    H=$(curl -s -m 1 "http://localhost:$port/health" 2>/dev/null)
    [ -n "$H" ] && echo "localhost:$port = $H"
done
for ip in 172.20.0.100 172.20.0.101 172.20.0.102 172.20.0.103; do
    H=$(curl -s -m 1 "http://$ip:9091/health" 2>/dev/null)
    [ -n "$H" ] && echo "$ip:9091 = $H"
done
echo "(empty = no response)"
