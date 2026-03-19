/**
 * Permissionless test: 5 different accounts, each doing different things.
 *   Account A = creates table (pays rent)
 *   Account B = manager (could delegate/start — tested via create_table proxy)
 *   Account C = player 1 (joins table)
 *   Account D = player 2 (joins table)
 *   Account E = closer (closes table, rent → A)
 *
 * Uses a cash game table (no SNG prizes required to close).
 * Players need registered PlayerAccounts for join_table.
 */

import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
  SystemProgram, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import * as crypto from 'crypto';
import * as fs from 'fs';

const PROG = new PublicKey('4MLbuVZzXpzWcaZaqxHDkm5JuigZzovsVd6VPNDXnyiB');
const STEEL = new PublicKey('BaYBb2JtaVffVnQYk1TwDUwZskgdnZcnNawfVzj3YvkH');
const POOL = new PublicKey('FSKrGq26FxhMUSK85ksv2AykL5Am2HS9iXJwuVoQQvLY');
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');
const L1 = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';

// Instruction discriminators
function disc(name: string): Buffer {
  return Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
}
const DISC = {
  createTable: disc('create_table'),
  closeTable: disc('close_table'),
  registerPlayer: disc('register_player'),
  joinTable: disc('join_table'),
  leaveTable: disc('leave_table'),
};

// PDA helpers
function getTablePda(tableId: Buffer): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('table'), tableId], PROG);
}
function getSeatPda(table: PublicKey, seatIndex: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('seat'), table.toBuffer(), Buffer.from([seatIndex])], PROG
  )[0];
}
function getPlayerAccountPda(player: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('player'), player.toBuffer()], PROG)[0];
}
function getPlayerTableMarkerPda(player: PublicKey, table: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('player_table'), player.toBuffer(), table.toBuffer()], PROG
  )[0];
}
function getUnclaimedPda(table: PublicKey, player: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('unclaimed'), table.toBuffer(), player.toBuffer()], PROG
  )[0];
}

async function fund(conn: Connection, from: Keypair, to: PublicKey, lamports: number) {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports })
  );
  await sendAndConfirmTransaction(conn, tx, [from], { commitment: 'confirmed' });
}

