import { NextRequest, NextResponse } from 'next/server';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || 'http://localhost:8899';
const PROGRAM_ID = process.env.NEXT_PUBLIC_PROGRAM_ID || 'BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N';

// Heartbeat file path — matches crank-service.ts (uses __dirname which resolves to backend/)
const HEARTBEAT_PATHS = [
  path.resolve(process.cwd(), '..', 'backend', 'crank-heartbeat.json'),  // from client/
  '/mnt/j/Poker-Arc/backend/crank-heartbeat.json',                       // WSL direct
  'J:/Poker-Arc/backend/crank-heartbeat.json',                           // Windows direct
];
const STEEL_PROGRAM_ID = '9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6';
const TREASURY = process.env.NEXT_PUBLIC_TREASURY || '4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3';
const POOL_PDA = process.env.NEXT_PUBLIC_POOL_PDA || 'FSKrGq26FxhMUSK85ksv2AykL5Am2HS9iXJwuVoQQvLY';
const LAMPORTS_PER_SOL = 1_000_000_000;

// ─── Table account layout offsets (437 bytes) ───
const T = {
  TABLE_ID: 8,
  AUTHORITY: 40,
  GAME_TYPE: 104,
  SB_AMT: 105,
  BB_AMT: 113,
  MAX_P: 121,
  CUR_PLAYERS: 122,
  HAND: 123,
  POT: 131,
  MIN_BET: 139,
  RAKE_ACC: 147,
  COMMUNITY: 155,
  PHASE: 160,
  CUR_PLAYER: 161,
  DEALER_BTN: 163,
  LAST_ACTION_SLOT: 166,
  IS_DELEGATED: 174,
  REVEALED_HANDS: 175,
  HAND_RESULTS: 193,
  SEATS_OCC: 250,
  SEATS_ALLIN: 252,
  SEATS_FOLDED: 254,
  TOKEN_ESCROW: 258,
  CREATOR: 290,
  IS_USER_CREATED: 322,
  CREATOR_RAKE_TOTAL: 323,
  PRIZES_DISTRIBUTED: 339,
  ELIMINATED_SEATS: 342,
  ELIMINATED_COUNT: 351,
  TIER: 360,
  ENTRY_AMOUNT: 361,
  FEE_AMOUNT: 369,
  PRIZE_POOL: 377,
  TOKEN_MINT: 385,
  BUY_IN_TYPE: 417,
  RAKE_CAP: 418,
  IS_PRIVATE: 426,
  BLIND_LEVEL: 241,
  TOURNAMENT_START_SLOT: 242,
};

// ─── Vault account layout offsets (113 bytes) ───
const V = {
  TABLE: 8,
  TOTAL_DEPOSITED: 40,
  TOTAL_WITHDRAWN: 48,
  BUMP: 56,
  RAKE_NONCE: 57,
  TOTAL_RAKE_DISTRIBUTED: 65,
  TOKEN_MINT: 73,
  TOTAL_CRANK_DISTRIBUTED: 105,
};

const PHASE_NAMES: Record<number, string> = {
  0: 'Waiting', 1: 'Starting', 2: 'AwaitingDeal', 3: 'Preflop',
  4: 'Flop', 5: 'Turn', 6: 'River', 7: 'Showdown',
  8: 'AwaitingShowdown', 9: 'Complete',
  10: 'FlopRevealPending', 11: 'TurnRevealPending', 12: 'RiverRevealPending',
};

const GAME_TYPE_NAMES: Record<number, string> = {
  0: 'SNG HU', 1: 'SNG 6-Max', 2: 'SNG 9-Max', 3: 'Cash Game',
};

const TIER_NAMES: Record<number, string> = {
  0: 'Micro', 1: 'Bronze', 2: 'Silver', 3: 'Gold', 4: 'Platinum', 5: 'Diamond',
};

