#!/bin/bash
# Start local Solana validator with STEEL + FastPoker programs preloaded
# Run: wsl bash /mnt/j/Poker-Arc/scripts/start-local-validator.sh
set -e

source ~/.cargo/env 2>/dev/null || true
export SOLANA_3="/home/user/.local/share/solana/install/releases/3.1.8/solana-release/bin"
export PATH="$HOME/.cargo/bin:$SOLANA_3:$HOME/.local/share/solana/install/active_release/bin:$PATH"

PROJECT="/mnt/j/Poker-Arc"
BUILD_DIR="$HOME/poker-arc-build"

STEEL_SO="$PROJECT/contracts/target/deploy/poker_program.so"
STEEL_ID="9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6"

FASTPOKER_SO="$BUILD_DIR/target/deploy/fastpoker.so"
FASTPOKER_ID="BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N"

# Check .so files exist
if [ ! -f "$STEEL_SO" ]; then
    echo "ERROR: STEEL .so not found at $STEEL_SO"
    echo "Copy from original project or build with: cd contracts && cargo-build-sbf"
    exit 1
fi

if [ ! -f "$FASTPOKER_SO" ]; then
    echo "ERROR: FastPoker .so not found at $FASTPOKER_SO"
    echo "Build with: wsl bash /mnt/j/Poker-Arc/scripts/build-all.sh program"
    exit 1
fi

echo "Starting local Solana validator..."
echo "  STEEL:     $STEEL_ID"
echo "  FastPoker: $FASTPOKER_ID"
echo ""

# Kill any existing validator
pkill -f solana-test-validator 2>/dev/null || true
sleep 1

solana-test-validator \
    --reset \
    --bpf-program "$STEEL_ID" "$STEEL_SO" \
    --bpf-program "$FASTPOKER_ID" "$FASTPOKER_SO" \
    --ledger "$HOME/.config/solana/test-ledger" \
    --rpc-port 8899
