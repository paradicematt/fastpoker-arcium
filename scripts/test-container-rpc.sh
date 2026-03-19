#!/bin/bash
# Test if arx-node-0 can reach the validator
echo "=== Container restart count ==="
for c in artifacts-arx-node-0-1 artifacts-arx-node-1-1 artifacts-arx-node-2-1 artifacts-arx-node-3-1 artifacts-arcium-trusted-dealer-1; do
    RC=$(docker inspect --format '{{.RestartCount}}' "$c" 2>/dev/null)
    ST=$(docker inspect --format '{{.State.Status}}' "$c" 2>/dev/null)
    echo "  $c: restarts=$RC status=$ST"
done

echo ""
echo "=== host.docker.internal resolution inside node-0 ==="
docker exec artifacts-arx-node-0-1 cat /etc/hosts 2>/dev/null | grep -i docker || echo "not found in /etc/hosts"

echo ""
echo "=== Try reaching validator from node-0 ==="
# Try using the container's built-in tools
docker exec artifacts-arx-node-0-1 sh -c 'echo | timeout 2 /bin/sh -c "cat < /dev/tcp/host.docker.internal/8899" 2>/dev/null' && echo "TCP connection OK" || echo "TCP connection FAILED"

# Try via IP directly (docker0 gateway = 172.17.0.1)
docker exec artifacts-arx-node-0-1 sh -c 'echo | timeout 2 /bin/sh -c "cat < /dev/tcp/172.17.0.1/8899" 2>/dev/null' && echo "172.17.0.1:8899 OK" || echo "172.17.0.1:8899 FAILED"

echo ""
echo "=== All node log files ==="
ls -lt /tmp/poker-arc-workspace/artifacts/arx_node_logs/ | head -10

echo ""
echo "=== Node 0 all log files with line counts ==="
for f in /tmp/poker-arc-workspace/artifacts/arx_node_logs/*_0.log; do
    echo "  $(wc -l < "$f") lines: $(basename "$f")"
done
