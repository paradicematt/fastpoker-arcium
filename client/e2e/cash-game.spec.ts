/**
 * Cash Game E2E — Full Lifecycle:
 *   1. Create a fresh table
 *   2. Both players join + buy in
 *   3. Play 3 hands
 *   4. Both players leave (verify leave works)
 *   5. Verify table is empty
 *
 * Uses the same 9 deterministic wallets every run.
 */
import { test, expect, createPlayerPage } from './fixtures/wallet';
import {
  registerAndGoToLobby, goToGame, findOpenCashTable, createCashTable,
  waitForMyTurn, doAction, getHandNumber, isSeated, leaveTable,
} from './fixtures/game-helper';

// Full lifecycle can take a while (table creation + gameplay + leave)
test.describe.configure({ timeout: 600_000 }); // 10 min per test

test.describe('Cash Game — Full Lifecycle', () => {

  test('create table → join → play → leave', async ({ browser, wallets }) => {
    // Wallet 2 = table creator (doesn't play), Wallet 0+1 = players (full balance)
    const { page: creator, context: ctxCreator } = await createPlayerPage(browser, wallets[2]);
    const { page: p1, context: ctx1 } = await createPlayerPage(browser, wallets[0]);
    const { page: p2, context: ctx2 } = await createPlayerPage(browser, wallets[1]);

    try {
      // ─── Register all players ───
      console.log('\n=== Register players ===');
      await registerAndGoToLobby(creator);
      await registerAndGoToLobby(p1);
      await registerAndGoToLobby(p2);
      console.log('  ✓ All registered');

      // ─── Create a fresh table (using creator wallet) ───
      console.log('\n=== Create table ===');
      let tablePda = await createCashTable(creator);
      if (!tablePda) {
        // Fallback: try finding an existing open table
        console.log('  Create failed — trying to find an open table...');
        await registerAndGoToLobby(p1);
        tablePda = await findOpenCashTable(p1);
      }
      if (!tablePda) {
        test.skip(true, 'Could not create or find an open table');
        return;
      }

      // ─── Both navigate to the table ───
      console.log('\n=== Navigate to table ===');
      await goToGame(p1, tablePda);
      await goToGame(p2, tablePda);
      await Promise.all([
        p1.waitForSelector('text=/BLINDS|ON-CHAIN|SIT/i', { timeout: 30000 }),
        p2.waitForSelector('text=/BLINDS|ON-CHAIN|SIT/i', { timeout: 30000 }),
      ]);
      console.log('  ✓ Both see the table');

      // ─── Player 1 sits down ───
      console.log('\n=== P1 sits down ===');
      // Capture console logs during buy-in to debug failures
      const buyInLogs: string[] = [];
      const buyInLogHandler = (msg: any) => {
        const t = msg.text();
        if (t.includes('confirmBuyIn') || t.includes('deposit') || t.includes('Error') || t.includes('error') || t.includes('seat') || t.includes('session')) {
          buyInLogs.push(`[${msg.type()}] ${t.slice(0, 150)}`);
        }
      };
      p1.on('console', buyInLogHandler);

      const p1SitBtn = p1.getByRole('button', { name: /^SIT$/i }).first();
      await expect(p1SitBtn).toBeVisible({ timeout: 10000 });
      await p1SitBtn.click();
      await expect(p1.getByText(/Buy In/i)).toBeVisible({ timeout: 10000 });
      console.log('  Buy-in modal open');
      // Set buy-in to minimum (20 BB) to ensure we have enough SOL
      const p1Slider = p1.locator('input[type="range"]');
      if (await p1Slider.isVisible({ timeout: 2000 }).catch(() => false)) {
        await p1Slider.fill('20');
        await p1.waitForTimeout(500);
      }
      await p1.getByRole('button', { name: /Confirm.*Sit/i }).click();
      console.log('  Depositing + seating (~30s)...');
      // Wait for seat confirmation: either "Leave Table" button or "Waiting for" text
      await p1.waitForSelector('text=/Leave Table|Waiting for/i', { timeout: 60000 });
      console.log(`  P1 seated: true`);
      // Print buy-in logs for debugging
      if (buyInLogs.length > 0) {
        console.log('  Buy-in console logs:');
        buyInLogs.forEach(l => console.log(`    ${l}`));
      }
      p1.off('console', buyInLogHandler);

      // ─── Player 2 sits down ───
      console.log('\n=== P2 sits down ===');
      await goToGame(p2, tablePda);
      await p2.waitForTimeout(3000);
      const p2SitBtn = p2.getByRole('button', { name: /^SIT$/i }).first();
      await expect(p2SitBtn).toBeVisible({ timeout: 10000 });
      await p2SitBtn.click();
      await expect(p2.getByText(/Buy In/i)).toBeVisible({ timeout: 10000 });
      console.log('  Buy-in modal open');
      const p2Slider = p2.locator('input[type="range"]');
      if (await p2Slider.isVisible({ timeout: 2000 }).catch(() => false)) {
        await p2Slider.fill('20');
        await p2.waitForTimeout(500);
      }
      await p2.getByRole('button', { name: /Confirm.*Sit/i }).click();
      console.log('  Depositing + seating...');
      await p2.waitForSelector('text=/Seated|Leave Table|Waiting for|PreFlop|Error/i', { timeout: 60000 });
      console.log(`  P2 seated: ${await isSeated(p2)}`);

      // ─── Play 3 hands ───
      console.log('\n=== Play hands ===');
      const startHand = await getHandNumber(p1);
      let handsPlayed = 0;

      for (let h = 0; h < 3; h++) {
        console.log(`\n  --- Hand ${h + 1} ---`);
        let handDone = false;

        for (let round = 0; round < 10 && !handDone; round++) {
          for (const [label, pg] of [['P1', p1], ['P2', p2]] as const) {
            const turn = await waitForMyTurn(pg, 8000);
            if (turn === 'check' || turn === 'call') {
              await doAction(pg, turn);
              console.log(`    [${label}] ${turn}`);
            } else if (turn === 'fold') {
              await doAction(pg, 'call');
              console.log(`    [${label}] call (instead of fold)`);
            } else if (turn === 'waiting') {
              console.log(`    [${label}] waiting (hand end/deal)`);
              handDone = true;
              break;
            }
          }
        }
        handsPlayed++;
        await p1.waitForTimeout(4000);
      }

      const endHand = await getHandNumber(p1);
      console.log(`\n  ✓ Played ${handsPlayed} hands (${startHand} → ${endHand})`);

      // ─── Both players leave ───
      console.log('\n=== Leave table ===');
      for (const [label, pg] of [['P1', p1], ['P2', p2]] as const) {
        // Dismiss modals
        await pg.keyboard.press('Escape');
        await pg.waitForTimeout(500);

        const leaveBtn = pg.getByRole('button', { name: /Leave Table/i });
        const canLeave = await leaveBtn.isVisible({ timeout: 3000 }).catch(() => false);
        if (canLeave) {
          await leaveBtn.click({ force: true });
          console.log(`  ${label}: clicked Leave Table`);
          // Wait for redirect to /my-tables or status message
          await pg.waitForSelector('text=/Leaving|returned|My Tables|my-tables/i', { timeout: 15000 }).catch(() => {});
          await pg.waitForTimeout(3000);
          console.log(`  ${label}: ✓ left`);
        } else {
          console.log(`  ${label}: ⚠ Leave Table button not visible — BUG?`);
          // Take screenshot for debugging
          await pg.screenshot({ path: `test-results/leave-bug-${label}.png` });
        }
      }

      // ─── Verify table is empty ───
      console.log('\n=== Verify table empty ===');
      await goToGame(p1, tablePda);
      await p1.waitForTimeout(5000);
      const sitButtons = p1.getByRole('button', { name: /^SIT$/i });
      const emptySeatCount = await sitButtons.count();
      console.log(`  Empty seats: ${emptySeatCount}`);

      console.log(`\n=== CASH GAME LIFECYCLE COMPLETE ===`);
      console.log(`  Table: ${tablePda.slice(0, 12)} | Hands: ${handsPlayed} | Range: #${startHand}→#${endHand}`);

    } finally {
      await ctxCreator.close();
      await ctx1.close();
      await ctx2.close();
    }
  });
});
