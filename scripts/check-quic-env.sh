#!/bin/bash
# Check QUIC-relevant networking parameters
source ~/.cargo/env 2>/dev/null || true

echo "=== Docker bridge MTU ==="
BRIDGE=$(docker network inspect artifacts_arx_network --format '{{.Options}}' 2>/dev/null)
echo "  Network options: $BRIDGE"
ip link show | grep -E 'br-|docker0' | head -5
echo ""

echo "=== Container interface MTU ==="
docker exec artifacts-arx-node-0-1 cat /sys/class/net/eth0/mtu 2>/dev/null
echo ""

echo "=== Large UDP packet test (1200 bytes - QUIC initial) ==="
# QUIC initial packets are ~1200 bytes
docker run --rm --network artifacts_arx_network alpine sh -c \
    'dd if=/dev/urandom bs=1200 count=1 2>/dev/null | nc -u -w2 172.20.0.100 8001 && echo "1200B_UDP_OK" || echo "1200B_UDP_FAIL"' 2>/dev/null

echo ""
echo "=== Node 0: check for QUIC/TLS errors in log ==="
grep -iE 'quic|tls|cert|handshake|crypto|quinn|rustls|connection_error|transport' \
    /tmp/poker-arc-workspace/artifacts/arx_node_logs/*_0.log 2>/dev/null | head -10
echo "(end)"

echo ""
echo "=== Node 0: ALL log after 'router initialized' ==="
# Get everything from all log files
for f in /tmp/poker-arc-workspace/artifacts/arx_node_logs/*_0.log; do
    grep -c "" "$f" 2>/dev/null
done
echo ""

echo "=== TD: ALL log after connections ==="
for f in /tmp/poker-arc-workspace/artifacts/trusted_dealer_logs/*.log; do
    LINES=$(grep -c "" "$f" 2>/dev/null)
    echo "  $f: $LINES lines"
done

echo ""
echo "=== Check if any node has DKG-related log entries ==="
grep -rlE 'dkg|DKG|key_gen|keygen|share|dealing' \
    /tmp/poker-arc-workspace/artifacts/arx_node_logs/ 2>/dev/null
grep -rlE 'dkg|DKG|key_gen|keygen|share|dealing' \
    /tmp/poker-arc-workspace/artifacts/trusted_dealer_logs/ 2>/dev/null
echo "(end)"
