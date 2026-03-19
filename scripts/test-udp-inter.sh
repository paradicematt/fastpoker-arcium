#!/bin/bash
echo "=== Test UDP between arx containers on arx_network ==="

# Start a UDP listener on node 1
echo "Starting UDP listener on node 1 (172.20.0.101:9999)..."
docker exec -d artifacts-arx-node-1-1 bash -c "timeout 10 bash -c 'nc -u -l -p 9999 > /tmp/udp_test 2>&1' &"
sleep 1

# Send UDP from node 0 to node 1
echo "Sending UDP from node 0 to node 1..."
docker exec artifacts-arx-node-0-1 bash -c "echo 'HELLO_UDP' | nc -u -w 2 172.20.0.101 9999" 2>/dev/null
sleep 1

# Check if received
echo "Checking if node 1 received..."
docker exec artifacts-arx-node-1-1 bash -c "cat /tmp/udp_test 2>/dev/null || echo 'nothing received'"

echo ""
echo "=== Check if port 8001 is listening on each node ==="
for C in artifacts-arx-node-0-1 artifacts-arx-node-1-1 artifacts-arx-node-2-1 artifacts-arx-node-3-1; do
    echo -n "  $C: "
    docker exec "$C" bash -c "cat /proc/net/udp 2>/dev/null | head -5; echo '---'; ss -ulnp 2>/dev/null | grep 8001 || echo 'ss not available'" 2>/dev/null || echo "exec failed"
done

echo ""
echo "=== Check Docker ICC setting for arx_network ==="
docker network inspect artifacts_arx_network 2>/dev/null | grep -A2 "com.docker.network"

echo ""
echo "=== Ping between nodes ==="
docker exec artifacts-arx-node-0-1 bash -c "ping -c 1 -W 2 172.20.0.101 2>&1" 2>/dev/null || echo "ping failed/not available"
