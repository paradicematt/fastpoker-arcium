#!/bin/bash
echo "=== Validator listening addresses ==="
ss -tlnp | grep 8899 || echo "ss: not found or no listener on 8899"
netstat -tlnp 2>/dev/null | grep 8899 || echo "netstat: no listener on 8899"

echo ""
echo "=== RPC from host ==="
curl -s http://127.0.0.1:8899 -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' 2>/dev/null | head -1
curl -s http://0.0.0.0:8899 -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' 2>/dev/null | head -1

echo ""
echo "=== Docker gateway IP ==="
ip addr show docker0 2>/dev/null | grep inet || echo "docker0 not found"

echo ""
echo "=== RPC from docker0 IP ==="
DOCKER_IP=$(ip addr show docker0 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1)
if [ -n "$DOCKER_IP" ]; then
    echo "Docker0 IP: $DOCKER_IP"
    curl -s "http://${DOCKER_IP}:8899" -X POST -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' 2>/dev/null | head -1 || echo "FAILED from $DOCKER_IP"
fi

echo ""
echo "=== Disconnect and reconnect bridge for node-0 ==="
docker network disconnect bridge artifacts-arx-node-0-1 2>/dev/null
docker network connect bridge artifacts-arx-node-0-1 2>/dev/null && echo "Reconnected" || echo "Failed"

echo ""
echo "=== Re-test TCP from node-0 ==="
docker exec artifacts-arx-node-0-1 sh -c 'cat /etc/hosts | grep docker' 2>/dev/null
docker exec artifacts-arx-node-0-1 sh -c 'timeout 2 sh -c "echo test > /dev/tcp/host.docker.internal/8899" 2>&1' && echo "TCP OK" || echo "TCP FAILED"
