#!/bin/bash
echo "=== Is validator alive? ==="
curl -s -m 2 http://127.0.0.1:8899 -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null || echo "VALIDATOR DOWN!"

echo ""
echo "=== Validator PID ==="
pgrep -a solana-test-val

echo ""
echo "=== Validator listening on bridge IPs? ==="
curl -s -m 2 http://172.20.0.1:8899 -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null || echo "FAIL at 172.20.0.1"
curl -s -m 2 http://172.17.0.1:8899 -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null || echo "FAIL at 172.17.0.1"

echo ""
echo "=== Test from arx-node IMAGE (not running container) ==="
# Try to exec a network test from the arx-node image
docker run --rm --network artifacts_arx_network --entrypoint="" arcium/arx-node:latest \
    sh -c "wget -q -O- --timeout=3 http://172.20.0.1:8899 2>&1 || echo 'wget failed'; cat /etc/hosts" 2>/dev/null \
    || echo "No shell in arx-node image"

echo ""
echo "=== Test from ubuntu on same network ==="
docker run --rm --network artifacts_arx_network ubuntu:latest \
    bash -c "apt-get update -qq > /dev/null 2>&1; apt-get install -y -qq curl > /dev/null 2>&1; curl -s -m 5 http://172.20.0.1:8899 -X POST -H 'Content-Type: application/json' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getHealth\"}'" 2>/dev/null \
    || echo "Ubuntu test failed"

echo ""
echo "=== Network from inside arx-node ==="
# Try to get network info from a running arx-node container
CONTAINER=$(docker ps -q --filter "name=arx-node-0" | head -1)
if [ -n "$CONTAINER" ]; then
    echo "Container $CONTAINER:"
    docker exec "$CONTAINER" cat /etc/hosts 2>/dev/null || echo "  /etc/hosts: exec failed"
    docker exec "$CONTAINER" cat /etc/resolv.conf 2>/dev/null || echo "  /etc/resolv.conf: exec failed"
    # Check if nslookup or ping available
    docker exec "$CONTAINER" ls /bin/ 2>/dev/null | head -20 || echo "  ls: exec failed"
fi
