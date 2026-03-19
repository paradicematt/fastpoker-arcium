import { NextResponse } from 'next/server';

import bs58 from 'bs58';

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || 'http://localhost:8899';
const PROGRAM_ID = process.env.NEXT_PUBLIC_PROGRAM_ID || 'BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N';

// Table account layout offsets (from Table struct in state/table.rs)
// Full offset derivation: see programs/fastpoker/src/state/table.rs Table::SIZE
const T = {
  AUTHORITY: 40,      // Pubkey (disc:8 + table_id:32)
  GAME_TYPE: 104,     // u8 (disc:8 + table_id:32 + authority:32 + pool:32)
  SB_AMT: 105,        // u64
  BB_AMT: 113,        // u64
  MAX_P: 121,         // u8
  CUR_PLAYERS: 122,   // u8
  HAND: 123,          // u64
  POT: 131,           // u64
  PHASE: 160,         // u8
  CREATOR: 290,       // Pubkey (token_escrow ends at 290)
  IS_USER_CREATED: 322, // bool
  TOKEN_MINT: 385,    // Pubkey (after tier:1+entry:8+fee:8+prize:8 = 385)
  RAKE_CAP: 418,      // u64 (after buy_in_type:1 at 417)
  IS_PRIVATE: 426,    // bool
};

function readU8(buf: Buffer, offset: number): number { return buf.readUInt8(offset); }
function readU64(buf: Buffer, offset: number): number { return Number(buf.readBigUInt64LE(offset)); }
function readPubkey(buf: Buffer, offset: number): string {
  return bs58.encode(buf.subarray(offset, offset + 32));
}

export async function GET() {
  try {
    // Use getProgramAccounts to find all table accounts
    // Tables have discriminator "table" in first 8 bytes
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getProgramAccounts',
        params: [
          PROGRAM_ID,
          {
            encoding: 'base64',
            commitment: 'confirmed',
            filters: [
              { dataSize: 437 }, // Table accounts are 437 bytes
            ],
          },
        ],
      }),
    });

    const data = await res.json();
    if (data.error) {
      return NextResponse.json({ error: data.error.message, tables: [] });
    }

    const accounts = data.result || [];
    const tables: any[] = [];

    for (const acc of accounts) {
      try {
        const buf = Buffer.from(acc.account.data[0], 'base64');
        if (buf.length < 300) continue; // Too small for a table account

        const phase = readU8(buf, T.PHASE);
        const maxPlayers = readU8(buf, T.MAX_P);
        const curPlayers = readU8(buf, T.CUR_PLAYERS);
        const gameType = readU8(buf, T.GAME_TYPE);
        const smallBlind = readU64(buf, T.SB_AMT);
        const bigBlind = readU64(buf, T.BB_AMT);
        const pot = readU64(buf, T.POT);
        const handNumber = readU64(buf, T.HAND);

        // Basic sanity: maxPlayers should be 2, 6, or 9
        if (![2, 6, 9].includes(maxPlayers)) continue;
        // gameType should be 0-3
        if (gameType > 10) continue;

        const creator = readPubkey(buf, T.CREATOR);
        const isUserCreated = readU8(buf, T.IS_USER_CREATED) === 1;
        const tokenMint = readPubkey(buf, T.TOKEN_MINT);
        const rakeCap = readU64(buf, T.RAKE_CAP);
        const isPrivate = readU8(buf, T.IS_PRIVATE) === 1;
        const authority = readPubkey(buf, T.AUTHORITY);

        tables.push({
          pubkey: acc.pubkey,
          phase,
          currentPlayers: curPlayers,
          maxPlayers,
          smallBlind,
          bigBlind,
          gameType,
          pot,
          handNumber,
          isUserCreated,
          authority,
          creator,
          tokenMint,
          rakeCap,
          isPrivate,
          location: 'localnet',
        });
      } catch {
        // Skip malformed accounts
      }
    }

    return NextResponse.json({ tables });
  } catch (err: any) {
    return NextResponse.json({ error: err.message, tables: [] }, { status: 500 });
  }
}
