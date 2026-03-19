// Test crank_kick_inactive with a FRESH ephemeral keypair (not the stale crank keypair)
const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } = require('@solana/web3.js');
const crypto = require('crypto');
const bs58pkg = require('bs58');
const bs58 = bs58pkg.default || bs58pkg;
const nacl = require('tweetnacl');
const fs = require('fs');

const PID = new PublicKey('4MLbuVZzXpzWcaZaqxHDkm5JuigZzovsVd6VPNDXnyiB');
const SEAT_SEED = Buffer.from('seat');
const STATUS_NAMES = {0:'Empty',1:'Active',2:'Folded',3:'AllIn',4:'SittingOut',5:'Busted',6:'Leaving'};

async function main() {
  // Use a FRESH ephemeral keypair — TEE is gasless, no SOL needed
  const freshKp = Keypair.generate();
  console.log('Fresh keypair:', freshKp.publicKey.toBase58());

  // Auth with fresh keypair
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

  const table = new PublicKey('HH3AXAJ6uTpquKXFMPCj2xU2BXp5wYuyxgn7sTmfsHCY');
  const seatIdx = parseInt(process.argv[2] || '0', 10);
  const [seatPda] = PublicKey.findProgramAddressSync([SEAT_SEED, table.toBuffer(), Buffer.from([seatIdx])], PID);

  // Read BEFORE state
  console.log('--- BEFORE ---');
  const tableInfo = await tee.getAccountInfo(table);
  if (!tableInfo) { console.log('Table not found!'); return; }
  const td = Buffer.from(tableInfo.data);
  const playersBefore = td[169];
  console.log(`Table: players=${playersBefore}/${td[170]}`);

  const seatInfo = await tee.getAccountInfo(seatPda);
  if (!seatInfo) { console.log('Seat not found!'); return; }
  const sd = Buffer.from(seatInfo.data);
  const statusBefore = sd[227];
  const chipsBefore = Number(sd.readBigUInt64LE(104));
  const wallet = new PublicKey(sd.slice(8, 40)).toBase58();
  const cashoutBefore = sd.length >= 254 ? Number(sd.readBigUInt64LE(246)) : 0;
  const nonceBefore = sd.length >= 262 ? Number(sd.readBigUInt64LE(254)) : 0;
  console.log(`Seat ${seatIdx}: status=${STATUS_NAMES[statusBefore]||statusBefore} chips=${chipsBefore}`);
  console.log(`  wallet=${wallet.slice(0,20)}... cashout=${cashoutBefore} nonce=${nonceBefore}`);

  if (statusBefore !== 4) {
    console.log(`\nSeat is ${STATUS_NAMES[statusBefore]||statusBefore}, not SittingOut. Cannot kick.`);
    return;
  }

  // Send crank_kick_inactive with FRESH keypair
  console.log('\n--- SENDING crank_kick_inactive (fresh keypair) ---');
  const disc = Buffer.from(crypto.createHash('sha256').update('global:crank_kick_inactive').digest().slice(0, 8));
  const ix = new TransactionInstruction({
    programId: PID,
    keys: [
      { pubkey: freshKp.publicKey, isSigner: true, isWritable: false },
      { pubkey: table, isSigner: false, isWritable: true },
      { pubkey: seatPda, isSigner: false, isWritable: true },
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
    console.log('TX SENT:', txSig);
  } catch (e) {
    console.log('TX FAILED:', e.message.slice(0, 200));
    return;
  }

  // Poll for confirmation
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const st = await tee.getSignatureStatuses([txSig]);
      const s = st?.value?.[0];
      if (s) {
        if (s.err) { console.log('TX ERROR:', JSON.stringify(s.err)); break; }
        if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') {
          console.log('TX CONFIRMED ✅'); break;
        }
      }
    } catch {}
    if (i === 14) console.log('Timeout — checking state anyway');
  }

  // Read AFTER state
  await new Promise(r => setTimeout(r, 2000));
  console.log('\n--- AFTER ---');
  const ti2 = await tee.getAccountInfo(table);
  const td2 = Buffer.from(ti2.data);
  const playersAfter = td2[169];
  console.log(`Table: players=${playersAfter}/${td2[170]}`);

  const si2 = await tee.getAccountInfo(seatPda);
  const sd2 = Buffer.from(si2.data);
  const statusAfter = sd2[227];
  const chipsAfter = Number(sd2.readBigUInt64LE(104));
  const cashoutAfter = sd2.length >= 254 ? Number(sd2.readBigUInt64LE(246)) : 0;
  const nonceAfter = sd2.length >= 262 ? Number(sd2.readBigUInt64LE(254)) : 0;
  const walletAfter = new PublicKey(sd2.slice(8, 40)).toBase58();
  console.log(`Seat ${seatIdx}: status=${STATUS_NAMES[statusAfter]||statusAfter} chips=${chipsAfter}`);
  console.log(`  wallet=${walletAfter.slice(0,20)}... cashout=${cashoutAfter} nonce=${nonceAfter}`);

  // Verify
  console.log('\n--- VERIFICATION ---');
  const checks = [
    ['Status -> Leaving(6)', statusAfter === 6],
    ['Chips -> 0', chipsAfter === 0],
    ['cashout_chips set', cashoutAfter > 0 || chipsBefore === 0],
    ['nonce incremented', nonceAfter > nonceBefore],
    ['currentPlayers decremented', playersAfter === playersBefore - 1],
    ['Wallet preserved', walletAfter === wallet],
  ];
  let allPass = true;
  for (const [name, pass] of checks) {
    console.log(`  ${pass ? '✅' : '❌'} ${name}`);
    if (!pass) allPass = false;
  }
  console.log(allPass ? '\n🎉 ALL CHECKS PASSED!' : '\n⚠️ SOME CHECKS FAILED');
}
main();
