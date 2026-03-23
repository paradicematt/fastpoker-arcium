'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  L1_RPC,
  PROGRAM_ID,
  TABLE_OFFSETS,
  CRANK_TALLY_ER_SEED,
  SEAT_SEED,
  SEAT_CARDS_SEED,
  SEAT_CARDS_OFFSETS,
  CARD_NOT_DEALT,
} from '@/lib/constants';

// ─── Constants ───

const SUITS = ['\u2660', '\u2665', '\u2666', '\u2663'] as const; // spades, hearts, diamonds, clubs
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;

const GAME_TYPE_NAMES: Record<number, string> = {
  0: 'Sit & Go HU',
  1: 'Sit & Go 6-Max',
  2: 'Sit & Go 9-Max',
  3: 'Cash Game',
};

const PHASE_NAMES: Record<number, string> = {
  0: 'Waiting',
  1: 'Preflop',
  2: 'Flop',
  3: 'Turn',
  4: 'River',
  5: 'Showdown',
};

// ─── Types ───

interface TableInfo {
  address: string;
  gameType: number;
  gameTypeName: string;
  smallBlind: number;
  bigBlind: number;
  maxPlayers: number;
  currentPlayers: number;
  handNumber: number;
  pot: number;
  rakeAccumulated: number;
  rakeCap: number;
  communityCards: number[];
  phase: number;
  phaseName: string;
  currentPlayer: number;
}

interface CrankOperator {
  pubkey: string;
  actionCount: number;
}

interface CrankTallyInfo {
  operators: CrankOperator[];
  totalActions: number;
  lastHand: number;
}

interface SeatInfo {
  index: number;
  playerPubkey: string;
  card1: number;
  card2: number;
  chips: number;
  bet: number;
  status: number;
}

interface HandData {
  handNumber: number;
  pot: number;
  rakeAccumulated: number;
  communityCards: number[];
  phase: number;
  phaseName: string;
  seats: SeatInfo[];
}

// ─── Helpers ───

function readU64LE(data: Buffer, offset: number): number {
  // Read as two u32 to avoid BigInt overhead; safe for values < 2^53
  const lo = data.readUInt32LE(offset);
  const hi = data.readUInt32LE(offset + 4);
  return hi * 0x100000000 + lo;
}

function lamportsToSol(lamports: number): string {
  return (lamports / 1e9).toFixed(lamports >= 1e9 ? 2 : lamports >= 1e8 ? 3 : 4);
}

function truncatePubkey(pk: string): string {
  if (pk.length <= 12) return pk;
  return `${pk.slice(0, 4)}...${pk.slice(-4)}`;
}

function decodeCard(idx: number): { rank: string; suit: string; isRed: boolean } | null {
  if (idx === CARD_NOT_DEALT || idx > 51) return null;
  const rank = RANKS[idx % 13];
  const suitIdx = Math.floor(idx / 13);
  const suit = SUITS[suitIdx];
  const isRed = suitIdx === 1 || suitIdx === 2; // hearts or diamonds
  return { rank, suit, isRed };
}

function getCrankTallyErPda(tablePda: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(CRANK_TALLY_ER_SEED), tablePda.toBuffer()],
    PROGRAM_ID,
  );
  return pda;
}

function getSeatPda(tablePda: PublicKey, seatIndex: number): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEAT_SEED), tablePda.toBuffer(), Buffer.from([seatIndex])],
    PROGRAM_ID,
  );
  return pda;
}

function getSeatCardsPda(tablePda: PublicKey, seatIndex: number): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEAT_CARDS_SEED), tablePda.toBuffer(), Buffer.from([seatIndex])],
    PROGRAM_ID,
  );
  return pda;
}

// ─── Card Component ───

