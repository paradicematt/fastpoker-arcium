#!/bin/bash
export PATH="/root/.nvm/versions/node/v20.20.1/bin:/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:/usr/bin:/bin"

# Start crank in tmux
tmux kill-session -t crank 2>/dev/null
tmux new-session -d -s crank "export PATH=/root/.nvm/versions/node/v20.20.1/bin:/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:/usr/bin:/bin && cd /mnt/j/Poker-Arc/backend && LOCAL_MODE=true ARCIUM_CLUSTER_OFFSET=0 npx ts-node --transpile-only crank-service.ts 2>&1 | tee /tmp/crank.log"

sleep 5
echo "Crank tmux session started"
tmux ls
tail -5 /tmp/crank.log