function readU8(buf: Buffer, offset: number): number { return buf.readUInt8(offset); }
function readU16(buf: Buffer, offset: number): number { return buf.readUInt16LE(offset); }
function readU64(buf: Buffer, offset: number): number { return Number(buf.readBigUInt64LE(offset)); }
function readI64(buf: Buffer, offset: number): number { return Number(buf.readBigInt64LE(offset)); }
function readPubkey(buf: Buffer, offset: number): string {
  return bs58.encode(buf.subarray(offset, offset + 32));
}
function isZeroPubkey(pubkey: string): boolean {
  return pubkey === '11111111111111111111111111111111';
}

async function rpcCall(method: string, params: any[]) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json();
}

function parseTable(pubkey: string, buf: Buffer, lamports: number) {
  if (buf.length < 437) return null;

  const phase = readU8(buf, T.PHASE);
  const gameType = readU8(buf, T.GAME_TYPE);
  const maxPlayers = readU8(buf, T.MAX_P);
  const currentPlayers = readU8(buf, T.CUR_PLAYERS);
  const seatsOccupied = readU16(buf, T.SEATS_OCC);
  const tier = readU8(buf, T.TIER);
  const eliminatedCount = readU8(buf, T.ELIMINATED_COUNT);
  const rakeAccumulated = readU64(buf, T.RAKE_ACC);

  // Sanity checks
  if (maxPlayers !== 2 && maxPlayers !== 6 && maxPlayers !== 9) return null;
  if (gameType > 10) return null;

  // Community cards
  const communityCards: number[] = [];
  for (let i = 0; i < 5; i++) communityCards.push(readU8(buf, T.COMMUNITY + i));

  // Eliminated seats
  const eliminatedSeats: number[] = [];
  for (let i = 0; i < eliminatedCount; i++) {
    eliminatedSeats.push(readU8(buf, T.ELIMINATED_SEATS + i));
  }

  return {
    pubkey,
    tableId: bs58.encode(buf.subarray(T.TABLE_ID, T.TABLE_ID + 32)),
    authority: readPubkey(buf, T.AUTHORITY),
    phase,
    phaseName: PHASE_NAMES[phase] ?? `Unknown(${phase})`,
    gameType,
    gameTypeName: GAME_TYPE_NAMES[gameType] ?? `Unknown(${gameType})`,
    maxPlayers,
    currentPlayers,
    handNumber: readU64(buf, T.HAND),
    pot: readU64(buf, T.POT),
    smallBlind: readU64(buf, T.SB_AMT),
    bigBlind: readU64(buf, T.BB_AMT),
    currentPlayer: readU8(buf, T.CUR_PLAYER),
    dealerSeat: readU8(buf, T.DEALER_BTN),
    isDelegated: readU8(buf, T.IS_DELEGATED) === 1,
    seatsOccupied,
    prizesDistributed: readU8(buf, T.PRIZES_DISTRIBUTED) === 1,
    eliminatedCount,
    eliminatedSeats,
    communityCards,
    lamports,
    location: 'L1' as const,
    seats: [], // Seats fetched separately via /api/admin/seats
    tier,
    tierName: TIER_NAMES[tier] ?? `Unknown(${tier})`,
    entryAmount: readU64(buf, T.ENTRY_AMOUNT),
    feeAmount: readU64(buf, T.FEE_AMOUNT),
    prizePool: readU64(buf, T.PRIZE_POOL),
    rakeAccumulated,
    isUserCreated: readU8(buf, T.IS_USER_CREATED) === 1,
    creator: readPubkey(buf, T.CREATOR),
    creatorRakeTotal: readU64(buf, T.CREATOR_RAKE_TOTAL),
    tokenMint: readPubkey(buf, T.TOKEN_MINT),
    // Vault data filled below if available
    vaultLamports: 0,
    vaultTotalDeposited: 0,
    vaultTotalWithdrawn: 0,
    vaultTotalRakeDistributed: 0,
    vaultRakeNonce: 0,
    isStuck: false,
    stuckReason: null as string | null,
    isClosing: false,
    closingStage: null as string | null,
    itmPreview: [] as any[],
    blindLevel: readU8(buf, T.BLIND_LEVEL),
    tournamentStartSlot: readU64(buf, T.TOURNAMENT_START_SLOT),
  };
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const skipTables = searchParams.get('skipTables') === 'true';
    const skipSeats = searchParams.get('skipSeats') === 'true';

    // Fetch treasury + pool balances in parallel
    const [treasuryRes, poolRes] = await Promise.all([
      rpcCall('getAccountInfo', [TREASURY, { encoding: 'base64', commitment: 'confirmed' }]),
      rpcCall('getAccountInfo', [POOL_PDA, { encoding: 'base64', commitment: 'confirmed' }]),
    ]);

    // Treasury
    const treasuryLamports = treasuryRes?.result?.value?.lamports ?? 0;
    const treasury = {
      address: TREASURY,
      balanceSol: treasuryLamports / LAMPORTS_PER_SOL,
      balanceLamports: treasuryLamports,
      pokerBalance: 0,
      tokens: [] as any[],
    };

    // Pool (Steel staking) — parse if available
    // Steel Pool layout (184 bytes, #[repr(C)]):
    //   [0-7]    discriminator (8 bytes padded)
    //   [8-39]   authority (Pubkey)
    //   [40-71]  poker_mint (Pubkey)
    //   [72-79]  total_burned (u64)
    //   [80-87]  sol_rewards_available (u64)
    //   [88-95]  sol_rewards_distributed (u64)
    //   [96-111] accumulated_sol_per_token (u128)
    //   [112-119] poker_rewards_available (u64)
    //   [120-127] poker_rewards_distributed (u64)
    //   [128-143] accumulated_poker_per_token (u128)
    //   [144-151] total_unrefined (u64)
    //   [152-167] accumulated_refined_per_token (u128)
    //   [168-175] current_epoch (u64)
    //   [176]    bump (u8)
    //   [177-183] padding
    let pool = null;
    if (poolRes?.result?.value) {
      const poolBuf = Buffer.from(poolRes.result.value.data[0], 'base64');
      if (poolBuf.length >= 176) {
        const POKER_DECIMALS = 1e9; // 9 decimals (SPL token mint)
        const UNREFINED_DECIMALS = 1e6; // 6 decimals (Steel unrefined uses 1e6 precision)
        pool = {
          totalStaked: readU64(poolBuf, 72) / POKER_DECIMALS,          // total_burned (stake weight) — POKER tokens (9 dec)
          totalUnrefined: readU64(poolBuf, 144) / UNREFINED_DECIMALS,  // total_unrefined — unrefined POKER (6 dec)
          solDistributed: readU64(poolBuf, 88) / LAMPORTS_PER_SOL,     // sol_rewards_distributed — SOL
          solClaimed: 0,                                                // not stored separately in Steel
          solAvailable: readU64(poolBuf, 80) / LAMPORTS_PER_SOL,       // sol_rewards_available — SOL
          pokerAvailable: readU64(poolBuf, 112) / POKER_DECIMALS,      // poker_rewards_available — POKER (9 dec)
          pokerDistributed: readU64(poolBuf, 120) / POKER_DECIMALS,    // poker_rewards_distributed — POKER (9 dec)
        };
      }
    }

    // Tables
    let tables = { er: [] as any[], l1: [] as any[], totalCount: 0, erCount: 0, l1Count: 0, stuckCount: 0, totalRentHeldSol: 0 };
    let summary = {
      activeTables: 0, waitingTables: 0, completedTables: 0,
      totalPot: 0, totalPlayers: 0, cashGameTables: 0, sitAndGoTables: 0,
      totalRakeAccumulated: 0, poolPokerBalance: pool?.pokerAvailable ?? 0,
    };

    if (!skipTables) {
      const tablesRes = await rpcCall('getProgramAccounts', [
        PROGRAM_ID,
        { encoding: 'base64', commitment: 'confirmed', filters: [{ dataSize: 437 }] },
      ]);

      const accounts = tablesRes?.result || [];
      const parsedTables: any[] = [];
      let totalRentHeld = 0;

      for (const acc of accounts) {
        try {
          const buf = Buffer.from(acc.account.data[0], 'base64');
          const parsed = parseTable(acc.pubkey, buf, acc.account.lamports);
          if (!parsed) continue;
          parsedTables.push(parsed);
          totalRentHeld += acc.account.lamports;
        } catch { /* skip malformed */ }
      }

      // Compute summary
      for (const t of parsedTables) {
        if (t.phase === 0) summary.waitingTables++;
        else if (t.phase === 9) summary.completedTables++;
        else summary.activeTables++;
        summary.totalPot += t.pot;
        summary.totalPlayers += t.currentPlayers;
        summary.totalRakeAccumulated += t.rakeAccumulated;
        if (t.gameType === 3) summary.cashGameTables++;
        else summary.sitAndGoTables++;
      }

      // All tables are L1 in Arcium architecture (no ER delegation)
      tables = {
        er: [],
        l1: parsedTables,
        totalCount: parsedTables.length,
        erCount: 0,
        l1Count: parsedTables.length,
        stuckCount: 0,
        totalRentHeldSol: totalRentHeld / LAMPORTS_PER_SOL,
      };
    }

    // Read crank heartbeat file (written by crank-service every 5s)
    let crankStatus = undefined;
    for (const hbPath of HEARTBEAT_PATHS) {
      try {
        if (fs.existsSync(hbPath)) {
          const hb = JSON.parse(fs.readFileSync(hbPath, 'utf-8'));
          const heartbeatAge = Date.now() - (hb.heartbeat || 0);
          crankStatus = {
            pid: hb.pid,
            startedAt: hb.startedAt,
            heartbeat: hb.heartbeat,
            status: heartbeatAge < 15_000 ? 'online' as const : 'offline' as const,
            tablesTracked: hb.tablesTracked ?? 0,
            tablesProcessing: hb.tablesProcessing ?? 0,
            recentErrors: hb.recentErrors ?? [],
            uptime: hb.uptime ?? '',
            heartbeatAge,
            config: hb.config,
            dealMode: hb.dealMode ?? 'unknown',
          };
          break;
        }
      } catch { /* skip */ }
    }

    // Check Arcium MXE node health (Docker containers on localnet)
    let arciumHealth = undefined;
    try {
      // Try to reach MXE node 0 via Docker network health check
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const mxeRes = await fetch('http://172.20.0.100:8080/health', { signal: controller.signal }).catch(() => null);
      clearTimeout(timeout);
      arciumHealth = {
        reachable: mxeRes !== null && mxeRes.ok,
        nodes: 4,  // From Arcium.toml
        backend: 'Cerberus',
      };
    } catch {
      arciumHealth = { reachable: false, nodes: 0, backend: 'Cerberus' };
    }

    return NextResponse.json({
      timestamp: Date.now(),
      treasury,
      pool,
      tables,
      summary,
      crankStatus,
      arciumHealth,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message, timestamp: Date.now(), treasury: { address: TREASURY, balanceSol: 0, balanceLamports: 0, pokerBalance: 0 }, pool: null, tables: { er: [], l1: [], totalCount: 0, erCount: 0, l1Count: 0, stuckCount: 0, totalRentHeldSol: 0 }, summary: { activeTables: 0, waitingTables: 0, completedTables: 0, totalPot: 0, totalPlayers: 0, cashGameTables: 0, sitAndGoTables: 0, totalRakeAccumulated: 0, poolPokerBalance: 0 } },
      { status: 500 },
    );
  }
}
