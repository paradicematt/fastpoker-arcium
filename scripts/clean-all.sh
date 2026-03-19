#!/bin/bash
pkill -f solana-test-validator 2>/dev/null
pkill -f "arcium localnet" 2>/dev/null
docker ps -aq 2>/dev/null | xargs -r docker rm -f 2>/dev/null
# Remove stale loopback aliases from native approach
for ip in 172.20.0.99 172.20.0.100 172.20.0.101 172.20.0.102 172.20.0.103; do
    ip addr del "$ip/32" dev lo 2>/dev/null
done
sleep 1
echo "Clean"
