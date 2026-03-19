#!/bin/bash
echo "Killing arcium processes..."
pkill -9 -f 'arcium localnet' 2>/dev/null || true
pkill -9 -f solana-test-validator 2>/dev/null || true
echo "Removing Docker containers..."
docker ps -aq | xargs -r docker rm -f 2>/dev/null || true
sleep 2
echo "All cleaned"
