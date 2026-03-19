'use client';

import Link from 'next/link';

const HAND_RANKINGS = [
  { name: 'Royal Flush', desc: 'A, K, Q, J, 10 — all the same suit', example: 'A♠ K♠ Q♠ J♠ T♠', rank: 1 },
  { name: 'Straight Flush', desc: 'Five consecutive cards of the same suit', example: '9♥ 8♥ 7♥ 6♥ 5♥', rank: 2 },
  { name: 'Four of a Kind', desc: 'Four cards of the same rank', example: 'Q♠ Q♥ Q♦ Q♣ 7♠', rank: 3 },
  { name: 'Full House', desc: 'Three of a kind plus a pair', example: 'J♠ J♥ J♦ 8♣ 8♠', rank: 4 },
  { name: 'Flush', desc: 'Five cards of the same suit (any order)', example: 'A♦ J♦ 8♦ 6♦ 2♦', rank: 5 },
  { name: 'Straight', desc: 'Five consecutive cards of mixed suits', example: 'T♠ 9♥ 8♦ 7♣ 6♠', rank: 6 },
  { name: 'Three of a Kind', desc: 'Three cards of the same rank', example: '7♠ 7♥ 7♦ K♣ 3♠', rank: 7 },
  { name: 'Two Pair', desc: 'Two different pairs', example: 'A♠ A♥ 9♦ 9♣ 4♠', rank: 8 },
  { name: 'One Pair', desc: 'Two cards of the same rank', example: 'K♠ K♥ J♦ 8♣ 3♠', rank: 9 },
  { name: 'High Card', desc: 'No made hand — highest card plays', example: 'A♠ J♥ 8♦ 6♣ 2♠', rank: 10 },
];

