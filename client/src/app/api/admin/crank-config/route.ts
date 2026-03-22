import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

// Paths to crank config — try multiple locations for WSL/Windows compat
const BACKEND_CANDIDATES = [
  path.resolve(process.cwd(), '..', 'backend'),
  '/mnt/j/Poker-Arc/backend',
  'J:/Poker-Arc/backend',
];

const CONFIG_FILENAME = 'crank-config.json';

function findConfigPath(): string | null {
  for (const dir of BACKEND_CANDIDATES) {
    const p = path.join(dir, CONFIG_FILENAME);
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

function getWritablePath(): string {
  for (const dir of BACKEND_CANDIDATES) {
    try { if (fs.existsSync(dir)) return path.join(dir, CONFIG_FILENAME); } catch {}
  }
  return path.join(BACKEND_CANDIDATES[0], CONFIG_FILENAME);
}

const DEFAULT_CONFIG: Record<string, any> = {
  process_cashouts: true,
  auto_kick: true,
  rake_sweep: false,
  auction_sweep: true,
  timeout_enabled: true,
  crank_sng: true,
  crank_cash: true,
  removal_sweep_interval: 30000,
  rake_sweep_interval: 60000,
  timeout_ms: 20000,
  tee_rpc: '',
  l1_rpc: 'http://127.0.0.1:8899',
  table_filter_mode: 'none',
  table_whitelist: [],
  table_blacklist: [],
  priority_fee_microlamports: 0,
  arcium_compute_units: 0,
};

function loadConfig(): Record<string, any> {
  const p = findConfigPath();
  if (p) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return { ...DEFAULT_CONFIG, ...raw };
    } catch {}
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config: Record<string, any>): void {
  const p = getWritablePath();
  fs.writeFileSync(p, JSON.stringify(config, null, 2), 'utf-8');
}

/** GET — returns current crank config */
export async function GET() {
  const config = loadConfig();
  return NextResponse.json({ config });
}

/** POST — update crank config fields (hot-reload, crank picks up within ~5s) */
export async function POST(req: NextRequest) {
  try {
    const updates = await req.json();
    const current = loadConfig();

    // Merge updates into current config
    const merged = { ...current };
    for (const [key, value] of Object.entries(updates)) {
      if (key in DEFAULT_CONFIG) {
        merged[key] = value;
      }
    }

    saveConfig(merged);
    return NextResponse.json({ config: merged, message: 'Config saved — crank will pick up changes within ~5s' });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
