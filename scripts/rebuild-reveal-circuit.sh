#!/bin/bash
set -e

# Source environment
source "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.arcium/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

echo "=== Environment ==="
echo "Solana: $(solana --version 2>&1 || echo 'NOT FOUND')"
echo "Rust: $(rustc --version 2>&1 || echo 'NOT FOUND')"
echo "Arcium: $(arcium --version 2>&1 || echo 'NOT FOUND')"

# Install arcium CLI if not found
if ! command -v arcium &>/dev/null; then
    echo ""
    echo "=== Installing Arcium CLI ==="
    curl -sSfL https://install.arcium.com | bash
    export PATH="$HOME/.arcium/bin:$PATH"
    
    echo ""
    echo "=== Installing Arcium 0.9.2 ==="
    arcup install 0.9.2
    echo "Arcium: $(arcium --version)"
fi

# Setup anchor shim (arcium 0.9.2 expects anchor 0.31.2)
SHIM_DIR="/tmp/anchor-shim"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/anchor" << 'SHIMEOF'
#!/bin/bash
REAL_ANCHOR="$HOME/.cargo/bin/anchor"
[ ! -x "$REAL_ANCHOR" ] && REAL_ANCHOR="$(which anchor 2>/dev/null)"
if [ "$1" = "--version" ] || [ "$1" = "-V" ]; then
    echo "anchor-cli 0.31.2"
else
    exec "$REAL_ANCHOR" "$@"
fi
SHIMEOF
chmod +x "$SHIM_DIR/anchor"
export PATH="$SHIM_DIR:$PATH"

echo ""
echo "=== Workspace setup ==="
mkdir -p /tmp/poker-arc-workspace
cd /tmp/poker-arc-workspace
ln -sf /mnt/j/Poker-Arc/encrypted-ixs .
ln -sf /mnt/j/Poker-Arc/Anchor.toml .
ln -sf /mnt/j/Poker-Arc/Cargo.toml .
ln -sf /mnt/j/Poker-Arc/programs .
ln -sf /mnt/j/Poker-Arc/build .

echo "Workspace: $(pwd)"
echo "Circuit source check:"
grep "pub fn reveal_player_cards" encrypted-ixs/src/lib.rs

echo ""
echo "=== Building circuits (--skip-program) ==="
export RUSTUP_TOOLCHAIN=nightly
arcium build --skip-program 2>&1

echo ""
echo "=== Verifying build output ==="
ls -la /mnt/j/Poker-Arc/build/reveal_player_cards.idarc
echo "idarc contents:"
cat /mnt/j/Poker-Arc/build/reveal_player_cards.idarc
echo ""
echo "=== DONE ==="
