import { NextRequest, NextResponse } from 'next/server';

// In-memory SNG queue state (resets on server restart — fine for localnet testing)
interface QueueEntry {
  id: string;
  type: 'heads_up' | '6max' | '9max';
  tier: number;
  maxPlayers: number;
  currentPlayers: number;
  players: string[];
  status: 'waiting' | 'starting' | 'in_progress';
  tablePda?: string;
  buyIn: number;
}

const SNG_BUYINS: Record<number, number> = {
  0: 0,            // Micro (free)
  1: 25_000_000,   // Bronze 0.025 SOL
  2: 50_000_000,   // Silver
  3: 100_000_000,  // Gold
  4: 200_000_000,  // Platinum
  5: 500_000_000,  // Diamond
};

// Pre-seed queues for each tier + game type
const queues: Map<string, QueueEntry> = new Map();
function ensureQueues() {
  if (queues.size > 0) return;
  for (const tier of [0, 1, 2, 3, 4, 5]) {
    for (const [type, mp] of [['heads_up', 2], ['6max', 6], ['9max', 9]] as const) {
      const id = `sng_${type}_t${tier}`;
      queues.set(id, {
        id,
        type,
        tier,
        maxPlayers: mp,
        currentPlayers: 0,
        players: [],
        status: 'waiting',
        buyIn: SNG_BUYINS[tier] || 0,
      });
    }
  }
}

// GET /api/sitngos — list all queues
export async function GET() {
  ensureQueues();
  return NextResponse.json({ queues: Array.from(queues.values()) });
}

// POST /api/sitngos — join a queue
export async function POST(req: NextRequest) {
  ensureQueues();
  try {
    const body = await req.json();
    const { wallet, queueId, tier } = body;

    if (!wallet) return NextResponse.json({ error: 'Missing wallet' }, { status: 400 });

    // Find or create queue
    let queue: QueueEntry | undefined;
    if (queueId) {
      queue = queues.get(queueId);
    } else if (tier !== undefined) {
      // Find first available queue of this tier with fewest players
      queue = Array.from(queues.values())
        .filter(q => q.tier === tier && q.status === 'waiting')
        .sort((a, b) => b.currentPlayers - a.currentPlayers)[0];
    }

    if (!queue) return NextResponse.json({ error: 'Queue not found' }, { status: 404 });

    // Check if already in queue
    if (queue.players.includes(wallet)) {
      return NextResponse.json({
        success: true,
        queue: { ...queue, position: queue.players.indexOf(wallet) },
      });
    }

    // Add to queue
    queue.players.push(wallet);
    queue.currentPlayers = queue.players.length;

    // Check if queue is full → start
    if (queue.currentPlayers >= queue.maxPlayers) {
      queue.status = 'starting';
    }

    return NextResponse.json({
      success: true,
      queue: { ...queue, position: queue.players.length - 1 },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// PATCH /api/sitngos — leave queue
export async function PATCH(req: NextRequest) {
  ensureQueues();
  try {
    const body = await req.json();
    const { action, queueId, wallet } = body;

    if (action === 'leave' && queueId && wallet) {
      const queue = queues.get(queueId);
      if (queue) {
        queue.players = queue.players.filter(p => p !== wallet);
        queue.currentPlayers = queue.players.length;
        if (queue.status === 'starting' && queue.currentPlayers < queue.maxPlayers) {
          queue.status = 'waiting';
        }
      }
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
