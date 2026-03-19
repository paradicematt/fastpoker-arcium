'use client';

import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as crypto from 'crypto';
import { L1_RPC, ANCHOR_PROGRAM_ID, TABLE_OFFSETS } from '@/lib/constants';

const PROGRAM_ID = new PublicKey(ANCHOR_PROGRAM_ID);
const TABLE_SEED = Buffer.from('table');
const WHITELIST_SEED = Buffer.from('whitelist');

const ADD_WL_DISC = crypto.createHash('sha256').update('global:add_whitelist').digest().slice(0, 8);
const REMOVE_WL_DISC = crypto.createHash('sha256').update('global:remove_whitelist').digest().slice(0, 8);

function getWhitelistPda(table: PublicKey, player: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [WHITELIST_SEED, table.toBuffer(), player.toBuffer()],
    PROGRAM_ID,
  );
}

interface WhitelistPlayer {
  address: string;
  addedAt: string;
  pda: string;
}

export default function WhitelistPage() {
  const { id: tableId } = useParams<{ id: string }>();
  const { publicKey, signTransaction } = useWallet();
  const [players, setPlayers] = useState<WhitelistPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [newAddress, setNewAddress] = useState('');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [tableInfo, setTableInfo] = useState<{ isPrivate: boolean; creator: string; isDelegated: boolean } | null>(null);

  let tablePk: PublicKey;
  try { tablePk = new PublicKey(tableId); } catch { tablePk = PublicKey.default; }

  const fetchWhitelist = useCallback(async () => {
    try {
      const conn = new Connection(L1_RPC, 'confirmed');

      // Fetch table data to verify it's private and user is creator
      // If table is delegated to TEE, the owner is DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh
      // and the data is a delegation marker (not Table struct). Whitelist ops only work on L1.
      const DELEG_PROGRAM = 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh';
      const tableAcct = await conn.getAccountInfo(tablePk);
      if (tableAcct) {
        const isDelegated = tableAcct.owner.toBase58() === DELEG_PROGRAM;
        if (isDelegated) {
          setTableInfo({ isPrivate: true, creator: publicKey?.toBase58() || '', isDelegated: true });
        } else {
          const data = Buffer.from(tableAcct.data);
          const O = TABLE_OFFSETS;
          const creator = new PublicKey(data.subarray(O.CREATOR, O.CREATOR + 32)).toBase58();
          const isPrivate = data.length > O.IS_PRIVATE ? data[O.IS_PRIVATE] === 1 : false;
          setTableInfo({ isPrivate, creator, isDelegated: false });
        }
      }

      // Fetch all WhitelistEntry PDAs for this table (81 bytes each)
      const accounts = await conn.getProgramAccounts(PROGRAM_ID, {
        filters: [
          { dataSize: 81 },
          { memcmp: { offset: 8, bytes: tablePk.toBase58() } },
        ],
      });

      const parsed: WhitelistPlayer[] = accounts.map(({ pubkey, account }) => {
        const d = Buffer.from(account.data);
        const player = new PublicKey(d.subarray(40, 72)).toBase58();
        const addedAt = Number(d.readBigInt64LE(72));
        return {
          address: player,
          addedAt: addedAt > 0 ? new Date(addedAt * 1000).toLocaleDateString() : 'Unknown',
          pda: pubkey.toBase58(),
        };
      });

      setPlayers(parsed);
    } catch (e) {
      console.error('Failed to fetch whitelist:', e);
    }
    setLoading(false);
  }, [tablePk]);

  useEffect(() => { fetchWhitelist(); }, [fetchWhitelist]);

  const addPlayer = async () => {
    if (!publicKey || !signTransaction || !newAddress.trim()) return;
    setAdding(true);
    try {
      let playerPk: PublicKey;
      try { playerPk = new PublicKey(newAddress.trim()); } catch {
        setToast({ msg: 'Invalid Solana address', type: 'error' });
        setAdding(false);
        return;
      }

      const conn = new Connection(L1_RPC, 'confirmed');
      const [wlPda] = getWhitelistPda(tablePk, playerPk);

      // Serialize: disc(8) + player pubkey(32) = 40 bytes
      const data = Buffer.alloc(8 + 32);
      Buffer.from(ADD_WL_DISC).copy(data);
      playerPk.toBuffer().copy(data, 8);

      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePk, isSigner: false, isWritable: false },
          { pubkey: wlPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      });

      const tx = new Transaction().add(ix);
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      const signed = await signTransaction(tx);
      const sig = await conn.sendRawTransaction(signed.serialize());
      await conn.confirmTransaction(sig, 'confirmed');

      setToast({ msg: `Added ${playerPk.toBase58().slice(0, 8)}... to whitelist`, type: 'success' });
      setNewAddress('');
      await fetchWhitelist();
    } catch (e: any) {
      setToast({ msg: `Failed: ${e?.message?.slice(0, 100)}`, type: 'error' });
    }
    setAdding(false);
  };

  const removePlayer = async (playerAddress: string) => {
    if (!publicKey || !signTransaction) return;
    setRemoving(playerAddress);
    try {
      const playerPk = new PublicKey(playerAddress);
      const conn = new Connection(L1_RPC, 'confirmed');
      const [wlPda] = getWhitelistPda(tablePk, playerPk);

      const data = Buffer.alloc(8 + 32);
      Buffer.from(REMOVE_WL_DISC).copy(data);
      playerPk.toBuffer().copy(data, 8);

      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePk, isSigner: false, isWritable: false },
          { pubkey: wlPda, isSigner: false, isWritable: true },
        ],
        data,
      });

      const tx = new Transaction().add(ix);
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      const signed = await signTransaction(tx);
      const sig = await conn.sendRawTransaction(signed.serialize());
      await conn.confirmTransaction(sig, 'confirmed');

      setToast({ msg: `Removed ${playerAddress.slice(0, 8)}...`, type: 'success' });
      await fetchWhitelist();
    } catch (e: any) {
      setToast({ msg: `Failed: ${e?.message?.slice(0, 100)}`, type: 'error' });
    }
    setRemoving(null);
  };

  const isCreator = publicKey && tableInfo?.creator === publicKey.toBase58();

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl border shadow-lg max-w-sm ${
          toast.type === 'success' ? 'bg-emerald-900/80 border-emerald-500/30 text-emerald-200' : 'bg-red-900/80 border-red-500/30 text-red-200'
        }`}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">{toast.msg}</span>
            <button onClick={() => setToast(null)} className="text-white/50 hover:text-white">✕</button>
          </div>
        </div>
      )}

      <div className="max-w-2xl mx-auto px-4 py-8">
        <Link href="/my-tables" className="text-gray-500 hover:text-gray-300 text-sm mb-4 block">&larr; Back to My Tables</Link>

        <h1 className="text-2xl font-bold mb-1">
          <span className="text-purple-400">Private Table</span> Whitelist
        </h1>
        <p className="text-gray-500 text-sm mb-6">
          Table: <span className="font-mono text-gray-400">{tableId.slice(0, 12)}...</span>
        </p>

        {!publicKey ? (
          <div className="text-center py-16">
            <p className="text-gray-400 mb-4">Connect your wallet to manage the whitelist</p>
            <WalletMultiButton />
          </div>
        ) : !tableInfo?.isPrivate ? (
          <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-8 text-center">
            <p className="text-gray-400">This table is not private. Only private tables have whitelists.</p>
          </div>
        ) : !isCreator ? (
          <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-8 text-center">
            <p className="text-gray-400">Only the table creator can manage the whitelist.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Delegation warning */}
            {tableInfo?.isDelegated && (
              <div className="bg-amber-500/10 border border-amber-500/25 rounded-xl p-4">
                <div className="text-amber-400 font-bold text-sm mb-1">Table is in active game session</div>
                <p className="text-amber-400/70 text-xs">
                  Whitelist changes can only be made when the table is on L1 (between game sessions).
                  The table will return to L1 during the next cashout cycle. Existing whitelist entries are shown below.
                </p>
              </div>
            )}
            {/* Add player */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-5">
              <h3 className="text-sm font-bold text-gray-300 mb-3">Add Player</h3>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newAddress}
                  onChange={e => setNewAddress(e.target.value)}
                  placeholder="Solana wallet address..."
                  className="flex-1 bg-black/30 border border-white/[0.08] rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:border-purple-500/50 focus:outline-none font-mono"
                />
                <button
                  onClick={addPlayer}
                  disabled={adding || !newAddress.trim() || tableInfo?.isDelegated}
                  className="px-5 py-2.5 rounded-lg bg-purple-500 hover:bg-purple-400 text-white font-bold text-sm transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
                >
                  {adding ? 'Adding...' : 'Add'}
                </button>
              </div>
            </div>

            {/* Whitelist */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-5">
              <h3 className="text-sm font-bold text-gray-300 mb-3">
                Whitelisted Players ({players.length})
              </h3>

              {loading ? (
                <div className="text-center py-8 text-gray-500 text-sm">Loading...</div>
              ) : players.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-gray-500 text-sm">No players whitelisted yet.</p>
                  <p className="text-gray-600 text-xs mt-1">The table creator can always join without being whitelisted.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {players.map(p => (
                    <div key={p.address} className="flex items-center justify-between bg-white/[0.02] border border-white/[0.04] rounded-lg px-3 py-2.5">
                      <div>
                        <div className="text-sm font-mono text-white">{p.address.slice(0, 8)}...{p.address.slice(-6)}</div>
                        <div className="text-[10px] text-gray-600">Added {p.addedAt}</div>
                      </div>
                      <button
                        onClick={() => removePlayer(p.address)}
                        disabled={removing === p.address}
                        className="px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-medium hover:bg-red-500/20 transition-colors disabled:opacity-40"
                      >
                        {removing === p.address ? 'Removing...' : 'Remove'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
