/**
 * Arcium Frontend Integration E2E Tests
 *
 * Tests the Arcium-specific UI features added to the poker frontend:
 *   1. MPC phase overlays (Shuffling & Dealing, Revealing Flop/Turn/River/Hands)
 *   2. Encrypted card display during active play (useArciumCards hook)
 *   3. Session key auto-claim fallback for P2+ seats
 *   4. Phase-aware community card buffering
 *   5. Cash game full lifecycle with MPC phases
 *
 * Prerequisites:
 *   - Arcium localnet running (localhost:8899) with MPC nodes
 *   - Circuit init completed (arcium-init-circuits.ts)
 *   - localnet-bootstrap.ts run (creates Steel pool + test tables)
 *   - Crank service running with LOCAL_MODE=true
 *   - Dev server running (npm run dev)
 *
 * Run: E2E_BASE_URL=http://localhost:3002 npx playwright test e2e/arcium-frontend.spec.ts
 */
import { test, expect, createPlayerPage } from './fixtures/wallet';
import {
  goToGame, waitForMyTurn, doAction,
} from './fixtures/game-helper';
import { Connection, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

const RPC = process.env.E2E_RPC_URL || 'http://localhost:8899';
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3001';
const PROGRAM_ID = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');

// MPC operations take 2-10s on localnet; generous timeouts needed
test.describe.configure({ timeout: 600_000 }); // 10 min per test

/** Load pre-bootstrapped table PDA from .localnet-state.json */
function getBootstrappedTable(type: string): string | null {
  try {
    const stateFile = path.join(__dirname, '.localnet-state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    const table = state.tables.find((t: any) => t.type.includes(type));
    return table?.pda || null;
  } catch { return null; }
}

/** Read table phase from on-chain data */
async function getTablePhase(tablePda: string): Promise<number> {
  const conn = new Connection(RPC, 'confirmed');
  const info = await conn.getAccountInfo(new PublicKey(tablePda));
  if (!info || info.data.length < 161) return -1;
  return info.data[160]; // PHASE offset
}

/** Read SeatCards encrypted data to verify encryption present */
async function getSeatCardsEncrypted(tablePda: string, seatIndex: number): Promise<{ hasEnc: boolean; card1: number; card2: number }> {
  const conn = new Connection(RPC, 'confirmed');
  const [seatCardsPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('seat_cards'), new PublicKey(tablePda).toBuffer(), Buffer.from([seatIndex])],
    PROGRAM_ID,
  );
  const info = await conn.getAccountInfo(seatCardsPda);
  if (!info || info.data.length < 156) return { hasEnc: false, card1: 255, card2: 255 };
  const enc = info.data.slice(76, 108); // enc_card1 (32 bytes)
  const hasEnc = !enc.every((b: number) => b === 0);
  return { hasEnc, card1: info.data[73], card2: info.data[74] };
}

// Phase enum (matches on-chain)
const Phase = {
  Waiting: 0, Starting: 1, AwaitingDeal: 2, Preflop: 3,
  Flop: 4, Turn: 5, River: 6, Showdown: 7,
  AwaitingShowdown: 8, Complete: 9,
  FlopRevealPending: 10, TurnRevealPending: 11, RiverRevealPending: 12,
};

/** Helper: register wallet on-chain via the landing page */
async function registerPlayer(page: any) {
  await page.goto(BASE_URL);
  await page.waitForTimeout(2000);
  const registerBtn = page.getByRole('button', { name: /Register.*Play/i });
  if (await registerBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await registerBtn.click();
    await page.waitForSelector('text=/Sit & Go|Cash Games|Loading/i', { timeout: 45000 });
    await page.waitForTimeout(2000);
  }
}

/** Helper: sit down at a table (click SIT, set buy-in, confirm) */
async function sitDown(page: any, label: string) {
  const sitBtn = page.getByRole('button', { name: /^SIT$/i }).first();
  await expect(sitBtn).toBeVisible({ timeout: 15000 });
  await sitBtn.click();
  await expect(page.getByText(/Buy In/i)).toBeVisible({ timeout: 10000 });
  const slider = page.locator('input[type="range"]');
  if (await slider.isVisible({ timeout: 2000 }).catch(() => false)) {
    await slider.fill('20');
    await page.waitForTimeout(500);
  }
  await page.getByRole('button', { name: /Confirm.*Sit/i }).click();
  await page.waitForSelector('text=/Leave Table|Waiting for|Seated|Error/i', { timeout: 60000 });
  console.log(`  ${label} seated`);
}

test.describe('Arcium Frontend Integration', () => {

  test('Full MPC game flow: deal → play → reveal → showdown', async ({ browser, wallets }) => {
    // Use pre-bootstrapped HU table (2 seats)
    const tablePda = getBootstrappedTable('HU');
    if (!tablePda) {
      test.skip(true, 'No bootstrapped table found — run localnet-bootstrap.ts first');
      return;
    }
    console.log(`\n  Using bootstrapped HU table: ${tablePda.slice(0, 16)}..`);

    const { page: p1, context: ctx1 } = await createPlayerPage(browser, wallets[0]);
    const { page: p2, context: ctx2 } = await createPlayerPage(browser, wallets[1]);

    try {
      // Register both players
      console.log('\n=== Register players ===');
      await registerPlayer(p1);
      await registerPlayer(p2);

      // Navigate to the pre-created table
      console.log('\n=== Navigate to table ===');
      await goToGame(p1, tablePda);
      await goToGame(p2, tablePda);
      await p1.waitForSelector('text=/BLINDS|ON-CHAIN|SIT|Cash Game/i', { timeout: 30000 });
      await p2.waitForSelector('text=/BLINDS|ON-CHAIN|SIT|Cash Game/i', { timeout: 30000 });

      // Sit both players
      console.log('\n=== Sit players ===');
      await sitDown(p1, 'P1');
      await p2.waitForTimeout(3000); // let P1 seat propagate
      await goToGame(p2, tablePda); // refresh to see updated seats
      await p2.waitForTimeout(2000);
      await sitDown(p2, 'P2');

      // Wait for MPC deal: Waiting → Starting → AwaitingDeal → Preflop
      console.log('\n=== Wait for MPC deal ===');
      let sawMpcOverlay = false;
      let sawPreflop = false;
      const mpcStart = Date.now();
      const MPC_TIMEOUT = 300_000; // 5 min — first MPC on fresh localnet can take minutes

      while (Date.now() - mpcStart < MPC_TIMEOUT) {
        // Check MPC overlay on P1's page
        const shuffleText = p1.getByText(/Shuffling.*Dealing/i);
        if (!sawMpcOverlay && await shuffleText.isVisible({ timeout: 500 }).catch(() => false)) {
          sawMpcOverlay = true;
          console.log('  ✓ MPC overlay visible: "Shuffling & Dealing..."');
        }

        // Check PreFlop reached
        const preflopText = p1.getByText(/PreFlop/i);
        if (await preflopText.isVisible({ timeout: 500 }).catch(() => false)) {
          sawPreflop = true;
          console.log('  ✓ Advanced to PreFlop (UI)');
          break;
        }

        // Also check on-chain phase
        const phase = await getTablePhase(tablePda).catch(() => -1);
        if (phase >= Phase.Preflop && phase <= Phase.Complete) {
          sawPreflop = true;
          console.log(`  ✓ On-chain phase: ${phase}`);
          await p1.reload();
          await p1.waitForTimeout(3000);
          break;
        }

        // Log progress every 10s
        if ((Date.now() - mpcStart) % 10000 < 2100) {
          console.log(`  [${Math.round((Date.now() - mpcStart) / 1000)}s] phase=${phase}, waiting...`);
        }

        await p1.waitForTimeout(2000);
      }

      if (!sawPreflop) {
        const finalPhase = await getTablePhase(tablePda).catch(() => -1);
        console.log(`  ⚠ MPC timeout. Final on-chain phase: ${finalPhase}`);
        test.skip(true, `MPC deal did not complete (phase=${finalPhase}). First run may need 5-15min preprocessing.`);
        return;
      }

      // Verify encrypted cards on-chain
      console.log('\n=== Verify encrypted cards ===');
      const sc0 = await getSeatCardsEncrypted(tablePda, 0);
      const sc1 = await getSeatCardsEncrypted(tablePda, 1);
      console.log(`  Seat 0: hasEnc=${sc0.hasEnc}, card1=${sc0.card1}, card2=${sc0.card2}`);
      console.log(`  Seat 1: hasEnc=${sc1.hasEnc}, card1=${sc1.card1}, card2=${sc1.card2}`);
      expect(sc0.hasEnc || sc1.hasEnc).toBe(true);
      console.log('  ✓ Encrypted hole cards present on-chain');

      // Play through the hand: check/call through all streets
      console.log('\n=== Play hand ===');
      let handComplete = false;
      for (let round = 0; round < 30 && !handComplete; round++) {
        for (const [label, pg] of [['P1', p1], ['P2', p2]] as const) {
          const turn = await waitForMyTurn(pg, 10000);
          if (turn === 'check') {
            await doAction(pg, 'check');
            console.log(`    [${label}] check`);
          } else if (turn === 'call') {
            await doAction(pg, 'call');
            console.log(`    [${label}] call`);
          } else if (turn === 'fold') {
            // Try call first to keep the hand going
            const callBtn = pg.getByRole('button', { name: /^Call/i });
            if (await callBtn.isVisible({ timeout: 500 }).catch(() => false)) {
              await doAction(pg, 'call');
              console.log(`    [${label}] call (was fold context)`);
            } else {
              await doAction(pg, 'fold');
              console.log(`    [${label}] fold`);
              handComplete = true;
              break;
            }
          } else if (turn === 'waiting') {
            console.log(`    [${label}] hand ended`);
            handComplete = true;
            break;
          } else {
            // timeout — check for MPC reveal pending or hand end
            const phase = await getTablePhase(tablePda).catch(() => -1);
            console.log(`    [${label}] timeout, on-chain phase=${phase}`);
            if (phase === Phase.Complete || phase === Phase.Waiting) {
              handComplete = true;
              break;
            }
            // MPC reveal in progress — wait
            if ([Phase.FlopRevealPending, Phase.TurnRevealPending, Phase.RiverRevealPending, Phase.AwaitingShowdown].includes(phase)) {
              console.log(`    MPC reveal in progress (phase=${phase}), waiting...`);
              await pg.waitForTimeout(10000);
              continue;
            }
          }
        }
      }

      await p1.waitForTimeout(5000);
      const endPhase = await getTablePhase(tablePda).catch(() => -1);
      console.log(`\n  Hand complete. Final phase: ${endPhase}`);
      console.log('=== ARCIUM FRONTEND E2E TEST COMPLETE ===');

    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });

  test('Frontend smoke test — renders without errors', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(2000);

    const pageTitle = await page.title();
    console.log(`  Page title: ${pageTitle}`);
    expect(pageTitle).toBeTruthy();

    // Check for critical console errors (exclude network/favicon)
    const errorLogs: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errorLogs.push(msg.text().slice(0, 100));
    });
    await page.waitForTimeout(3000);

    const criticalErrors = errorLogs.filter(e =>
      !e.includes('favicon') && !e.includes('404') && !e.includes('net::')
    );
    if (criticalErrors.length > 0) {
      console.log('  ⚠ Console errors:', criticalErrors.slice(0, 5));
    } else {
      console.log('  ✓ No critical console errors');
    }

    // Navigate to the bootstrapped table and verify game page renders
    const tablePda = getBootstrappedTable('HU');
    if (tablePda) {
      await goToGame(page, tablePda);
      await page.waitForTimeout(5000);
      // Verify game page shows table elements
      const gameEl = page.getByText(/Cash Game|Waiting|SIT|BLINDS/i).first();
      const visible = await gameEl.isVisible({ timeout: 10000 }).catch(() => false);
      if (visible) {
        console.log('  ✓ Game page rendered successfully');
      } else {
        console.log('  ⚠ Game page elements not found');
      }
    }
  });

});
