#!/bin/bash
# Check what iptables rules affect arx_network traffic

echo "=== Current bridge for arx_network ==="
BRIDGE=$(docker network inspect artifacts_arx_network 2>/dev/null | grep -oP '"com.docker.network.bridge.name": "\K[^"]+')
echo "Bridge: $BRIDGE"

echo ""
echo "=== iptables FILTER table (all chains) ==="
iptables -L -n -v 2>/dev/null | head -60

echo ""
echo "=== iptables for bridge $BRIDGE ==="
iptables -L -n -v 2>/dev/null | grep "$BRIDGE"

echo ""
echo "=== DOCKER-ISOLATION chains ==="
iptables -L DOCKER-ISOLATION-STAGE-1 -n -v 2>/dev/null
iptables -L DOCKER-ISOLATION-STAGE-2 -n -v 2>/dev/null

echo ""
echo "=== DOCKER-FORWARD chain ==="
iptables -L DOCKER-FORWARD -n -v 2>/dev/null

echo ""
echo "=== iptables INPUT chain ==="
iptables -L INPUT -n -v 2>/dev/null
