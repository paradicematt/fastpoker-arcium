#!/bin/bash
# Build Arcium encrypted-ixs (MPC circuits)
# Run: wsl bash /mnt/j/Poker-Arc/scripts/build-circuits.sh
#
# IMPORTANT: Two separate toolchains required:
#   - encrypted-ixs:  nightly Rust (arcis-interpreter needs Span::local_file)
#   - Anchor program: Solana BPF compiler (cargo-build-sbf, uses rustc 1.79.0-dev)
# They CANNOT be built with a single `arcium test` command.
# Build them separately: this script for circuits, build-anchor.sh for the program.
set -e

source ~/.cargo/env 2>/dev/null || true
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/releases/2.1.21/solana-release/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

PROJECT_SRC="/mnt/j/Poker-Arc"
BUILD_DIR="$HOME/poker-arc-build"

echo "=== Building Arcium encrypted-ixs (MPC circuits) ==="

# Copy source to native Linux filesystem (NTFS has permission issues with cargo)
echo "Syncing to Linux filesystem..."
rsync -a --delete --exclude='target' --exclude='node_modules' --exclude='.git' "$PROJECT_SRC/" "$BUILD_DIR/"

cd "$BUILD_DIR"

# Pin time crate if needed (Arcium 0.8.5 pulls in time 0.3.47 which needs Rust 1.88)
cargo update time --precise 0.3.36 2>/dev/null || true

# Build encrypted-ixs with nightly (arcis-interpreter needs Span::local_file)
echo "Building with nightly toolchain..."
RUSTUP_TOOLCHAIN=nightly cargo build -p encrypted-ixs 2>&1

# Copy Cargo.lock back (preserves pinned versions)
cp "$BUILD_DIR/Cargo.lock" "$PROJECT_SRC/Cargo.lock" 2>/dev/null || true

echo "=== Circuit build complete ==="
echo ""
echo "To build the Anchor program, run:"
echo "  wsl bash /mnt/j/Poker-Arc/build-anchor.sh"
