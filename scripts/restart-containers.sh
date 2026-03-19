#!/bin/bash
WS="/tmp/poker-arc-workspace"

echo "=== Verify config is patched ==="
grep endpoint_rpc "$WS/artifacts/node_config_0.toml"
grep solana_rpc "$WS/artifacts/trusted_dealer_config.toml"

echo ""
echo "=== Stop all containers ==="
docker compose -f "$WS/artifacts/docker-compose-arx-env.yml" down 2>/dev/null
sleep 2

echo ""
echo "=== Start containers fresh ==="
docker compose -f "$WS/artifacts/docker-compose-arx-env.yml" up -d 2>/dev/null

echo ""
echo "=== Wait 15s for startup ==="
sleep 15

echo ""
echo "=== Container status ==="
docker ps --filter "name=arx" --filter "name=arcium" --format "{{.Names}}: {{.Status}}"

echo ""
echo "=== Try exec into running node ==="
docker exec artifacts-arx-node-0-1 cat /usr/arx-node/arx/node_config.toml 2>/dev/null || echo "EXEC FAILED"

echo ""
echo "=== Latest node 0 log ==="
LATEST=$(ls -t "$WS/artifacts/arx_node_logs/"*_0.log 2>/dev/null | head -1)
if [ -n "$LATEST" ]; then
    cat "$LATEST" | head -10
fi

echo ""
echo "=== Latest TD log ==="
LATEST=$(ls -t "$WS/artifacts/trusted_dealer_logs/"*.log 2>/dev/null | head -1)
if [ -n "$LATEST" ]; then
    cat "$LATEST"
fi

echo ""
echo "=== Health ==="
for port in 9091 9092 9093 9094; do
    H=$(curl -s -m 2 "http://localhost:$port/health" 2>/dev/null)
    [ -n "$H" ] && echo "  :$port = $H"
done
echo "(empty = no health yet)"
