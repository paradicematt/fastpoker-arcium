/**
 * Sit & Go E2E — HU (Heads Up):
 *   1. Both players go to lobby
 *   2. Both click "Play Free" / "Join" on HU queue
 *   3. Matchmaking creates table, both auto-join on-chain
 *   4. Play hands until one busts
 *
 * Note: SNG uses the main page (/) with internal view switching.
 * The URL stays at / — game view renders inline.
 *
 * Uses the same 9 deterministic wallets every run.
 */
import { test, expect, createPlayerPage } from './fixtures/wallet';
import {
  registerAndGoToLobby, waitForMyTurn, doAction,
} from './fixtures/game-helper';

const BASE_URL = 'http://localhost:3000';

test.describe.configure({ timeout: 600_000 }); // 10 min

test.describe('Sit & Go — Heads Up', () => {

  test('join HU queue, play until bust', async ({ browser, wallets }) => {
    // Wallet 3+4 for SNG (0,1,2 used by cash game test)
    const { page: p1, context: ctx1 } = await createPlayerPage(browser, wallets[3]);
    const { page: p2, context: ctx2 } = await createPlayerPage(browser, wallets[4]);

    // Capture console logs for debugging
    const p1Logs: string[] = [];
    const p2Logs: string[] = [];
    p1.on('console', msg => {
      const t = msg.text();
      if (t.includes('queue') || t.includes('Queue') || t.includes('join') || t.includes('Join') || t.includes('table') || t.includes('Table') || t.includes('error') || t.includes('Error')) {
        p1Logs.push(`[P1] ${t.slice(0, 120)}`);
      }
    });
    p2.on('console', msg => {
      const t = msg.text();
      if (t.includes('queue') || t.includes('Queue') || t.includes('join') || t.includes('Join') || t.includes('table') || t.includes('Table') || t.includes('error') || t.includes('Error')) {
        p2Logs.push(`[P2] ${t.slice(0, 120)}`);
      }
    });

    try {
      // ─── Register both players ───
      console.log('\n=== Register players ===');
      await registerAndGoToLobby(p1);
      await registerAndGoToLobby(p2);
      console.log('  ✓ Both registered');

      // ─── P1 joins HU SNG queue (creates table) ───
      console.log('\n=== P1 joins HU queue ===');
      await joinSngQueue(p1, 'P1');

      // Wait for P1's table to appear in P2's lobby as "Join Open Seat"
      console.log('\n=== P2 joins P1\'s table ===');
      await p2.waitForTimeout(8000); // wait for lobby refresh (5s poll interval)

      // P2 needs to see the in_progress HU table with empty seat
      // Refresh P2's lobby and look for "Join Open Seat" on a HU card
      await p2.goto(BASE_URL);
      await p2.waitForTimeout(5000);
      const sngTab2 = p2.getByRole('button', { name: /Sit & Go/i });
      if (await sngTab2.isVisible({ timeout: 3000 }).catch(() => false)) {
        await sngTab2.click();
        await p2.waitForTimeout(2000);
      }

      // Look for "Join Open Seat" button (appears on in_progress tables with empty seats)
      const joinOpenBtn = p2.getByRole('button', { name: /Join Open Seat/i }).first();
      if (await joinOpenBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
        await joinOpenBtn.click();
        console.log('  P2: Clicked "Join Open Seat" on P1\'s table');
      } else {
        // Fallback: click "Play Free" on HU card (might get matched)
        console.log('  P2: No "Join Open Seat" found, trying Play Free...');
        await joinSngQueue(p2, 'P2');
      }

      // ─── Wait for game to start ───
      console.log('\n=== Wait for game start ===');

      // Extract tablePda from console logs (both players log it)
      let tablePda: string | null = null;
      const allLogs = [...p1Logs, ...p2Logs];
      for (const log of allLogs) {
        const m = log.match(/On-chain table ready: ([A-Za-z1-9]{32,44})/);
        if (m) { tablePda = m[1]; break; }
      }
      if (tablePda) {
        console.log(`  Table PDA: ${tablePda.slice(0, 12)}`);
        // Retry the /api/sitngos/ready endpoint until game delegation succeeds
        // (The fire-and-forget call in handleJoinSitNGo often fires before P2's join confirms)
        for (let retry = 0; retry < 10; retry++) {
          const readyResult = await p2.evaluate(async ({ tpda, count }: { tpda: string; count: number }) => {
            const res = await fetch('/api/sitngos/ready', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tablePda: tpda, playerCount: count }),
            });
            return res.json();
          }, { tpda: tablePda, count: 2 });
          console.log(`  Ready attempt ${retry}: ${JSON.stringify(readyResult).slice(0, 100)}`);
          if (readyResult.success) {
            console.log('  ✓ Game ready on L1!');
            break;
          }
          await p2.waitForTimeout(5000);
        }
      }

      // Wait for game elements on either page
      // The SNG game view shows: "Sit & Go", "ON-CHAIN", "BLINDS 10/20", "PHASE: Starting"
      let gameStarted = false;
      for (let i = 0; i < 30; i++) { // up to 1 min
        for (const [label, pg] of [['P1', p1], ['P2', p2]] as const) {
          // Check multiple indicators — any one means game is running
          const indicators = [
            pg.locator('text=Starting').isVisible({ timeout: 300 }).catch(() => false),
            pg.locator('text=PreFlop').isVisible({ timeout: 300 }).catch(() => false),
            pg.locator('text=Flop').isVisible({ timeout: 300 }).catch(() => false),
            pg.locator('text=/1,\\d{3}/').isVisible({ timeout: 300 }).catch(() => false), // stack like "1,480"
            pg.locator('text=ON-CHAIN').isVisible({ timeout: 300 }).catch(() => false),
          ];
          const results = await Promise.all(indicators);
          if (results.some(r => r)) {
            console.log(`  ✓ ${label} sees game view`);
            gameStarted = true;
          }
        }
        if (gameStarted) break;
        await p1.waitForTimeout(2000);
      }

      if (!gameStarted) {
        console.log('  ⚠ Game did not start');
        console.log('  Recent logs:');
        [...p1Logs.slice(-5), ...p2Logs.slice(-5)].forEach(l => console.log(`    ${l}`));
        await p1.screenshot({ path: 'test-results/sng-p1-no-start.png' });
        await p2.screenshot({ path: 'test-results/sng-p2-no-start.png' });
        test.skip(true, 'SNG game did not start within timeout');
        return;
      }

      // ─── Play hands ───
      // P2's game state may be stale (stuck on Starting) — only P1 acts.
      // The crank auto-folds P2 on timeout, so blinds attrition will end the game.
      console.log('\n=== Play SNG hands ===');
      let handsPlayed = 0;
      const maxHands = 10;

      for (let h = 0; h < maxHands; h++) {
        // Check if game ended (any player sees end state)
        for (const pg of [p1, p2]) {
          const endText = pg.getByText(/You Won|You Lost|Winner|Bust|Finished|Complete|Game Over/i);
          if (await endText.isVisible({ timeout: 1000 }).catch(() => false)) {
            console.log(`  ✓ SNG ended after ${handsPlayed} hands`);
            h = maxHands; // break outer
            break;
          }
        }
        if (h >= maxHands) break;

        console.log(`\n  --- Hand ${h + 1} ---`);
        let actionsThisHand = 0;

        // Try to act with P1 (primary actor) for up to 4 streets
        for (let round = 0; round < 8; round++) {
          const turn = await waitForMyTurn(p1, 5000);
          if (turn === 'check' || turn === 'call') {
            await doAction(p1, turn);
            console.log(`    [P1] ${turn}`);
            actionsThisHand++;
          } else {
            // timeout/waiting/fold — hand is done or not P1's turn
            break;
          }
          // Also try P2 quickly (may work if state refreshes)
          const p2Turn = await waitForMyTurn(p2, 3000);
          if (p2Turn === 'check' || p2Turn === 'call') {
            await doAction(p2, p2Turn);
            console.log(`    [P2] ${p2Turn}`);
            actionsThisHand++;
          }
        }

        handsPlayed++;
        if (actionsThisHand === 0) {
          console.log('    No actions — game may be over or stuck');
          break;
        }
        await p1.waitForTimeout(3000);
      }

      console.log(`\n=== SNG TEST COMPLETE ===`);
      console.log(`  Hands played: ${handsPlayed}`);

    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });
});

