#!/bin/bash
echo "=== Docker networks ==="
docker network ls

echo ""
echo "=== Containers on arx_network ==="
docker network inspect artifacts_arx_network --format '{{range .Containers}}{{.Name}} → {{.IPv4Address}}{{"\n"}}{{end}}' 2>/dev/null || echo "arx_network not found"

echo ""
echo "=== Container network details ==="
for c in artifacts-arx-node-0-1 artifacts-arx-node-1-1 artifacts-arx-node-2-1 artifacts-arx-node-3-1 artifacts-arcium-trusted-dealer-1; do
    NETS=$(docker inspect "$c" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}:{{$v.IPAddress}} {{end}}' 2>/dev/null)
    echo "  $c → $NETS"
done

echo ""
echo "=== TD health ==="
docker logs artifacts-arcium-trusted-dealer-1 2>&1 | tail -5

echo ""
echo "=== Node 0 last log lines ==="
LOG=$(ls -t /tmp/poker-arc-workspace/artifacts/arx_node_logs/*_0.log 2>/dev/null | head -1)
if [ -n "$LOG" ]; then
    tail -5 "$LOG"
fi

echo ""
echo "=== Node health ports ==="
for port in 9091 9092 9093 9094; do
    STATUS=$(curl -s http://localhost:$port/health 2>/dev/null || echo "NOT_OK")
    echo "  Port $port: $STATUS"
done
