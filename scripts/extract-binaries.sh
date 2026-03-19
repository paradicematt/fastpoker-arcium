#!/bin/bash
# Extract arx and trusted-dealer binaries from Docker images
NATIVE_DIR="/tmp/arx-native"
mkdir -p "$NATIVE_DIR"

echo "=== Extract arx binary ==="
docker create --name arx-ext arcium/arx-node:v0.8.5 2>/dev/null
docker cp arx-ext:/usr/local/bin/arx "$NATIVE_DIR/arx" 2>/dev/null
docker rm arx-ext 2>/dev/null
ls -la "$NATIVE_DIR/arx" 2>/dev/null
file "$NATIVE_DIR/arx" 2>/dev/null

echo ""
echo "=== Find TD binary ==="
docker inspect arcium/trusted-dealer:v0.8.5 --format '{{.Config.Entrypoint}}' 2>/dev/null
docker create --name td-ext arcium/trusted-dealer:v0.8.5 2>/dev/null
docker cp td-ext:/usr/local/bin/trusted-dealer "$NATIVE_DIR/trusted-dealer" 2>/dev/null || \
    docker cp td-ext:/usr/trusted-dealer/trusted-dealer "$NATIVE_DIR/trusted-dealer" 2>/dev/null || \
    echo "Trying to find TD binary..."
docker rm td-ext 2>/dev/null
ls -la "$NATIVE_DIR/trusted-dealer" 2>/dev/null
file "$NATIVE_DIR/trusted-dealer" 2>/dev/null

echo ""
echo "=== Also extract circuits ==="
docker create --name circ-ext arcium/arx-node:v0.8.5 2>/dev/null
docker cp circ-ext:/usr/arx-node/circuits "$NATIVE_DIR/circuits" 2>/dev/null
docker rm circ-ext 2>/dev/null
ls -la "$NATIVE_DIR/circuits/" 2>/dev/null

echo ""
echo "=== Test arx binary runs ==="
"$NATIVE_DIR/arx" --version 2>&1 || echo "(no --version flag)"
"$NATIVE_DIR/arx" --help 2>&1 | head -5 || echo "(no --help flag)"

chmod +x "$NATIVE_DIR/arx" "$NATIVE_DIR/trusted-dealer" 2>/dev/null
echo "Done"
