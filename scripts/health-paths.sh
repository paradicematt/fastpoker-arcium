#!/bin/bash
echo "=== Try different health paths ==="
for path in /health /metrics / /ready /status; do
    R=$(curl -s -m 2 "http://localhost:9091$path" 2>/dev/null)
    [ -n "$R" ] && echo "  :9091$path = $R" || echo "  :9091$path = (empty)"
done

echo ""
echo "=== Try from INSIDE container ==="
docker exec artifacts-arx-node-0-1 bash -c '
for path in /health /metrics / /ready; do
    R=$(curl -s -m 2 "http://127.0.0.1:9091$path" 2>/dev/null)
    [ -n "$R" ] && echo "  :9091$path = $R" || echo "  :9091$path = (empty)"
done
' 2>/dev/null

echo ""
echo "=== Docker iptables NAT rules (port forwarding) ==="
sudo iptables -t nat -L -n 2>/dev/null | grep 909 | head -5

echo ""
echo "=== Docker proxy process for 9091 ==="
ps aux 2>/dev/null | grep "docker-proxy\|9091" | grep -v grep | head -3

echo ""
echo "=== Direct TCP test to container IP ==="
docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' artifacts-arx-node-0-1 2>/dev/null
# Try the arx_network IP directly
NODE0_IP=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' artifacts-arx-node-0-1 2>/dev/null | tr -d ' ' | head -c 15)
echo "Node 0 IP: $NODE0_IP"
curl -s -m 2 "http://$NODE0_IP:9091/health" 2>/dev/null && echo "" || echo "  direct IP health: (empty)"
curl -s -m 2 "http://$NODE0_IP:9091/metrics" 2>/dev/null | head -3 || echo "  direct IP metrics: (empty)"
