#!/bin/bash
for c in artifacts-arx-node-0-1 artifacts-arx-node-1-1 artifacts-arx-node-2-1 artifacts-arx-node-3-1 artifacts-arcium-trusted-dealer-1; do
    docker network connect bridge "$c" 2>/dev/null && echo "$c → bridge ✓" || echo "$c → already connected"
done
echo "Done connecting containers to bridge"