export default function HowToPlayPage() {
  return (
    <div className="bg-gray-950 text-white">
      <main className="max-w-4xl mx-auto px-4 py-8 space-y-10">
        {/* Hero */}
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight">
            <span className="text-cyan-400">How to Play</span> Texas Hold&apos;em
          </h1>
          <p className="mt-2 text-gray-400 max-w-xl mx-auto">
            The complete guide to playing poker on FAST POKER — fully on-chain, provably fair, with real stakes.
          </p>
        </div>

        {/* Quick Nav */}
        <div className="flex flex-wrap gap-2 justify-center">
          {['Rules', 'Hand Rankings', 'Game Types', 'Fees & Rake', 'On-Chain', 'Sessions'].map(s => (
            <a key={s} href={`#${s.toLowerCase().replace(/[^a-z]/g, '-')}`}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/[0.04] border border-white/[0.06] text-gray-400 hover:text-cyan-400 hover:border-cyan-500/30 transition-colors">
              {s}
            </a>
          ))}
        </div>

        {/* ─── Rules ─── */}
        <section id="rules" className="space-y-4">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <span className="text-cyan-400">♠</span> Basic Rules
          </h2>
          <div className="space-y-3 text-sm text-gray-300 leading-relaxed">
            <p>
              Texas Hold&apos;em is played with a standard 52-card deck. Each player is dealt <strong className="text-white">2 hole cards</strong> face down,
              and <strong className="text-white">5 community cards</strong> are dealt face up on the board. You make the best 5-card hand using any
              combination of your hole cards and the community cards.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-4">
                <h3 className="text-sm font-bold text-cyan-400 mb-2">Betting Rounds</h3>
                <ol className="space-y-1.5 text-xs text-gray-400">
                  <li><strong className="text-white">1. Preflop</strong> — Two hole cards dealt. Betting starts left of big blind.</li>
                  <li><strong className="text-white">2. Flop</strong> — Three community cards revealed. Betting starts left of dealer.</li>
                  <li><strong className="text-white">3. Turn</strong> — Fourth community card revealed. Another betting round.</li>
                  <li><strong className="text-white">4. River</strong> — Fifth community card revealed. Final betting round.</li>
                  <li><strong className="text-white">5. Showdown</strong> — Best hand wins the pot.</li>
                </ol>
              </div>
              <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-4">
                <h3 className="text-sm font-bold text-cyan-400 mb-2">Player Actions</h3>
                <ul className="space-y-1.5 text-xs text-gray-400">
                  <li><strong className="text-white">Fold</strong> — Surrender your hand and forfeit any bets.</li>
                  <li><strong className="text-white">Check</strong> — Pass the action (only if no bet to you).</li>
                  <li><strong className="text-white">Call</strong> — Match the current bet.</li>
                  <li><strong className="text-white">Raise</strong> — Increase the bet. Min raise = previous raise size.</li>
                  <li><strong className="text-white">All-In</strong> — Bet your entire stack.</li>
                </ul>
              </div>
            </div>
            <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-4">
              <h3 className="text-sm font-bold text-cyan-400 mb-2">Blinds & Dealer Button</h3>
              <p className="text-xs text-gray-400">
                Each hand, the <strong className="text-white">dealer button (D)</strong> rotates clockwise. The player left of the dealer posts the
                <strong className="text-white"> small blind (SB)</strong>, and the next player posts the <strong className="text-white">big blind (BB)</strong>.
                These forced bets seed the pot and ensure action every hand.
              </p>
            </div>
          </div>
        </section>

        {/* ─── Hand Rankings ─── */}
        <section id="hand-rankings" className="space-y-4">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <span className="text-amber-400">♦</span> Hand Rankings
          </h2>
          <p className="text-sm text-gray-400">Hands ranked from strongest (1) to weakest (10):</p>
          <div className="space-y-1">
            {HAND_RANKINGS.map(h => (
              <div key={h.rank}
                className="flex items-center justify-between px-4 py-2.5 rounded-lg bg-white/[0.02] border border-white/[0.04] hover:bg-white/[0.04] transition-colors">
                <div className="flex items-center gap-3">
                  <span className="w-6 h-6 rounded-full bg-white/[0.06] flex items-center justify-center text-xs font-bold text-gray-400">{h.rank}</span>
                  <div>
                    <span className="text-sm font-bold text-white">{h.name}</span>
                    <span className="text-xs text-gray-500 ml-2">{h.desc}</span>
                  </div>
                </div>
                <span className="font-mono text-xs text-gray-400 hidden sm:block">{h.example}</span>
              </div>
            ))}
          </div>
        </section>

        {/* ─── Game Types ─── */}
        <section id="game-types" className="space-y-4">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <span className="text-emerald-400">♣</span> Game Types
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-xl bg-gradient-to-br from-cyan-500/[0.06] to-transparent border border-cyan-500/20 p-5">
              <h3 className="text-base font-bold text-cyan-400 mb-2">Sit &amp; Go Tournaments</h3>
              <ul className="space-y-2 text-xs text-gray-400">
                <li><strong className="text-white">Buy-in:</strong> Fixed entry fee + tournament fee</li>
                <li><strong className="text-white">Players:</strong> 2-9 players per table</li>
                <li><strong className="text-white">Blinds:</strong> Increase over time (escalating levels)</li>
                <li><strong className="text-white">Prizes:</strong> Top finishers split the prize pool</li>
                <li><strong className="text-white">Chips:</strong> Virtual tournament chips (no cash value)</li>
                <li><strong className="text-white">End:</strong> Last player standing wins</li>
              </ul>
              <div className="mt-3 text-[10px] text-gray-600">Tiers: Micro, Bronze, Silver, Gold, Platinum, Diamond</div>
            </div>
            <div className="rounded-xl bg-gradient-to-br from-amber-500/[0.06] to-transparent border border-amber-500/20 p-5">
              <h3 className="text-base font-bold text-amber-400 mb-2">Cash Games</h3>
              <ul className="space-y-2 text-xs text-gray-400">
                <li><strong className="text-white">Buy-in:</strong> 20-100 big blinds (your choice)</li>
                <li><strong className="text-white">Players:</strong> 2-6 per table (sit anytime, leave anytime)</li>
                <li><strong className="text-white">Blinds:</strong> Fixed (e.g. 0.005/0.01 SOL)</li>
                <li><strong className="text-white">Stakes:</strong> Real SOL or $POKER tokens</li>
                <li><strong className="text-white">Chips:</strong> 1:1 backed by your deposit (escrow)</li>
                <li><strong className="text-white">Leave:</strong> Cash out your chip balance anytime between hands</li>
              </ul>
              <div className="mt-3 text-[10px] text-gray-600">Create your own table or join an existing one</div>
            </div>
          </div>
        </section>

        {/* ─── Fees & Rake ─── */}
        <section id="fees---rake" className="space-y-4">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <span className="text-purple-400">♥</span> Fees &amp; Rake
          </h2>
          <div className="space-y-3">
            <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-4">
              <h3 className="text-sm font-bold text-purple-400 mb-2">Sit &amp; Go Fees</h3>
              <p className="text-xs text-gray-400">
                Each tournament has a <strong className="text-white">buy-in</strong> that goes to the prize pool and a
                <strong className="text-white"> tournament fee</strong> that supports the platform. No rake on individual hands.
              </p>
              <div className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-lg bg-white/[0.03] p-2">
                  <div className="text-gray-500">Micro</div>
                  <div className="text-white font-bold">0.01 SOL</div>
                </div>
                <div className="rounded-lg bg-white/[0.03] p-2">
                  <div className="text-gray-500">Bronze</div>
                  <div className="text-white font-bold">0.05 SOL</div>
                </div>
                <div className="rounded-lg bg-white/[0.03] p-2">
                  <div className="text-gray-500">Silver</div>
                  <div className="text-white font-bold">0.1 SOL</div>
                </div>
              </div>
            </div>
            <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-4">
              <h3 className="text-sm font-bold text-amber-400 mb-2">Cash Game Rake</h3>
              <p className="text-xs text-gray-400">
                Cash games use a standard <strong className="text-white">5% pot rake</strong> (taken only when the flop is reached).
                No rake on hands that end preflop. Rake is deducted from the pot before winnings are distributed.
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg bg-white/[0.03] p-2">
                  <div className="text-gray-500">Rake Rate</div>
                  <div className="text-white font-bold">5% of pot</div>
                </div>
                <div className="rounded-lg bg-white/[0.03] p-2">
                  <div className="text-gray-500">Only If</div>
                  <div className="text-white font-bold">Flop reached</div>
                </div>
              </div>
            </div>
            <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-4">
              <h3 className="text-sm font-bold text-emerald-400 mb-2">Where Rake Goes</h3>
              <div className="grid grid-cols-3 gap-2 text-center text-xs mt-2">
                <div className="rounded-lg bg-amber-500/[0.06] border border-amber-500/15 p-2">
                  <div className="text-amber-400/60">Table Creator</div>
                  <div className="text-amber-400 font-bold text-lg">50%</div>
                </div>
                <div className="rounded-lg bg-emerald-500/[0.06] border border-emerald-500/15 p-2">
                  <div className="text-emerald-400/60">Stakers</div>
                  <div className="text-emerald-400 font-bold text-lg">25%</div>
                </div>
                <div className="rounded-lg bg-purple-500/[0.06] border border-purple-500/15 p-2">
                  <div className="text-purple-400/60">Treasury</div>
                  <div className="text-purple-400 font-bold text-lg">25%</div>
                </div>
              </div>
              <p className="text-[10px] text-gray-600 mt-2 text-center">System tables: 50% stakers, 50% treasury (no creator share)</p>
            </div>
          </div>
        </section>

        {/* ─── On-Chain ─── */}
        <section id="on-chain" className="space-y-4">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <span className="text-cyan-400">&#9939;</span> Provably Fair &amp; On-Chain
          </h2>
          <div className="space-y-3 text-sm text-gray-300 leading-relaxed">
            <div className="rounded-xl bg-gradient-to-br from-cyan-500/[0.04] to-emerald-500/[0.04] border border-cyan-500/15 p-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-gray-400">
                <div>
                  <h3 className="text-sm font-bold text-cyan-400 mb-2">Card Dealing (MPC)</h3>
                  <p>Cards are shuffled and dealt via <strong className="text-white">Arcium Multi-Party Computation (MPC)</strong> — a cryptographic
                  protocol where multiple independent nodes jointly compute a provably random shuffle. No single party can predict or manipulate the cards.</p>
                </div>
                <div>
                  <h3 className="text-sm font-bold text-cyan-400 mb-2">Card Privacy (MPC)</h3>
                  <p>Your hole cards are encrypted with <strong className="text-white">Rescue cipher</strong> using your unique key —
                  stored on-chain as ciphertext that only you can decrypt. Even the server can&apos;t see them.</p>
                </div>
                <div>
                  <h3 className="text-sm font-bold text-cyan-400 mb-2">Ephemeral Rollup</h3>
                  <p>Game actions run on a <strong className="text-white">MagicBlock Ephemeral Rollup</strong> for
                  instant, gasless transactions. Your chips and actions are verifiable on Solana L1.</p>
                </div>
                <div>
                  <h3 className="text-sm font-bold text-cyan-400 mb-2">Escrow System</h3>
                  <p>Cash game deposits are held in a <strong className="text-white">table PDA escrow</strong> — a program-owned
                  account on Solana. Funds can only move via the smart contract rules. No custody risk.</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ─── Sessions ─── */}
        <section id="sessions" className="space-y-4">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <span className="text-emerald-400">&#128274;</span> Session Keys
          </h2>
          <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-4 space-y-2 text-xs text-gray-400">
            <p>
              FAST POKER uses <strong className="text-white">session keys</strong> so you don&apos;t need to approve every action in your wallet.
              When you create a session, a temporary keypair is generated in your browser and registered on-chain.
            </p>
            <ul className="space-y-1.5 pl-4">
              <li>- Session costs ~0.01 SOL (covers ~2000 gasless transactions)</li>
              <li>- Sessions last 24 hours and can be extended</li>
              <li>- You can reclaim unused session funds at any time</li>
              <li>- Session key never has access to your wallet funds — only game actions</li>
            </ul>
            <p className="text-[10px] text-gray-600 mt-2">
              Check your session status in the footer bar at the bottom of every page.
            </p>
          </div>
        </section>

        {/* Spacer for footer */}
        <div className="h-10" />
      </main>
    </div>
  );
}
