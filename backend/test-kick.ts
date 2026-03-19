/**
 * Manual test: crank_kick_inactive on a single sitting-out player
 * Run from backend dir: npx ts-node test-kick.ts <table> <seat>
 */
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import * as crypto from 'crypto';
import * as fs from 'fs';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

const PROGRAM_ID = new PublicKey('4MLbuVZzXpzWcaZaqxHDkm5JuigZzovsVd6VPNDXnyiB');
const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';
const TEE_RPC_BASE = 'https://devnet-tee.magicblock.app';
const SEAT_SEED = Buffer.from('seat');

const OFF = {
  PHASE: 160, HAND_NUMBER: 161, CURRENT_PLAYERS: 169, MAX_PLAYERS: 170,
  GAME_TYPE: 171, SEATS_OCCUPIED: 383,
};
const SEAT_STATUS_OFFSET = 227;
const SEAT_WALLET_OFFSET = 8;
const SEAT_CHIPS_OFFSET = 104;
const SEAT_CASHOUT_CHIPS_OFFSET = 246;
const SEAT_CASHOUT_NONCE_OFFSET = 254;
const SEAT_SIT_OUT_TIMESTAMP_OFFSET = 270;
const SEAT_SIT_OUT_COUNT_OFFSET = 240;

const STATUS_NAMES: Record<number, string> = {
  0: 'Empty', 1: 'Active', 2: 'Folded', 3: 'AllIn', 4: 'SittingOut', 5: 'Busted', 6: 'Leaving',
};

const DISC_KICK = Buffer.from(
  crypto.createHash('sha256').update('global:crank_kick_inactive').digest().slice(0, 8),
);

function getSeatPda(table: PublicKey, seatIndex: number): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [SEAT_SEED, table.toBuffer(), Buffer.from([seatIndex])],
    PROGRAM_ID,
  );
  return pda;
}

