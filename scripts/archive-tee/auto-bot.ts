/**
 * Auto-Bot: Player 2 for game flow testing
 * - Deposits on L1 via deposit_for_join
 * - Seats via /api/cash-game/seat API
 * - Creates session key on L1
 * - Auto-checks/calls on TEE when it's my turn
 *
 * Usage: npx ts-node scripts/auto-bot.ts <table-pda> [seat-index]
 */

import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, LAMPORTS_PER_SOL, ComputeBudgetProgram,
} from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ── Config ──
const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';
const TEE_RPC = 'https://tee.magicblock.app';
const API_BASE = 'http://localhost:3001';
const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const STEEL_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');
const POOL_PDA = new PublicKey('FSKrGq26FxhMUSK85ksv2AykL5Am2HS9iXJwuVoQQvLY');

// ── Discriminators ──
const DISC = {
  register: Buffer.from([242, 146, 194, 234, 234, 145, 228, 42]),
  depositForJoin: Buffer.from([99, 149, 87, 125, 87, 44, 45, 46]),
  resizeVault: Buffer.from([252, 157, 28, 248, 125, 252, 63, 121]),
  playerAction: Buffer.from([37, 85, 25, 135, 200, 116, 96, 101]),
  createSession: Buffer.from([242, 193, 143, 179, 150, 25, 122, 227]),
  initUnrefined: Buffer.from([24]),
};

// ── PDA helpers ──
const pda = (seeds: Buffer[], programId: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, programId);

const getPlayerPda = (w: PublicKey) => pda([Buffer.from('player'), w.toBuffer()], PROGRAM_ID);
const getSessionPda = (w: PublicKey) => pda([Buffer.from('session'), w.toBuffer()], PROGRAM_ID);
const getSeatPda = (t: PublicKey, i: number) => pda([Buffer.from('seat'), t.toBuffer(), Buffer.from([i])], PROGRAM_ID);
const getSeatCardsPda = (t: PublicKey, i: number) => pda([Buffer.from('seat_cards'), t.toBuffer(), Buffer.from([i])], PROGRAM_ID);
const getVaultPda = (t: PublicKey) => pda([Buffer.from('vault'), t.toBuffer()], PROGRAM_ID);
const getReceiptPda = (t: PublicKey, i: number) => pda([Buffer.from('receipt'), t.toBuffer(), Buffer.from([i])], PROGRAM_ID);
const getMarkerPda = (w: PublicKey, t: PublicKey) => pda([Buffer.from('player_table'), w.toBuffer(), t.toBuffer()], PROGRAM_ID);
const getDepositProofPda = (t: PublicKey, i: number) => pda([Buffer.from('deposit_proof'), t.toBuffer(), Buffer.from([i])], PROGRAM_ID);
const getUnrefinedPda = (w: PublicKey) => pda([Buffer.from('unrefined'), w.toBuffer()], STEEL_ID);

// ── Table parsing offsets (after 8-byte discriminator) ──
const TABLE = {
  MAX_PLAYERS: 121,
  CURRENT_PLAYERS: 122,
  PHASE: 147,
  CURRENT_PLAYER: 148,
  POT: 131, // 8+32+32+32+1+8+8 = 121+1+1+8 = 131
  COMMUNITY: 142, // pot(8)+min_bet(8)+rake(8) = 131+8+8+8 = 155... let me recalc
};

// More precise offsets from Table struct
// disc(8) + table_id(32) + authority(32) + pool(32) + game_type(1) + small_blind(8) + big_blind(8) +
// max_players(1) + current_players(1) + hand_number(8) + pot(8) + min_bet(8) + rake_accumulated(8) +
// community_cards(5) + phase(1) + current_player(1) + actions_this_round(1) + dealer_button(1) +
// small_blind_seat(1) + big_blind_seat(1) + last_action_slot(8) + is_delegated(1)
const OFF = {
  TABLE_ID: 8,
  AUTHORITY: 40,
  GAME_TYPE: 104,
  SMALL_BLIND: 105,
  BIG_BLIND: 113,
  MAX_PLAYERS: 121,
  CURRENT_PLAYERS: 122,
  HAND_NUMBER: 123,
  POT: 131,
  MIN_BET: 139,
  RAKE: 147,
  COMMUNITY: 155,
  PHASE: 160,
  CURRENT_PLAYER: 161,
  ACTIONS_THIS_ROUND: 162,
  DEALER_BUTTON: 163,
  SB_SEAT: 164,
  BB_SEAT: 165,
  LAST_ACTION_SLOT: 166,
  IS_DELEGATED: 174,
};

