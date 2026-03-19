#!/bin/bash

echo "=== Curl test (dynamic IP on arx_network) ==="
docker run --rm --network artifacts_arx_network curlimages/curl:latest \
    -s -m 5 http://172.20.0.1:8899 -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null || echo "FAIL"

echo ""
echo "=== Curl test (static IP 172.20.0.50 on arx_network) ==="
docker run --rm --network artifacts_arx_network --ip 172.20.0.50 curlimages/curl:latest \
    -s -m 5 http://172.20.0.1:8899 -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null || echo "FAIL"

echo ""
echo "=== Curl test (static IP 172.20.0.100 - same as node 0) ==="
docker run --rm --network artifacts_arx_network --ip 172.20.0.200 curlimages/curl:latest \
    -s -m 5 http://172.20.0.1:8899 -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null || echo "FAIL"

echo ""
echo "=== arx-node container route table (from /proc) ==="
# Wait for container to be running
for i in $(seq 1 20); do
    STATE=$(docker inspect --format='{{.State.Running}}' artifacts-arx-node-0-1 2>/dev/null)
    if [ "$STATE" = "true" ]; then
        docker exec artifacts-arx-node-0-1 bash -c "
            echo 'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT'
            cat /proc/net/route
            echo ''
            echo '=== Interfaces ==='
            cat /proc/net/dev
            echo ''
            echo '=== IP addresses ==='
            cat /proc/net/fib_trie 2>/dev/null | head -30
            echo ''
            echo '=== ARP table ==='  
            cat /proc/net/arp
            echo ''
            echo '=== TCP test to gateway ==='
            timeout 3 bash -c 'echo test > /dev/tcp/172.20.0.1/8899' 2>&1
            echo \"Exit: \$?\"
        " 2>/dev/null
        break
    fi
    sleep 1
done
