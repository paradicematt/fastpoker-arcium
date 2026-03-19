#!/bin/bash
# Verify Docker can reach the validator before starting localnet

echo "=== route_localnet ==="
cat /proc/sys/net/ipv4/conf/all/route_localnet

echo ""
echo "=== iptables DNAT rules ==="
iptables -t nat -L PREROUTING -n 2>/dev/null | grep 8899

echo ""
echo "=== Test: Can Docker container reach host on port 8899? ==="
# Start a temp validator to test connectivity
# Actually, just test DNS resolution and basic connectivity
docker run --rm alpine sh -c "nslookup host.docker.internal 2>/dev/null || echo 'DNS failed'; wget -q -O- --timeout=2 http://host.docker.internal:8899 2>&1 | head -3 || echo 'Connection to host.docker.internal:8899 failed (expected - no validator running)'"

echo ""
echo "=== Docker bridge gateway ==="
docker network inspect bridge 2>/dev/null | grep -A3 '"Gateway"' || echo "No bridge network"

echo ""
echo "=== host.docker.internal from container ==="
docker run --rm alpine sh -c "getent hosts host.docker.internal 2>/dev/null || cat /etc/hosts | grep host.docker.internal 2>/dev/null || echo 'host.docker.internal not resolvable'"
