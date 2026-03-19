#!/bin/bash
cd /mnt/j/Poker-Arc/backend
export TS_NODE_COMPILER_OPTIONS='{"types":["node"],"skipLibCheck":true}'
export NODE_PATH=/mnt/j/Poker-Arc/backend/node_modules
# Copy script to backend so ts-node resolves modules from node_modules
cp /mnt/j/Poker-Arc/scripts/arcium-init-circuits.ts /mnt/j/Poker-Arc/backend/_init-circuits-tmp.ts
npx ts-node _init-circuits-tmp.ts
rm -f /mnt/j/Poker-Arc/backend/_init-circuits-tmp.ts
