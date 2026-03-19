#!/bin/bash
# Comprehensive build script for FastPoker-Arc
# Run: wsl bash /mnt/j/Poker-Arc/scripts/build-all.sh [circuits|program|all]
set -e

source ~/.cargo/env 2>/dev/null || true
export SOLANA_3="/home/user/.local/share/solana/install/releases/3.1.8/solana-release/bin"
export PATH="$HOME/.cargo/bin:$SOLANA_3:$HOME/.local/share/solana/install/active_release/bin:$PATH"

PROJECT_SRC="/mnt/j/Poker-Arc"
BUILD_DIR="$HOME/poker-arc-build"
MODE="${1:-all}"

echo "================================================"
echo "FastPoker-Arc Build (mode: $MODE)"
echo "================================================"

# Sync source to native Linux FS (NTFS has cargo permission issues)
echo "[1/4] Syncing to Linux filesystem..."
rsync -a --delete --exclude='target' --exclude='node_modules' --exclude='.git' --exclude='build' "$PROJECT_SRC/" "$BUILD_DIR/"
cd "$BUILD_DIR"

# Pin time crate if needed
cargo update time --precise 0.3.36 2>/dev/null || true

if [ "$MODE" = "circuits" ] || [ "$MODE" = "all" ]; then
    echo ""
    echo "[2/4] Building encrypted-ixs (MPC circuits) with nightly..."
    echo "  Toolchain: nightly (arcis-interpreter needs Span::local_file)"
    RUSTUP_TOOLCHAIN=nightly arcium build --skip-program 2>&1 | tail -5
    echo "  ✓ Circuit artifacts generated (.arcis, .idarc, .hash, .ts)"
fi

if [ "$MODE" = "program" ] || [ "$MODE" = "all" ]; then
    echo ""
    echo "[3/4] Building fastpoker program (BPF)..."
    echo "  Toolchain: Solana 3.1.8 BPF (rustc 1.89.0)"
    echo "  NOTE: Using cargo-build-sbf directly (arcium build triggers session-keys IDL conflict)"
    cargo-build-sbf --manifest-path programs/fastpoker/Cargo.toml 2>&1 | tail -5
    echo "  ✓ Program BPF build complete"
fi

# Copy artifacts back
echo ""
echo "[4/4] Syncing build artifacts back..."
cp "$BUILD_DIR/Cargo.lock" "$PROJECT_SRC/Cargo.lock" 2>/dev/null || true
if [ -d "$BUILD_DIR/build" ]; then
    mkdir -p "$PROJECT_SRC/build"
    cp -r "$BUILD_DIR/build/"* "$PROJECT_SRC/build/" 2>/dev/null || true
fi

echo ""
echo "================================================"
echo "Build complete!"
echo ""
echo "Workspace: $PROJECT_SRC"
echo "Build dir: $BUILD_DIR"
echo ""
echo "Key info:"
echo "  - Circuits: nightly Rust (encrypted-ixs/)"
echo "  - Program:  Solana 3.1.8 BPF (programs/fastpoker/)"
echo "  - Artifacts: build/ (.arcis, .idarc, .hash, .ts)"
echo ""
echo "Next steps:"
echo "  - Mock test:  ARCIUM_MOCK=true (use devnet_bypass_deal)"
echo "  - Local MPC:  solana-test-validator + docker compose + arcium deploy"
echo "  - Devnet:     arcium deploy --cluster-offset 456 -u d"
echo "================================================"
