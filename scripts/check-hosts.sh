#!/bin/bash
# Check what host.docker.internal resolves to inside containers

echo "=== What does host-gateway map to? ==="
docker run --rm --add-host=test:host-gateway alpine cat /etc/hosts

echo ""
echo "=== With extra_hosts override (like docker-compose) ==="
docker run --rm --add-host="host.docker.internal:host-gateway" alpine sh -c "cat /etc/hosts; echo '---'; getent hosts host.docker.internal"

echo ""
echo "=== On arx_network with extra_hosts override ==="
docker run --rm --network artifacts_arx_network --add-host="host.docker.internal:host-gateway" alpine sh -c "cat /etc/hosts; echo '---'; getent hosts host.docker.internal; echo '---'; wget -q -O- --timeout=3 http://host.docker.internal:18899 2>&1 | head -1 || echo 'UNREACHABLE'"

echo ""
echo "=== Without extra_hosts (default) ==="
docker run --rm --network artifacts_arx_network alpine sh -c "cat /etc/hosts | grep host.docker; echo '---'; getent hosts host.docker.internal 2>/dev/null || echo 'unresolvable'"
