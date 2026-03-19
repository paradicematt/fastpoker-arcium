#!/bin/bash
# Wait for container to be running, then exec into it quickly
echo "Waiting for arx-node-0 to be running..."
for i in $(seq 1 30); do
    STATE=$(docker inspect --format='{{.State.Running}}' artifacts-arx-node-0-1 2>/dev/null)
    if [ "$STATE" = "true" ]; then
        echo "Container is running! Exec'ing..."
        
        # Quick test: try to connect from inside the container
        docker exec artifacts-arx-node-0-1 bash -c "
            echo '=== Config inside container ==='
            cat /usr/arx-node/arx/node_config.toml
            echo ''
            echo '=== Network ==='
            ip addr 2>/dev/null || ifconfig 2>/dev/null || echo 'no ip/ifconfig'
            echo ''
            echo '=== Route ==='
            ip route 2>/dev/null || route -n 2>/dev/null || echo 'no route cmd'
            echo ''
            echo '=== Test connectivity ==='
            echo 'Testing 172.20.0.1:8899...'
            timeout 3 bash -c 'echo > /dev/tcp/172.20.0.1/8899' 2>&1 && echo 'TCP CONNECT OK' || echo 'TCP CONNECT FAILED'
            echo 'Testing 172.20.0.1:8900...'
            timeout 3 bash -c 'echo > /dev/tcp/172.20.0.1/8900' 2>&1 && echo 'TCP CONNECT OK' || echo 'TCP CONNECT FAILED'
            echo ''
            echo '=== DNS ==='
            cat /etc/resolv.conf
        " 2>&1
        
        break
    fi
    sleep 1
done
