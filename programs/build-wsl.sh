#!/bin/bash
set -e

# Source cargo environment
source ~/.cargo/env

# Use stable Rust
echo "Using stable Rust..."
rustup default stable

# Install Solana CLI 3.1.x (ships with rustc 1.81+)
echo "Installing Solana CLI 3.1.8..."
sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.8/install)" || true

# Add solana to path
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Show versions
echo "Rust version: $(rustc --version)"
echo "Cargo version: $(cargo --version)"
echo "Solana version: $(solana --version)"

# Navigate to program
cd /mnt/j/Poker/programs/fastpoker

# Clean lockfile
rm -f Cargo.lock 2>/dev/null || true

# Generate lockfile
echo "Generating Cargo.lock..."
cargo generate-lockfile

# Pin problematic crates to avoid edition2024 and rustc 1.81 issues
echo "Pinning problematic crates..."
cargo update -p blake3 --precise 1.5.5 || echo "blake3 pin failed"
cargo update -p constant_time_eq --precise 0.3.1 || echo "constant_time_eq pin failed"
cargo update -p num_enum --precise 0.7.3 || echo "num_enum pin failed"
cargo update -p num_enum_derive --precise 0.7.3 || echo "num_enum_derive pin failed"
cargo update -p proc-macro-crate@3.4.0 --precise 3.1.0 || echo "proc-macro-crate pin failed"
cargo update -p hashbrown@0.15.2 --precise 0.15.0 || echo "hashbrown pin failed"

# Pin solana crates to versions compatible with rustc 1.79.0-dev
echo "Pinning solana crates for rustc 1.79 compatibility..."
cargo update -p five8_core --precise 0.1.1 || echo "five8_core pin failed"
cargo update -p solana-program --precise 2.1.0 || echo "solana-program pin failed"
cargo update -p solana-pubkey@3.0.0 --precise 2.1.0 || echo "solana-pubkey@3 pin failed"
cargo update -p solana-pubkey@4.0.0 --precise 2.1.0 || echo "solana-pubkey@4 pin failed"
cargo update -p solana-hash@3.1.0 --precise 2.1.0 || echo "solana-hash@3 pin failed"
cargo update -p solana-hash@4.1.0 --precise 2.1.0 || echo "solana-hash@4 pin failed"
cargo update -p solana-address@1.1.0 --precise 1.0.0 || echo "solana-address@1 pin failed"
cargo update -p solana-address@2.1.0 --precise 1.0.0 || echo "solana-address@2 pin failed"
cargo update -p solana-instruction-error --precise 2.0.0 || echo "solana-instruction-error pin failed"
cargo update -p solana-program-entrypoint --precise 2.1.0 || echo "solana-program-entrypoint pin failed"
cargo update -p solana-program-error --precise 2.1.0 || echo "solana-program-error pin failed"
cargo update -p solana-sanitize --precise 2.1.0 || echo "solana-sanitize pin failed"
cargo update -p solana-system-interface --precise 1.0.0 || echo "solana-system-interface pin failed"

# Build
echo "Building with cargo build-sbf..."
cargo build-sbf --sbf-out-dir /mnt/j/Poker/target/deploy

echo "Build complete!"
ls -la /mnt/j/Poker/target/deploy/

# Deploy to devnet
echo ""
echo "Deploying to devnet..."
solana program deploy /mnt/j/Poker/target/deploy/fastpoker.so \
  --program-id FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR \
  -u devnet \
  --keypair /mnt/j/critters/mini-game/deployer-keypair.json

echo "Deploy complete!"
solana program show FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR -u devnet
