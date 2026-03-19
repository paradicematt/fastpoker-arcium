// Verify seat 0 cashout state with CORRECT offsets, then kick seat 1
const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } = require('@solana/web3.js');
const crypto = require('crypto');
const bs58pkg = require('bs58');
const bs58 = bs58pkg.default || bs58pkg;
const nacl = require('tweetnacl');

const PID = new PublicKey('4MLbuVZzXpzWcaZaqxHDkm5JuigZzovsVd6VPNDXnyiB');
const SEAT_SEED = Buffer.from('seat');
const STATUS_NAMES = {0:'Empty',1:'Active',2:'Folded',3:'AllIn',4:'SittingOut',5:'Busted',6:'Leaving'};

// CORRECT offsets from process_cashout_v2.rs and settle.rs
const OFF = {
  WALLET: 8,
  CHIPS: 104,
  STATUS: 227,
  CASHOUT_CHIPS: 246,
  CASHOUT_NONCE: 254,
  VAULT_RESERVE: 262,
  SIT_OUT_TS: 270,
};

const table = new PublicKey('HH3AXAJ6uTpquKXFMPCj2xU2BXp5wYuyxgn7sTmfsHCY');

function readSeat(sd, idx) {
  const wallet = new PublicKey(sd.slice(OFF.WALLET, OFF.WALLET + 32)).toBase58();
  const chips = Number(sd.readBigUInt64LE(OFF.CHIPS));
  const status = sd[OFF.STATUS];
  const cashoutChips = sd.length >= OFF.CASHOUT_CHIPS + 8 ? Number(sd.readBigUInt64LE(OFF.CASHOUT_CHIPS)) : -1;
  const cashoutNonce = sd.length >= OFF.CASHOUT_NONCE + 8 ? Number(sd.readBigUInt64LE(OFF.CASHOUT_NONCE)) : -1;
  const vaultReserve = sd.length >= OFF.VAULT_RESERVE + 8 ? Number(sd.readBigUInt64LE(OFF.VAULT_RESERVE)) : -1;
  const sitOutTs = sd.length >= OFF.SIT_OUT_TS + 8 ? Number(sd.readBigInt64LE(OFF.SIT_OUT_TS)) : 0;
  const isEmpty = wallet === '11111111111111111111111111111111';
  return { idx, wallet, chips, status, cashoutChips, cashoutNonce, vaultReserve, sitOutTs, isEmpty };
}

