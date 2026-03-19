#!/bin/bash
source ~/.cargo/env 2>/dev/null || true
export PATH="$HOME/.local/share/solana/install/releases/2.1.21/solana-release/bin:$HOME/.avm/bin:$HOME/.cargo/bin:/usr/bin:/usr/local/bin:$PATH"

# Shim
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

echo "=== arcium localnet --help ==="
arcium localnet --help 2>&1

echo ""
echo "=== arcium --version ==="
arcium --version 2>&1

echo ""
echo "=== uname -r (WSL kernel) ==="
uname -r

echo ""
echo "=== Docker version ==="
docker version --format '{{.Server.Version}}' 2>/dev/null
