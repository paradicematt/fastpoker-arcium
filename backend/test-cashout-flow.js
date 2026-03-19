/**
 * test-cashout-flow.js
 * 
 * End-to-end test for the cashout claim flow:
 * 1. Find all tables with players
 * 2. Identify any Leaving seats or kickable SittingOut seats
 * 3. If needed, kick a SittingOut player to create a Leaving seat
 * 4. Verify the seat state (status=6, cashout_chips > 0)
 * 5. Read vault balance BEFORE cashout
 * 6. Execute the 3-step cashout: CommitState → process_cashout_v2 → clear_leaving_seat
 * 7. Read vault balance AFTER cashout
 * 8. Verify the delta matches cashout_chips
 * 
 * Usage: node test-cashout-flow.js [tablePda]
 */
const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction } = require('@solana/web3.js');
const crypto = require('crypto');
const fs = require('fs');
const nacl = require('tweetnacl');
const bs58pkg = require('bs58');
const bs58 = bs58pkg.default || bs58pkg;

const PID = new PublicKey('4MLbuVZzXpzWcaZaqxHDkm5JuigZzovsVd6VPNDXnyiB');
const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');
const MAGIC_CONTEXT = new PublicKey('MagicContext1111111111111111111111111111111');

const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';
const TEE_BASE = 'https://tee.magicblock.app';

// Seeds
const TABLE_SEED = Buffer.from('table');
const SEAT_SEED = Buffer.from('seat');
const VAULT_SEED = Buffer.from('vault');
const RECEIPT_SEED = Buffer.from('receipt');
const MARKER_SEED = Buffer.from('player_table');

// Discriminators
const DISC = {
  commitState: Buffer.from(crypto.createHash('sha256').update('global:commit_state').digest().slice(0, 8)),
  processCashoutV2: Buffer.from(crypto.createHash('sha256').update('global:process_cashout_v2').digest().slice(0, 8)),
  clearLeavingSeat: Buffer.from(crypto.createHash('sha256').update('global:clear_leaving_seat').digest().slice(0, 8)),
  crankKickInactive: Buffer.from(crypto.createHash('sha256').update('global:crank_kick_inactive').digest().slice(0, 8)),
};

// Seat offsets
const OFF = {
  WALLET: 8, TABLE: 72, CHIPS: 104, STATUS: 227,
  CASHOUT_CHIPS: 246, CASHOUT_NONCE: 254, VAULT_RESERVE: 262, SIT_OUT_TS: 270,
};
const STATUS_NAMES = {0:'Empty',1:'Active',2:'Folded',3:'AllIn',4:'SittingOut',5:'Busted',6:'Leaving'};

// Table offsets
const TABLE_OFF_MAX_PLAYERS = 121;
const TABLE_OFF_CURRENT_PLAYERS = 122;
const TABLE_OFF_RAKE_ACCUMULATED = 147;

// Vault offsets
const VAULT_OFF_TABLE = 8;
const VAULT_OFF_TOTAL_DEPOSITED = 40;
const VAULT_OFF_TOTAL_WITHDRAWN = 48;
const VAULT_OFF_TOTAL_RAKE_DISTRIBUTED = 65;

function getSeatPda(table, idx) {
  return PublicKey.findProgramAddressSync([SEAT_SEED, table.toBuffer(), Buffer.from([idx])], PID)[0];
}
function getVaultPda(table) {
  return PublicKey.findProgramAddressSync([VAULT_SEED, table.toBuffer()], PID)[0];
}
function getReceiptPda(table, idx) {
  return PublicKey.findProgramAddressSync([RECEIPT_SEED, table.toBuffer(), Buffer.from([idx])], PID)[0];
}
function getMarkerPda(wallet, table) {
  return PublicKey.findProgramAddressSync([MARKER_SEED, wallet.toBuffer(), table.toBuffer()], PID)[0];
}

function readSeat(sd, idx) {
  const wallet = new PublicKey(sd.slice(OFF.WALLET, OFF.WALLET + 32));
  const chips = Number(sd.readBigUInt64LE(OFF.CHIPS));
  const status = sd[OFF.STATUS];
  const cashoutChips = sd.length >= OFF.CASHOUT_CHIPS + 8 ? Number(sd.readBigUInt64LE(OFF.CASHOUT_CHIPS)) : 0;
  const cashoutNonce = sd.length >= OFF.CASHOUT_NONCE + 8 ? Number(sd.readBigUInt64LE(OFF.CASHOUT_NONCE)) : 0;
  const vaultReserve = sd.length >= OFF.VAULT_RESERVE + 8 ? Number(sd.readBigUInt64LE(OFF.VAULT_RESERVE)) : 0;
  const isEmpty = wallet.equals(PublicKey.default);
  return { idx, wallet, chips, status, statusName: STATUS_NAMES[status] || `?${status}`, cashoutChips, cashoutNonce, vaultReserve, isEmpty };
}

