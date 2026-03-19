/**
 * Localnet Bootstrap — Run ONCE before E2E tests to set up on-chain state.
 * Creates: POKER mint, Steel pool, dealer registry, test cash tables.
 * 
 * Usage: npx ts-node --transpile-only e2e/localnet-bootstrap.ts
 * Or:    npx playwright test e2e/bootstrap.spec.ts (runs as first test)
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RPC_URL = process.env.E2E_RPC_URL || 'http://localhost:8899';
const ANCHOR_PROGRAM_ID = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');

// PDA helpers
function pda(seeds: Buffer[], prog: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, prog)[0];
}
const getPool = () => pda([Buffer.from('pool')], STEEL_PROGRAM_ID);
const getUnrefined = (w: PublicKey) => pda([Buffer.from('unrefined'), w.toBuffer()], STEEL_PROGRAM_ID);
const getTable = (id: Buffer) => pda([Buffer.from('table'), id], ANCHOR_PROGRAM_ID);
const getSeat = (t: PublicKey, i: number) => pda([Buffer.from('seat'), t.toBuffer(), Buffer.from([i])], ANCHOR_PROGRAM_ID);
const getSeatCards = (t: PublicKey, i: number) => pda([Buffer.from('seat_cards'), t.toBuffer(), Buffer.from([i])], ANCHOR_PROGRAM_ID);
const getDeckState = (t: PublicKey) => pda([Buffer.from('deck_state'), t.toBuffer()], ANCHOR_PROGRAM_ID);
const getVault = (t: PublicKey) => pda([Buffer.from('vault'), t.toBuffer()], ANCHOR_PROGRAM_ID);
const getReceipt = (t: PublicKey, i: number) => pda([Buffer.from('receipt'), t.toBuffer(), Buffer.from([i])], ANCHOR_PROGRAM_ID);
const getTallyEr = (t: PublicKey) => pda([Buffer.from('crank_tally_er'), t.toBuffer()], ANCHOR_PROGRAM_ID);
const getTallyL1 = (t: PublicKey) => pda([Buffer.from('crank_tally_l1'), t.toBuffer()], ANCHOR_PROGRAM_ID);
const getPlayer = (w: PublicKey) => pda([Buffer.from('player'), w.toBuffer()], ANCHOR_PROGRAM_ID);
const getDealerReg = () => pda([Buffer.from('dealer_registry')], ANCHOR_PROGRAM_ID);

// Discriminators (Anchor-style: sha256("global:<name>")[0..8])
function disc(name: string): Buffer {
  return Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
}

// State file to avoid re-bootstrapping
const STATE_FILE = path.join(__dirname, '.localnet-state.json');

interface LocalnetState {
  pokerMint: string;
  poolPda: string;
  tables: { id: string; pda: string; type: string }[];
  bootstrappedAt: string;
}

function loadState(): LocalnetState | null {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {}
  return null;
}

function saveState(state: LocalnetState) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function send(c: Connection, ix: TransactionInstruction, signers: Keypair[], label: string): Promise<boolean> {
  try {
    await sendAndConfirmTransaction(c, new Transaction().add(ix), signers, { commitment: 'confirmed', skipPreflight: true });
    return true;
  } catch (e: any) {
    console.log(`  ❌ ${label}: ${e.message?.slice(0, 200)}`);
    if (e.logs) e.logs.slice(-3).forEach((l: string) => console.log(`     ${l}`));
    return false;
  }
}

export async function bootstrap(): Promise<LocalnetState> {
  const conn = new Connection(RPC_URL, 'confirmed');
  console.log('🔧 Localnet Bootstrap');
  console.log(`  RPC: ${RPC_URL}`);

  // Check if already bootstrapped
  const existing = loadState();
  if (existing) {
    const poolInfo = await conn.getAccountInfo(new PublicKey(existing.poolPda));
    if (poolInfo) {
      console.log('  ✓ Already bootstrapped — skipping');
      return existing;
    }
    console.log('  ⚠ State file exists but pool not found — re-bootstrapping');
  }

  // Admin keypair (funded via airdrop)
  const admin = Keypair.generate();
  const sig = await conn.requestAirdrop(admin.publicKey, 10 * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, 'confirmed');
  console.log(`  Admin: ${admin.publicKey.toBase58().slice(0, 12)}.. (10 SOL)`);

  // Fund treasury
  const treasurySig = await conn.requestAirdrop(TREASURY, 1 * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(treasurySig, 'confirmed');
  console.log(`  Treasury funded: ${TREASURY.toBase58().slice(0, 12)}..`);

  // ── 1. Create POKER mint ──
  console.log('\n  === Creating POKER Mint ===');
  const mintAuthority = admin;
  const pokerMint = await createMint(conn, admin, mintAuthority.publicKey, null, 9); // 9 decimals
  console.log(`  POKER Mint: ${pokerMint.toBase58()}`);

  // ── 2. Initialize Steel Pool ──
  console.log('\n  === Initializing Steel Pool ===');
  const poolPda = getPool();
  const poolInfo = await conn.getAccountInfo(poolPda);
  if (poolInfo) {
    console.log('  ✓ Pool already exists');
  } else {
    // Steel Initialize: disc(0) = first byte is instruction discriminator
    // Steel uses raw discriminator byte, not Anchor sha256
    const initData = Buffer.alloc(1);
    initData.writeUInt8(0, 0); // Initialize = 0
    const ok = await send(conn, new TransactionInstruction({
      programId: STEEL_PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: poolPda, isSigner: false, isWritable: true },
        { pubkey: pokerMint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: initData,
    }), [admin], 'steel_initialize');
    if (!ok) throw new Error('Steel pool init failed');
    console.log(`  ✓ Pool initialized: ${poolPda.toBase58().slice(0, 12)}..`);
  }

  // ── 3. Init Dealer Registry (Anchor) ──
  console.log('\n  === Initializing Dealer Registry ===');
  const dealerReg = getDealerReg();
  const regInfo = await conn.getAccountInfo(dealerReg);
  if (regInfo) {
    console.log('  ✓ Dealer registry already exists');
  } else {
    const ok = await send(conn, new TransactionInstruction({
      programId: ANCHOR_PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: dealerReg, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: disc('init_dealer_registry'),
    }), [admin], 'init_dealer_registry');
    if (ok) console.log('  ✓ Dealer registry initialized');
  }

  // ── 4. Create test cash tables ──
  console.log('\n  === Creating Test Cash Tables ===');
  const tables: { id: string; pda: string; type: string }[] = [];

  // Table config serializer: id(32) + gameType(1) + stakeLevel(1) + maxPlayers(1) + tier(1)
  function serializeCfg(id: Buffer, gt: number, st: number, mp: number, tier: number) {
    const b = Buffer.alloc(36); id.copy(b); b.writeUInt8(gt, 32); b.writeUInt8(st, 33); b.writeUInt8(mp, 34); b.writeUInt8(tier, 35); return b;
  }

  async function createTable(label: string, gt: number, st: number, mp: number, tier: number): Promise<PublicKey> {
    const tableId = crypto.randomBytes(32);
    const t = getTable(tableId);
    const ok = await send(conn, new TransactionInstruction({
      programId: ANCHOR_PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: t, isSigner: false, isWritable: true },
        { pubkey: poolPda, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([disc('create_table'), serializeCfg(tableId, gt, st, mp, tier)]),
    }), [admin], `create_table(${label})`);
    if (!ok) throw new Error(`create_table(${label}) failed`);

    // Init seats
    for (let i = 0; i < mp; i++) {
      await send(conn, new TransactionInstruction({
        programId: ANCHOR_PROGRAM_ID,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: true },
          { pubkey: t, isSigner: false, isWritable: false },
          { pubkey: getSeat(t, i), isSigner: false, isWritable: true },
          { pubkey: getSeatCards(t, i), isSigner: false, isWritable: true },
          { pubkey: getDeckState(t), isSigner: false, isWritable: true },
          { pubkey: getReceipt(t, i), isSigner: false, isWritable: true },
          { pubkey: getVault(t), isSigner: false, isWritable: true },
          { pubkey: getTallyEr(t), isSigner: false, isWritable: true },
          { pubkey: getTallyL1(t), isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([disc('init_table_seat'), Buffer.from([i])]),
      }), [admin], `init_seat_${i}`);
    }

    tables.push({ id: tableId.toString('hex'), pda: t.toBase58(), type: label });
    console.log(`  ✓ ${label}: ${t.toBase58().slice(0, 12)}.. (${mp} seats)`);
    return t;
  }

  // Cash HU Micro (SOL)
  await createTable('Cash HU Micro', 3, 0, 2, 0);
  // Cash 6-max Micro (SOL) 
  await createTable('Cash 6-max Micro', 3, 0, 6, 0);
  // Cash 9-max Low (SOL)
  await createTable('Cash 9-max Low', 3, 1, 9, 0);

  // ── 5. Mint POKER tokens to test wallets ──
  console.log('\n  === Minting POKER tokens to test wallets ===');
  // Derive the same deterministic wallets used by E2E tests
  for (let i = 0; i < 3; i++) {
    const seed = crypto.createHash('sha256').update(`fastpoker-e2e-wallet-v1-${i}`).digest();
    const wallet = Keypair.fromSeed(seed);
    try {
      const ata = await getOrCreateAssociatedTokenAccount(conn, admin, pokerMint, wallet.publicKey);
      await mintTo(conn, admin, pokerMint, ata.address, admin, 1_000_000_000_000); // 1000 POKER (9 decimals)
      console.log(`  ✓ Wallet ${i}: ${wallet.publicKey.toBase58().slice(0, 8)}.. → 1000 POKER`);
    } catch (e: any) {
      console.log(`  ⚠ Wallet ${i} mint failed: ${e.message?.slice(0, 100)}`);
    }
  }

  // ── Save state ──
  const state: LocalnetState = {
    pokerMint: pokerMint.toBase58(),
    poolPda: poolPda.toBase58(),
    tables,
    bootstrappedAt: new Date().toISOString(),
  };
  saveState(state);

  // Write mint address to .env.local for frontend
  const envPath = path.join(__dirname, '..', '.env.local');
  let envContent = '';
  try { envContent = fs.readFileSync(envPath, 'utf-8'); } catch {}
  if (!envContent.includes('NEXT_PUBLIC_POKER_MINT')) {
    envContent += `\nNEXT_PUBLIC_POKER_MINT=${pokerMint.toBase58()}\n`;
    fs.writeFileSync(envPath, envContent);
    console.log(`\n  Updated .env.local with POKER_MINT=${pokerMint.toBase58().slice(0, 12)}..`);
  }

  console.log('\n✅ Bootstrap complete!');
  console.log(`  POKER Mint: ${pokerMint.toBase58()}`);
  console.log(`  Pool PDA:   ${poolPda.toBase58()}`);
  console.log(`  Tables:     ${tables.length}`);
  return state;
}

// Run directly
if (require.main === module) {
  bootstrap().catch(e => { console.error(e); process.exit(1); });
}
