#!/bin/bash
set -e

# Source cargo environment
source ~/.cargo/env

# Use stable Rust
echo "Using stable Rust..."
rustup default stable

# Install Solana CLI 2.1.x
echo "Installing Solana CLI 2.1.21..."
sh -c "$(curl -sSfL https://release.anza.xyz/v2.1.21/install)"

# Add solana to path
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Show versions
echo "Rust version: $(rustc --version)"
echo "Cargo version: $(cargo --version)"
echo "Solana version: $(solana --version)"

# Clean (preserve keypair)
cd /mnt/j/Poker/contracts
if [ -f target/deploy/poker_program-keypair.json ]; then
  cp target/deploy/poker_program-keypair.json /tmp/poker_program-keypair.json
fi
rm -rf target Cargo.lock 2>/dev/null || true

# Generate lockfile
echo "Generating Cargo.lock..."
cargo generate-lockfile

# Pin problematic crates - order matters!
echo "Pinning problematic crates..."
cargo update -p blake3 --precise 1.5.5 || echo "blake3 pin failed"
cargo update -p az --precise 1.2.1 || echo "az pin failed"
cargo update -p half --precise 2.4.1 || echo "half pin failed"
# Pin num_enum chain to versions that don't require new indexmap
cargo update -p num_enum --precise 0.7.3 || echo "num_enum pin failed"
cargo update -p num_enum_derive --precise 0.7.3 || echo "num_enum_derive pin failed"
cargo update -p proc-macro-crate@3.4.0 --precise 3.1.0 || echo "proc-macro-crate pin failed"
# Now pin indexmap to version compatible with rustc 1.79
cargo update -p indexmap --precise 2.6.0 || echo "indexmap pin failed"
cargo update -p hashbrown@0.15 --precise 0.15.0 || echo "hashbrown 0.15 pin failed"
cargo update -p hashbrown@0.14 --precise 0.14.7 || echo "hashbrown 0.14 pin failed"

echo "Building with cargo build-sbf..."
cargo build-sbf --sbf-out-dir ./target/deploy

# Skip keypair restoration for fresh v2 deployment
# if [ -f /tmp/poker_program-keypair.json ]; then
#   echo "Restoring saved keypair..."
#   cp /tmp/poker_program-keypair.json target/deploy/poker_program-keypair.json
# fi

echo "Build complete!"
ls -la target/deploy/
