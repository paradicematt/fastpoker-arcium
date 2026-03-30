#!/bin/bash
export PATH="/root/.nvm/versions/node/v20.20.1/bin:/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:/usr/bin:/bin"

# Kill old crank and test
pkill -f crank-service 2>/dev/null
pkill -f e2e-rake-cap 2>/dev/null
tmux kill-session -t crank 2>/dev/null
sleep 2

# Start crank in tmux
tmux new-session -d -s crank "export PATH=/root/.nvm/versions/node/v20.20.1/bin:/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:/usr/bin:/bin && cd /mnt/j/Poker-Arc/backend && LOCAL_MODE=true ARCIUM_CLUSTER_OFFSET=0 npx ts-node --transpile-only crank-service.ts 2>&1 | tee /tmp/crank.log"
sleep 8

# Run rake cap test
cd /mnt/j/Poker-Arc/backend
ARCIUM_CLUSTER_OFFSET=0 npx ts-node --transpile-only e2e-rake-cap-test.ts 2>&1
