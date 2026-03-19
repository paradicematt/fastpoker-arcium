#!/bin/bash
echo "=== Validator TCP listen ==="
ss -tlnp | grep 8899

echo ""
echo "=== From host to 172.20.0.1:8899 ==="
curl -s -m 2 http://172.20.0.1:8899 -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null || echo "FAIL"

echo ""
echo "=== From arx container to 172.20.0.1:8899 ==="
docker run --rm --network artifacts_arx_network curlimages/curl:latest \
    -s -m 5 http://172.20.0.1:8899 -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null
echo ""
echo "(empty above = timeout/fail)"

echo ""
echo "=== arx_network bridge details ==="
docker network inspect artifacts_arx_network 2>/dev/null | grep -A5 '"Gateway"'

echo ""
echo "=== iptables FORWARD for 172.20 ==="
iptables -L FORWARD -n -v 2>/dev/null | grep 172.20
iptables -L DOCKER-FORWARD -n -v 2>/dev/null | grep 172.20
