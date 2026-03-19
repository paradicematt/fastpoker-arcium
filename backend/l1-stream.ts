/**
 * Phase 3: LaserStream L1 Streaming (Pure-JS gRPC — cross-platform)
 *
 * Replaces L1 polling (getProgramAccounts) with push-based gRPC account
 * subscriptions via Helius LaserStream. Eliminates ~17k L1 credits/hr.
 *
 * Uses @grpc/grpc-js (pure JavaScript) instead of native helius-laserstream SDK
 * so it works on Windows, Linux, and macOS.
 *
 * When enabled (laserstream_enabled: true in crank-config.json), this module:
 *   1. Subscribes to all table accounts (program-owned + delegated)
 *   2. Subscribes to treasury + pool accounts
 *   3. Emits events when accounts change — crank-service reacts accordingly
 *   4. Supports dynamic vault subscriptions as new tables are discovered
 *
 * When disabled, crank falls back to existing polling — zero impact.
 */
import { EventEmitter } from 'events';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'path';

// ─── Types ───

export interface L1StreamConfig {
  apiKey: string;
  endpoint: string;            // e.g. https://laserstream-devnet-ewr.helius-rpc.com
  programId: string;           // Anchor program ID
  delegationProgramId: string; // MagicBlock delegation program
  tableDiscriminatorB58: string; // base58-encoded 8-byte table discriminator
  tableSize: number;           // Expected table account size (437)
  treasuryPubkey: string;
  poolPubkey: string;
}

export interface L1AccountUpdate {
  pubkey: string;
  data: Buffer;
  slot: number;
  owner: string;
  lamports: number;
  label: string;  // Which subscription filter matched
}

export interface L1TransactionUpdate {
  signature: string;
  slot: number;
  accounts: string[];
  label: string;
}

// ─── Events emitted by L1Stream ───
// 'table-update'       → L1AccountUpdate  (program-owned or delegated table changed)
// 'treasury-update'    → L1AccountUpdate  (treasury balance changed)
// 'pool-update'        → L1AccountUpdate  (pool balance changed)
// 'vault-update'       → L1AccountUpdate  (vault balance changed)
// 'program-tx'         → L1TransactionUpdate (program transaction landed)
// 'connected'          → void
// 'error'              → Error
// 'reconnecting'       → void

// CommitmentLevel enum (matches geyser.proto)
const COMMITMENT_CONFIRMED = 1;

export class L1Stream extends EventEmitter {
  private config: L1StreamConfig;
  private alive = false;
  private connected = false;

  // Dynamic vault subscriptions — accumulated for reconnect
  private dynamicVaultPubkeys = new Set<string>();

  // gRPC client and active stream
  private client: any = null;
  private stream: any = null;

  // Ping keepalive interval
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pingId = 0;

  constructor(config: L1StreamConfig) {
    super();
    this.config = config;
  }

  /** Start the LaserStream subscription. Non-blocking — runs in background. */
  async start(): Promise<void> {
    if (this.alive) return;
    this.alive = true;

    console.log('[LaserStream] Starting L1 gRPC stream (pure-JS)...');
    console.log(`  Endpoint : ${this.config.endpoint}`);
    console.log(`  Program  : ${this.config.programId}`);
    console.log(`  Delegation: ${this.config.delegationProgramId}`);
    console.log(`  Treasury : ${this.config.treasuryPubkey}`);
    console.log(`  Pool     : ${this.config.poolPubkey}`);

    // Load proto definitions
    try {
      const protoPath = path.resolve(
        __dirname,
        'node_modules',
        'laserstream-core-proto-js',
        'geyser.proto',
      );
      const packageDef = protoLoader.loadSync(protoPath, {
        keepCase: false,       // camelCase field names
        longs: String,         // u64 as string (avoids precision loss)
        enums: Number,         // enums as numbers
        defaults: true,
        oneofs: true,
        includeDirs: [path.dirname(protoPath)],
      });
      const proto = grpc.loadPackageDefinition(packageDef) as any;
      const GeyserService = proto.geyser.Geyser;

      // Parse endpoint — strip https:// for gRPC, add port 443
      let host = this.config.endpoint
        .replace(/^https?:\/\//, '')
        .replace(/\/$/, '');
      if (!host.includes(':')) host += ':443';

      // Create gRPC client with TLS + API key metadata
      const channelCreds = grpc.credentials.createSsl();
      const callCreds = grpc.credentials.createFromMetadataGenerator(
        (_params: any, callback: any) => {
          const md = new grpc.Metadata();
          md.set('x-token', this.config.apiKey);
          callback(null, md);
        },
      );
      const combinedCreds = grpc.credentials.combineChannelCredentials(
        channelCreds,
        callCreds,
      );

      this.client = new GeyserService(host, combinedCreds, {
        'grpc.max_receive_message_length': 64 * 1024 * 1024, // 64MB
        'grpc.keepalive_time_ms': 30_000,
        'grpc.keepalive_timeout_ms': 10_000,
        'grpc.keepalive_permit_without_calls': 1,
      });

      console.log(`[LaserStream] gRPC client created for ${host}`);
    } catch (e: any) {
      console.error(`[LaserStream] Failed to load proto/create client: ${e.message?.slice(0, 150)}`);
      this.emit('error', new Error(`gRPC init failed: ${e.message}`));
      return;
    }

    this.connectWithRetry();
  }

  /** Stop the stream gracefully. */
  stop(): void {
    this.alive = false;
    this.connected = false;
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.stream) {
      try { this.stream.cancel(); } catch {}
      this.stream = null;
    }
    if (this.client) {
      try { this.client.close(); } catch {}
      this.client = null;
    }
    console.log('[LaserStream] Stopped.');
  }

