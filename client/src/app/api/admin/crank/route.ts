import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

// Paths to crank files — try multiple locations for WSL/Windows compat
const BACKEND_CANDIDATES = [
  path.resolve(process.cwd(), '..', 'backend'),
  '/mnt/j/Poker-Arc/backend',
  'J:/Poker-Arc/backend',
];

function findFile(filename: string): string | null {
  for (const dir of BACKEND_CANDIDATES) {
    const p = path.join(dir, filename);
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

function readJsonFile(filename: string): any | null {
  const p = findFile(filename);
  if (!p) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function getBackendDir(): string {
  for (const dir of BACKEND_CANDIDATES) {
    try { if (fs.existsSync(dir)) return dir; } catch {}
  }
  return BACKEND_CANDIDATES[0];
}

/** GET — returns crank heartbeat, metrics, and status */
export async function GET() {
  const heartbeat = readJsonFile('crank-heartbeat.json');
  const metrics = readJsonFile('crank-metrics.json');

  if (!heartbeat) {
    return NextResponse.json({
      status: 'offline',
      message: 'No heartbeat file found — crank may not be running',
      heartbeat: null,
      metrics: null,
      recentLogs: [],
    });
  }

  const heartbeatAge = Date.now() - (heartbeat.heartbeat || 0);
  const isOnline = heartbeatAge < 15_000;

  return NextResponse.json({
    status: isOnline ? 'online' : 'offline',
    pid: heartbeat.pid,
    startedAt: heartbeat.startedAt,
    heartbeat: heartbeat.heartbeat,
    heartbeatAge,
    uptime: heartbeat.uptime || '',
    tablesTracked: heartbeat.tablesTracked ?? 0,
    tablesProcessing: heartbeat.tablesProcessing ?? 0,
    recentErrors: heartbeat.recentErrors ?? [],
    dealMode: heartbeat.dealMode ?? 'unknown',
    dealerStats: heartbeat.dealerStats ?? null,
    config: heartbeat.config ?? null,
    metrics: metrics ?? null,
    recentLogs: heartbeat.recentErrors?.slice(0, 20) ?? [],
  });
}

/** POST — send control commands to crank via control file */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = body.action as string;

    if (!['start', 'stop', 'restart'].includes(action)) {
      return NextResponse.json({ error: 'Invalid action. Use: start, stop, restart' }, { status: 400 });
    }

    const backendDir = getBackendDir();
    const controlPath = path.join(backendDir, 'crank-control.json');

    if (action === 'stop' || action === 'restart') {
      // Write control file — crank polls this every 5s
      fs.writeFileSync(controlPath, JSON.stringify({ command: action, timestamp: Date.now() }), 'utf-8');
      return NextResponse.json({
        message: `${action} command sent — crank will pick it up within ~5 seconds`,
        action,
      });
    }

    if (action === 'start') {
      // Check if crank is already running
      const heartbeat = readJsonFile('crank-heartbeat.json');
      if (heartbeat) {
        const age = Date.now() - (heartbeat.heartbeat || 0);
        if (age < 15_000) {
          return NextResponse.json({
            message: 'Crank is already running',
            action: 'start',
            pid: heartbeat.pid,
          });
        }
      }
      return NextResponse.json({
        message: 'Start command noted — please start the crank service manually via CLI',
        action: 'start',
        hint: 'ARCIUM_CLUSTER_OFFSET=0 npx ts-node --transpile-only backend/crank-service.ts',
      });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
