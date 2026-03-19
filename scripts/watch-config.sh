#!/bin/bash
echo "=== Config content ==="
cat /tmp/poker-arc-workspace/artifacts/node_config_0.toml

echo ""
echo "=== Config mtime ==="
stat /tmp/poker-arc-workspace/artifacts/node_config_0.toml 2>/dev/null | grep Modify

echo ""
echo "=== Watch for overwrites (5s intervals x4) ==="
HASH1=$(md5sum /tmp/poker-arc-workspace/artifacts/node_config_0.toml 2>/dev/null | cut -d' ' -f1)
echo "Initial: $HASH1"
for i in 1 2 3 4; do
    sleep 5
    HASH=$(md5sum /tmp/poker-arc-workspace/artifacts/node_config_0.toml 2>/dev/null | cut -d' ' -f1)
    MTIME=$(stat -c '%Y' /tmp/poker-arc-workspace/artifacts/node_config_0.toml 2>/dev/null)
    if [ "$HASH" != "$HASH1" ]; then
        echo "Check $i: CHANGED! $HASH (mtime=$MTIME)"
        echo "  New content:"
        cat /tmp/poker-arc-workspace/artifacts/node_config_0.toml
        HASH1="$HASH"
    else
        echo "Check $i: unchanged ($HASH, mtime=$MTIME)"
    fi
done
