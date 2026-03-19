// API client for backend services - protects API keys server-side

export interface RpcResponse<T> {
  result?: T;
  error?: string;
}

export interface AccountInfo {
  data: string; // base64
  executable: boolean;
  lamports: number;
  owner: string;
  rentEpoch: number;
}

export interface SitNGoQueue {
  id: string;
  type: 'heads_up' | '6max' | '9max';
  currentPlayers: number;
  maxPlayers: number;
  buyIn: number;
  tier: number;  // SnGTier enum: 0=Micro,...5=Diamond
  status: 'waiting' | 'starting' | 'in_progress';
  tablePda?: string;
  players?: string[];
  onChainPlayers?: number; // actual seated players on-chain (may differ from queue)
  emptySeats?: number[];   // seat indices that are open for joining
}

export interface JoinQueueResult {
  success: boolean;
  queue: SitNGoQueue & { position: number; emptySeat?: number };
}

// RPC API calls (server handles Helius API key)
export async function rpcGetAccountInfo(pubkey: string): Promise<AccountInfo | null> {
  const res = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'getAccountInfo', params: [pubkey] }),
  });
  const data: RpcResponse<AccountInfo | null> = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result ?? null;
}

export async function rpcGetBalance(pubkey: string): Promise<number> {
  const res = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'getBalance', params: [pubkey] }),
  });
  const data: RpcResponse<number> = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result ?? 0;
}

export async function rpcGetLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const res = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'getLatestBlockhash', params: [] }),
  });
  const data: RpcResponse<{ blockhash: string; lastValidBlockHeight: number }> = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result!;
}

export async function rpcSendTransaction(txBase64: string): Promise<string> {
  const res = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'sendRawTransaction', params: [txBase64] }),
  });
  const data: RpcResponse<string> = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result!;
}

export async function rpcGetMultipleAccounts(pubkeys: string[]): Promise<(AccountInfo | null)[]> {
  const res = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'getMultipleAccountsInfo', params: [pubkeys] }),
  });
  const data: RpcResponse<(AccountInfo | null)[]> = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result ?? [];
}

// Sit N Go Queues API
export async function getQueues(): Promise<SitNGoQueue[]> {
  const res = await fetch('/api/sitngos');
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.queues;
}

export async function joinQueue(queueId: string, playerPubkey: string, tier?: number): Promise<JoinQueueResult> {
  const res = await fetch('/api/sitngos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet: playerPubkey, queueId, tier }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function leaveQueue(queueId: string, wallet: string): Promise<void> {
  const res = await fetch('/api/sitngos', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'leave', queueId, wallet }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
}

export async function getTableState(tablePda: string): Promise<any> {
  const res = await fetch('/api/tables', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'getTable', tablePda }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}
