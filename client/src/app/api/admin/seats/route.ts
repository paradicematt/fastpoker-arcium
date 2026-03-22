import { NextRequest, NextResponse } from 'next/server';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || 'http://localhost:8899';
const PROGRAM_ID_STR = process.env.NEXT_PUBLIC_PROGRAM_ID || 'BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N';
const PROGRAM_ID = new PublicKey(PROGRAM_ID_STR);

// ─── Seat account layout offsets ───
// Total: disc(8) + wallet(32) + session_key(32) + table(32) + chips(8) + bet_this_round(8)
// + total_bet_this_hand(8) + hole_cards_encrypted(64) + hole_cards_commitment(32)
// + hole_cards(2) + seat_number(1) + status(1) + last_action_slot(8) + missed_sb(1)
// + missed_bb(1) + posted_blind(1) + waiting_for_bb(1) + sit_out_button_count(1)
// + hands_since_bust(1) + auto_fold_count(1) + missed_bb_count(1) + bump(1)
// + paid_entry(1) + cashout_chips(8) + cashout_nonce(8) + vault_reserve(8)
// + sit_out_timestamp(8) + time_bank_seconds(2) + time_bank_active(1) = 281
const S = {
  WALLET: 8,
  SESSION_KEY: 40,
  TABLE: 72,
  CHIPS: 104,
  BET: 112,
  TOTAL_BET: 120,
  HOLE_CARDS: 224,
  SEAT_NUM: 226,
  STATUS: 227,
  LAST_ACTION: 228,
  CASHOUT_CHIPS: 246,
  CASHOUT_NONCE: 254,
  VAULT_RESERVE: 262,
  SIT_OUT_TS: 270,
};

const STATUS_NAMES: Record<number, string> = {
  0: 'Empty', 1: 'Active', 2: 'Folded', 3: 'AllIn',
  4: 'SittingOut', 5: 'Busted', 6: 'Leaving',
};

function readU8(buf: Buffer, offset: number): number { return buf.readUInt8(offset); }
function readU64(buf: Buffer, offset: number): number { return Number(buf.readBigUInt64LE(offset)); }
function readI64(buf: Buffer, offset: number): number { return Number(buf.readBigInt64LE(offset)); }
function readPubkey(buf: Buffer, offset: number): string {
  return bs58.encode(buf.subarray(offset, offset + 32));
}

function getSeatPda(tablePubkey: PublicKey, seatIndex: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('seat'), tablePubkey.toBuffer(), Buffer.from([seatIndex])],
    PROGRAM_ID,
  )[0];
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const tablePubkeyStr = searchParams.get('table');
    const maxPlayers = parseInt(searchParams.get('maxPlayers') || '9', 10);

    if (!tablePubkeyStr) {
      return NextResponse.json({ error: 'Missing table parameter' }, { status: 400 });
    }

    const tablePubkey = new PublicKey(tablePubkeyStr);
    const seatPdas = Array.from({ length: maxPlayers }, (_, i) => getSeatPda(tablePubkey, i));

    // Batch fetch all seat accounts
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getMultipleAccounts',
        params: [
          seatPdas.map(p => p.toBase58()),
          { encoding: 'base64', commitment: 'confirmed' },
        ],
      }),
    });

    const data = await res.json();
    const accounts = data?.result?.value || [];
    const seats: any[] = [];

    for (let i = 0; i < maxPlayers; i++) {
      const acc = accounts[i];
      if (!acc || !acc.data) {
        seats.push({
          index: i,
          pubkey: seatPdas[i].toBase58(),
          wallet: '11111111111111111111111111111111',
          chips: 0,
          bet: 0,
          status: 0,
          statusName: 'Empty',
        });
        continue;
      }

      const buf = Buffer.from(acc.data[0], 'base64');
      if (buf.length < 270) {
        seats.push({
          index: i,
          pubkey: seatPdas[i].toBase58(),
          wallet: '11111111111111111111111111111111',
          chips: 0,
          bet: 0,
          status: 0,
          statusName: 'Empty',
        });
        continue;
      }

      const status = readU8(buf, S.STATUS);
      seats.push({
        index: i,
        pubkey: seatPdas[i].toBase58(),
        wallet: readPubkey(buf, S.WALLET),
        chips: readU64(buf, S.CHIPS),
        bet: readU64(buf, S.BET),
        status,
        statusName: STATUS_NAMES[status] ?? `Unknown(${status})`,
        cashoutChips: readU64(buf, S.CASHOUT_CHIPS),
        cashoutNonce: readU64(buf, S.CASHOUT_NONCE),
        vaultReserve: readU64(buf, S.VAULT_RESERVE),
        sitOutTimestamp: readI64(buf, S.SIT_OUT_TS),
      });
    }

    return NextResponse.json({ seats });
  } catch (err: any) {
    return NextResponse.json({ error: err.message, seats: [] }, { status: 500 });
  }
}
