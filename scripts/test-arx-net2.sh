#!/bin/bash
# Test connectivity from the ACTUAL artifacts_arx_network

echo "=== Start HTTP listener on 0.0.0.0:18899 ==="
python3 -c "
from http.server import HTTPServer, BaseHTTPRequestHandler
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'OK')
    def do_POST(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'OK')
    def log_message(self, format, *args):
        print(f'  HIT from {self.client_address[0]}')
HTTPServer(('0.0.0.0', 18899), H).serve_forever()
" &
SRV=$!
sleep 1

echo "=== Verify from host ==="
curl -s -m 2 http://127.0.0.1:18899 && echo "" || echo "HOST FAIL"

echo ""
echo "=== From artifacts_arx_network ==="
for target in "172.20.0.1:18899" "172.17.0.1:18899" "172.28.77.77:18899" "host.docker.internal:18899"; do
    echo -n "  $target: "
    docker run --rm --network artifacts_arx_network curlimages/curl:latest -s -m 5 "http://$target" 2>/dev/null || echo "FAIL"
    echo ""
done

echo ""
echo "=== From default bridge ==="
for target in "172.17.0.1:18899" "172.20.0.1:18899"; do
    echo -n "  $target: "
    docker run --rm curlimages/curl:latest -s -m 5 "http://$target" 2>/dev/null || echo "FAIL"
    echo ""
done

echo ""
echo "=== host-gateway from arx_network ==="
echo -n "  host-gateway: "
docker run --rm --network artifacts_arx_network --add-host=myhost:host-gateway curlimages/curl:latest -s -m 5 http://myhost:18899 2>/dev/null || echo "FAIL"
echo ""

kill $SRV 2>/dev/null
echo "Done"
