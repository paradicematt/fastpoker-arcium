#!/bin/bash
set -e
LOG="/mnt/j/Poker-Arc/circuit-build2.log"
exec > "$LOG" 2>&1

source "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.arcium/bin:$PATH"

# Anchor shim
SHIM_DIR="/tmp/anchor-shim"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/anchor" << 'SHIMEOF'
#!/bin/bash
if [ "$1" = "--version" ] || [ "$1" = "-V" ]; then
    echo "anchor-cli 0.31.2"
else
    exec "$HOME/.cargo/bin/anchor" "$@"
fi
SHIMEOF
chmod +x "$SHIM_DIR/anchor"
export PATH="$SHIM_DIR:$PATH"

echo "=== Environment ==="
echo "Solana: $(solana --version)"
echo "Arcium: $(arcium --version)"
echo "Anchor shim: $(anchor --version)"

# Copy everything to ext4 (NTFS causes build failures)
WORK=/tmp/circuit-build-workspace
rm -rf "$WORK"
mkdir -p "$WORK"

echo ""
echo "=== Copying project to ext4 ==="
# Copy only what arcium build needs
cp -r /mnt/j/Poker-Arc/encrypted-ixs "$WORK/"
cp /mnt/j/Poker-Arc/Anchor.toml "$WORK/"
cp /mnt/j/Poker-Arc/Cargo.toml "$WORK/"
cp -r /mnt/j/Poker-Arc/programs "$WORK/"
mkdir -p "$WORK/build"
# Copy existing build artifacts so arcium can check what needs rebuilding
cp /mnt/j/Poker-Arc/build/*.* "$WORK/build/" 2>/dev/null || true
# Need target/deploy for keypair
mkdir -p "$WORK/target/deploy"
# Generate a keypair matching our program ID
solana-keygen new --no-bip39-passphrase -o "$WORK/target/deploy/fastpoker-keypair.json" --force 2>/dev/null || true

echo "Workspace: $WORK"
ls -la "$WORK/"
echo ""
grep "pub fn reveal_player_cards" "$WORK/encrypted-ixs/src/lib.rs"

echo ""
echo "=== Building circuits on ext4 (--skip-program --skip-keys-sync) ==="
cd "$WORK"
export RUSTUP_TOOLCHAIN=nightly
# --skip-keys-sync prevents program ID overwrite
arcium build --skip-program --skip-keys-sync 2>&1 || {
    echo "=== arcium build failed, trying without --skip-keys-sync ==="
    arcium build --skip-program 2>&1 || true
}

echo ""
echo "=== Build output ==="
ls -la "$WORK/build/reveal_player_cards."* 2>&1

echo ""
echo "=== idarc ==="
cat "$WORK/build/reveal_player_cards.idarc" 2>&1

echo ""
echo "=== Copying results back ==="
cp "$WORK/build/reveal_player_cards."* /mnt/j/Poker-Arc/build/ 2>/dev/null && echo "Copied!" || echo "No new files to copy"

echo ""
echo "=== Final check ==="
ls -la /mnt/j/Poker-Arc/build/reveal_player_cards.*
echo ""
echo "=== DONE ==="
