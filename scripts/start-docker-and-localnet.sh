#!/bin/bash
set -e
LOG="/mnt/j/Poker-Arc/localnet-start.log"
exec > "$LOG" 2>&1

echo "=== Starting Docker ==="
if ! pgrep -x dockerd > /dev/null; then
    sudo dockerd > /tmp/dockerd.log 2>&1 &
    sleep 3
    echo "Docker started"
else
    echo "Docker already running"
fi
docker ps --format "{{.Names}}" 2>/dev/null | head -5 || echo "No containers"

echo ""
echo "=== Starting Arcium Localnet ==="
# This calls the existing start script
bash /mnt/j/Poker-Arc/scripts/start-arcium-localnet.sh 2>&1

echo ""
echo "=== Localnet startup complete ==="