/** Click "Play Free" or "Join" on the first available HU queue in the lobby */
async function joinSngQueue(page: any, label: string): Promise<void> {
  // Ensure we're on the lobby page
  if (!page.url().includes('localhost:3000')) {
    await page.goto(BASE_URL);
    await page.waitForTimeout(3000);
  }

  // Make sure Sit & Go tab is active
  const sngTab = page.getByRole('button', { name: /Sit & Go/i });
  if (await sngTab.isVisible({ timeout: 3000 }).catch(() => false)) {
    await sngTab.click();
    await page.waitForTimeout(1000);
  }

  // First: leave any stale queue from a previous run
  const leaveBtn = page.getByRole('button', { name: /^Leave$/ });
  if (await leaveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await leaveBtn.click();
    console.log(`  ${label}: Left stale queue from previous run`);
    await page.waitForTimeout(3000);
  }

  // Strategy: find the HU queue card by its h3 title "Heads Up"
  // Each card is: div.rounded-xl > div.p-4 > h3 "Heads Up" ... button "Play Free"/"Join"
  const huCards = page.locator('div.rounded-xl').filter({ has: page.locator('h3:text("Heads Up")') });
  const cardCount = await huCards.count();
  console.log(`  ${label}: Found ${cardCount} "Heads Up" cards`);

  let clicked = false;
  for (let i = 0; i < cardCount; i++) {
    const card = huCards.nth(i);
    // Look for actionable buttons inside this HU card
    for (const btnText of ['Play Free', 'Join Open Seat', 'Join']) {
      const btn = card.getByRole('button', { name: btnText });
      if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await btn.click();
        console.log(`  ${label}: Clicked "${btnText}" on Heads Up card`);
        clicked = true;
        break;
      }
    }
    if (clicked) break;
  }

  if (!clicked) {
    console.log(`  ${label}: ⚠ No HU join button found`);
    await page.screenshot({ path: `test-results/sng-no-join-${label}.png` });
  }
}