  /** Add vault pubkeys dynamically (Phase 3D). Safe to call multiple times with same key. */
  addVaultSubscription(pubkey: string): void {
    if (this.dynamicVaultPubkeys.has(pubkey)) return;
    this.dynamicVaultPubkeys.add(pubkey);

    // Send updated subscription request via the bidirectional stream
    if (this.stream && this.connected) {
      try {
        this.stream.write(this.buildSubscribeRequest());
        console.log(`[LaserStream] Dynamic vault added: ${pubkey.slice(0, 12)}... (total=${this.dynamicVaultPubkeys.size})`);
      } catch (e: any) {
        console.warn(`[LaserStream] Failed to write dynamic vault update: ${e.message?.slice(0, 80)}`);
      }
    }
  }

  /** Check if stream is connected and receiving data. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Get count of tracked vault subscriptions. */
  getVaultCount(): number {
    return this.dynamicVaultPubkeys.size;
  }

  // ─── Internal ───

  private buildSubscribeRequest(): any {
    // Collect specific account pubkeys for direct watching
    const specificAccounts = [
      this.config.treasuryPubkey,
      this.config.poolPubkey,
      ...Array.from(this.dynamicVaultPubkeys),
    ];

    // Build Yellowstone/LaserStream SubscribeRequest (matches geyser.proto)
    return {
      accounts: {
        // 1. Watch program-owned tables (undelegated — on L1 after Complete/close)
        'program-tables': {
          account: [],
          owner: [this.config.programId],
          filters: [
            {
              memcmp: {
                offset: 0,
                base58: this.config.tableDiscriminatorB58,
              },
            },
          ],
        },
        // 2. Watch delegated tables (owned by delegation program on L1)
        'delegated-tables': {
          account: [],
          owner: [this.config.delegationProgramId],
          filters: [
            {
              memcmp: {
                offset: 0,
                base58: this.config.tableDiscriminatorB58,
              },
            },
            { datasize: this.config.tableSize },
          ],
        },
        // 3. Watch specific accounts (treasury, pool, vaults)
        'specific-accounts': {
          account: specificAccounts,
          owner: [],
          filters: [],
        },
      },
      transactions: {
        // 4. Watch program transactions (for event parsing — rake, prizes, etc.)
        'program-txs': {
          accountInclude: [this.config.programId],
          accountExclude: [],
          accountRequired: [],
          vote: false,
          failed: false,
        },
      },
      commitment: COMMITMENT_CONFIRMED,
      slots: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
    };
  }

  private async connectWithRetry(): Promise<void> {
    let retryDelay = 2000;
    const MAX_RETRY_DELAY = 60_000;

    while (this.alive) {
      try {
        await this.runSubscription();
      } catch (e: any) {
        if (!this.alive) return;
        this.connected = false;
        this.emit('reconnecting');
        console.warn(`[LaserStream] Connection lost: ${e.message?.slice(0, 100)}`);
        console.log(`[LaserStream] Reconnecting in ${retryDelay / 1000}s...`);
        await sleep(retryDelay);
        retryDelay = Math.min(retryDelay * 1.5, MAX_RETRY_DELAY);
      }
    }
  }

  private runSubscription(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.client || !this.alive) {
        reject(new Error('Client not initialized'));
        return;
      }

      // Open bidirectional stream: Subscribe(stream SubscribeRequest) returns (stream SubscribeUpdate)
      this.stream = this.client.Subscribe();
      let firstUpdate = true;

      // Send initial subscription request
      const request = this.buildSubscribeRequest();
      this.stream.write(request);
      console.log('[LaserStream] Subscription request sent...');

      // Send initial ping to detect connection (pong confirms server is alive)
      this.pingId++;
      this.stream.write({ ping: { id: this.pingId } });

