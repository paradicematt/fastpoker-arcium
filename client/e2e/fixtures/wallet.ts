/**
 * Playwright fixture: pool of 9 DETERMINISTIC Solana wallets, reused across runs.
 * Only tops up wallets that are below MIN_BALANCE. Never creates new wallets,
 * never refunds. Same 9 wallets every single test run.
 *
 * Multi-player tests use `createPlayerPage(browser, wallets[n])`.
 */
import { test as base, expect, Browser, Page, BrowserContext } from '@playwright/test';
import { Keypair, Connection, LAMPORTS_PER_SOL, Transaction, VersionedTransaction } from '@solana/web3.js';
import * as nacl from 'tweetnacl';
import * as crypto from 'crypto';

const L1_RPC = process.env.E2E_RPC_URL || 'http://localhost:8899';
const WALLET_COUNT = 9;
const MIN_BALANCE = 0.3 * LAMPORTS_PER_SOL;   // top up if below 0.3 SOL
const AIRDROP_AMOUNT = 2 * LAMPORTS_PER_SOL;  // airdrop 2 SOL on localnet (free)

export type WalletInfo = { keypair: Keypair; sessionKeypair: Keypair; pubB58: string; pubBytes: number[]; index: number };

/** Derive the same keypair every time from a fixed seed + index */
function deriveWallet(index: number): Keypair {
  const seed = crypto.createHash('sha256')
    .update(`fastpoker-e2e-wallet-v1-${index}`)
    .digest();
  return Keypair.fromSeed(seed); // 32-byte seed → deterministic ed25519 keypair
}

/** Derive a deterministic session key for each wallet (persists across runs) */
function deriveSessionKey(index: number): Keypair {
  const seed = crypto.createHash('sha256')
    .update(`fastpoker-e2e-session-v1-${index}`)
    .digest();
  return Keypair.fromSeed(seed);
}

/** Only top up wallets whose balance is below MIN_BALANCE (uses localnet airdrop) */
async function topUpIfNeeded(wallets: Keypair[]): Promise<void> {
  const conn = new Connection(L1_RPC, 'confirmed');
  const balances = await Promise.all(wallets.map(w => conn.getBalance(w.publicKey)));
  const needFunding = wallets.filter((_, i) => balances[i] < MIN_BALANCE);

  if (needFunding.length === 0) {
    console.log(`  ✓ All ${wallets.length} wallets have ≥${MIN_BALANCE / LAMPORTS_PER_SOL} SOL — no top-up needed`);
    return;
  }

  // Localnet: free airdrop
  for (const w of needFunding) {
    const sig = await conn.requestAirdrop(w.publicKey, AIRDROP_AMOUNT);
    await conn.confirmTransaction(sig, 'confirmed');
  }
  console.log(`  ✓ Airdropped ${AIRDROP_AMOUNT / LAMPORTS_PER_SOL} SOL to ${needFunding.length}/${wallets.length} wallets`);
}

const SESSION_MIN_BALANCE = 0.005 * LAMPORTS_PER_SOL; // 5000 lamports minimum
const SESSION_TOP_UP = 0.01 * LAMPORTS_PER_SOL;      // top up to 0.01 SOL (~2000 txs)

/** Fund session keys that are below minimum (they pay for gasless game actions) */
async function topUpSessionKeys(wallets: WalletInfo[]): Promise<void> {
  const conn = new Connection(L1_RPC, 'confirmed');
  const balances = await Promise.all(wallets.map(w => conn.getBalance(w.sessionKeypair.publicKey)));
  const needFunding = wallets.filter((_, i) => balances[i] < SESSION_MIN_BALANCE);

  if (needFunding.length === 0) {
    console.log(`  ✓ All ${wallets.length} session keys funded`);
    return;
  }

  // Localnet: free airdrop
  for (const w of needFunding) {
    const sig = await conn.requestAirdrop(w.sessionKeypair.publicKey, SESSION_TOP_UP);
    await conn.confirmTransaction(sig, 'confirmed');
  }
  console.log(`  ✓ Airdropped to ${needFunding.length} session keys × ${SESSION_TOP_UP / LAMPORTS_PER_SOL} SOL`);
}

// ─── Wallet-standard mock injection (reusable for any Page) ──────────────────

