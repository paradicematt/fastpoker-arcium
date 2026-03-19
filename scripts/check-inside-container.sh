#!/bin/bash
# Check from INSIDE a running arx-node container

echo "=== Container status ==="
docker ps --filter "name=arx-node-0" --format "{{.Names}}: {{.Status}}"

echo ""
echo "=== Config file inside container ==="
docker exec artifacts-arx-node-0-1 cat /usr/arx-node/arx/node_config.toml 2>/dev/null || echo "EXEC FAILED (container may be restarting)"

echo ""
echo "=== /etc/hosts inside container ==="
docker exec artifacts-arx-node-0-1 cat /etc/hosts 2>/dev/null || echo "EXEC FAILED"

echo ""
echo "=== Test connectivity from inside container ==="
docker exec artifacts-arx-node-0-1 wget -q -O- --timeout=3 http://172.20.0.1:8899 2>&1 | head -3 || echo "wget not available, trying curl..."
docker exec artifacts-arx-node-0-1 curl -s -m 3 http://172.20.0.1:8899 -X POST -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null || echo "curl not available either"

echo ""
echo "=== Network info inside container ==="
docker exec artifacts-arx-node-0-1 ip addr 2>/dev/null || echo "ip not available"
docker exec artifacts-arx-node-0-1 cat /etc/resolv.conf 2>/dev/null
