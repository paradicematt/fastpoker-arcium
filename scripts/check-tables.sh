#!/bin/bash
source ~/.nvm/nvm.sh 2>/dev/null
export PATH="$HOME/.local/share/solana/install/releases/2.1.21/solana-release/bin:$PATH"
RPC="http://127.0.0.1:8899"

echo "=== Table State Check ==="

for TABLE in BJ7E3VoTy8H5HrMUPnL6jsTXzybr5Up9B7CD1fkWCG2h 5tQB6dAS5yQVsYHibXuWMHZxHYv4mJeoxiMqYX4eazmR 4jtJQPMKSt4KaMS7ngTLJ65GoR7iA5B6ozsrFYs27B9b 5R3cs2BJjgtHj96tF5ktmthWeB5LRr2gF8P4xYkmanyP; do
  echo ""
  echo "--- ${TABLE:0:12}... ---"
  DATA=$(solana account "$TABLE" --url "$RPC" --output json 2>/dev/null)
  if [ -z "$DATA" ]; then
    echo "  NOT FOUND"
    continue
  fi
  # Use node to parse the base64 data
  node -e "
    const data = Buffer.from(JSON.parse(process.argv[1]).account.data[0], 'base64');
    const maxP = data[121];
    const curP = data[122];
    const hand = data[123];
    const phase = data[160];
    const curPlayer = data[161];
    const button = data[163];
    const sbSeat = data[164];
    const bbSeat = data[165];
    const occ = data.readUInt16LE(250);
    const folded = data.readUInt16LE(254);
    const allin = data.readUInt16LE(252);
    const pot = data.readBigUInt64LE(131);
    const phases = ['Waiting','Starting','AwaitingDeal','Preflop','Flop','Turn','River','Showdown','AwaitingShowdown','Complete','FlopRevealPending','TurnRevealPending','RiverRevealPending'];
    console.log('  Phase:', phases[phase] || phase, '(' + phase + ')');
    console.log('  Hand:', hand, ' MaxP:', maxP, ' CurP:', curP);
    console.log('  Button:', button, ' SB:', sbSeat, ' BB:', bbSeat, ' CurPlayer:', curPlayer);
    console.log('  Occ:', occ.toString(2).padStart(maxP,'0'), ' Folded:', folded.toString(2).padStart(maxP,'0'), ' AllIn:', allin.toString(2).padStart(maxP,'0'));
    console.log('  Pot:', pot.toString());
  " "$DATA"
done
