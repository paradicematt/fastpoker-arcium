#!/bin/bash
WS="/tmp/poker-arc-workspace"

echo "=== Validator log: callback-related entries ==="
VLOG="$WS/validator.log"
if [ -f "$VLOG" ]; then
    grep -n "callback\|reveal_community\|6000\|InvalidAuthority\|Custom\|failed\|Program log" "$VLOG" | tail -30 | cut -c1-300
else
    echo "No validator.log at $VLOG"
    # Try alternate locations
    find "$WS" -name "*.log" -not -path "*/arx_node*" -not -path "*/trusted_dealer*" 2>/dev/null
fi

echo ""
echo "=== Check on-chain: computation account for reveal (offset 2492392) ==="
# The computation PDA is derived from the offset + MXE program
# Let's check if it's still on chain
curl -s http://localhost:8899 -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getRecentBlockhash"}' 2>/dev/null | head -1

echo ""
echo "=== Recent transaction errors ==="
curl -s http://localhost:8899 -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSignaturesForAddress","params":["BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N",{"limit":10}]}' 2>/dev/null | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    for sig in data.get('result', []):
        err = sig.get('err')
        if err:
            print(f'  ERR: {sig[\"signature\"][:20]}... -> {err}')
        else:
            print(f'  OK:  {sig[\"signature\"][:20]}...')
except Exception as e:
    print(f'Parse error: {e}')
" 2>/dev/null

echo ""
echo "=== Node 0: what happens between shuffle callback success and reveal callback failure? ==="
LATEST=$(ls -t "$WS/artifacts/arx_node_logs/"*_0.log 2>/dev/null | head -1)
[ -n "$LATEST" ] && sed -n '345,470p' "$LATEST" | grep -v "connection_handlers\|ConnectionRequest\|network_router\|substream" | cut -c1-250
