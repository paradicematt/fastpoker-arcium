#!/bin/bash
# Test UDP connectivity between Docker containers on arx_network
source ~/.cargo/env 2>/dev/null || true

echo "=== UDP connectivity test ==="

# Check if containers are running
docker ps --format '{{.Names}}' | grep arx-node || { echo "No arx-node containers running"; exit 1; }

# Test 1: Can we send UDP between containers?
echo ""
echo "--- Test 1: UDP between node-0 and node-1 ---"
# Start listener on node-0 in background
docker exec -d artifacts-arx-node-0-1 sh -c 'echo "UDP_WORKS" | nc -u -l -p 55555 -w5' 2>/dev/null
sleep 1
# Send from node-1 to node-0
RESULT=$(docker exec artifacts-arx-node-1-1 sh -c 'echo "HELLO" | nc -u -w2 172.20.0.100 55555' 2>&1)
echo "  Result: ${RESULT:-timeout/empty}"

# Test 2: Can node-1 reach node-0 on 8001/UDP?
echo ""
echo "--- Test 2: UDP to port 8001 (QUIC) ---"
RESULT=$(docker exec artifacts-arx-node-1-1 sh -c 'echo "PING" | nc -u -w2 172.20.0.100 8001' 2>&1)
echo "  8001 result: ${RESULT:-timeout/empty}"

# Test 3: Check /proc/net/udp on all nodes
echo ""
echo "--- Test 3: UDP sockets per node ---"
for i in 0 1 2 3; do
    UDP_COUNT=$(docker exec artifacts-arx-node-$i-1 cat /proc/net/udp 2>/dev/null | grep -c "1F41" || echo 0)
    echo "  node-$i: port 8001 bound=$UDP_COUNT"
done

# Test 4: Check if TD has UDP socket bound
echo ""
echo "--- Test 4: TD sockets ---"
docker exec artifacts-arcium-trusted-dealer-1 cat /proc/net/udp 2>/dev/null
docker exec artifacts-arcium-trusted-dealer-1 cat /proc/net/tcp 2>/dev/null

# Test 5: Try QUIC-level test using nmap or basic UDP
echo ""
echo "--- Test 5: nmap UDP scan from node-1 to node-0:8001 ---"
docker exec artifacts-arx-node-1-1 sh -c 'echo "test" > /dev/udp/172.20.0.100/8001 2>&1 && echo "UDP_SEND_OK" || echo "UDP_SEND_FAIL"' 2>/dev/null
echo "  (bash /dev/udp test)"

echo ""
echo "=== Done ==="
