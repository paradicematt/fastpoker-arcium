#!/bin/bash
echo "=== Docker daemon ==="
docker info 2>&1 | head -15

echo ""
echo "=== Docker Root Dir ==="
docker info 2>&1 | grep 'Docker Root Dir'

echo ""
echo "=== Docker storage ==="
docker info 2>&1 | grep -E 'Storage|Backing'

echo ""
echo "=== Docker images ==="
docker images | grep -E 'arx-node|trusted-dealer'

echo ""
echo "=== Validator running? ==="
curl -s -m 2 http://localhost:8899 -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null || echo "NO VALIDATOR"

echo ""
echo "=== /var/lib/docker exists? ==="
ls -la /var/lib/docker/ 2>/dev/null | head -5 || echo "NOT FOUND"

echo ""
echo "=== What was deleted/moved? ==="
echo "Checking apt/dpkg logs for recent removals:"
grep -i "remove\|purge" /var/log/dpkg.log 2>/dev/null | tail -20 || echo "No dpkg log"

echo ""
echo "=== Snap/conda/large dirs ==="
du -sh /usr/local/lib/ /opt/ /snap/ /var/cache/ 2>/dev/null || true
