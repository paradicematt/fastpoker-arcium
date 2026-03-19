#!/bin/bash
set -e

# Source cargo environment
source ~/.cargo/env

# Use Rust 1.86.0 (1.93+ has ctrlc handler panic on WSL)
echo "Using Rust 1.86.0 (WSL-compatible)..."
rustup install 1.86.0 --no-self-update 2>/dev/null || true
rustup default 1.86.0

# Install Solana CLI 2.1.x if needed
echo "Checking Solana CLI..."
if ! command -v solana &> /dev/null || ! solana --version | grep -q "2.1"; then
    echo "Installing Solana CLI 2.1.21..."
    sh -c "$(curl -sSfL https://release.anza.xyz/v2.1.21/install)"
fi

# Add solana to path
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"

# Show versions
echo "Rust version: $(rustc --version)"
echo "Cargo version: $(cargo --version)"
echo "Solana version: $(solana --version)"

cd /mnt/j/Poker-Arc/programs/fastpoker

# Clean lockfile to avoid version 4 issues
rm -f Cargo.lock 2>/dev/null || true

# Generate fresh lockfile
echo "Generating Cargo.lock..."
cargo generate-lockfile

# Pin problematic crates for rustc 1.79 compatibility
echo "Pinning problematic crates..."

# Pin newer solana crates down to 2.x versions (compatible with rustc 1.79.0-dev)
cargo update -p solana-program@3.0.0 --precise 2.3.0 2>/dev/null || true
cargo update -p solana-program@4.0.0 --precise 2.3.0 2>/dev/null || true
cargo update -p solana-msg@3.0.0 --precise 2.2.1 2>/dev/null || true
cargo update -p solana-hash@3.1.0 --precise 2.3.0 2>/dev/null || true
cargo update -p solana-hash@4.1.0 --precise 2.3.0 2>/dev/null || true
cargo update -p solana-hash@4.2.0 --precise 2.3.0 2>/dev/null || true
cargo update -p solana-pubkey@3.0.0 --precise 2.4.0 2>/dev/null || true
cargo update -p solana-pubkey@4.0.0 --precise 2.4.0 2>/dev/null || true
cargo update -p solana-pubkey@4.1.0 --precise 2.4.0 2>/dev/null || true
cargo update -p solana-sanitize@3.0.1 --precise 2.2.1 2>/dev/null || true
cargo update -p solana-instruction-error@2.1.0 --precise 2.0.0 2>/dev/null || true
cargo update -p solana-program-error@3.0.0 --precise 2.2.2 2>/dev/null || true
cargo update -p solana-program-entrypoint@3.1.1 --precise 2.3.0 2>/dev/null || true
cargo update -p solana-system-interface@2.0.0 --precise 1.0.0 2>/dev/null || true
cargo update -p solana-system-interface@3.0.0 --precise 1.0.0 2>/dev/null || true
cargo update -p solana-address@1.1.0 --precise 1.0.0 2>/dev/null || true
cargo update -p solana-address@2.1.0 --precise 1.0.0 2>/dev/null || true
cargo update -p solana-address@2.2.0 --precise 1.0.0 2>/dev/null || true
cargo update -p solana-sysvar@4.0.0 --precise 2.3.0 2>/dev/null || true
cargo update -p solana-rent@4.0.0 --precise 2.2.1 2>/dev/null || true
cargo update -p solana-example-mocks@4.0.0 --precise 2.2.1 2>/dev/null || true
cargo update -p solana-fee-calculator@3.1.0 --precise 2.2.1 2>/dev/null || true
cargo update -p solana-nonce@3.1.0 --precise 2.2.1 2>/dev/null || true

# Pin five8 crates down (require rustc 1.81+)
cargo update -p five8_core@1.0.0 --precise 0.1.2 2>/dev/null || true
cargo update -p five8@1.0.0 --precise 0.2.1 2>/dev/null || true
cargo update -p five8_const@1.0.0 --precise 0.1.4 2>/dev/null || true

# Pin proc-macro-crate FIRST (3.5.0 needs indexmap>=2.11.4 via toml_edit, 3.2.0 doesn't)
cargo update -p proc-macro-crate@3.5.0 --precise 3.2.0 2>/dev/null || true

# Pin indexmap AFTER proc-macro-crate (2.13.0 needs rustc 1.82, SBF has 1.79)
cargo update -p indexmap@2.13.0 --precise 2.7.1 2>/dev/null || true

# Pin other problematic crates
cargo update -p constant_time_eq@0.4.2 --precise 0.3.1 2>/dev/null || true
cargo update -p base64ct --precise 1.6.0 2>/dev/null || true
cargo update -p blake3 --precise 1.5.5 2>/dev/null || true
cargo update -p hashbrown@0.15.2 --precise 0.15.0 2>/dev/null || true

echo "Building with cargo-build-sbf..."
# SKIP_BLS=1 (default for localnet): skip BLS verification in callbacks.
# SKIP_BLS=0 or unset for production: enable BLS signature verification.
if [ "${SKIP_BLS:-1}" = "1" ]; then
    echo "  Features: skip-bls (localnet mode)"
    cargo-build-sbf -- --features skip-bls
else
    echo "  Features: none (production mode — BLS enabled)"
    cargo-build-sbf
fi

echo "Build complete!"
# Copy output to workspace-level target/deploy for easy access
# cargo-build-sbf outputs to target/sbf-solana-solana/release/, not target/deploy/
mkdir -p /mnt/j/Poker-Arc/target/deploy/
SBF_SO="/mnt/j/Poker-Arc/target/sbf-solana-solana/release/fastpoker.so"
if [ -f "$SBF_SO" ]; then
    cp "$SBF_SO" /mnt/j/Poker-Arc/target/deploy/fastpoker.so
else
    # Fallback: check program-local target
    cp /mnt/j/Poker-Arc/programs/fastpoker/target/deploy/fastpoker.so /mnt/j/Poker-Arc/target/deploy/fastpoker.so 2>/dev/null || true
fi
echo "Copied .so to workspace target/deploy/"
ls -la /mnt/j/Poker-Arc/target/deploy/
