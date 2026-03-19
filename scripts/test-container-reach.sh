#!/bin/bash
# Test if a Docker container can reach the validator via host.docker.internal
# Start a temp validator first, then test from a container

source ~/.cargo/env 2>/dev/null || true
export PATH="$HOME/.local/share/solana/install/releases/2.1.21/solana-release/bin:$HOME/.cargo/bin:$PATH"

echo "=== Start a quick validator on 0.0.0.0:8899 ==="
solana-test-validator --bind-address 0.0.0.0 --rpc-port 8899 --no-bpf-jit --reset --quiet &
VAL_PID=$!
sleep 5

echo "=== Test from host ==="
curl -s http://127.0.0.1:8899 -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null
echo ""

echo ""
echo "=== Test from container (default bridge) ==="
docker run --rm curlimages/curl:latest \
    -s -m 5 http://host.docker.internal:8899 -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null || echo "FAILED from default bridge"
echo ""

echo ""
echo "=== Test from container on arx_network ==="
# Create arx_network if it doesn't exist
docker network create --subnet=172.20.0.0/16 arx_network 2>/dev/null || true
docker run --rm --network arx_network curlimages/curl:latest \
    -s -m 5 http://host.docker.internal:8899 -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null || echo "FAILED from arx_network"
echo ""

echo ""
echo "=== Also test bridge gateway directly ==="
docker run --rm --network arx_network curlimages/curl:latest \
    -s -m 5 http://172.20.0.1:8899 -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null || echo "FAILED via bridge gateway"
echo ""

# Cleanup
kill $VAL_PID 2>/dev/null
echo ""
echo "=== Done ==="