function CardDisplay({ cardIndex }: { cardIndex: number }) {
  const card = decodeCard(cardIndex);
  if (!card) {
    return (
      <div className="w-10 h-14 rounded-md bg-gray-700 border border-gray-600 flex items-center justify-center">
        <span className="text-gray-500 text-xs">?</span>
      </div>
    );
  }
  return (
    <div className="w-10 h-14 rounded-md bg-white border border-gray-300 shadow-sm flex flex-col items-center justify-center">
      <span className={`text-sm font-bold leading-none ${card.isRed ? 'text-red-600' : 'text-gray-800'}`}>
        {card.rank}
      </span>
      <span className={`text-base leading-none ${card.isRed ? 'text-red-600' : 'text-gray-800'}`}>
        {card.suit}
      </span>
    </div>
  );
}

// ─── Seat Status ───

const SEAT_STATUS_NAMES: Record<number, string> = {
  0: 'Empty',
  1: 'Active',
  2: 'Folded',
  3: 'All-In',
  4: 'Sitting Out',
  5: 'Eliminated',
  6: 'Left',
};

// ─── Main Page ───

export default function VerifyPage() {
  const [tableAddress, setTableAddress] = useState('');
  const [handNumberInput, setHandNumberInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [tableInfo, setTableInfo] = useState<TableInfo | null>(null);
  const [crankTally, setCrankTally] = useState<CrankTallyInfo | null>(null);
  const [handData, setHandData] = useState<HandData | null>(null);

  const lookUp = useCallback(async () => {
    setError(null);
    setTableInfo(null);
    setCrankTally(null);
    setHandData(null);

    const addr = tableAddress.trim();
    if (!addr) {
      setError('Please enter a table address.');
      return;
    }

    let tablePda: PublicKey;
    try {
      tablePda = new PublicKey(addr);
    } catch {
      setError('Invalid table address. Must be a valid Solana public key.');
      return;
    }

    setLoading(true);

    try {
      const connection = new Connection(L1_RPC, 'confirmed');

      // Fetch table account
      const tableAcct = await connection.getAccountInfo(tablePda);
      if (!tableAcct || !tableAcct.data) {
        throw new Error('Table account not found. Verify the address is correct.');
      }

      const d = Buffer.from(tableAcct.data);

      // Parse table data
      const gameType = d.readUInt8(TABLE_OFFSETS.GAME_TYPE);
      const smallBlind = readU64LE(d, TABLE_OFFSETS.SMALL_BLIND);
      const bigBlind = readU64LE(d, TABLE_OFFSETS.BIG_BLIND);
      const maxPlayers = d.readUInt8(TABLE_OFFSETS.MAX_PLAYERS);
      const currentPlayers = d.readUInt8(TABLE_OFFSETS.CURRENT_PLAYERS);
      const handNumber = readU64LE(d, TABLE_OFFSETS.HAND_NUMBER);
      const pot = readU64LE(d, TABLE_OFFSETS.POT);
      const rakeAccumulated = readU64LE(d, TABLE_OFFSETS.RAKE_ACCUMULATED);
      const phase = d.readUInt8(TABLE_OFFSETS.PHASE);
      const currentPlayer = d.readUInt8(TABLE_OFFSETS.CURRENT_PLAYER);
      const rakeCap = readU64LE(d, TABLE_OFFSETS.RAKE_CAP);

      const communityCards: number[] = [];
      for (let i = 0; i < 5; i++) {
        communityCards.push(d.readUInt8(TABLE_OFFSETS.COMMUNITY_CARDS + i));
      }

      const info: TableInfo = {
        address: addr,
        gameType,
        gameTypeName: GAME_TYPE_NAMES[gameType] || `Unknown (${gameType})`,
        smallBlind,
        bigBlind,
        maxPlayers,
        currentPlayers,
        handNumber,
        pot,
        rakeAccumulated,
        rakeCap,
        communityCards,
        phase,
        phaseName: PHASE_NAMES[phase] || `Unknown (${phase})`,
        currentPlayer,
      };
      setTableInfo(info);

      // Fetch crank tally ER
      try {
        const crankPda = getCrankTallyErPda(tablePda);
        const crankAcct = await connection.getAccountInfo(crankPda);
        if (crankAcct && crankAcct.data) {
          const cd = Buffer.from(crankAcct.data);
          // Layout: disc(8) + table(32) = offset 40 for operators
          // operators: 4 x 32-byte pubkeys starting at offset 40
          // action_counts: 4 x u32 starting at offset 168
          // total_actions: u32 at offset 184
          // last_hand: u32 at offset 188
          const operators: CrankOperator[] = [];
          for (let i = 0; i < 4; i++) {
            const pkBytes = cd.subarray(40 + i * 32, 40 + (i + 1) * 32);
            const pk = new PublicKey(pkBytes).toBase58();
            const actionCount = cd.readUInt32LE(168 + i * 4);
            // Skip zero pubkeys (empty operator slots)
            if (pk !== '11111111111111111111111111111111') {
              operators.push({ pubkey: pk, actionCount });
            }
          }
          const totalActions = cd.readUInt32LE(184);
          const lastHand = cd.readUInt32LE(188);
          setCrankTally({ operators, totalActions, lastHand });
        }
      } catch {
        // Crank tally may not exist for all tables; that is fine
      }

      // Fetch seat data for current hand
      const seats: SeatInfo[] = [];
      const seatPromises: Promise<void>[] = [];
      for (let i = 0; i < maxPlayers; i++) {
        const seatPda = getSeatPda(tablePda, i);
        const seatCardsPda = getSeatCardsPda(tablePda, i);
        seatPromises.push(
          (async () => {
            try {
              const [seatAcct, cardsAcct] = await Promise.all([
                connection.getAccountInfo(seatPda),
                connection.getAccountInfo(seatCardsPda),
              ]);

              let playerPubkey = '11111111111111111111111111111111';
              let chips = 0;
              let bet = 0;
              let status = 0;

              if (seatAcct && seatAcct.data) {
                const sd = Buffer.from(seatAcct.data);
                // Seat layout: disc(8) + table(32) + seat_index(1) + player(32) + chips(8) + bet(8) + status(1) ...
                playerPubkey = new PublicKey(sd.subarray(41, 73)).toBase58();
                chips = readU64LE(sd, 73);
                bet = readU64LE(sd, 81);
                status = sd.readUInt8(89);
              }

              let card1 = CARD_NOT_DEALT;
              let card2 = CARD_NOT_DEALT;

              if (cardsAcct && cardsAcct.data) {
                const scd = Buffer.from(cardsAcct.data);
                card1 = scd.readUInt8(SEAT_CARDS_OFFSETS.CARD1);
                card2 = scd.readUInt8(SEAT_CARDS_OFFSETS.CARD2);
              }

              seats[i] = { index: i, playerPubkey, card1, card2, chips, bet, status };
            } catch {
              seats[i] = {
                index: i,
                playerPubkey: '11111111111111111111111111111111',
                card1: CARD_NOT_DEALT,
                card2: CARD_NOT_DEALT,
                chips: 0,
                bet: 0,
                status: 0,
              };
            }
          })(),
        );
      }
      await Promise.all(seatPromises);

      setHandData({
        handNumber,
        pot,
        rakeAccumulated,
        communityCards,
        phase,
        phaseName: PHASE_NAMES[phase] || `Unknown (${phase})`,
        seats: seats.filter((s) => s.status !== 0), // only occupied seats
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'An unexpected error occurred.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [tableAddress]);

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <div className="max-w-3xl mx-auto px-4 py-10">
        {/* Header */}
        <div className="mb-8">
          <Link href="/" className="text-emerald-400 hover:text-emerald-300 text-sm mb-4 inline-block">
            &larr; Back to Lobby
          </Link>
          <h1 className="text-3xl font-bold text-white">Hand Verification</h1>
          <p className="text-gray-400 mt-1">
            Verify poker hands dealt via Arcium Multi-Party Computation
          </p>
        </div>

        {/* How It Works */}
        <div className="bg-emerald-900/15 border border-emerald-800/30 rounded-xl p-5 mb-8">
          <h2 className="text-emerald-400 font-semibold text-sm uppercase tracking-wide mb-2">
            How It Works
          </h2>
          <p className="text-gray-300 text-sm leading-relaxed">
            Every hand in FastPoker is dealt using Arcium&apos;s Multi-Party Computation (MPC) network.
            Cards are shuffled and encrypted across multiple independent nodes &mdash; no single party
            (including the house) ever sees the full deck. Community cards and hole cards are revealed
            only when the game state requires it. Crank operators submit on-chain transactions to
            advance game phases, and their activity is tracked in a verifiable tally.
          </p>
        </div>

        {/* Input Section */}
        <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-5 mb-8">
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Table Address</label>
              <input
                type="text"
                value={tableAddress}
                onChange={(e) => setTableAddress(e.target.value)}
                placeholder="Enter Solana public key..."
                className="w-full px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white font-mono text-sm placeholder-gray-600 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/30 transition-colors"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">
                Hand Number <span className="text-gray-600">(optional)</span>
              </label>
              <input
                type="text"
                value={handNumberInput}
                onChange={(e) => setHandNumberInput(e.target.value)}
                placeholder="Leave empty for current hand"
                className="w-full px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white font-mono text-sm placeholder-gray-600 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/30 transition-colors"
              />
            </div>
            <button
              onClick={lookUp}
              disabled={loading}
              className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-800 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Looking up...
                </span>
              ) : (
                'Look Up'
              )}
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-900/20 border border-red-800/30 rounded-xl p-4 mb-6">
            <p className="text-red-400 text-sm">{error}</p>
          </div>
        )}

        {/* Results */}
        {tableInfo && (
          <div className="space-y-6">
            {/* Table Info Bar */}
            <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-5">
              <h3 className="text-white font-semibold mb-3">Table Info</h3>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-gray-500">Address</span>
                  <p className="text-white font-mono text-xs mt-0.5 break-all">{tableInfo.address}</p>
                </div>
                <div>
                  <span className="text-gray-500">Game Type</span>
                  <p className="text-white mt-0.5">{tableInfo.gameTypeName}</p>
                </div>
                <div>
                  <span className="text-gray-500">Blinds</span>
                  <p className="text-white mt-0.5">
                    {lamportsToSol(tableInfo.smallBlind)} / {lamportsToSol(tableInfo.bigBlind)} SOL
                  </p>
                </div>
                <div>
                  <span className="text-gray-500">Rake Cap</span>
                  <p className="text-white mt-0.5">
                    {tableInfo.rakeCap > 0 ? `${lamportsToSol(tableInfo.rakeCap)} SOL` : 'None'}
                  </p>
                </div>
                <div>
                  <span className="text-gray-500">Players</span>
                  <p className="text-white mt-0.5">
                    {tableInfo.currentPlayers} / {tableInfo.maxPlayers}
                  </p>
                </div>
                <div>
                  <span className="text-gray-500">Phase</span>
                  <p className="text-white mt-0.5">{tableInfo.phaseName}</p>
                </div>
              </div>
            </div>

            {/* Crank Operators */}
            {crankTally && crankTally.operators.length > 0 && (
              <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-white font-semibold">Crank Operators</h3>
                  <span className="text-xs text-gray-500">
                    {crankTally.totalActions} total actions &middot; last hand #{crankTally.lastHand}
                  </span>
                </div>
                <div className="space-y-3">
                  {crankTally.operators.map((op) => {
                    const pct =
                      crankTally.totalActions > 0
                        ? (op.actionCount / crankTally.totalActions) * 100
                        : 0;
                    return (
                      <div key={op.pubkey}>
                        <div className="flex items-center justify-between text-sm mb-1">
                          <span className="font-mono text-cyan-400 text-xs">
                            {truncatePubkey(op.pubkey)}
                          </span>
                          <span className="text-gray-400">
                            {op.actionCount} actions ({pct.toFixed(1)}%)
                          </span>
                        </div>
                        <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-cyan-500 rounded-full transition-all duration-500"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Hand History */}
            {handData && (
              <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-white font-semibold">
                    Hand #{handData.handNumber}
                  </h3>
                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-gray-400">
                      Pot: <span className="text-white font-medium">{lamportsToSol(handData.pot)} SOL</span>
                    </span>
                    {handData.rakeAccumulated > 0 && (
                      <span className="text-amber-400">
                        Rake: {lamportsToSol(handData.rakeAccumulated)} SOL
                      </span>
                    )}
                  </div>
                </div>

                {/* Phase Badge */}
                <div className="mb-4">
                  <span className="inline-block px-2.5 py-1 bg-emerald-600 text-white text-xs font-medium rounded-full">
                    {handData.phaseName}
                  </span>
                </div>

                {/* Board */}
                <div className="mb-5">
                  <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Board</p>
                  <div className="flex gap-2">
                    {handData.communityCards.map((c, i) => (
                      <CardDisplay key={i} cardIndex={c} />
                    ))}
                  </div>
                </div>

                {/* Seats */}
                {handData.seats.length > 0 && (
                  <div>
                    <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Seats</p>
                    <div className="space-y-2">
                      {handData.seats.map((seat) => {
                        const hasCards = seat.card1 !== CARD_NOT_DEALT || seat.card2 !== CARD_NOT_DEALT;
                        const isEmpty = seat.playerPubkey === '11111111111111111111111111111111';
                        const statusName = SEAT_STATUS_NAMES[seat.status] || `Status ${seat.status}`;
                        const isWinner = seat.status === 1 && handData.phase === 5 && seat.chips > 0;

                        return (
                          <div
                            key={seat.index}
                            className={`p-3 rounded-lg border ${
                              isWinner
                                ? 'bg-emerald-900/20 border-emerald-800/30'
                                : 'bg-gray-800/30 border-gray-700/30'
                            }`}
                          >
                            <div className="flex items-center justify-between mb-1.5">
                              <div className="flex items-center gap-2">
                                <span className="text-gray-500 text-xs">Seat {seat.index}</span>
                                {!isEmpty && (
                                  <span className="font-mono text-xs text-gray-300">
                                    {truncatePubkey(seat.playerPubkey)}
                                  </span>
                                )}
                                {isWinner && (
                                  <span className="text-emerald-400 text-xs font-medium px-1.5 py-0.5 bg-emerald-900/30 rounded">
                                    Winner
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-3 text-xs text-gray-400">
                                <span>{statusName}</span>
                                <span>{lamportsToSol(seat.chips)} SOL</span>
                                {seat.bet > 0 && (
                                  <span className="text-amber-400">
                                    Bet: {lamportsToSol(seat.bet)}
                                  </span>
                                )}
                              </div>
                            </div>
                            {hasCards && (
                              <div className="flex gap-1.5 mt-1">
                                <CardDisplay cardIndex={seat.card1} />
                                <CardDisplay cardIndex={seat.card2} />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Arcium MPC Note */}
                <div className="mt-5 pt-4 border-t border-gray-800">
                  <p className="text-gray-500 text-xs">
                    Cards dealt via Arcium MPC &mdash; shuffled across multiple independent nodes.
                    Full hand history for past hands requires indexer integration. The data above
                    reflects the current on-chain state for hand #{handData.handNumber}.
                  </p>
                </div>
              </div>
            )}

            {/* Historical hands note */}
            {handData && handData.handNumber > 1 && (
              <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-4">
                <p className="text-gray-400 text-sm">
                  <span className="text-gray-300 font-medium">Note:</span> Unlike TEE-based
                  systems with a FairnessBuffer ring buffer, Arcium MPC does not store hand history
                  on-chain. The verification above shows the current hand state. For historical hand
                  replay, an off-chain indexer (parsing transaction logs and Arcium computation
                  events) is required.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Empty State */}
        {!tableInfo && !loading && !error && (
          <div className="text-center py-16">
            <div className="text-gray-600 text-5xl mb-4">&#x1F50D;</div>
            <p className="text-gray-500">Enter a table address to verify hand data</p>
          </div>
        )}
      </div>
    </div>
  );
}
