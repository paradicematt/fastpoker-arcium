/**
 * Diagnostic: Find the correct MXE x25519 key by brute-force scanning all on-chain accounts.
 * 
 * The E2E test produces garbage decryption. Cipher self-test passes. Nonce is correct.
 * Hypothesis: getMXEPublicKey() returns a stale/wrong key that doesn't match the MPC nodes' actual key.
 * 
 * Strategy: Read the latest SeatCards[0] ciphertext+nonce, then try every 32-byte segment
 * from MXE account, cluster account, and Arcium program's MXE account as a potential x25519 key.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import {
  getMXEAccAddress, getMXEPublicKey, getClusterAccAddress,
  getArciumProgramId, getArciumEnv, x25519, RescueCipher,
} from '@arcium-hq/client';

const PROGRAM_ID = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
const conn = new Connection('http://127.0.0.1:8899', 'confirmed');

// Latest test's player 0 secret key — we need to recreate this.
// Instead, we'll generate a fresh keypair and use it for the test.

function tryDecrypt(playerSecret: Uint8Array, candidateKey: Uint8Array, ct: Buffer, nonce: Buffer): bigint | null {
  try {
    const ss = x25519.getSharedSecret(playerSecret, candidateKey);
    const cipher = new RescueCipher(ss);
    const val = cipher.decrypt([Array.from(ct)], nonce)[0];
    if (val >= 0n && val <= 65535n) return val;
  } catch {}
  return null;
}

(async () => {
  const wallet = new anchor.Wallet(anchor.web3.Keypair.generate());
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: 'confirmed' });
  anchor.setProvider(provider);

  // 1. Read MXE key via SDK
  const mxePubKey = await getMXEPublicKey(provider, PROGRAM_ID);
  console.log('=== getMXEPublicKey ===');
  console.log('  Key:', mxePubKey ? Buffer.from(mxePubKey).toString('hex') : 'NULL');
  console.log('  Length:', mxePubKey?.length);

  // 2. Dump FULL MXE account
  const mxeAddr = getMXEAccAddress(PROGRAM_ID);
  const mxeInfo = await conn.getAccountInfo(mxeAddr);
  console.log('\n=== MXE Account (FastPoker) ===');
  console.log('  Address:', mxeAddr.toBase58());
  console.log('  Owner:', mxeInfo?.owner.toBase58());
  console.log('  Size:', mxeInfo?.data.length, 'bytes');
  if (mxeInfo) {
    const raw = Buffer.from(mxeInfo.data);
    for (let i = 0; i < raw.length; i += 32) {
      const end = Math.min(i + 32, raw.length);
      console.log(`  [${i.toString().padStart(4)}]: ${raw.slice(i, end).toString('hex')}`);
    }
    // Find where getMXEPublicKey value appears
    if (mxePubKey) {
      const keyHex = Buffer.from(mxePubKey).toString('hex');
      const rawHex = raw.toString('hex');
      const idx = rawHex.indexOf(keyHex);
      console.log(`  Key found at byte offset: ${idx === -1 ? 'NOT FOUND' : idx / 2}`);
    }
  }

  // 3. Dump cluster account
  const clusterAddr = getClusterAccAddress(0);
  const clusterInfo = await conn.getAccountInfo(clusterAddr);
  console.log('\n=== Cluster Account ===');
  console.log('  Address:', clusterAddr.toBase58());
  console.log('  Size:', clusterInfo?.data.length, 'bytes');
  if (clusterInfo) {
    const raw = Buffer.from(clusterInfo.data);
    for (let i = 0; i < raw.length; i += 32) {
      const end = Math.min(i + 32, raw.length);
      console.log(`  [${i.toString().padStart(4)}]: ${raw.slice(i, end).toString('hex')}`);
    }
  }

  // 4. Try Arcium program's own MXE account (different from FastPoker's)
  const arciumProgId = getArciumProgramId();
  const arciumMxeAddr = getMXEAccAddress(arciumProgId);
  const arciumMxeInfo = await conn.getAccountInfo(arciumMxeAddr);
  console.log('\n=== Arcium Program MXE Account ===');
  console.log('  Address:', arciumMxeAddr.toBase58());
  console.log('  Size:', arciumMxeInfo?.data.length ?? 'NOT FOUND');
  if (arciumMxeInfo) {
    const raw = Buffer.from(arciumMxeInfo.data);
    for (let i = 0; i < Math.min(256, raw.length); i += 32) {
      const end = Math.min(i + 32, raw.length);
      console.log(`  [${i.toString().padStart(4)}]: ${raw.slice(i, end).toString('hex')}`);
    }
  }

  // 5. Also try getMXEPublicKey with Arcium program ID
  try {
    const arciumMxeKey = await getMXEPublicKey(provider, arciumProgId);
    console.log('  getMXEPublicKey(arcium):', arciumMxeKey ? Buffer.from(arciumMxeKey).toString('hex') : 'NULL');
  } catch (e: any) {
    console.log('  getMXEPublicKey(arcium) error:', e.message?.slice(0, 100));
  }

  console.log('\n=== Key Comparison ===');
  if (mxePubKey) {
    // Check if key is all-zeros or has suspicious patterns
    const buf = Buffer.from(mxePubKey);
    const isZero = buf.every(b => b === 0);
    const isOne = buf[0] === 9 && buf.slice(1).every(b => b === 0); // basepoint
    console.log('  All zeros:', isZero);
    console.log('  Is basepoint:', isOne);
  }
})().catch(console.error);
