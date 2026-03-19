#!/bin/bash
set -e
LOG="/mnt/j/Poker-Arc/circuit-build.log"
exec > "$LOG" 2>&1

source "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.arcium/bin:/tmp/anchor-shim:$PATH"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

echo "=== Environment ==="
echo "Solana: $(solana --version 2>&1 || echo 'NOT FOUND')"
echo "Arcium: $(arcium --version 2>&1 || echo 'NOT FOUND')"
echo "Anchor shim: $(/tmp/anchor-shim/anchor --version 2>&1 || echo 'NOT FOUND')"

# Install arcium if needed
if ! command -v arcium &>/dev/null; then
    echo ""
    echo "=== Installing Arcium CLI ==="
    curl -sSfL https://install.arcium.com | bash
    export PATH="$HOME/.arcium/bin:$PATH"
    echo "=== Installing v0.9.2 ==="
    arcup install 0.9.2
    echo "Arcium: $(arcium --version)"
fi

# Setup anchor shim
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

echo ""
echo "=== Workspace ==="
mkdir -p /tmp/poker-arc-workspace
cd /tmp/poker-arc-workspace
ln -sf /mnt/j/Poker-Arc/encrypted-ixs .
ln -sf /mnt/j/Poker-Arc/Anchor.toml .
ln -sf /mnt/j/Poker-Arc/Cargo.toml .
ln -sf /mnt/j/Poker-Arc/programs .
ln -sf /mnt/j/Poker-Arc/build .
echo "pwd: $(pwd)"
grep "pub fn reveal_player_cards" encrypted-ixs/src/lib.rs

echo ""
echo "=== Building circuits ==="
export RUSTUP_TOOLCHAIN=nightly
arcium build --skip-program || true

echo ""
echo "=== Check output ==="
ls -la /mnt/j/Poker-Arc/build/reveal_player_cards.* 2>&1
echo ""
echo "idarc:"
cat /mnt/j/Poker-Arc/build/reveal_player_cards.idarc 2>&1
echo ""
echo "=== DONE ==="