function readVault(vd) {
  if (!vd || vd.length < 73) return null;
  return {
    table: new PublicKey(vd.slice(VAULT_OFF_TABLE, VAULT_OFF_TABLE + 32)),
    totalDeposited: Number(vd.readBigUInt64LE(VAULT_OFF_TOTAL_DEPOSITED)),
    totalWithdrawn: Number(vd.readBigUInt64LE(VAULT_OFF_TOTAL_WITHDRAWN)),
    totalRakeDistributed: vd.length >= VAULT_OFF_TOTAL_RAKE_DISTRIBUTED + 8
      ? Number(vd.readBigUInt64LE(VAULT_OFF_TOTAL_RAKE_DISTRIBUTED)) : 0,
  };
}

async function getTeeConnection() {
  const kp = Keypair.generate();
  const cr = await fetch(`${TEE_BASE}/auth/challenge?pubkey=${kp.publicKey.toBase58()}`);
  const { challenge } = await cr.json();
  const sig = nacl.sign.detached(Buffer.from(challenge, 'utf-8'), kp.secretKey);
  const sigB58 = bs58.encode(Buffer.from(sig));
  const lr = await fetch(`${TEE_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pubkey: kp.publicKey.toBase58(), challenge, signature: sigB58 }),
  });
  const { token } = await lr.json();
  return { conn: new Connection(`${TEE_BASE}?token=${token}`, 'confirmed'), kp };
}

function getCrankKeypair() {
  const paths = [
    'j:/Poker/contracts/auth/deployers/crank-keypair.json',
    'j:/Poker/.keys/crank.json',
    'j:/Poker/contracts/auth/deployers/anchor-mini-game-deployer-keypair.json',
  ];
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, 'utf-8'))));
    } catch {}
  }
  throw new Error('No crank/admin keypair found');
}

async function pollConfirm(conn, sig, max = 15) {
  for (let i = 0; i < max; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const s = await conn.getSignatureStatuses([sig]);
      const v = s?.value?.[0];
      if (v?.err) return false;
      if (v?.confirmationStatus === 'confirmed' || v?.confirmationStatus === 'finalized') return true;
    } catch {}
  }
  return false;
}

async function main() {
  const argTable = process.argv[2];
  
  console.log('\n=== CASHOUT FLOW TEST ===\n');
  
  // Connect
  const l1 = new Connection(L1_RPC, 'confirmed');
  const { conn: tee, kp: teeKp } = await getTeeConnection();
  const l1Kp = getCrankKeypair();
  console.log(`TEE keypair: ${teeKp.publicKey.toBase58().slice(0, 12)}...`);
  console.log(`L1 payer:    ${l1Kp.publicKey.toBase58().slice(0, 12)}...`);
  console.log(`L1 balance:  ${(await l1.getBalance(l1Kp.publicKey)) / 1e9} SOL\n`);

  // Find tables via vault discovery on L1
  let tablePda;
  if (argTable) {
    tablePda = new PublicKey(argTable);
    console.log(`Using specified table: ${tablePda.toBase58()}`);
  } else {
    console.log('Discovering tables via vault PDAs on L1...');
    const vaults = await l1.getProgramAccounts(PID, { filters: [{ dataSize: 105 }] });
    console.log(`Found ${vaults.length} vault(s)\n`);

    // Find a table with a Leaving seat or kickable SittingOut player
    for (const { account } of vaults) {
      const vd = readVault(Buffer.from(account.data));
      if (!vd) continue;
      const tPda = vd.table;
      
      const tableInfo = await tee.getAccountInfo(tPda).catch(() => null);
      if (!tableInfo) continue;
      const td = Buffer.from(tableInfo.data);
      const maxPlayers = td[TABLE_OFF_MAX_PLAYERS];
      const currentPlayers = td[TABLE_OFF_CURRENT_PLAYERS];
      if (currentPlayers === 0) continue;

      for (let i = 0; i < maxPlayers; i++) {
        const seatPda = getSeatPda(tPda, i);
        const seatInfo = await tee.getAccountInfo(seatPda).catch(() => null);
        if (!seatInfo) continue;
        const seat = readSeat(Buffer.from(seatInfo.data), i);
        if (seat.isEmpty) continue;
        
        if (seat.status === 6) { // Already Leaving
          tablePda = tPda;
          console.log(`Found Leaving seat ${i} at table ${tPda.toBase58().slice(0, 12)}... (cashoutChips=${seat.cashoutChips})`);
          break;
        }
        if (seat.status === 4) { // SittingOut — can kick
          tablePda = tPda;
          console.log(`Found SittingOut seat ${i} at table ${tPda.toBase58().slice(0, 12)}... — will kick`);
          break;
        }
      }
      if (tablePda) break;
    }
    if (!tablePda) {
      console.log('No table with Leaving or SittingOut players found. Cannot test cashout.');
      return;
    }
  }

  // Read table state
  const tableInfo = await tee.getAccountInfo(tablePda);
  if (!tableInfo) { console.log('Table not found on TEE'); return; }
  const td = Buffer.from(tableInfo.data);
  const maxPlayers = td[TABLE_OFF_MAX_PLAYERS];
  const currentPlayers = td[TABLE_OFF_CURRENT_PLAYERS];
  const rakeAccumulated = Number(td.readBigUInt64LE(TABLE_OFF_RAKE_ACCUMULATED));
  console.log(`\nTable: ${tablePda.toBase58()}`);
  console.log(`  maxPlayers=${maxPlayers}, currentPlayers=${currentPlayers}, rakeAccumulated=${rakeAccumulated}`);

  // Read all seats
  console.log('\n--- Seats ---');
  let targetSeat = null;
  for (let i = 0; i < maxPlayers; i++) {
    const seatPda = getSeatPda(tablePda, i);
    const seatInfo = await tee.getAccountInfo(seatPda).catch(() => null);
    if (!seatInfo) { console.log(`  Seat ${i}: not found`); continue; }
    const seat = readSeat(Buffer.from(seatInfo.data), i);
    if (seat.isEmpty) { console.log(`  Seat ${i}: empty`); continue; }
    console.log(`  Seat ${i}: ${seat.statusName} | wallet=${seat.wallet.toBase58().slice(0, 12)}... | chips=${seat.chips} | cashoutChips=${seat.cashoutChips} | nonce=${seat.cashoutNonce}`);
    
    if (seat.status === 6 && !targetSeat) targetSeat = seat;
    if (seat.status === 4 && !targetSeat) targetSeat = seat;
  }

  if (!targetSeat) {
    console.log('\nNo Leaving or SittingOut seat found on this table.');
    return;
  }

  // If SittingOut, kick first
  if (targetSeat.status === 4) {
    console.log(`\n--- Step 0: Kicking seat ${targetSeat.idx} (SittingOut → Leaving) ---`);
    const seatPda = getSeatPda(tablePda, targetSeat.idx);
    const kickData = Buffer.alloc(8);
    DISC.crankKickInactive.copy(kickData, 0);
    const kickIx = new TransactionInstruction({
      programId: PID,
      keys: [
        { pubkey: teeKp.publicKey, isSigner: true, isWritable: true },
        { pubkey: tablePda, isSigner: false, isWritable: true },
        { pubkey: seatPda, isSigner: false, isWritable: true },
      ],
      data: kickData,
    });
    const kickTx = new Transaction().add(kickIx);
    kickTx.feePayer = teeKp.publicKey;
    kickTx.recentBlockhash = (await tee.getLatestBlockhash()).blockhash;
    kickTx.sign(teeKp);
    try {
      const kickSig = await tee.sendRawTransaction(kickTx.serialize(), { skipPreflight: true });
      const kickOk = await pollConfirm(tee, kickSig);
      if (!kickOk) { console.log('  Kick failed to confirm'); return; }
      console.log(`  Kicked! sig: ${kickSig.slice(0, 24)}...`);
    } catch (e) {
      console.log(`  Kick failed: ${e.message?.slice(0, 100)}`);
      return;
    }

    // Re-read seat after kick
    await new Promise(r => setTimeout(r, 2000));
    const seatInfo2 = await tee.getAccountInfo(seatPda);
    const seat2 = readSeat(Buffer.from(seatInfo2.data), targetSeat.idx);
    console.log(`  Post-kick: status=${seat2.statusName}, cashoutChips=${seat2.cashoutChips}, nonce=${seat2.cashoutNonce}`);
    targetSeat = seat2;
    
    if (targetSeat.status !== 6) {
      console.log(`  ERROR: Expected Leaving(6), got ${targetSeat.statusName}(${targetSeat.status})`);
      return;
    }
  }

  // Read vault balance BEFORE
  const vaultPda = getVaultPda(tablePda);
  const vaultInfoBefore = await l1.getAccountInfo(vaultPda);
  const vaultBalBefore = vaultInfoBefore ? vaultInfoBefore.lamports : 0;
  const vaultData = vaultInfoBefore ? readVault(Buffer.from(vaultInfoBefore.data)) : null;
  console.log(`\n--- Vault BEFORE ---`);
  console.log(`  Balance: ${vaultBalBefore / 1e9} SOL (${vaultBalBefore} lamports)`);
  if (vaultData) {
    console.log(`  totalDeposited: ${vaultData.totalDeposited}, totalWithdrawn: ${vaultData.totalWithdrawn}`);
    console.log(`  totalRakeDistributed: ${vaultData.totalRakeDistributed}`);
  }

  // Read player wallet balance BEFORE
  const playerBalBefore = await l1.getBalance(targetSeat.wallet);
  console.log(`  Player wallet (${targetSeat.wallet.toBase58().slice(0, 12)}...) balance: ${playerBalBefore / 1e9} SOL`);

  const seatPda = getSeatPda(tablePda, targetSeat.idx);
  const receiptPda = getReceiptPda(tablePda, targetSeat.idx);
  const markerPda = getMarkerPda(targetSeat.wallet, tablePda);

  // Step 1: CommitState on TEE
  console.log(`\n--- Step 1: CommitState (seat ${targetSeat.idx} → L1) ---`);
  try {
    const commitIx = new TransactionInstruction({
      programId: PID,
      data: DISC.commitState,
      keys: [
        { pubkey: teeKp.publicKey, isSigner: true, isWritable: true },
        { pubkey: MAGIC_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: MAGIC_CONTEXT, isSigner: false, isWritable: true },
        { pubkey: seatPda, isSigner: false, isWritable: true },
      ],
    });
    const commitTx = new Transaction().add(commitIx);
    commitTx.feePayer = teeKp.publicKey;
    commitTx.recentBlockhash = (await tee.getLatestBlockhash()).blockhash;
    commitTx.sign(teeKp);
    const commitSig = await tee.sendRawTransaction(commitTx.serialize(), { skipPreflight: true });
    const commitOk = await pollConfirm(tee, commitSig);
    console.log(`  ${commitOk ? 'OK' : 'FAILED'} | sig: ${commitSig.slice(0, 24)}...`);
    if (!commitOk) { console.log('  CommitState failed to confirm — aborting'); return; }
  } catch (e) {
    console.log(`  CommitState error: ${e.message?.slice(0, 100)}`);
    return;
  }

  // Wait for L1 propagation
  console.log('  Waiting 6s for L1 propagation...');
  await new Promise(r => setTimeout(r, 6000));

  // Step 2: process_cashout_v2 on L1
  console.log(`\n--- Step 2: process_cashout_v2 on L1 ---`);
  let cashoutSig = '';
  try {
    const data = Buffer.alloc(9);
    DISC.processCashoutV2.copy(data, 0);
    data.writeUInt8(targetSeat.idx, 8);

    const cashoutIx = new TransactionInstruction({
      programId: PID,
      keys: [
        { pubkey: l1Kp.publicKey,   isSigner: true,  isWritable: true  },
        { pubkey: tablePda,          isSigner: false, isWritable: false },
        { pubkey: seatPda,           isSigner: false, isWritable: false },
        { pubkey: vaultPda,          isSigner: false, isWritable: true  },
        { pubkey: receiptPda,        isSigner: false, isWritable: true  },
        { pubkey: targetSeat.wallet, isSigner: false, isWritable: true  },
        { pubkey: markerPda,         isSigner: false, isWritable: true  },
        { pubkey: PID,               isSigner: false, isWritable: false },
        { pubkey: PID,               isSigner: false, isWritable: false },
        { pubkey: PID,               isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const cashoutTx = new Transaction().add(cashoutIx);
    cashoutTx.feePayer = l1Kp.publicKey;
    cashoutSig = await sendAndConfirmTransaction(l1, cashoutTx, [l1Kp], { commitment: 'confirmed' });
    console.log(`  OK | sig: ${cashoutSig.slice(0, 24)}...`);
  } catch (e) {
    console.log(`  process_cashout_v2 FAILED: ${e.message?.slice(0, 150)}`);
    console.log('  Funds are safe in vault. Retry or wait for crank.');
    return;
  }

  // Step 3: clear_leaving_seat on TEE
  console.log(`\n--- Step 3: clear_leaving_seat on TEE ---`);
  try {
    const clearData = Buffer.alloc(8);
    DISC.clearLeavingSeat.copy(clearData, 0);
    const clearIx = new TransactionInstruction({
      programId: PID,
      keys: [
        { pubkey: teeKp.publicKey, isSigner: true,  isWritable: false },
        { pubkey: tablePda,         isSigner: false, isWritable: true  },
        { pubkey: seatPda,          isSigner: false, isWritable: true  },
        { pubkey: receiptPda,       isSigner: false, isWritable: false },
      ],
      data: clearData,
    });
    const clearTx = new Transaction().add(clearIx);
    clearTx.feePayer = teeKp.publicKey;
    clearTx.recentBlockhash = (await tee.getLatestBlockhash()).blockhash;
    clearTx.sign(teeKp);
    const clearSig = await tee.sendRawTransaction(clearTx.serialize(), { skipPreflight: true });
    const clearOk = await pollConfirm(tee, clearSig);
    console.log(`  ${clearOk ? 'OK' : 'FAILED'} | sig: ${clearSig.slice(0, 24)}...`);
  } catch (e) {
    console.log(`  clear_leaving_seat failed (non-fatal): ${e.message?.slice(0, 80)}`);
  }

  // Verify AFTER
  await new Promise(r => setTimeout(r, 3000));

  const vaultInfoAfter = await l1.getAccountInfo(vaultPda);
  const vaultBalAfter = vaultInfoAfter ? vaultInfoAfter.lamports : 0;
  const vaultDataAfter = vaultInfoAfter ? readVault(Buffer.from(vaultInfoAfter.data)) : null;
  const playerBalAfter = await l1.getBalance(targetSeat.wallet);

  console.log(`\n--- Vault AFTER ---`);
  console.log(`  Balance: ${vaultBalAfter / 1e9} SOL (${vaultBalAfter} lamports)`);
  if (vaultDataAfter) {
    console.log(`  totalDeposited: ${vaultDataAfter.totalDeposited}, totalWithdrawn: ${vaultDataAfter.totalWithdrawn}`);
  }

  console.log(`\n--- RESULTS ---`);
  const vaultDelta = vaultBalBefore - vaultBalAfter;
  const playerDelta = playerBalAfter - playerBalBefore;
  console.log(`  Vault delta:  -${vaultDelta / 1e9} SOL (-${vaultDelta} lamports)`);
  console.log(`  Player delta: +${playerDelta / 1e9} SOL (+${playerDelta} lamports)`);
  console.log(`  Expected:     ${targetSeat.cashoutChips / 1e9} SOL (${targetSeat.cashoutChips} lamports)`);

  if (vaultDelta === targetSeat.cashoutChips && playerDelta === targetSeat.cashoutChips) {
    console.log('\n  ✅ PASS — Vault decreased and player increased by exact cashout amount!');
  } else if (vaultDelta === targetSeat.cashoutChips) {
    console.log('\n  ⚠️  Vault matches but player delta differs (marker lamports returned?)');
  } else {
    console.log('\n  ❌ MISMATCH — investigate vault/player balances');
  }

  // Re-read seat to confirm it's cleared
  const seatInfoFinal = await tee.getAccountInfo(getSeatPda(tablePda, targetSeat.idx)).catch(() => null);
  if (seatInfoFinal) {
    const finalSeat = readSeat(Buffer.from(seatInfoFinal.data), targetSeat.idx);
    console.log(`\n  Final seat ${targetSeat.idx}: status=${finalSeat.statusName}, chips=${finalSeat.chips}, cashoutChips=${finalSeat.cashoutChips}`);
    if (finalSeat.isEmpty || (finalSeat.status === 0 && finalSeat.cashoutChips === 0)) {
      console.log('  ✅ Seat cleared successfully');
    } else {
      console.log('  ⚠️  Seat not fully cleared (crank will handle)');
    }
  }

  console.log('\n=== TEST COMPLETE ===\n');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
