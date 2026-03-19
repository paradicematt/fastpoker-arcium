// Shared test configuration
// Set SOLANA_RPC_URL env var to override (default: localhost for local testing)

export const RPC_URL = process.env.SOLANA_RPC_URL || 'http://127.0.0.1:8899';
export const WS_URL = process.env.SOLANA_WS_URL || 'ws://127.0.0.1:8900';

// Devnet config (for remote testing)
export const DEVNET_RPC_URL = 'https://devnet.helius-rpc.com/?api-key=8801f9b3-fe0b-42b5-ba5c-67f0fed31c5e';
export const DEVNET_WS_URL = 'wss://devnet.helius-rpc.com/?api-key=8801f9b3-fe0b-42b5-ba5c-67f0fed31c5e';