async function getTeeToken(kp: Keypair): Promise<string> {
  const cr = await fetch(`${TEE_RPC_BASE}/auth/challenge?pubkey=${kp.publicKey.toBase58()}`);
  const { challenge } = (await cr.json()) as any;
  const sig = bs58.encode(Buffer.from(nacl.sign.detached(Buffer.from(challenge), kp.secretKey)));
  const lr = await fetch(`${TEE_RPC_BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pubkey: kp.publicKey.toBase58(), challenge, signature: sig }),
  });
  const { token } = (await lr.json()) as any;
  return token;
}

async function main() {
  const kp = Keypair.fromSecretKey(Uint8Array.from(
    JSON.parse(fs.readFileSync('j:/Poker/contracts/auth/deployers/crank-keypair.json', 'utf-8'))
  ));
  console.log(`Payer: ${kp.publicKey.toBase58()}`);

  const l1 = new Connection(L1_RPC, 'confirmed');
  const token = await getTeeToken(kp);
  const tee = new Connection(`${TEE_RPC_BASE}?token=${token}`, 'confirmed');
  console.log('TEE auth ✅\n');

  const tablePk = new PublicKey(process.argv[2]);
  const seatIdx = parseInt(process.argv[3], 10);
  const seatPda = getSeatPda(tablePk, seatIdx);

  console.log(`Table: ${tablePk.toBase58()}`);
  console.log(`Seat:  ${seatIdx} → ${seatPda.toBase58()}\n`);

  // Read BEFORE state — try TEE first, fall back to L1
  console.log('--- BEFORE ---');
  let tableData: Buffer;
  let seatData: Buffer;
  let readConn = tee;
  try {
    const ti = await tee.getAccountInfo(tablePk);
    if (!ti) throw new Error('null');
    tableData = Buffer.from(ti.data);
    console.log('(read from TEE)');
  } catch {
    console.log('TEE read failed, trying L1...');
    readConn = l1;
    const ti = await l1.getAccountInfo(tablePk);
    if (!ti) { console.log('Table not found on L1 either!'); return; }
    tableData = Buffer.from(ti.data);
    console.log('(read from L1)');
  }

  const playersBefore = tableData[OFF.CURRENT_PLAYERS];
  const occupiedBefore = tableData.readUInt16LE(OFF.SEATS_OCCUPIED);
  const phase = tableData[OFF.PHASE];
  console.log(`Table: phase=${phase} players=${playersBefore}/${tableData[OFF.MAX_PLAYERS]} occupied=0b${occupiedBefore.toString(2).padStart(9, '0')}`);

  try {
    const si = await readConn.getAccountInfo(seatPda);
    if (!si) { console.log('Seat not found!'); return; }
    seatData = Buffer.from(si.data);
  } catch {
    const si = await l1.getAccountInfo(seatPda);
    if (!si) { console.log('Seat not found on L1!'); return; }
    seatData = Buffer.from(si.data);
  }

  const statusBefore = seatData[SEAT_STATUS_OFFSET];
  const chipsBefore = Number(seatData.readBigUInt64LE(SEAT_CHIPS_OFFSET));
  const walletBefore = new PublicKey(seatData.slice(SEAT_WALLET_OFFSET, SEAT_WALLET_OFFSET + 32)).toBase58();
  const cashoutBefore = seatData.length >= SEAT_CASHOUT_CHIPS_OFFSET + 8 ? Number(seatData.readBigUInt64LE(SEAT_CASHOUT_CHIPS_OFFSET)) : 0;
  const nonceBefore = seatData.length >= SEAT_CASHOUT_NONCE_OFFSET + 8 ? Number(seatData.readBigUInt64LE(SEAT_CASHOUT_NONCE_OFFSET)) : 0;
  let sitOutSecs = 0;
  if (seatData.length >= SEAT_SIT_OUT_TIMESTAMP_OFFSET + 8) {
    const ts = Number(seatData.readBigInt64LE(SEAT_SIT_OUT_TIMESTAMP_OFFSET));
    if (ts > 0) sitOutSecs = Math.floor(Date.now() / 1000) - ts;
  }
  const sitOutCount = seatData[SEAT_SIT_OUT_COUNT_OFFSET];

  console.log(`Seat:  status=${STATUS_NAMES[statusBefore]}(${statusBefore}) chips=${chipsBefore} wallet=${walletBefore.slice(0, 16)}...`);
  console.log(`       cashout=${cashoutBefore} nonce=${nonceBefore} sitOut=${sitOutSecs}s count=${sitOutCount}`);
  console.log(`       eligible: ${sitOutSecs >= 300 || (sitOutCount >= 3 && sitOutSecs === 0) ? 'YES' : 'NO (need 5min+)'}`);

  if (statusBefore !== 4) {
    console.log(`\n❌ Seat is ${STATUS_NAMES[statusBefore]} — not SittingOut. Cannot kick.`);
    return;
  }

  // Send crank_kick_inactive
  console.log('\n--- SENDING crank_kick_inactive ---');
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: kp.publicKey, isSigner: true, isWritable: true },
      { pubkey: tablePk, isSigner: false, isWritable: true },
      { pubkey: seatPda, isSigner: false, isWritable: true },
    ],
    data: DISC_KICK,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await tee.getLatestBlockhash()).blockhash;
  tx.sign(kp);

  let sig: string;
  try {
    sig = await tee.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    console.log(`TX sent: ${sig}`);
  } catch (e: any) {
    console.log(`❌ sendRawTransaction failed: ${e.message?.slice(0, 200)}`);
    return;
  }

  // Poll
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const st = await tee.getSignatureStatuses([sig]);
      const s = st?.value?.[0];
      if (s) {
        if (s.err) { console.log(`❌ TX error: ${JSON.stringify(s.err)}`); return; }
        if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') {
          console.log(`✅ TX confirmed!`); break;
        }
      }
    } catch {}
    if (i === 14) console.log('⚠️  Confirmation timeout — checking state anyway');
  }

  // Read AFTER
  await new Promise(r => setTimeout(r, 2000));
  console.log('\n--- AFTER ---');
  let tAfter: Buffer, sAfter: Buffer;
  try {
    const ti = await readConn.getAccountInfo(tablePk);
    tAfter = Buffer.from(ti!.data);
  } catch {
    const ti = await l1.getAccountInfo(tablePk);
    tAfter = Buffer.from(ti!.data);
  }
  try {
    const si = await readConn.getAccountInfo(seatPda);
    sAfter = Buffer.from(si!.data);
  } catch {
    const si = await l1.getAccountInfo(seatPda);
    sAfter = Buffer.from(si!.data);
  }

  const playersAfter = tAfter[OFF.CURRENT_PLAYERS];
  const occupiedAfter = tAfter.readUInt16LE(OFF.SEATS_OCCUPIED);
  const statusAfter = sAfter[SEAT_STATUS_OFFSET];
  const chipsAfter = Number(sAfter.readBigUInt64LE(SEAT_CHIPS_OFFSET));
  const cashoutAfter = sAfter.length >= SEAT_CASHOUT_CHIPS_OFFSET + 8 ? Number(sAfter.readBigUInt64LE(SEAT_CASHOUT_CHIPS_OFFSET)) : 0;
  const nonceAfter = sAfter.length >= SEAT_CASHOUT_NONCE_OFFSET + 8 ? Number(sAfter.readBigUInt64LE(SEAT_CASHOUT_NONCE_OFFSET)) : 0;
  const walletAfter = new PublicKey(sAfter.slice(SEAT_WALLET_OFFSET, SEAT_WALLET_OFFSET + 32)).toBase58();

  console.log(`Table: players=${playersAfter}/${tableData[OFF.MAX_PLAYERS]} occupied=0b${occupiedAfter.toString(2).padStart(9, '0')}`);
  console.log(`Seat:  status=${STATUS_NAMES[statusAfter]}(${statusAfter}) chips=${chipsAfter}`);
  console.log(`       cashout=${cashoutAfter} nonce=${nonceAfter} wallet=${walletAfter.slice(0, 16)}...`);

  // Verify
  console.log('\n--- VERIFICATION ---');
  const checks = [
    { name: 'Status → Leaving(6)', pass: statusAfter === 6 },
    { name: 'Chips → 0', pass: chipsAfter === 0 },
    { name: 'cashout_chips snapshotted', pass: cashoutAfter > 0 || chipsBefore === 0 },
    { name: 'cashout_nonce incremented', pass: nonceAfter > nonceBefore },
    { name: 'currentPlayers decremented', pass: playersAfter === playersBefore - 1 },
    { name: 'Seat bit cleared', pass: (occupiedAfter & (1 << seatIdx)) === 0 },
    { name: 'Wallet preserved', pass: walletAfter === walletBefore },
  ];
  let allPass = true;
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}`);
    if (!c.pass) allPass = false;
  }
  console.log(allPass ? '\n🎉 ALL CHECKS PASSED!' : '\n⚠️  SOME CHECKS FAILED');
}

main().catch(e => console.error(e));
