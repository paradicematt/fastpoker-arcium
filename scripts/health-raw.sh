#!/bin/bash
echo "=== wget test from inside container ==="
docker exec artifacts-arx-node-0-1 bash -c 'wget -qO- -T 3 http://127.0.0.1:9091/health 2>&1' 2>/dev/null
echo "(exit: $?)"

echo ""
echo "=== wget /metrics ==="
docker exec artifacts-arx-node-0-1 bash -c 'wget -qO- -T 3 http://127.0.0.1:9091/metrics 2>&1' 2>/dev/null | head -5
echo "(exit: $?)"

echo ""
echo "=== Raw TCP test with bash /dev/tcp ==="
docker exec artifacts-arx-node-0-1 bash -c '
exec 3<>/dev/tcp/127.0.0.1/9091
echo -e "GET /health HTTP/1.0\r\nHost: localhost\r\n\r\n" >&3
timeout 3 cat <&3
exec 3>&-
' 2>/dev/null
echo "(exit: $?)"

echo ""
echo "=== Check if timeout is blocking curl on host ==="
# Use nc to test raw TCP
echo -e "GET /health HTTP/1.0\r\nHost: localhost\r\n\r\n" | timeout 3 nc 127.0.0.1 9091 2>/dev/null
echo "(exit: $?)"

echo ""
echo "=== Python HTTP test from inside ==="
docker exec artifacts-arx-node-0-1 bash -c '
python3 -c "
import urllib.request, sys
try:
    r = urllib.request.urlopen(\"http://127.0.0.1:9091/health\", timeout=3)
    print(f\"Status: {r.status}\")
    print(r.read().decode())
except Exception as e:
    print(f\"Error: {e}\")
" 2>&1' 2>/dev/null || echo "no python"
