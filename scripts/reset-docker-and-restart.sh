#!/bin/bash
# Full Docker reset + localnet restart
set -e

source ~/.cargo/env 2>/dev/null || true
export PATH="$HOME/.local/share/solana/install/releases/2.1.21/solana-release/bin:$HOME/.avm/bin:$HOME/.cargo/bin:/usr/bin:/usr/local/bin:$PATH"

echo "=== Step 1: Kill everything ==="
pkill -f solana-test-validator 2>/dev/null || true
pkill -f 'arcium localnet' 2>/dev/null || true
docker ps -aq 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
sleep 1

echo "=== Step 2: Prune Docker networks ==="
docker network prune -f 2>/dev/null || true

echo "=== Step 3: Restart Docker daemon ==="
sudo service docker restart
sleep 3
docker info --format '{{.ServerVersion}}' 2>/dev/null
echo "Docker restarted"

echo "=== Step 4: Verify clean state ==="
docker ps -a 2>/dev/null
docker network ls 2>/dev/null
echo ""

echo "=== Step 5: Verify iptables clean ==="
# Make sure no stale DNAT rules
sudo iptables -t nat -L PREROUTING -n 2>/dev/null | grep -v "^Chain\|^target\|DOCKER" || echo "  No custom NAT rules (good)"
echo "route_localnet=$(cat /proc/sys/net/ipv4/conf/all/route_localnet)"

echo ""
echo "=== Ready to start localnet ==="
