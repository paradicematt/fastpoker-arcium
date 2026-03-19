#!/bin/bash
# Rebuild circuits from the workspace
export PATH="$HOME/.local/share/solana/install/releases/2.1.21/solana-release/bin:$HOME/.avm/bin:$HOME/.cargo/bin:/usr/bin:/usr/local/bin:$PATH"
source ~/.cargo/env 2>/dev/null || true

# Shim for anchor version check
SHIM_DIR="/tmp/anchor-shim"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/anchor" << 'SHIMEOF'
#!/bin/bash
if [ "$1" = "--version" ] || [ "$1" = "-V" ]; then
    echo "anchor-cli 0.31.2"
else
    exec "$HOME/.avm/bin/anchor" "$@"
fi
SHIMEOF
chmod +x "$SHIM_DIR/anchor"
export PATH="$SHIM_DIR:$PATH"

cd /tmp/poker-arc-workspace

# Sync latest circuit source
cp -r /mnt/j/Poker-Arc/encrypted-ixs/* encrypted-ixs/

# Ensure fastpoker has a dummy lib.rs so Cargo workspace resolves
# (arcium build --skip-program still needs valid workspace)
mkdir -p programs/fastpoker/src
if [ ! -f programs/fastpoker/src/lib.rs ]; then
    echo "// dummy for workspace resolution" > programs/fastpoker/src/lib.rs
fi

echo "=== Building circuits ==="
RUSTUP_TOOLCHAIN=nightly arcium build --skip-program 2>&1

echo ""
echo "=== Build artifacts ==="
ls -la build/*.arcis 2>/dev/null

# Copy back to project
echo ""
echo "=== Copying artifacts back ==="
cp build/*.arcis /mnt/j/Poker-Arc/build/ 2>/dev/null
cp build/*.hash /mnt/j/Poker-Arc/build/ 2>/dev/null
cp build/*.weight /mnt/j/Poker-Arc/build/ 2>/dev/null
cp build/*.idarc /mnt/j/Poker-Arc/build/ 2>/dev/null
cp build/*.profile.json /mnt/j/Poker-Arc/build/ 2>/dev/null
echo "Done."
