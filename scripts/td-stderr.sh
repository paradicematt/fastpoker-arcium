#!/bin/bash
# Get the FULL docker logs for the TD (stdout + stderr)
# The file logs miss errors that go to stderr

echo "=== TD docker logs (last restart, full) ==="
docker logs --since 1m artifacts-arcium-trusted-dealer-1 2>&1

echo ""
echo "=== If TD is running, exec and check ==="
STATE=$(docker inspect --format '{{.State.Status}}' artifacts-arcium-trusted-dealer-1 2>/dev/null)
echo "Current state: $STATE"

if [ "$STATE" = "running" ]; then
    echo "=== Files in /usr/trusted-dealer/ ==="
    docker exec artifacts-arcium-trusted-dealer-1 ls -la /usr/trusted-dealer/ 2>/dev/null
    echo ""
    echo "=== TD config inside container ==="
    docker exec artifacts-arcium-trusted-dealer-1 cat /usr/trusted-dealer/trusted_dealer_config.toml 2>/dev/null
fi