const WALLET_INIT_SCRIPT = ({ pubB58, pubBytes }: { pubB58: string; pubBytes: number[] }) => {
  const publicKey = new Uint8Array(pubBytes);
  const account = Object.freeze({
    address: pubB58,
    publicKey: publicKey.slice(),
    chains: ['solana:localnet'],
    features: ['solana:signTransaction', 'solana:signMessage'],
  });
  const eventListeners: Record<string, Function[]> = {};
  function emit(event: string, data: any) { (eventListeners[event] || []).forEach(fn => fn(data)); }
  const wallet = {
    version: '1.0.0',
    name: 'Test Wallet',
    icon: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgZmlsbD0iIzAwZmYwMCIvPjwvc3ZnPg==',
    chains: ['solana:localnet'],
    accounts: [] as any[],
    features: {
      'standard:connect': { version: '1.0.0',
        connect: async () => { wallet.accounts = [account]; emit('change', { accounts: wallet.accounts }); return { accounts: wallet.accounts }; },
      },
      'standard:disconnect': { version: '1.0.0',
        disconnect: async () => { wallet.accounts = []; emit('change', { accounts: wallet.accounts }); },
      },
      'standard:events': { version: '1.0.0',
        on: (event: string, listener: Function) => {
          if (!eventListeners[event]) eventListeners[event] = [];
          eventListeners[event].push(listener);
          return () => { const i = eventListeners[event]?.indexOf(listener); if (i !== undefined && i >= 0) eventListeners[event].splice(i, 1); };
        },
      },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0],
        signTransaction: async (...inputs: any[]) => {
          const results = [];
          for (const input of inputs) {
            const b64 = btoa(String.fromCharCode.apply(null, Array.from(input.transaction as Uint8Array)));
            const signedB64: string = await (window as any).__e2eSignTransaction(b64);
            results.push({ signedTransaction: Uint8Array.from(atob(signedB64), c => c.charCodeAt(0)) });
          }
          return results;
        },
      },
      'solana:signMessage': { version: '1.0.0',
        signMessage: async (...inputs: any[]) => {
          const results = [];
          for (const input of inputs) {
            const b64 = btoa(String.fromCharCode.apply(null, Array.from(input.message as Uint8Array)));
            const sigB64: string = await (window as any).__e2eSignMessage(b64);
            results.push({ signedMessage: input.message, signature: Uint8Array.from(atob(sigB64), c => c.charCodeAt(0)) });
          }
          return results;
        },
      },
    },
  };
  const cb = (api: { register: (w: any) => void }) => api.register(wallet);
  try { window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: cb })); } catch {}
  window.addEventListener('wallet-standard:app-ready', ((e: any) => cb(e.detail)) as EventListener);
  try { localStorage.setItem('walletName', JSON.stringify('Test Wallet')); } catch {}
};

/** Inject signing functions + wallet-standard mock into a Page */
export async function injectWallet(page: Page, wallet: WalletInfo): Promise<void> {
  const { keypair, pubB58, pubBytes } = wallet;

  await page.exposeFunction('__e2eSignMessage', async (msgB64: string): Promise<string> => {
    const sig = nacl.sign.detached(Buffer.from(msgB64, 'base64'), keypair.secretKey);
    return Buffer.from(sig).toString('base64');
  });

  await page.exposeFunction('__e2eSignTransaction', async (txB64: string): Promise<string> => {
    const buf = Buffer.from(txB64, 'base64');
    try {
      const tx = Transaction.from(buf);
      tx.partialSign(keypair);
      return Buffer.from(tx.serialize({ requireAllSignatures: false })).toString('base64');
    } catch {
      const vtx = VersionedTransaction.deserialize(buf);
      vtx.sign([keypair]);
      return Buffer.from(vtx.serialize()).toString('base64');
    }
  });

  await page.addInitScript(WALLET_INIT_SCRIPT, { pubB58, pubBytes });
}

/** Create a new browser context + page with a specific wallet injected.
 *  Also injects the deterministic session key into localStorage so Gum
 *  session creation uses the same keypair across test runs. */
export async function createPlayerPage(browser: Browser, wallet: WalletInfo): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await injectWallet(page, wallet);

  // Pre-inject deterministic session key into localStorage
  // This prevents Gum CreateSession error 6013 (stale session from previous run)
  const sessionStorageKey = `fastpoker_session_key_${wallet.pubB58}`;
  const sessionSecretArr = JSON.stringify(Array.from(wallet.sessionKeypair.secretKey));
  await page.addInitScript(({ key, value }: { key: string; value: string }) => {
    try { localStorage.setItem(key, value); } catch {}
  }, { key: sessionStorageKey, value: sessionSecretArr });

  return { page, context };
}

// ─── Fixture: 9 wallets funded once, default page uses wallet[0] ─────────────

export const test = base.extend<{}, { wallets: WalletInfo[] }>({
  wallets: [async ({}, use) => {
    // Same 9 wallets every run — derived deterministically from seed
    const wallets: WalletInfo[] = [];
    for (let i = 0; i < WALLET_COUNT; i++) {
      const kp = deriveWallet(i);
      const sk = deriveSessionKey(i);
      wallets.push({ keypair: kp, sessionKeypair: sk, pubB58: kp.publicKey.toBase58(), pubBytes: Array.from(kp.publicKey.toBytes()), index: i });
    }
    console.log(`  🔑 Wallet pool (fixed): ${wallets.map(w => w.pubB58.slice(0, 6)).join(', ')}`);
    await topUpIfNeeded(wallets.map(w => w.keypair));
    // Also fund session keys (need SOL for gasless game actions)
    await topUpSessionKeys(wallets);

    await use(wallets);
    // No refund — wallets persist across runs
  }, { scope: 'worker' }],

  page: async ({ page, wallets }, use) => {
    await injectWallet(page, wallets[0]);
    await use(page);
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Click "Register & Play" if the wallet isn't registered yet, wait for lobby */
export async function registerIfNeeded(page: Page) {
  await page.waitForTimeout(2000);
  const registerBtn = page.getByRole('button', { name: /Register.*Play/i });
  if (await registerBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('  → Registering wallet on-chain...');
    await registerBtn.click();
    await page.waitForSelector('text=/Sit & Go|Cash Games|Loading/i', { timeout: 45000 });
    await page.waitForTimeout(2000);
  }
}

export { expect };