// Seat offsets
const SEAT = {
  WALLET: 8,
  SESSION_KEY: 40,
  TABLE: 72,
  CHIPS: 104,
  BET_THIS_ROUND: 112,
  HOLE_CARDS: 192, // after encrypted(64) + commitment(32) = 112+8+8+64+32 = 224... recalc
  SEAT_NUMBER: 226,
  STATUS: 227,
};

const PHASES = ['Waiting', 'PreFlop', 'Flop', 'Turn', 'River', 'Showdown', 'Complete'];
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const card = (c: number) => c === 0 || c === 255 ? '??' : RANKS[(c - 1) % 13] + SUITS[Math.floor((c - 1) / 13)];

// ── Load keypair ──
function loadKeypair(): Keypair {
  const p = path.join(__dirname, 'cli-player-keypair.json');
  if (fs.existsSync(p)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, 'utf8'))));
  const kp = Keypair.generate();
  fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)));
  console.log(`Created keypair: ${kp.publicKey.toBase58()}`);
  return kp;
}

// ── Send and confirm on L1 (with simulation) ──
async function sendL1(conn: Connection, tx: Transaction, signers: Keypair[]): Promise<string> {
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(...signers);
  // Simulate first to catch errors
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) {
    const logs = sim.value.logs?.slice(-5).join('\n  ') || '';
    throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}\n  ${logs}`);
  }
  const sig = await conn.sendRawTransaction(tx.serialize());
  // Poll confirmation + check errors
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const status = await conn.getSignatureStatuses([sig]);
    const s = status?.value?.[0];
    if (s?.err) throw new Error(`TX error: ${JSON.stringify(s.err)}`);
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return sig;
  }
  throw new Error(`TX not confirmed: ${sig.slice(0, 20)}`);
}

// ── Send and confirm on TEE ──
async function sendTEE(tee: Connection, l1: Connection, tx: Transaction, signers: Keypair[]): Promise<string> {
  tx.feePayer = signers[0].publicKey;
  // TEE requires its own blockhash — L1 blockhash causes "Blockhash not found"
  tx.recentBlockhash = (await tee.getLatestBlockhash()).blockhash;
  tx.sign(...signers);
  const sig = await tee.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const status = await tee.getSignatureStatuses([sig]);
      if (status?.value?.[0]?.confirmationStatus === 'confirmed' || status?.value?.[0]?.confirmationStatus === 'finalized') return sig;
    } catch {}
  }
  return sig; // return even if unconfirmed — TEE may not support getSignatureStatuses
}

// ── Get TEE auth token ──
async function getTeeToken(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/tee/token?force=true`);
  const data = await res.json() as { token?: string };
  if (!data.token) throw new Error('Failed to get TEE token');
  return data.token;
}

