#!/bin/bash
# Test UDP between containers using alpine with nc
NETWORK="artifacts_arx_network"

echo "=== UDP test with alpine containers ==="

# Check network exists
docker network ls | grep arx || { echo "arx_network not found"; exit 1; }

# Start a UDP listener on the network at a specific IP
echo "Starting UDP listener on 172.20.0.200..."
docker run -d --rm --name udp-listener --network $NETWORK --ip 172.20.0.200 \
    alpine sh -c 'nc -u -l -p 9999 > /tmp/result 2>&1; cat /tmp/result' 2>/dev/null
sleep 1

# Send UDP from another container
echo "Sending UDP from 172.20.0.201..."
docker run --rm --name udp-sender --network $NETWORK --ip 172.20.0.201 \
    alpine sh -c 'echo "UDP_TEST_OK" | nc -u -w2 172.20.0.200 9999' 2>/dev/null
sleep 1

# Check listener result
echo "Checking listener..."
docker logs udp-listener 2>&1 | head -5
docker stop udp-listener 2>/dev/null

echo ""
echo "=== Test: UDP from alpine to arx-node-0:8001 ==="
docker run --rm --network $NETWORK --ip 172.20.0.210 \
    alpine sh -c 'echo "QUIC_PING" | nc -u -w2 172.20.0.100 8001 && echo "SENT" || echo "FAIL"' 2>/dev/null

echo ""
echo "=== Test: Ping between containers (ICMP baseline) ==="
docker run --rm --network $NETWORK \
    alpine sh -c 'ping -c 1 -W 1 172.20.0.100 && echo "PING_OK" || echo "PING_FAIL"' 2>/dev/null

echo ""
echo "=== Test: TCP to node-0 internal port 40481 ==="
docker run --rm --network $NETWORK \
    alpine sh -c 'nc -z -w2 172.20.0.100 40481 && echo "TCP_40481_OPEN" || echo "TCP_40481_CLOSED"' 2>/dev/null

echo ""
echo "=== Docker network inspect (subnet + driver) ==="
docker network inspect $NETWORK --format '{{.Driver}} {{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null

echo ""
echo "=== iptables UDP rules ==="
sudo iptables -L -n -v 2>/dev/null | grep -i udp | head -10
echo "---"
sudo iptables -L DOCKER -n -v 2>/dev/null | head -20
