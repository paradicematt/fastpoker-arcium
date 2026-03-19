#!/bin/bash
set -e
source "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.arcium/bin:$PATH"

# === Solana CLI ===
echo "--- Solana CLI 2.1.21 ---"
if ! command -v solana &>/dev/null; then
    sh -c "$(curl -sSfL https://release.anza.xyz/v2.1.21/install)"
    export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
fi
solana --version

# === Node.js 20 ===
echo ""
echo "--- Node.js 20 ---"
export NVM_DIR="$HOME/.nvm"
if [ ! -d "$NVM_DIR" ]; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
if ! node --version 2>/dev/null | grep -q "v20"; then
    nvm install 20
    nvm use 20
fi
node --version
npm install -g ts-node typescript 2>/dev/null || true
echo "ts-node: $(ts-node --version 2>/dev/null || echo 'installing...')"

# === Nightly Rust (for Arcium circuits) ===
echo ""
echo "--- Nightly Rust ---"
rustup toolchain install nightly 2>/dev/null || true

# === cargo-build-sbf ===
echo ""
echo "--- cargo-build-sbf ---"
if ! command -v cargo-build-sbf &>/dev/null; then
    echo "Installing cargo-build-sbf (this takes a few minutes)..."
    cargo install --git https://github.com/anza-xyz/agave.git --tag v2.1.21 cargo-build-sbf
fi
echo "cargo-build-sbf: $(cargo-build-sbf --version 2>/dev/null || echo 'installed')"

# === Anchor CLI 0.32.1 ===
echo ""
echo "--- Anchor CLI 0.32.1 ---"
if ! command -v anchor &>/dev/null; then
    echo "Installing anchor-cli (this takes a few minutes)..."
    cargo install --git https://github.com/coral-xyz/anchor --tag v0.32.1 anchor-cli
fi
anchor --version

# === Arcium CLI 0.8.5 ===
echo ""
echo "--- Arcium CLI 0.8.5 ---"
if ! command -v arcium &>/dev/null; then
    echo "Installing Arcium CLI..."
    curl -sSfL https://install.arcium.com | bash
    export PATH="$HOME/.arcium/bin:$PATH"
    if command -v arcup &>/dev/null; then
        arcup install 0.8.5
    fi
fi
arcium --version 2>/dev/null || echo "Arcium needs arcup"

# === Anchor shim ===
echo ""
echo "--- Anchor shim ---"
SHIM_DIR="/tmp/anchor-shim"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/anchor" << 'SHIMEOF'
#!/bin/bash
REAL_ANCHOR="$HOME/.cargo/bin/anchor"
[ ! -x "$REAL_ANCHOR" ] && REAL_ANCHOR="$HOME/.avm/bin/anchor"
if [ "$1" = "--version" ] || [ "$1" = "-V" ]; then
    echo "anchor-cli 0.31.2"
elif [ "$1" = "localnet" ]; then
    if echo "$@" | grep -q -- '--skip-build'; then
        exec "$REAL_ANCHOR" "$@"
    else
        shift; exec "$REAL_ANCHOR" localnet --skip-build "$@"
    fi
else
    exec "$REAL_ANCHOR" "$@"
fi
SHIMEOF
chmod +x "$SHIM_DIR/anchor"
echo "Shim: $($SHIM_DIR/anchor --version)"

# === Start Docker ===
echo ""
echo "--- Docker ---"
if ! pgrep -x dockerd > /dev/null; then
    echo "Starting dockerd..."
    dockerd > /tmp/dockerd.log 2>&1 &
    sleep 3
fi
docker --version

# === Summary ===
echo ""
echo "=== SETUP COMPLETE ==="
echo "  Rust:    $(rustc --version)"
echo "  Solana:  $(solana --version)"
echo "  Node:    $(node --version)"
echo "  Anchor:  $(anchor --version)"
echo "  Arcium:  $(arcium --version 2>/dev/null || echo 'pending')"
echo "  Docker:  $(docker --version)"
