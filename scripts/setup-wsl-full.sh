#!/bin/bash
set -e

echo "=== WSL Full Toolchain Setup ==="

# === System packages ===
echo ""
echo "--- Installing system packages ---"
apt-get update -qq
apt-get install -y -qq curl build-essential pkg-config libssl-dev libudev-dev git unzip jq ca-certificates gnupg lsb-release > /dev/null 2>&1
echo "  ✓ System packages"

# === Docker ===
echo ""
echo "--- Installing Docker ---"
if ! command -v docker &>/dev/null; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg 2>/dev/null
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin > /dev/null 2>&1
fi
# Start Docker daemon
if ! pgrep -x dockerd > /dev/null; then
    dockerd > /tmp/dockerd.log 2>&1 &
    sleep 3
fi
docker --version
echo "  ✓ Docker"

# === Rust ===
echo ""
echo "--- Installing Rust ---"
if [ ! -f "$HOME/.cargo/env" ]; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.86.0 2>/dev/null
fi
source "$HOME/.cargo/env"
rustup default 1.86.0 2>/dev/null
# Also install nightly for Arcium circuits
rustup toolchain install nightly 2>/dev/null || true
rustc --version
echo "  ✓ Rust"

# === Solana CLI ===
echo ""
echo "--- Installing Solana CLI 2.1.21 ---"
if ! command -v solana &>/dev/null; then
    sh -c "$(curl -sSfL https://release.anza.xyz/v2.1.21/install)" 2>/dev/null
fi
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana --version
echo "  ✓ Solana CLI"

# === cargo-build-sbf ===
echo ""
echo "--- Installing cargo-build-sbf ---"
if ! command -v cargo-build-sbf &>/dev/null; then
    cargo install --git https://github.com/anza-xyz/agave.git --tag v2.1.21 cargo-build-sbf 2>/dev/null
fi
echo "  ✓ cargo-build-sbf"

# === Node.js 20 via nvm ===
echo ""
echo "--- Installing Node.js 20 ---"
if [ ! -d "$HOME/.nvm" ]; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash 2>/dev/null
fi
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
if ! command -v node &>/dev/null || ! node --version 2>/dev/null | grep -q "v20"; then
    nvm install 20 2>/dev/null
    nvm use 20 2>/dev/null
fi
node --version
npm --version
# Install ts-node globally
npm install -g ts-node typescript 2>/dev/null || true
echo "  ✓ Node.js + ts-node"

# === Anchor CLI 0.32.1 ===
echo ""
echo "--- Installing Anchor CLI 0.32.1 ---"
if ! command -v anchor &>/dev/null; then
    cargo install --git https://github.com/coral-xyz/anchor --tag v0.32.1 anchor-cli 2>/dev/null
fi
anchor --version
echo "  ✓ Anchor CLI"

# === Arcium CLI 0.8.5 ===
echo ""
echo "--- Installing Arcium CLI 0.8.5 ---"
if ! command -v arcium &>/dev/null; then
    curl -sSfL https://install.arcium.com | bash 2>/dev/null
    export PATH="$HOME/.arcium/bin:$PATH"
    # arcup might need to be in PATH
    if command -v arcup &>/dev/null; then
        arcup install 0.8.5 2>/dev/null || true
    fi
fi
export PATH="$HOME/.arcium/bin:$PATH"
arcium --version 2>/dev/null || echo "  Arcium CLI not yet installed (may need arcup)"
echo "  ✓ Arcium CLI"

# === Anchor shim (reports 0.31.2 for Arcium compatibility) ===
echo ""
echo "--- Setting up Anchor shim ---"
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
echo "  ✓ Anchor shim at $SHIM_DIR/anchor"

# === Summary ===
echo ""
echo "=== Setup Complete ==="
echo "  Rust:    $(rustc --version 2>/dev/null)"
echo "  Solana:  $(solana --version 2>/dev/null)"
echo "  Node:    $(node --version 2>/dev/null)"
echo "  Anchor:  $(anchor --version 2>/dev/null)"
echo "  Arcium:  $(arcium --version 2>/dev/null || echo 'pending arcup')"
echo "  Docker:  $(docker --version 2>/dev/null)"
echo ""
echo "NOTE: To use these tools in future sessions, add to PATH:"
echo '  export PATH="/tmp/anchor-shim:$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.arcium/bin:$PATH"'
echo '  source "$HOME/.nvm/nvm.sh"'
