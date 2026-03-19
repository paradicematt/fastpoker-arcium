#!/bin/bash
# Build STEEL program .so
set -e
source ~/.bashrc 2>/dev/null || true
source ~/.cargo/env 2>/dev/null || true
export PATH="/home/user/.local/share/solana/install/releases/3.1.8/solana-release/bin:$HOME/.cargo/bin:$PATH"

SRC="/mnt/j/Poker-Arc/contracts"
BUILD="$HOME/steel-build"

echo "Building STEEL program..."
mkdir -p "$BUILD"
cp -r "$SRC/api" "$BUILD/"
cp -r "$SRC/program" "$BUILD/"
cp "$SRC/Cargo.toml" "$BUILD/"

cd "$BUILD"
cargo-build-sbf --manifest-path program/Cargo.toml

echo "Copying .so back..."
cp "$BUILD/target/deploy/poker_program.so" "$SRC/target/deploy/poker_program.so"
echo "STEEL build complete: $SRC/target/deploy/poker_program.so"
