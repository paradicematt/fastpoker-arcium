#!/bin/bash
set -e
source ~/.cargo/env
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

echo "=== Versions ==="
rustc --version
solana --version

echo "=== Building (preserving existing Cargo.lock) ==="
cd /mnt/j/Poker/programs/fastpoker
cargo build-sbf --sbf-out-dir /mnt/j/Poker/target/deploy

echo "=== Build complete ==="
ls -la /mnt/j/Poker/target/deploy/fastpoker.so