async function main() {
  const freshKp = Keypair.generate();
  const base = 'https://tee.magicblock.app';
  const cr = await fetch(`${base}/auth/challenge?pubkey=${freshKp.publicKey.toBase58()}`);
  const { challenge } = await cr.json();
  const sig = bs58.encode(Buffer.from(nacl.sign.detached(Buffer.from(challenge), freshKp.secretKey)));
  const lr = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pubkey: freshKp.publicKey.toBase58(), challenge, signature: sig }),
  });
  const { token } = await lr.json();
  const tee = new Connection(`${base}?token=${token}`, 'confirmed');

  const l1 = new Connection('https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df', 'confirmed');
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from('vault'), table.toBuffer()], PID);

  // Vault balance BEFORE
  const vaultBefore = await l1.getAccountInfo(vaultPda);
  const vaultLamportsBefore = vaultBefore?.lamports || 0;
  console.log(`\n=== VAULT BEFORE ===`);
  console.log(`  ${vaultPda.toBase58()}`);
  console.log(`  Balance: ${vaultLamportsBefore / 1e9} SOL (${vaultLamportsBefore} lamports)\n`);

  // Read table
  const tableInfo = await tee.getAccountInfo(table);
  const td = Buffer.from(tableInfo.data);
  // Correct table offsets
  const maxPlayers = td[121];
  const currentPlayers = td[122];
  console.log(`Table: currentPlayers=${currentPlayers} maxPlayers=${maxPlayers}`);

  // Read all seats with CORRECT offsets
  console.log('\n=== ALL SEATS (correct offsets) ===');
  let sittingOutSeats = [];
  let totalVirtualChips = 0;
  for (let i = 0; i < maxPlayers; i++) {
    const [seatPda] = PublicKey.findProgramAddressSync([SEAT_SEED, table.toBuffer(), Buffer.from([i])], PID);
    try {
      const seatInfo = await tee.getAccountInfo(seatPda);
      if (!seatInfo) { console.log(`  Seat ${i}: not found`); continue; }
      const s = readSeat(Buffer.from(seatInfo.data), i);
      const statusName = STATUS_NAMES[s.status] || s.status;
      if (s.isEmpty) {
        console.log(`  Seat ${i}: ${statusName} (empty)`);
      } else {
        console.log(`  Seat ${i}: ${statusName} chips=${s.chips} cashout=${s.cashoutChips} nonce=${s.cashoutNonce} reserve=${s.vaultReserve} wallet=${s.wallet.slice(0,12)}...`);
        totalVirtualChips += s.chips + s.vaultReserve;
        if (s.status === 6) totalVirtualChips += s.cashoutChips; // Leaving — chips already zeroed, cashout pending
      }
      if (s.status === 4) sittingOutSeats.push(s);
    } catch (e) {
      console.log(`  Seat ${i}: error - ${e.message.slice(0, 60)}`);
    }
  }
  console.log(`\n  Total virtual chips across all seats: ${totalVirtualChips} lamports (${totalVirtualChips / 1e9} SOL)`);
  console.log(`  Vault balance: ${vaultLamportsBefore} lamports (${vaultLamportsBefore / 1e9} SOL)`);

  if (sittingOutSeats.length === 0) {
    console.log('\nNo SittingOut players to kick.');
    return;
  }

  // Kick first SittingOut player
  const target = sittingOutSeats[0];
  console.log(`\n=== KICKING SEAT ${target.idx} ===`);
  console.log(`  wallet=${target.wallet.slice(0,20)}... chips=${target.chips}`);

  const disc = Buffer.from(crypto.createHash('sha256').update('global:crank_kick_inactive').digest().slice(0, 8));
  const [targetSeatPda] = PublicKey.findProgramAddressSync([SEAT_SEED, table.toBuffer(), Buffer.from([target.idx])], PID);
  const ix = new TransactionInstruction({
    programId: PID,
    keys: [
      { pubkey: freshKp.publicKey, isSigner: true, isWritable: false },
      { pubkey: table, isSigner: false, isWritable: true },
      { pubkey: targetSeatPda, isSigner: false, isWritable: true },
    ],
    data: disc,
  });
  const tx = new Transaction().add(ix);
  tx.feePayer = freshKp.publicKey;
  tx.recentBlockhash = (await tee.getLatestBlockhash()).blockhash;
  tx.sign(freshKp);

  let txSig;
  try {
    txSig = await tee.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    console.log(`  TX sent: ${txSig}`);
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const st = await tee.getSignatureStatuses([txSig]);
      const s = st?.value?.[0];
      if (s?.err) { console.log(`  TX ERROR: ${JSON.stringify(s.err)}`); break; }
      if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') {
        console.log('  TX CONFIRMED ✅'); break;
      }
    }
  } catch (e) {
    console.log(`  TX FAILED: ${e.message.slice(0, 200)}`);
    return;
  }

  // Re-read after kick
  await new Promise(r => setTimeout(r, 2000));
  console.log('\n=== AFTER KICK ===');
  const seatAfter = await tee.getAccountInfo(targetSeatPda);
  const sa = readSeat(Buffer.from(seatAfter.data), target.idx);
  console.log(`  Seat ${target.idx}: ${STATUS_NAMES[sa.status]} chips=${sa.chips} cashout=${sa.cashoutChips} nonce=${sa.cashoutNonce} reserve=${sa.vaultReserve}`);

  // Vault should NOT have changed (cashout hasn't run)
  const vaultAfter = await l1.getAccountInfo(vaultPda);
  const vaultLamportsAfter = vaultAfter?.lamports || 0;
  console.log(`\n  Vault BEFORE: ${vaultLamportsBefore} lamports`);
  console.log(`  Vault AFTER:  ${vaultLamportsAfter} lamports`);
  console.log(`  Vault change: ${vaultLamportsAfter - vaultLamportsBefore} lamports`);

  console.log('\n=== CASHOUT FLOW EXPLANATION ===');
  console.log('The kick ONLY marks the seat as Leaving with cashout_chips snapshotted.');
  console.log('The actual SOL transfer requires the crank cashout flow:');
  console.log('  1. CommitState (TEE → L1) — syncs seat data to L1');
  console.log('  2. process_cashout_v2 (L1) — vault transfers SOL to player wallet');
  console.log('  3. clear_leaving_seat (TEE) — zeros the seat for reuse');
  console.log('The crank service handles steps 1-3 automatically when running.');
  console.log('Vault balance does NOT change until step 2 completes on L1.');
}
main();
