/**
 * Claim unrefined POKER from player1 for SPL cash game E2E test.
 * Uses claim_all (disc 6) to mint POKER SPL tokens to player1's ATA.
 * 
 * Usage: npx ts-node scripts/claim-for-spl-test.ts
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress, getAccount, createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import * as fs from 'fs';

const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const POOL_PDA = new PublicKey('FSKrGq26FxhMUSK85ksv2AykL5Am2HS9iXJwuVoQQvLY');
const POKER_MINT = new PublicKey('DiJC3FVReapYYDwRnPMrCRH7aYyeJ47Nu81MemTaHZWX');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const CLAIM_ALL_DISC = 6;
const DEPLOYER_KEY = 'j:/Poker/contracts/auth/deployers/anchor-mini-game-deployer-keypair.json';

// Players to claim from — pick the ones with the most unrefined
const CLAIMERS = [
  { path: 'tests/keys/player1.json', label: 'player1' },
  { path: 'tests/keys/player2.json', label: 'player2' },
  { path: 'tests/keys/player6.json', label: 'player6' },
];

function getUnrefinedPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('unrefined'), owner.toBuffer()], STEEL_PROGRAM_ID
  )[0];
}

function getMintAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool')], STEEL_PROGRAM_ID
  )[0];
}

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(path, 'utf-8'))));
}

async function readUnrefined(conn: Connection, owner: PublicKey): Promise<{ unrefined: number; refined: number } | null> {
  const pda = getUnrefinedPda(owner);
  const info = await conn.getAccountInfo(pda);
  if (!info || info.data.length < 56) return null;
  const d = Buffer.from(info.data);
  return {
    unrefined: Number(d.readBigUInt64LE(40)) / 1e6,
    refined: Number(d.readBigUInt64LE(48)) / 1e6,
  };
}

async function main() {
  const conn = new Connection(L1_RPC, 'confirmed');
  const deployer = loadKeypair(DEPLOYER_KEY);

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║   CLAIM UNREFINED POKER FOR SPL CASH GAME TEST             ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  for (const { path, label } of CLAIMERS) {
    const claimer = loadKeypair(path);
    const before = await readUnrefined(conn, claimer.publicKey);
    if (!before || before.unrefined === 0) {
      console.log(`  ${label}: No unrefined balance — skip`);
      continue;
    }

    console.log(`═══ ${label} (${claimer.publicKey.toBase58().slice(0, 20)}...) ═══`);
    console.log(`  Unrefined: ${before.unrefined.toFixed(2)} POKER`);
    console.log(`  Refined:   ${before.refined.toFixed(6)} POKER`);
    const expectedNet = before.unrefined * 0.9 + before.refined;
    console.log(`  Expected mint: ~${expectedNet.toFixed(2)} POKER (90% unrefined + refined)\n`);

    // Get or create ATA
    const claimerAta = await getAssociatedTokenAddress(POKER_MINT, claimer.publicKey);
    let needsAta = false;
    try { await getAccount(conn, claimerAta); } catch { needsAta = true; }

    const tx = new Transaction();
    if (needsAta) {
      console.log('  Creating ATA...');
      tx.add(createAssociatedTokenAccountInstruction(deployer.publicKey, claimerAta, claimer.publicKey, POKER_MINT));
    }

    // claim_all (disc 6)
    const ix = new TransactionInstruction({
      programId: STEEL_PROGRAM_ID,
      keys: [
        { pubkey: claimer.publicKey,                  isSigner: true,  isWritable: true  },
        { pubkey: getUnrefinedPda(claimer.publicKey),  isSigner: false, isWritable: true  },
        { pubkey: POOL_PDA,                            isSigner: false, isWritable: true  },
        { pubkey: claimerAta,                          isSigner: false, isWritable: true  },
        { pubkey: POKER_MINT,                          isSigner: false, isWritable: true  },
        { pubkey: getMintAuthorityPda(),                isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID,                    isSigner: false, isWritable: false },
      ],
      data: Buffer.from([CLAIM_ALL_DISC]),
    });
    tx.add(ix);

    tx.feePayer = deployer.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.sign(deployer, claimer);

    try {
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      console.log(`  TX: ${sig}`);
      const result = await conn.confirmTransaction(sig, 'confirmed');
      if (result.value.err) {
        console.log(`  ❌ Error: ${JSON.stringify(result.value.err)}`);
        continue;
      }
      console.log('  ✅ Claim confirmed!');

      // Check ATA balance
      await new Promise(r => setTimeout(r, 2000));
      try {
        const account = await getAccount(conn, claimerAta);
        const balance = Number(account.amount) / 1e9; // 9 decimals
        console.log(`  ATA balance: ${balance.toFixed(4)} POKER\n`);
      } catch (e: any) {
        console.log(`  Could not read ATA: ${e.message?.slice(0, 80)}\n`);
      }
    } catch (e: any) {
      console.log(`  ❌ Failed: ${e.message?.slice(0, 200)}\n`);
    }
  }

  // Summary: check all claimer ATA balances
  console.log('═══ SUMMARY ═══');
  for (const { path, label } of CLAIMERS) {
    const kp = loadKeypair(path);
    const ata = await getAssociatedTokenAddress(POKER_MINT, kp.publicKey);
    try {
      const account = await getAccount(conn, ata);
      const balance = Number(account.amount) / 1e9;
      console.log(`  ${label}: ${balance.toFixed(4)} POKER (ATA: ${ata.toBase58().slice(0, 20)}...)`);
    } catch {
      console.log(`  ${label}: No ATA`);
    }
  }
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
