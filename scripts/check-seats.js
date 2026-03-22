const {Connection, PublicKey} = require("@solana/web3.js");
const RPC = "http://127.0.0.1:8899";
const PROG = new PublicKey("BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N");
const TABLE = new PublicKey("BJ7E3VoTy8H5HrMUPnL6jsTXzybr5Up9B7CD1fkWCG2h");
const statuses = ["Empty","Occupied","SittingOut","Leaving","Eliminated","Reserved"];

async function main() {
  const conn = new Connection(RPC, "confirmed");
  
  // Table state
  const tInfo = await conn.getAccountInfo(TABLE);
  if (tInfo) {
    const d = tInfo.data;
    const phases = ['Waiting','Starting','AwaitingDeal','Preflop','Flop','Turn','River','Showdown','AwaitingShowdown','Complete','FlopRevealPending','TurnRevealPending','RiverRevealPending'];
    console.log("Table:", phases[d[160]] || d[160], "hand=#" + d[123], "curP=" + d[122], "maxP=" + d[121]);
    console.log("  Occ:", d.readUInt16LE(250).toString(2).padStart(d[121], '0'));
    console.log("  Pot:", d.readBigUInt64LE(131).toString());
  }
  
  // Seats
  for (let i = 0; i < 2; i++) {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("seat"), TABLE.toBuffer(), Buffer.from([i])], PROG
    );
    const info = await conn.getAccountInfo(pda);
    if (!info) { console.log("Seat", i, ": NOT FOUND"); continue; }
    const d = info.data;
    // PlayerSeat: disc(8) + wallet(32) + session_key(32) + table(32) + chips(8) + bet_round(8) + total_bet(8) + hole_enc(64) + commitment(32) + hole_cards(2) + seat_num(1) + status(1) + last_action(8)
    const player = new PublicKey(d.slice(8, 40)).toBase58();
    const sessionKey = new PublicKey(d.slice(40, 72)).toBase58();
    const chips = d.readBigUInt64LE(104);
    const betRound = d.readBigUInt64LE(112);
    const totalBet = d.readBigUInt64LE(120);
    const holeCards = [d[224], d[225]];
    const seatNum = d[226];
    const status = d[227];
    const lastAction = d.readBigUInt64LE(228);
    // x25519 stored in hole_cards_commitment (offset 192, 32 bytes)
    const x25519 = d.slice(192, 224);
    const hasX25519 = !x25519.every(b => b === 0);
    // Additional fields for kick eligibility
    const sitOutBtnCount = d[240]; // sit_out_button_count
    const handsSinceBust = d[241]; // hands_since_bust
    const sitOutTimestamp = d.length >= 278 ? Number(d.readBigInt64LE(270)) : 0; // sit_out_timestamp (i64)
    const nowUnix = Math.floor(Date.now() / 1000);
    const sitOutSecs = sitOutTimestamp > 0 ? nowUnix - sitOutTimestamp : 0;
    const statuses = ['Empty','Active','Folded','AllIn','SittingOut','Busted','Leaving'];
    console.log("Seat", i, ":", statuses[status] || ("unknown:" + status), 
      "player=" + player.slice(0,12) + "..",
      "chips=" + chips.toString(),
      "bet=" + betRound.toString(),
      "cards=[" + holeCards.join(",") + "]",
      "x25519=" + (hasX25519 ? "yes" : "EMPTY"),
      "lastSlot=" + lastAction.toString());
    console.log("       sitOutTs=" + sitOutTimestamp, "sitOutSecs=" + sitOutSecs, "sitOutBtnCount=" + sitOutBtnCount, "handsSinceBust=" + handsSinceBust);
  }
}
main().catch(e => console.error(e.message));
