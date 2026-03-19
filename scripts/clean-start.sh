#!/bin/bash
# Kill everything cleanly
pkill -f solana-test-validator 2>/dev/null || true
pkill -f "arcium localnet" 2>/dev/null || true
docker ps -aq 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
sleep 2
echo "All processes killed, containers removed"
