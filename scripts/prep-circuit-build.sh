#!/bin/bash
# Prepare a temp ext4 workspace for circuit building, build circuits,
# then copy .idarc + .arcis back to NTFS build/ for localnet startup.
set -e
source ~/.cargo/env 2>/dev/null || true

PROJECT="/mnt/j/Poker-Arc"
WORK="/tmp/circuit-build"

# Clean and create workspace
rm -rf "$WORK"
mkdir -p "$WORK"

# Copy what arcium build needs
cp -r "$PROJECT/encrypted-ixs" "$WORK/"
cp "$PROJECT/Cargo.toml" "$WORK/"
cp "$PROJECT/Cargo.lock" "$WORK/" 2>/dev/null || true
cp "$PROJECT/Anchor.toml" "$WORK/"
cp "$PROJECT/Arcium.toml" "$WORK/"

# Minimal program stub (arcium build parses Anchor workspace)
mkdir -p "$WORK/programs/fastpoker/src"
cp "$PROJECT/programs/fastpoker/Cargo.toml" "$WORK/programs/fastpoker/" 2>/dev/null || true
cat > "$WORK/programs/fastpoker/src/lib.rs" << 'EOF'
use anchor_lang::prelude::*;
declare_id!("BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N");
EOF

mkdir -p "$WORK/target/deploy"
cp "$PROJECT/target/deploy/"*.so "$WORK/target/deploy/" 2>/dev/null || true

# Build circuits
cd "$WORK"
RUSTUP_TOOLCHAIN=nightly arcium build --skip-program 2>&1

# Copy results back to NTFS
echo ""
echo "=== Copying build artifacts to NTFS ==="
mkdir -p "$PROJECT/build"
cp "$WORK/build/"*.arcis "$PROJECT/build/" 2>/dev/null || true
cp "$WORK/build/"*.idarc "$PROJECT/build/" 2>/dev/null || true
cp "$WORK/build/"*.arcis.ir "$PROJECT/build/" 2>/dev/null || true
ls -la "$PROJECT/build/"*.arcis "$PROJECT/build/"*.idarc 2>/dev/null
echo "=== Done ==="