      // Start ping keepalive (every 30s)
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.pingInterval = setInterval(() => {
        if (this.stream && this.alive) {
          try {
            this.pingId++;
            this.stream.write({ ping: { id: this.pingId } });
          } catch {}
        }
      }, 30_000);

      // Handle incoming data
      this.stream.on('data', (data: any) => {
        if (!this.alive) return;

        if (firstUpdate) {
          firstUpdate = false;
          this.connected = true;
          console.log('[LaserStream] Connected — receiving updates.');
          this.emit('connected');
        }

        try {
          this.handleUpdate(data);
        } catch (e: any) {
          console.warn(`[LaserStream] Error handling update: ${e.message?.slice(0, 100)}`);
        }
      });

      // Handle stream end
      this.stream.on('end', () => {
        this.connected = false;
        if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
        if (this.alive) {
          reject(new Error('Stream ended by server'));
        } else {
          resolve();
        }
      });

      // Handle stream error
      this.stream.on('error', (err: any) => {
        this.connected = false;
        if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
        if (this.alive) {
          reject(err instanceof Error ? err : new Error(String(err)));
        } else {
          resolve();
        }
      });
    });
  }

  private handleUpdate(data: any): void {
    // Pong response — keepalive confirmation, ignore
    if (data.pong) return;

    // Ping from server — respond (protocol requires it for some implementations)
    if (data.ping) return;

    // Account update
    if (data.account) {
      const acct = data.account.account;
      if (!acct) return;

      const pubkeyBytes = acct.pubkey;
      const ownerBytes = acct.owner;
      const dataBytes = acct.data;

      if (!pubkeyBytes || !dataBytes) return;

      // Convert bytes to base58 pubkey string
      const pubkey = bytesToBase58(
        pubkeyBytes instanceof Uint8Array ? pubkeyBytes : Buffer.from(pubkeyBytes),
      );
      const owner = ownerBytes
        ? bytesToBase58(ownerBytes instanceof Uint8Array ? ownerBytes : Buffer.from(ownerBytes))
        : '';

      // Determine which subscription label matched
      const label = data.filters?.[0] || 'unknown';

      const update: L1AccountUpdate = {
        pubkey,
        data: Buffer.from(dataBytes instanceof Uint8Array ? dataBytes : Buffer.from(dataBytes)),
        slot: Number(data.account.slot || 0),
        owner,
        lamports: Number(acct.lamports || 0),
        label,
      };

      // Route to appropriate event based on label/pubkey
      if (pubkey === this.config.treasuryPubkey) {
        this.emit('treasury-update', update);
      } else if (pubkey === this.config.poolPubkey) {
        this.emit('pool-update', update);
      } else if (this.dynamicVaultPubkeys.has(pubkey)) {
        this.emit('vault-update', update);
      } else {
        // Table account (program-owned or delegated)
        this.emit('table-update', update);
      }
    }

    // Transaction update
    if (data.transaction) {
      const tx = data.transaction;
      const sig = tx.transaction?.signature;
      if (!sig) return;

      const label = data.filters?.[0] || 'program-txs';

      const update: L1TransactionUpdate = {
        signature: bytesToBase58(
          sig instanceof Uint8Array ? sig : Buffer.from(sig),
        ),
        slot: Number(tx.slot || 0),
        accounts: [], // Simplified — full account list parsing not needed for Phase 3
        label,
      };

      this.emit('program-tx', update);
    }
  }
}

// ─── Helpers ───

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Convert a Uint8Array to base58 string.
 * Uses the same bs58 encoding as Solana pubkeys.
 */
function bytesToBase58(bytes: Uint8Array): string {
  // Inline base58 encode to avoid importing bs58 separately
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  if (bytes.length === 0) return '';

  // Count leading zeros
  let zeroes = 0;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) zeroes++;

  // Convert to big number
  const size = ((bytes.length - zeroes) * 138 / 100) + 1 >>> 0;
  const b58 = new Uint8Array(size);

  let length = 0;
  for (let i = zeroes; i < bytes.length; i++) {
    let carry = bytes[i];
    let j = 0;
    for (let it = size - 1; (carry !== 0 || j < length) && it >= 0; it--, j++) {
      carry += 256 * b58[it] >>> 0;
      b58[it] = carry % 58 >>> 0;
      carry = carry / 58 >>> 0;
    }
    length = j;
  }

  // Skip leading zeros in base58 result
  let it2 = size - length;
  while (it2 < size && b58[it2] === 0) it2++;

  let str = '';
  for (let i = 0; i < zeroes; i++) str += '1';
  for (; it2 < size; it2++) str += ALPHABET[b58[it2]];

  return str;
}
