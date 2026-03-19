/**
 * Arcium x25519 key derivation for card encryption/decryption.
 *
 * Flow:
 *   1. Player signs a deterministic message with their wallet → Ed25519 signature
 *   2. SHA-256(signature) → 32-byte seed
 *   3. Seed is used as x25519 secret key (clamped by noble/curves internally)
 *   4. Public key = x25519.getPublicKey(secretKey)
 *   5. Public key is stored on-chain via set_x25519_key instruction
 *   6. MPC encrypts hole cards to this public key
 *   7. Frontend decrypts using secret key + MXE public key + nonce from SeatCards
 */

const X25519_DERIVE_MESSAGE = 'fastpoker-x25519-v1';
const X25519_SIG_STORAGE_PREFIX = 'fastpoker_x25519_sig';

export interface X25519Keypair {
  secretKey: Uint8Array; // 32 bytes
  publicKey: Uint8Array; // 32 bytes
}

/**
 * Derive a deterministic x25519 keypair from a wallet signature.
 * Same wallet + same message = same signature = same keypair.
 * Signature is cached in localStorage to avoid repeated wallet popups.
 */
export async function deriveX25519Keypair(
  walletPubkeyBase58: string,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
): Promise<X25519Keypair> {
  const sigCacheKey = `${X25519_SIG_STORAGE_PREFIX}_${walletPubkeyBase58}`;

  // Try cached signature first (avoids wallet popup)
  const cachedSig = localStorage.getItem(sigCacheKey);
  if (cachedSig) {
    try {
      const sigBytes = Uint8Array.from(atob(cachedSig), c => c.charCodeAt(0));
      return await keypairFromSignature(sigBytes);
    } catch {
      localStorage.removeItem(sigCacheKey);
    }
  }

  // Sign deterministic message (one wallet popup)
  const message = new TextEncoder().encode(X25519_DERIVE_MESSAGE);
  const signature = await signMessage(message);

  // Cache signature for future page loads
  localStorage.setItem(sigCacheKey, btoa(String.fromCharCode(...Array.from(signature))));

  return keypairFromSignature(signature);
}

async function keypairFromSignature(signature: Uint8Array): Promise<X25519Keypair> {
  // SHA-256(signature) → 32-byte seed → x25519 secret key
  const hashBuffer = await crypto.subtle.digest('SHA-256', signature.buffer as ArrayBuffer);
  const secretKey = new Uint8Array(hashBuffer);

  // x25519 public key derivation (uses noble/curves via @arcium-hq/client)
  // We import dynamically to avoid bundling issues if @arcium-hq/client isn't available
  const { x25519 } = await import('@noble/curves/ed25519');
  const publicKey = x25519.getPublicKey(secretKey);

  return { secretKey, publicKey: new Uint8Array(publicKey) };
}

/**
 * Get the cached x25519 keypair without prompting for signature.
 * Returns null if no cached signature exists.
 */
export async function getCachedX25519Keypair(
  walletPubkeyBase58: string,
): Promise<X25519Keypair | null> {
  const sigCacheKey = `${X25519_SIG_STORAGE_PREFIX}_${walletPubkeyBase58}`;
  const cachedSig = localStorage.getItem(sigCacheKey);
  if (!cachedSig) return null;

  try {
    const sigBytes = Uint8Array.from(atob(cachedSig), c => c.charCodeAt(0));
    return await keypairFromSignature(sigBytes);
  } catch {
    return null;
  }
}

/**
 * Fetch the MXE x25519 public key needed for Rescue cipher shared secret derivation.
 *
 * Priority:
 *   1. NEXT_PUBLIC_MXE_X25519_PUBKEY env variable (hex-encoded, 64 chars)
 *   2. Dynamic fetch from MXE account on-chain via @arcium-hq/client
 *   3. null (caller should show error)
 *
 * The MXE key is static per Arcium deployment — cache aggressively.
 */
let cachedMxePubkey: Uint8Array | null = null;

export async function getMxeX25519Pubkey(
  connection: import('@solana/web3.js').Connection,
  programId: import('@solana/web3.js').PublicKey,
): Promise<Uint8Array | null> {
  if (cachedMxePubkey) return cachedMxePubkey;

  // 1. Check env variable
  const envHex = process.env.NEXT_PUBLIC_MXE_X25519_PUBKEY;
  if (envHex && envHex.length === 64) {
    cachedMxePubkey = Uint8Array.from(
      envHex.match(/.{2}/g)!.map(b => parseInt(b, 16)),
    );
    return cachedMxePubkey;
  }

  // 2. Dynamic fetch from MXE account
  try {
    const { getMXEAccAddress, getArciumProgramId } = await import('@arcium-hq/client');
    const arciumProgramId = getArciumProgramId();
    const { PublicKey: PK } = await import('@solana/web3.js');
    const mxeAccPda = getMXEAccAddress(programId);
    const info = await connection.getAccountInfo(mxeAccPda);
    if (info && info.data.length > 200) {
      // MXE account layout: the x25519Pubkey is in the utilityPubkeys field.
      // utilityPubkeys is an Option<Vec<UtilityPubkeys>> — when Set, it contains
      // x25519Pubkey ([u8; 32]) + ed25519VerifyingKey ([u8; 32]).
      // Rather than parse the full IDL, search for a non-zero 32-byte sequence
      // near the end of the account that looks like a valid x25519 pubkey.
      // Fallback: use @arcium-hq/client with a minimal provider if available.
      console.warn('[arcium-keys] MXE account found but raw parsing not yet implemented. Set NEXT_PUBLIC_MXE_X25519_PUBKEY env var.');
    }
  } catch (err: any) {
    console.warn('[arcium-keys] Failed to fetch MXE pubkey:', err.message?.slice(0, 80));
  }

  return null;
}
