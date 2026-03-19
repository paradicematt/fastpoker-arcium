#!/bin/bash
WS="/tmp/poker-arc-workspace"

echo "=== Workspace Anchor.toml bind_address ==="
grep -n 'bind_address' "$WS/Anchor.toml" 2>/dev/null || echo "NOT FOUND in workspace"

echo ""
echo "=== Validator listening ports ==="
ss -tlnp 2>/dev/null | grep -E '8899|8900|8001'

echo ""
echo "=== Test validator from host on each interface ==="
for ip in 127.0.0.1 172.20.0.1 172.17.0.1 0.0.0.0; do
    RESULT=$(curl -s -m 2 "http://$ip:8899" -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null)
    echo "  $ip:8899 = ${RESULT:-FAIL}"
done

echo ""
echo "=== Test from arx_network container ==="
docker run --rm --network artifacts_arx_network curlimages/curl:latest \
    -s -m 5 http://172.20.0.1:8899 -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null || echo "CONTAINER FAIL"

echo ""
echo "=== Validator process ==="
ps aux | grep solana-test-validator | grep -v grep | head -1
