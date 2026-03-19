#!/bin/bash
set -e
source ~/.cargo/env
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
echo "=== Building Steel program ==="
cd /mnt/j/Poker/contracts
cargo build-sbf --sbf-out-dir ./target/deploy
echo "=== Done ==="
ls -la target/deploy/poker_program.so
