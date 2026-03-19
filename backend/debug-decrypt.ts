/**
 * Diagnostic: test RescueCipher decryption with various approaches.
 * Reads SeatCards + DeckState from localnet and tries multiple decrypt strategies.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { x25519, RescueCipher, getMXEPublicKey } from '@arcium-hq/client';
import * as anchor from '@coral-xyz/anchor';
import * as crypto from 'crypto';

const PROGRAM_ID = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
const conn = new Connection('http://127.0.0.1:8899', 'confirmed');

// ── Basic RescueCipher round-trip test ──
async function testRescueRoundTrip() {
  console.log('\n=== RescueCipher Round-Trip Test ===');
  const sk1 = x25519.utils.randomSecretKey();
  const pk1 = x25519.getPublicKey(sk1);
  const sk2 = x25519.utils.randomSecretKey();
  const pk2 = x25519.getPublicKey(sk2);

  const shared1 = x25519.getSharedSecret(sk1, pk2);
  const shared2 = x25519.getSharedSecret(sk2, pk1);

  console.log('  shared1:', Buffer.from(shared1).toString('hex').slice(0, 32) + '...');
  console.log('  shared2:', Buffer.from(shared2).toString('hex').slice(0, 32) + '...');
  console.log('  match:', Buffer.from(shared1).equals(Buffer.from(shared2)));

  const nonce = crypto.randomBytes(16);
  const cipher1 = new RescueCipher(shared1);
  const cipher2 = new RescueCipher(shared2);

  // Encrypt with cipher1, decrypt with cipher2
  const plaintext = [42n];
  const ct = cipher1.encrypt(plaintext, nonce);
  console.log('  ct[0] length:', ct[0].length, 'bytes');
  console.log('  ct[0]:', Buffer.from(ct[0]).toString('hex'));

  const pt = cipher2.decrypt(ct, nonce);
  console.log('  decrypt:', pt[0]);
  console.log('  round-trip OK:', pt[0] === 42n);

  // Also test packed u16 like the circuit
  const packed = BigInt(13 * 256 + 51); // card1=13, card2=51
  const ct2 = cipher1.encrypt([packed], nonce);
  const pt2 = cipher2.decrypt(ct2, nonce);
  console.log('  packed u16 test:', pt2[0], '=== expected', packed, ':', pt2[0] === packed);
}

// ── Test with nonce+1 ──
async function testNonceIncrement() {
  console.log('\n=== Nonce Increment Test ===');
  const sk1 = x25519.utils.randomSecretKey();
  const pk1 = x25519.getPublicKey(sk1);
  const sk2 = x25519.utils.randomSecretKey();
  const pk2 = x25519.getPublicKey(sk2);

  const shared = x25519.getSharedSecret(sk1, pk2);
  const cipher = new RescueCipher(shared);

  const inputNonce = crypto.randomBytes(16);

  // Simulate MPC behavior: encrypt with input_nonce, output uses output_nonce = input_nonce + 1
  const ct = cipher.encrypt([7n], inputNonce);
  const pt1 = cipher.decrypt(ct, inputNonce);
  console.log('  decrypt with input_nonce:', pt1[0], '(expected 7)');

  // Try output_nonce = input + 1
  const outputNonce = Buffer.alloc(16);
  let val = BigInt('0x' + Buffer.from(inputNonce).reverse().toString('hex'));
  val += 1n;
  for (let b = 0; b < 16; b++) { outputNonce[b] = Number(val & 0xFFn); val >>= 8n; }
  const pt2 = cipher.decrypt(ct, outputNonce);
  console.log('  decrypt with output_nonce (input+1):', pt2[0], '(expected garbage or 7)');
}

// ── Test: MPC encrypts with output_nonce, client decrypts with output_nonce ──
async function testMpcNonceBehavior() {
  console.log('\n=== MPC Nonce Behavior Simulation ===');
  const sk = x25519.utils.randomSecretKey();
  const pk = x25519.getPublicKey(sk);
  const mxeSk = x25519.utils.randomSecretKey();
  const mxePk = x25519.getPublicKey(mxeSk);

  const shared = x25519.getSharedSecret(sk, mxePk);
  const cipher = new RescueCipher(shared);

  const inputNonce = crypto.randomBytes(16);
  // MPC: encrypts with OUTPUT nonce (= input+1)
  const outputNonce = Buffer.alloc(16);
  let tmp = BigInt('0x' + Buffer.from(inputNonce).reverse().toString('hex')) + 1n;
  for (let b = 0; b < 16; b++) { outputNonce[b] = Number(tmp & 0xFFn); tmp >>= 8n; }

  const ct_output_nonce = cipher.encrypt([99n], outputNonce);
  // Client: decrypt with output nonce
  const pt = cipher.decrypt(ct_output_nonce, outputNonce);
  console.log('  encrypt(output_nonce) → decrypt(output_nonce):', pt[0], '=== 99:', pt[0] === 99n);
}

(async () => {
  await testRescueRoundTrip();
  await testNonceIncrement();
  await testMpcNonceBehavior();

  console.log('\n=== DONE ===');
})().catch(console.error);
