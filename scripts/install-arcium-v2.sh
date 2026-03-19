#!/bin/bash
set -e
source "$HOME/.cargo/env"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

echo "Solana: $(solana --version)"
echo "Node: $(node --version)"
echo "Anchor: $(anchor --version)"
echo "Yarn: $(yarn --version)"

echo ""
echo "=== Installing Arcium CLI ==="
curl -sSfL https://install.arcium.com | bash

echo ""
echo "=== Installing Arcium 0.8.5 ==="
export PATH="$HOME/.arcium/bin:$PATH"
arcup install 0.8.5
arcium --version

echo ""
echo "=== Setting up Anchor shim ==="
SHIM_DIR="/tmp/anchor-shim"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/anchor" << 'SHIMEOF'
#!/bin/bash
REAL_ANCHOR="$HOME/.avm/bin/anchor"
[ ! -x "$REAL_ANCHOR" ] && REAL_ANCHOR="$HOME/.cargo/bin/anchor"
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
echo "Shim version: $($SHIM_DIR/anchor --version)"

echo ""
echo "=== Starting Docker ==="
if ! pgrep -x dockerd > /dev/null; then
    dockerd > /tmp/dockerd.log 2>&1 &
    sleep 3
fi
docker --version

echo ""
echo "=== ALL DONE ==="