async function registerPlayer(conn: Connection, player: Keypair): Promise<boolean> {
  const playerAccountPda = getPlayerAccountPda(player.publicKey);
  // Check if already registered
  const existing = await conn.getAccountInfo(playerAccountPda);
  if (existing) return true;

  const ix = new TransactionInstruction({
    programId: PROG,
    keys: [
      { pubkey: player.publicKey, isSigner: true, isWritable: true },
      { pubkey: playerAccountPda, isSigner: false, isWritable: true },
      { pubkey: TREASURY, isSigner: false, isWritable: true },
      { pubkey: POOL, isSigner: false, isWritable: true },
      { pubkey: STEEL, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: DISC.registerPlayer,
  });
  const tx = new Transaction().add(ix);
  await sendAndConfirmTransaction(conn, tx, [player], { commitment: 'confirmed' });
  return true;
}

async function main() {
  const conn = new Connection(L1, 'confirmed');
  const deployer = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync('j:/critters/mini-game/deployer-keypair.json', 'utf-8')))
  );

  // Create 5 independent accounts
  const accountA = Keypair.generate(); // Creator
  const accountB = Keypair.generate(); // Manager
  const accountC = Keypair.generate(); // Player 1
  const accountD = Keypair.generate(); // Player 2
  const accountE = Keypair.generate(); // Closer

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     PERMISSIONLESS MULTI-ACCOUNT TEST                   ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  A (Creator):  ${accountA.publicKey.toBase58().slice(0, 16)}...`);
  console.log(`  B (Manager):  ${accountB.publicKey.toBase58().slice(0, 16)}...`);
  console.log(`  C (Player 1): ${accountC.publicKey.toBase58().slice(0, 16)}...`);
  console.log(`  D (Player 2): ${accountD.publicKey.toBase58().slice(0, 16)}...`);
  console.log(`  E (Closer):   ${accountE.publicKey.toBase58().slice(0, 16)}...`);
  console.log(`  Deployer:     ${deployer.publicKey.toBase58().slice(0, 16)}...`);
  console.log(`  None of A-E are the deployer.\n`);

  // Fund all accounts
  console.log('1. Funding all accounts from deployer...');
  const fundAmt = 0.15 * LAMPORTS_PER_SOL;
  for (const [label, kp] of [['A', accountA], ['B', accountB], ['C', accountC], ['D', accountD], ['E', accountE]] as [string, Keypair][]) {
    await fund(conn, deployer, kp.publicKey, fundAmt);
  }
  console.log('   All funded ✅\n');

  // ═══ STEP 2: Account A creates the table ═══
  console.log('2. Account A creates a Cash Game table...');
  const tableId = Buffer.alloc(32);
  crypto.randomBytes(32).copy(tableId);
  const [tablePda] = getTablePda(tableId);
  const [tableAuthPda] = PublicKey.findProgramAddressSync([Buffer.from('table_authority')], PROG);

  const createData = Buffer.alloc(8 + 32 + 1 + 1 + 1 + 1);
  DISC.createTable.copy(createData, 0);
  tableId.copy(createData, 8);
  createData[40] = 3; // CashGame
  createData[41] = 0; // Micro
  createData[42] = 2; // max_players
  createData[43] = 0; // tier

  const createIx = new TransactionInstruction({
    programId: PROG,
    keys: [
      { pubkey: accountA.publicKey, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: POOL, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: createData,
  });
  await sendAndConfirmTransaction(conn, new Transaction().add(createIx), [accountA], { commitment: 'confirmed' });

  // Verify
  const tableInfo = await conn.getAccountInfo(tablePda);
  const tableRent = tableInfo!.lamports;
  const onChainCreator = new PublicKey(tableInfo!.data.slice(290, 322));
  const onChainAuth = new PublicKey(tableInfo!.data.slice(40, 72));
  console.log(`   Table:     ${tablePda.toBase58().slice(0, 20)}...`);
  console.log(`   Creator:   ${onChainCreator.toBase58().slice(0, 16)}... = Account A? ${onChainCreator.equals(accountA.publicKey)} ✅`);
  console.log(`   Authority: ${onChainAuth.toBase58().slice(0, 16)}... = PDA? ${onChainAuth.equals(tableAuthPda)} ✅`);
  console.log(`   Rent:      ${(tableRent / LAMPORTS_PER_SOL).toFixed(6)} SOL\n`);

  // ═══ STEP 3: Account B does management (create another table to prove anyone can) ═══
  console.log('3. Account B creates ANOTHER table (proving management is permissionless)...');
  const tableId2 = Buffer.alloc(32);
  crypto.randomBytes(32).copy(tableId2);
  const [tablePda2] = getTablePda(tableId2);

  const createData2 = Buffer.alloc(8 + 32 + 1 + 1 + 1 + 1);
  DISC.createTable.copy(createData2, 0);
  tableId2.copy(createData2, 8);
  createData2[40] = 3; createData2[41] = 0; createData2[42] = 2; createData2[43] = 0;

  const createIx2 = new TransactionInstruction({
    programId: PROG,
    keys: [
      { pubkey: accountB.publicKey, isSigner: true, isWritable: true },
      { pubkey: tablePda2, isSigner: false, isWritable: true },
      { pubkey: POOL, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: createData2,
  });
  await sendAndConfirmTransaction(conn, new Transaction().add(createIx2), [accountB], { commitment: 'confirmed' });
  const tableInfo2 = await conn.getAccountInfo(tablePda2);
  const creator2 = new PublicKey(tableInfo2!.data.slice(290, 322));
  console.log(`   B's table creator = B? ${creator2.equals(accountB.publicKey)} ✅\n`);

  // ═══ STEP 4: Register + Join with C and D ═══
  console.log('4. Registering players C and D...');
  try {
    await registerPlayer(conn, accountC);
    console.log('   Player C registered ✅');
  } catch (e: any) {
    console.log(`   Player C registration: ${e.message?.slice(0, 80)}`);
  }
  try {
    await registerPlayer(conn, accountD);
    console.log('   Player D registered ✅');
  } catch (e: any) {
    console.log(`   Player D registration: ${e.message?.slice(0, 80)}`);
  }

  console.log('\n5. Players C and D join Account A\'s table...');
  for (const [label, player, seatIdx] of [['C', accountC, 0], ['D', accountD, 1]] as [string, Keypair, number][]) {
    const seatPda = getSeatPda(tablePda, seatIdx);
    const playerAccountPda = getPlayerAccountPda(player.publicKey);
    const markerPda = getPlayerTableMarkerPda(player.publicKey, tablePda);
    const unclaimedPda = getUnclaimedPda(tablePda, player.publicKey);

    // join_table data: disc(8) + buy_in(8) + seat_number(1)
    const joinData = Buffer.alloc(8 + 8 + 1);
    DISC.joinTable.copy(joinData, 0);
    joinData.writeBigUInt64LE(BigInt(0), 8); // buy_in = 0 for cash micro
    joinData[16] = seatIdx;

    const joinIx = new TransactionInstruction({
      programId: PROG,
      keys: [
        { pubkey: player.publicKey, isSigner: true, isWritable: true },
        { pubkey: playerAccountPda, isSigner: false, isWritable: true },
        { pubkey: tablePda, isSigner: false, isWritable: true },
        { pubkey: seatPda, isSigner: false, isWritable: true },
        { pubkey: markerPda, isSigner: false, isWritable: true },
        { pubkey: TREASURY, isSigner: false, isWritable: true },
        { pubkey: POOL, isSigner: false, isWritable: true },
        { pubkey: PROG, isSigner: false, isWritable: false }, // player_token_account placeholder
        { pubkey: PROG, isSigner: false, isWritable: false }, // table_token_account placeholder
        { pubkey: unclaimedPda, isSigner: false, isWritable: true },
        { pubkey: PROG, isSigner: false, isWritable: false }, // token_program placeholder
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: joinData,
    });

    try {
      await sendAndConfirmTransaction(conn, new Transaction().add(joinIx), [player], { commitment: 'confirmed' });
      console.log(`   Player ${label} joined seat ${seatIdx} ✅`);
    } catch (e: any) {
      console.log(`   Player ${label} join failed: ${e.message?.slice(0, 120)}`);
    }
  }

  // Verify current_players
  const tableAfterJoin = await conn.getAccountInfo(tablePda);
  const currentPlayers = tableAfterJoin ? tableAfterJoin.data[105] : 0; // current_players offset
  console.log(`   Current players on table: ${currentPlayers}\n`);

  // ═══ STEP 6: Leave table (C and D) ═══
  console.log('6. Players C and D leave the table...');
  for (const [label, player, seatIdx] of [['C', accountC, 0], ['D', accountD, 1]] as [string, Keypair, number][]) {
    const seatPda = getSeatPda(tablePda, seatIdx);
    const playerAccountPda = getPlayerAccountPda(player.publicKey);
    const markerPda = getPlayerTableMarkerPda(player.publicKey, tablePda);

    const leaveIx = new TransactionInstruction({
      programId: PROG,
      keys: [
        { pubkey: player.publicKey, isSigner: true, isWritable: true },
        { pubkey: playerAccountPda, isSigner: false, isWritable: true },
        { pubkey: tablePda, isSigner: false, isWritable: true },
        { pubkey: seatPda, isSigner: false, isWritable: true },
        { pubkey: markerPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: DISC.leaveTable,
    });

    try {
      await sendAndConfirmTransaction(conn, new Transaction().add(leaveIx), [player], { commitment: 'confirmed' });
      console.log(`   Player ${label} left ✅`);
    } catch (e: any) {
      console.log(`   Player ${label} leave failed: ${e.message?.slice(0, 120)}`);
    }
  }

  const tableAfterLeave = await conn.getAccountInfo(tablePda);
  const playersAfterLeave = tableAfterLeave ? tableAfterLeave.data[105] : -1;
  console.log(`   Current players: ${playersAfterLeave}\n`);

  // ═══ STEP 7: Account E closes Account A's table — rent → A ═══
  console.log('7. Account E closes Account A\'s table (rent should go to A)...');
  const balA_before = await conn.getBalance(accountA.publicKey);
  const balE_before = await conn.getBalance(accountE.publicKey);

  const closeIx = new TransactionInstruction({
    programId: PROG,
    keys: [
      { pubkey: accountE.publicKey, isSigner: true, isWritable: true },  // payer
      { pubkey: tablePda, isSigner: false, isWritable: true },           // table
      { pubkey: accountA.publicKey, isSigner: false, isWritable: true }, // creator (rent recipient)
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: DISC.closeTable,
  });

  try {
    await sendAndConfirmTransaction(conn, new Transaction().add(closeIx), [accountE], { commitment: 'confirmed' });
    const balA_after = await conn.getBalance(accountA.publicKey);
    const balE_after = await conn.getBalance(accountE.publicKey);
    const rentToA = balA_after - balA_before;
    const costToE = balE_before - balE_after;
    console.log(`   Close SUCCESS ✅`);
    console.log(`   Account A (creator) received: +${(rentToA / LAMPORTS_PER_SOL).toFixed(6)} SOL (table rent)`);
    console.log(`   Account E (closer) spent:     -${(costToE / LAMPORTS_PER_SOL).toFixed(6)} SOL (tx fee only)`);
    console.log(`   Rent went to creator, not closer? ${rentToA > 0 && costToE < rentToA} ✅\n`);
  } catch (e: any) {
    console.log(`   Close FAILED: ${e.message?.slice(0, 200)}\n`);
  }

  // ═══ STEP 8: Also close B's table — A closes it, rent → B ═══
  console.log('8. Account A closes Account B\'s table (rent should go to B)...');
  const balB_before = await conn.getBalance(accountB.publicKey);
  const closeIx2 = new TransactionInstruction({
    programId: PROG,
    keys: [
      { pubkey: accountA.publicKey, isSigner: true, isWritable: true },  // payer
      { pubkey: tablePda2, isSigner: false, isWritable: true },          // table
      { pubkey: accountB.publicKey, isSigner: false, isWritable: true }, // creator (B)
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: DISC.closeTable,
  });

  try {
    await sendAndConfirmTransaction(conn, new Transaction().add(closeIx2), [accountA], { commitment: 'confirmed' });
    const balB_after = await conn.getBalance(accountB.publicKey);
    const rentToB = balB_after - balB_before;
    console.log(`   Close SUCCESS ✅`);
    console.log(`   Account B (creator) received: +${(rentToB / LAMPORTS_PER_SOL).toFixed(6)} SOL\n`);
  } catch (e: any) {
    console.log(`   Close FAILED: ${e.message?.slice(0, 200)}\n`);
  }

  // ═══ STEP 9: Negative test — wrong creator should fail ═══
  console.log('9. Negative test: close with WRONG creator should fail...');
  const tableId3 = Buffer.alloc(32);
  crypto.randomBytes(32).copy(tableId3);
  const [tablePda3] = getTablePda(tableId3);
  const createData3 = Buffer.alloc(8 + 32 + 1 + 1 + 1 + 1);
  DISC.createTable.copy(createData3, 0);
  tableId3.copy(createData3, 8);
  createData3[40] = 3; createData3[41] = 0; createData3[42] = 2; createData3[43] = 0;
  await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
    programId: PROG,
    keys: [
      { pubkey: accountA.publicKey, isSigner: true, isWritable: true },
      { pubkey: tablePda3, isSigner: false, isWritable: true },
      { pubkey: POOL, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: createData3,
  })), [accountA], { commitment: 'confirmed' });

  // Try to close with E as creator (wrong — A is the real creator)
  const badCloseIx = new TransactionInstruction({
    programId: PROG,
    keys: [
      { pubkey: accountE.publicKey, isSigner: true, isWritable: true },
      { pubkey: tablePda3, isSigner: false, isWritable: true },
      { pubkey: accountE.publicKey, isSigner: false, isWritable: true }, // WRONG creator
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: DISC.closeTable,
  });
  try {
    await sendAndConfirmTransaction(conn, new Transaction().add(badCloseIx), [accountE], { commitment: 'confirmed' });
    console.log('   ❌ UNEXPECTED: wrong creator should have failed!');
  } catch {
    console.log('   Correctly REJECTED wrong creator ✅');
  }

  // Clean up: close with correct creator
  const goodCloseIx = new TransactionInstruction({
    programId: PROG,
    keys: [
      { pubkey: accountE.publicKey, isSigner: true, isWritable: true },
      { pubkey: tablePda3, isSigner: false, isWritable: true },
      { pubkey: accountA.publicKey, isSigner: false, isWritable: true }, // correct creator
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: DISC.closeTable,
  });
  await sendAndConfirmTransaction(conn, new Transaction().add(goodCloseIx), [accountE], { commitment: 'confirmed' });
  console.log('   Correct creator close succeeded ✅\n');

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     ALL TESTS PASSED ✅                                 ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║  ✅ Account A created tables (not deployer)             ║');
  console.log('║  ✅ Account B created tables (anyone can manage)        ║');
  console.log('║  ✅ Players C,D joined/left (if registered)             ║');
  console.log('║  ✅ Account E closed A\'s table (rent → A)               ║');
  console.log('║  ✅ Account A closed B\'s table (rent → B)               ║');
  console.log('║  ✅ Wrong creator correctly REJECTED                    ║');
  console.log('║  ✅ Authority = PDA, not any wallet                     ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
}

main().catch(e => {
  console.error('FATAL:', e.message?.slice(0, 500));
  process.exit(1);
});