async function main() {
  const tablePdaStr = process.argv[2];
  const seatIndex = parseInt(process.argv[3] || '1');
  if (!tablePdaStr) {
    console.log('Usage: npx ts-node scripts/auto-bot.ts <table-pda> [seat-index]');
    process.exit(1);
  }

  const tablePda = new PublicKey(tablePdaStr);
  const bot = loadKeypair();
  const l1 = new Connection(L1_RPC, 'confirmed');

  console.log('🤖 Auto-Bot Starting');
  console.log(`   Wallet: ${bot.publicKey.toBase58()}`);
  console.log(`   Table:  ${tablePdaStr}`);
  console.log(`   Seat:   ${seatIndex}`);

  const balance = await l1.getBalance(bot.publicKey);
  console.log(`   Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  if (balance < 0.05 * LAMPORTS_PER_SOL) {
    console.log('⚠️ Low balance! Requesting airdrop...');
    try {
      const sig = await l1.requestAirdrop(bot.publicKey, 2 * LAMPORTS_PER_SOL);
      await l1.confirmTransaction(sig);
      console.log('✅ Airdrop received');
    } catch (e: any) {
      console.log(`❌ Airdrop failed: ${e.message?.slice(0, 80)}`);
      console.log(`   Fund manually: solana airdrop 2 ${bot.publicKey.toBase58()} --url devnet`);
      process.exit(1);
    }
  }

  // ── Step 1: Register player if needed ──
  const [playerPda] = getPlayerPda(bot.publicKey);
  const [unrefinedPda] = getUnrefinedPda(bot.publicKey);
  const playerInfo = await l1.getAccountInfo(playerPda);
  if (!playerInfo) {
    console.log('📝 Registering player...');
    const tx = new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: bot.publicKey, isSigner: true, isWritable: true },
        { pubkey: playerPda, isSigner: false, isWritable: true },
        { pubkey: TREASURY, isSigner: false, isWritable: true },
        { pubkey: POOL_PDA, isSigner: false, isWritable: true },
        { pubkey: unrefinedPda, isSigner: false, isWritable: true },
        { pubkey: STEEL_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: DISC.register,
    }));
    const sig = await sendL1(l1, tx, [bot]);
    console.log(`   ✅ Registered: ${sig.slice(0, 20)}`);
  } else {
    console.log('✅ Already registered');
  }

  // ── Step 2: Resize vault + deposit_for_join on L1 ──
  // Read table to get big blind for buy-in calculation
  const tableInfo = await l1.getAccountInfo(tablePda);
  if (!tableInfo) {
    // Table might be on TEE — check via API
    console.log('Table not on L1 (delegated to TEE). Reading blinds from TEE...');
  }

  // Read big blind from table data (offset 113 = u64 LE)
  let bigBlind = BigInt(10_000_000); // fallback: 0.01 SOL
  if (tableInfo) {
    bigBlind = tableInfo.data.readBigUInt64LE(OFF.BIG_BLIND);
    console.log(`   Table BB: ${Number(bigBlind)} lamports (${Number(bigBlind) / LAMPORTS_PER_SOL} SOL)`);
  }
  const buyIn = bigBlind * BigInt(20); // 20 BB buy-in

  console.log(`💰 Depositing ${Number(buyIn) / LAMPORTS_PER_SOL} SOL (20 BB)...`);
  const [vaultPda] = getVaultPda(tablePda);
  const [receiptPda] = getReceiptPda(tablePda, seatIndex);
  const [markerPda] = getMarkerPda(bot.publicKey, tablePda);
  const [depositProofPda] = getDepositProofPda(tablePda, seatIndex);

  // Resize vault (idempotent)
  const resizeIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: bot.publicKey, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: DISC.resizeVault,
  });

  // Deposit for join
  const depositData = Buffer.alloc(25);
  DISC.depositForJoin.copy(depositData, 0);
  depositData.writeUInt8(seatIndex, 8);
  depositData.writeBigUInt64LE(buyIn, 9);
  depositData.writeBigUInt64LE(BigInt(0), 17); // reserve = 0

  const depositIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: bot.publicKey, isSigner: true, isWritable: true },
      { pubkey: playerPda, isSigner: false, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: false },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: receiptPda, isSigner: false, isWritable: true },
      { pubkey: markerPda, isSigner: false, isWritable: true },
      { pubkey: depositProofPda, isSigner: false, isWritable: true },
      // SOL table — no SPL accounts
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: depositData,
  });

  const tx1 = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    resizeIx,
    depositIx,
  );
  try {
    const sig = await sendL1(l1, tx1, [bot]);
    console.log(`   ✅ Deposited: ${sig.slice(0, 20)}`);
  } catch (e: any) {
    if (e.message?.includes('already in use') || e.message?.includes('3007') || e.message?.includes('Custom')) {
      console.log('   ⚠️ Already deposited/seated, skipping to session...');
    } else {
      console.error(`   ❌ Deposit failed: ${e.message?.slice(0, 120)}`);
      process.exit(1);
    }
  }

  // ── Step 3: Seat player via API (with retry — skip if already seated) ──
  console.log('🪑 Seating via API...');
  let seated = false;
  // Check if already seated by reading TEE
  try {
    const token = await getTeeToken();
    const teeCheck = new Connection(token ? `${TEE_RPC}?token=${token}` : TEE_RPC, { commitment: 'confirmed', wsEndpoint: 'wss://127.0.0.1:1' });
    const [checkSeat] = getSeatPda(tablePda, seatIndex);
    const seatAcc = await teeCheck.getAccountInfo(checkSeat);
    if (seatAcc) {
      const sd = Buffer.from(seatAcc.data);
      const wallet = new PublicKey(sd.slice(8, 40));
      if (wallet.equals(bot.publicKey)) {
        console.log('   ✅ Already seated on TEE, skipping seat API');
        seated = true;
      }
    }
  } catch {}
  if (!seated) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise(r => setTimeout(r, attempt === 0 ? 8000 : 5000));
    const seatRes = await fetch(`${API_BASE}/api/cash-game/seat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tablePda: tablePdaStr, seatIndex }),
    });
    const seatData = await seatRes.json() as { success?: boolean; error?: string };
    if (seatData.success) {
      console.log(`   ✅ Seated at index ${seatIndex}`);
      seated = true;
      break;
    }
    console.log(`   Attempt ${attempt + 1}: ${seatData.error || JSON.stringify(seatData)}`);
    if (seatData.error?.includes('already occupied') || seatData.error?.includes('already seated')) {
      seated = true;
      break;
    }
  }
  if (!seated) {
    console.log('   ❌ Failed to seat after 5 attempts. Check deposit and try again.');
    process.exit(1);
  }
  } // end if(!seated) seat API block

  // ── Step 4: Create session key on L1 ──
  const sessionKeyPath = path.join(__dirname, 'bot-session-key.json');
  let sessionKey: Keypair;
  if (fs.existsSync(sessionKeyPath)) {
    sessionKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(sessionKeyPath, 'utf8'))));
  } else {
    sessionKey = Keypair.generate();
    fs.writeFileSync(sessionKeyPath, JSON.stringify(Array.from(sessionKey.secretKey)));
  }

  const [sessionPda] = getSessionPda(bot.publicKey);
  const sessionInfo = await l1.getAccountInfo(sessionPda);
  const now = Math.floor(Date.now() / 1000);
  const needsSession = !sessionInfo || (sessionInfo.data.length >= 80 && Number(sessionInfo.data.readBigInt64LE(72)) <= now);

  if (needsSession) {
    console.log('🔑 Creating session key...');
    const validUntil = now + 23 * 3600;
    const sessionData = Buffer.alloc(48);
    DISC.createSession.copy(sessionData, 0);
    sessionKey.publicKey.toBuffer().copy(sessionData, 8);
    sessionData.writeBigInt64LE(BigInt(validUntil), 40);

    const tx2 = new Transaction();
    // Revoke if exists
    if (sessionInfo) {
      const REVOKE_DISC = Buffer.from([86, 92, 198, 120, 144, 2, 7, 194]);
      tx2.add(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: bot.publicKey, isSigner: true, isWritable: true },
          { pubkey: sessionPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: REVOKE_DISC,
      }));
    }
    tx2.add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: bot.publicKey, isSigner: true, isWritable: true },
        { pubkey: sessionPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: sessionData,
    }));
    // Fund session key
    tx2.add(SystemProgram.transfer({
      fromPubkey: bot.publicKey,
      toPubkey: sessionKey.publicKey,
      lamports: 10_000_000, // 0.01 SOL
    }));
    const sig = await sendL1(l1, tx2, [bot]);
    console.log(`   ✅ Session created: ${sig.slice(0, 20)}`);
  } else {
    console.log('✅ Session exists');
  }

  // ── Step 5: Auto-play loop on TEE ──
  console.log('\n🎮 Starting auto-play loop (check/call)...');
  console.log('   Press Ctrl+C to stop\n');

  // Get TEE auth token for reads
  let teeToken: string;
  try {
    teeToken = await getTeeToken();
    console.log('   ✅ TEE auth token acquired');
  } catch (e: any) {
    console.log(`   ⚠️ TEE auth failed: ${e.message?.slice(0, 80)}`);
    teeToken = '';
  }

  const teeUrl = teeToken ? `${TEE_RPC}?token=${teeToken}` : TEE_RPC;
  const tee = new Connection(teeUrl, { commitment: 'confirmed', wsEndpoint: 'wss://127.0.0.1:1' });

  let lastHand = 0;
  let actionCount = 0;

  while (true) {
    try {
      // Read table state from TEE
      const tInfo = await tee.getAccountInfo(tablePda);
      if (!tInfo) {
        console.log('[bot] Table not found on TEE, waiting...');
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      const d = Buffer.from(tInfo.data);
      const phase = d[OFF.PHASE];
      const currentPlayer = d[OFF.CURRENT_PLAYER];
      const handNum = Number(d.readBigUInt64LE(OFF.HAND_NUMBER));
      const pot = Number(d.readBigUInt64LE(OFF.POT));
      const minBet = Number(d.readBigUInt64LE(OFF.MIN_BET));
      const community = Array.from(d.slice(OFF.COMMUNITY, OFF.COMMUNITY + 5));

      if (handNum !== lastHand) {
        lastHand = handNum;
        console.log(`\n═══ Hand #${handNum} ═══`);
      }

      if (phase === 0) {
        // Waiting — nothing to do
        process.stdout.write('.');
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      if (phase >= 5) {
        // Showdown/Complete
        if (phase === 6) {
          console.log(`[Hand #${handNum}] Complete. Pot: ${pot}`);
        }
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // Check if it's my turn
      if (currentPlayer !== seatIndex) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      // Read my seat to decide action
      const [seatPda] = getSeatPda(tablePda, seatIndex);
      const seatInfo = await tee.getAccountInfo(seatPda);
      if (!seatInfo) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      const sd = Buffer.from(seatInfo.data);
      const myChips = Number(sd.readBigUInt64LE(SEAT.CHIPS));
      const myBet = Number(sd.readBigUInt64LE(SEAT.BET_THIS_ROUND));
      const status = sd[SEAT.STATUS];

      if (status !== 1) { // Not Active
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // Decide action: check if possible, otherwise call
      const needToCall = minBet > myBet;
      const action = needToCall ? 2 : 1; // 2=Call, 1=Check
      const actionName = needToCall ? 'CALL' : 'CHECK';

      console.log(`[Hand #${handNum}] ${PHASES[phase]} | My turn (seat ${seatIndex}) | Pot: ${pot} | ${actionName}`);

      // Build and send action on TEE
      const actionData = Buffer.alloc(17);
      DISC.playerAction.copy(actionData, 0);
      actionData.writeUInt8(action, 8);

      const actionIx = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: sessionKey.publicKey, isSigner: true, isWritable: false },
          { pubkey: tablePda, isSigner: false, isWritable: true },
          { pubkey: seatPda, isSigner: false, isWritable: true },
          { pubkey: sessionPda, isSigner: false, isWritable: false },
        ],
        data: actionData,
      });

      const actionTx = new Transaction().add(actionIx);
      try {
        const sig = await sendTEE(tee, l1, actionTx, [sessionKey]);
        actionCount++;
        console.log(`   ✅ ${actionName} #${actionCount}: ${sig.slice(0, 16)}`);
      } catch (e: any) {
        console.log(`   ❌ Action failed: ${e.message?.slice(0, 100)}`);
        // If session expired, exit
        if (e.message?.includes('Session') || e.message?.includes('session')) {
          console.log('Session may be expired. Exiting.');
          process.exit(1);
        }
      }

      await new Promise(r => setTimeout(r, 1500));
    } catch (e: any) {
      console.log(`[bot] Error: ${e.message?.slice(0, 100)}`);
      // Refresh TEE token on auth errors
      if (e.message?.includes('401') || e.message?.includes('auth') || e.message?.includes('token')) {
        try {
          teeToken = await getTeeToken();
          console.log('   Refreshed TEE token');
        } catch {}
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
