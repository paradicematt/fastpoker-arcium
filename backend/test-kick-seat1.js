// Check all seats on the table, then kick the next SittingOut player
const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } = require('@solana/web3.js');
const crypto = require('crypto');
const bs58pkg = require('bs58');
const bs58 = bs58pkg.default || bs58pkg;
const nacl = require('tweetnacl');
const fs = require('fs');

const PID = new PublicKey('4MLbuVZzXpzWcaZaqxHDkm5JuigZzovsVd6VPNDXnyiB');
const SEAT_SEED = Buffer.from('seat');
const STATUS_NAMES = {0:'Empty',1:'Active',2:'Folded',3:'AllIn',4:'SittingOut',5:'Busted',6:'Leaving'};
const table = new PublicKey('HH3AXAJ6uTpquKXFMPCj2xU2BXp5wYuyxgn7sTmfsHCY');

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
  console.log('TEE auth OK\n');

  // Also check vault on L1
  const l1 = new Connection('https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df', 'confirmed');
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from('vault'), table.toBuffer()], PID);
  const vaultInfo = await l1.getAccountInfo(vaultPda);
  if (vaultInfo) {
    console.log(`Vault PDA: ${vaultPda.toBase58()}`);
    console.log(`Vault SOL: ${vaultInfo.lamports / 1e9} SOL (${vaultInfo.lamports} lamports)\n`);
  } else {
    console.log('Vault PDA not found on L1!\n');
  }

  // Read table
  const tableInfo = await tee.getAccountInfo(table);
  const td = Buffer.from(tableInfo.data);
  const currentPlayers = td[122]; // correct offset
  const maxPlayers = td[121];
  const phase = td[155];
  const gameType = td[104];
  const PHASE_NAMES = {0:'Waiting',1:'Preflop',2:'Flop',3:'Turn',4:'River',5:'Showdown',6:'Starting',7:'Complete'};
  console.log(`Table: phase=${PHASE_NAMES[phase]||phase} players=${currentPlayers}/${maxPlayers} gameType=${gameType}`);

  // Read all seats
  const sittingOut = [];
  for (let i = 0; i < maxPlayers; i++) {
    const [seatPda] = PublicKey.findProgramAddressSync([SEAT_SEED, table.toBuffer(), Buffer.from([i])], PID);
    try {
      const seatInfo = await tee.getAccountInfo(seatPda);
      if (!seatInfo) { console.log(`  Seat ${i}: not found`); continue; }
      const sd = Buffer.from(seatInfo.data);
      const status = sd[227];
      const chips = Number(sd.readBigUInt64LE(104));
      const wallet = new PublicKey(sd.slice(8, 40)).toBase58();
      const cashoutChips = sd.length >= 254 ? Number(sd.readBigUInt64LE(238)) : 0;
      const cashoutNonce = sd.length >= 262 ? Number(sd.readBigUInt64LE(246)) : 0;
      const vaultReserve = sd.length >= 270 ? Number(sd.readBigUInt64LE(254)) : 0;
      const isEmpty = wallet === '11111111111111111111111111111111';
      console.log(`  Seat ${i}: status=${STATUS_NAMES[status]||status} chips=${chips}${isEmpty ? ' (empty wallet)' : ` wallet=${wallet.slice(0,12)}...`} cashout=${cashoutChips} nonce=${cashoutNonce} reserve=${vaultReserve}`);
      if (status === 4) sittingOut.push({ idx: i, chips, wallet, seatPda });
    } catch (e) {
      console.log(`  Seat ${i}: error - ${e.message.slice(0, 80)}`);
    }
  }

  console.log(`\nSittingOut players: ${sittingOut.length}`);
  if (sittingOut.length === 0) {
    console.log('No SittingOut players to kick.');
    return;
  }

  // Pick the target seat (first SittingOut)
  const target = sittingOut[0];
  console.log(`\nTarget: seat ${target.idx}, chips=${target.chips}, wallet=${target.wallet.slice(0,20)}...`);

  // Ask for confirmation via command line arg
  if (process.argv[2] !== '--kick') {
    console.log('\nRun with --kick to execute the kick. Dry run only.');
    return;
  }

  // Execute kick
  console.log('\n--- KICKING ---');
  const disc = Buffer.from(crypto.createHash('sha256').update('global:crank_kick_inactive').digest().slice(0, 8));
  const ix = new TransactionInstruction({
    programId: PID,
    keys: [
      { pubkey: freshKp.publicKey, isSigner: true, isWritable: false },
      { pubkey: table, isSigner: false, isWritable: true },
      { pubkey: target.seatPda, isSigner: false, isWritable: true },
    ],
    data: disc,
  });
  const tx = new Transaction().add(ix);
  tx.feePayer = freshKp.publicKey;
  tx.recentBlockhash = (await tee.getLatestBlockhash()).blockhash;
  tx.sign(freshKp);
  try {
    const txSig = await tee.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    console.log('TX SENT:', txSig);
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const st = await tee.getSignatureStatuses([txSig]);
      const s = st?.value?.[0];
      if (s?.err) { console.log('TX ERROR:', JSON.stringify(s.err)); break; }
      if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') {
        console.log('TX CONFIRMED ✅'); break;
      }
    }
  } catch (e) {
    console.log('TX FAILED:', e.message.slice(0, 200));
    return;
  }

  // Re-read after
  await new Promise(r => setTimeout(r, 2000));
  console.log('\n--- AFTER KICK ---');
  const si = await tee.getAccountInfo(target.seatPda);
  const sd = Buffer.from(si.data);
  console.log(`  Seat ${target.idx}: status=${STATUS_NAMES[sd[227]]||sd[227]} chips=${Number(sd.readBigUInt64LE(104))} cashout=${Number(sd.readBigUInt64LE(238))} nonce=${Number(sd.readBigUInt64LE(246))}`);

  // Re-check vault (shouldn't change yet — cashout is L1 side)
  const vaultInfo2 = await l1.getAccountInfo(vaultPda);
  if (vaultInfo2) {
    console.log(`\nVault SOL after: ${vaultInfo2.lamports / 1e9} SOL (${vaultInfo2.lamports} lamports)`);
    if (vaultInfo) {
      const diff = vaultInfo2.lamports - vaultInfo.lamports;
      console.log(`  Change: ${diff} lamports (expected: 0 — cashout hasn't run yet)`);
    }
  }

  console.log('\n⚠️  NOTE: The kick only marks the seat as Leaving.');
  console.log('   The actual SOL transfer requires the crank cashout flow:');
  console.log('   1. CommitState (TEE → L1)');
  console.log('   2. process_cashout_v2 (L1 vault → player wallet)');
  console.log('   3. clear_leaving_seat (TEE — zeros the seat)');
  console.log('   The crank service handles this automatically when running.');
}
main();
