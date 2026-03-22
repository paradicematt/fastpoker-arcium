/**
 * Game interaction helpers for E2E tests.
 * Wraps common UI actions: register, navigate, join cash game, play actions, etc.
 */
import { Page, expect } from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3001';

/** Register the wallet on-chain if needed, then ensure lobby is visible */
export async function registerAndGoToLobby(page: Page): Promise<void> {
  await page.goto(BASE_URL);
  await page.waitForTimeout(2000);
  const registerBtn = page.getByRole('button', { name: /Register.*Play/i });
  if (await registerBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('  → Registering wallet on-chain...');
    await registerBtn.click();
    await page.waitForSelector('text=/Sit & Go|Cash Games|Loading/i', { timeout: 45000 });
    await page.waitForTimeout(2000);
  }
  // Verify lobby loaded
  await expect(page.getByRole('button', { name: /Sit & Go/i })).toBeVisible({ timeout: 15000 });
}

/** Navigate to a specific game page by table PDA */
export async function goToGame(page: Page, tablePda: string): Promise<void> {
  await page.goto(`${BASE_URL}/game/${tablePda}`);
  // Wait for game page to load (shows Cash Game or Sit & Go header)
  await expect(page.getByText(/Cash Game|Sit & Go|Loading Table/i).first()).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1000);
}

/** Click an empty seat on the poker table to open buy-in modal (cash game) */
export async function clickEmptySeat(page: Page): Promise<void> {
  // Empty seats show as clickable areas with "Empty" or seat numbers
  // The PokerTable component renders seat slots — look for clickable empty seat
  const emptySeat = page.locator('[class*="cursor-pointer"]').filter({ hasText: /Empty|Open|Seat/i }).first();
  if (await emptySeat.isVisible({ timeout: 5000 }).catch(() => false)) {
    await emptySeat.click();
    return;
  }
  // Fallback: look for any seat area that's clickable
  const seatArea = page.locator('button, div[role="button"]').filter({ hasText: /Seat \d|Empty/i }).first();
  await seatArea.click({ timeout: 5000 });
}

/** Set buy-in amount and confirm (cash game buy-in modal) */
export async function confirmBuyIn(page: Page, bbAmount?: number): Promise<void> {
  // Wait for buy-in modal
  await expect(page.getByText(/Buy In/i)).toBeVisible({ timeout: 10000 });

  // Select BB amount if specified (click quick-pick button)
  if (bbAmount) {
    const bbBtn = page.getByRole('button', { name: `${bbAmount} BB` });
    if (await bbBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await bbBtn.click();
    }
  }

  // Click "Confirm & Sit"
  await page.getByRole('button', { name: /Confirm.*Sit/i }).click();

  // Wait for deposit + seating (this involves L1 TX + API call, can take 30s+)
  // Look for status messages that indicate progress
  await page.waitForSelector('text=/Seated|Depositing|Seating|Error/i', { timeout: 60000 });
  await page.waitForTimeout(3000);
}

/** Wait until it's this player's turn (action buttons visible) */
export async function waitForMyTurn(page: Page, timeoutMs = 60000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Check if action buttons are visible
    const foldBtn = page.getByRole('button', { name: /^Fold$/i });
    if (await foldBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      // Determine what actions are available
      const checkBtn = page.getByRole('button', { name: /^Check$/i });
      const callBtn = page.getByRole('button', { name: /^Call/i });
      if (await checkBtn.isVisible({ timeout: 500 }).catch(() => false)) return 'check';
      if (await callBtn.isVisible({ timeout: 500 }).catch(() => false)) return 'call';
      return 'fold'; // At minimum, fold is always available
    }

    // Check if game is in showdown or waiting phase
    const showdown = page.getByText(/Showdown|Complete|Waiting/i);
    if (await showdown.isVisible({ timeout: 500 }).catch(() => false)) {
      return 'waiting';
    }

    await page.waitForTimeout(2000);
  }
  return 'timeout';
}

/** Perform a game action (fold, check, call, raise, allin) */
export async function doAction(page: Page, action: 'fold' | 'check' | 'call' | 'raise' | 'allin'): Promise<void> {
  switch (action) {
    case 'fold':
      await page.getByRole('button', { name: /^Fold$/i }).click();
      break;
    case 'check':
      await page.getByRole('button', { name: /^Check$/i }).click();
      break;
    case 'call':
      await page.getByRole('button', { name: /^Call/i }).click();
      break;
    case 'raise':
      // Click "Raise" or "Bet" button
      await page.getByRole('button', { name: /^Raise$|^Bet$/i }).click();
      break;
    case 'allin':
      await page.getByRole('button', { name: /All-In/i }).click();
      break;
  }

  // Wait for TX confirmation
  await page.waitForTimeout(2000);
}

/** Get the current hand number from the game page */
export async function getHandNumber(page: Page): Promise<number> {
  const handEl = page.locator('text=/#\\d+/');
  const text = await handEl.textContent().catch(() => '#0');
  const match = text?.match(/#(\d+)/);
  return match ? parseInt(match[1]) : 0;
}

/** Get the current game phase */
export async function getPhase(page: Page): Promise<string> {
  const phases = ['PreFlop', 'Flop', 'Turn', 'River', 'Showdown', 'Complete', 'Waiting'];
  for (const phase of phases) {
    if (await page.getByText(phase, { exact: true }).isVisible({ timeout: 200 }).catch(() => false)) {
      return phase;
    }
  }
  return 'unknown';
}

/** Wait for a specific hand number to appear */
export async function waitForHand(page: Page, handNumber: number, timeoutMs = 60000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = await getHandNumber(page);
    if (current >= handNumber) return true;
    await page.waitForTimeout(2000);
  }
  return false;
}

/** Play one hand with a simple strategy: check when possible, call small bets, fold large raises */
export async function playOneHandSimple(page: Page, playerLabel: string): Promise<string> {
  let lastAction = 'none';
  const maxRounds = 8; // Safety limit per hand (preflop + flop + turn + river × 2 actions each)

  for (let round = 0; round < maxRounds; round++) {
    const turnResult = await waitForMyTurn(page, 30000);

    if (turnResult === 'waiting' || turnResult === 'timeout') {
      return lastAction || turnResult;
    }

    // Simple strategy: check > call > fold
    if (turnResult === 'check') {
      await doAction(page, 'check');
      lastAction = 'check';
      console.log(`    [${playerLabel}] Check`);
    } else if (turnResult === 'call') {
      await doAction(page, 'call');
      lastAction = 'call';
      console.log(`    [${playerLabel}] Call`);
    } else {
      await doAction(page, 'fold');
      lastAction = 'fold';
      console.log(`    [${playerLabel}] Fold`);
      return lastAction;
    }
  }
  return lastAction;
}

/** Open the Tip Jar modal and deposit a tip */
export async function depositTip(page: Page, solAmount: string = '0.01', hands: string = '10'): Promise<void> {
  // Click Tip Jar pill
  await page.getByRole('button', { name: /Tip Jar/i }).click();

  // Wait for tip modal
  await expect(page.getByText(/Tip Your Dealer/i)).toBeVisible({ timeout: 5000 });

  // Fill in amount and hands
  const amountInput = page.locator('input[type="number"]').first();
  const handsInput = page.locator('input[type="number"]').nth(1);
  await amountInput.fill(solAmount);
  await handsInput.fill(hands);

  // Click "Deposit Tip"
  await page.getByRole('button', { name: /Deposit Tip/i }).click();

  // Wait for TX
  await page.waitForTimeout(5000);
}

/** Join a SNG from the lobby by clicking the Play Free / Join button for a specific game type */
export async function joinSngFromLobby(page: Page, tier: string, gameType: '6-Max' | 'Heads Up' | '9-Max'): Promise<void> {
  // Click the tier button
  await page.getByRole('button', { name: new RegExp(tier, 'i') }).click();
  await page.waitForTimeout(500);

  // Find the game type card and click its Join/Play button
  const gameCard = page.locator(`text=${gameType}`).locator('..').locator('..');
  const playBtn = gameCard.getByRole('button', { name: /Play Free|Join/i });
  await playBtn.click();

  // Wait for navigation to game page or queue status
  await page.waitForTimeout(3000);
}

/** Navigate to Cash Games tab and get table PDAs from the list */
export async function getCashTablePdas(page: Page, max = 10): Promise<string[]> {
  const cashBtn = page.getByRole('button', { name: /Cash Games/i });
  await expect(cashBtn).toBeVisible({ timeout: 15000 });
  await cashBtn.click();
  // Wait for table links to load (fetched from TEE)
  const links = page.locator('a[href^="/game/"]');
  await links.first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);

  const count = Math.min(max, await links.count());
  const pdas: string[] = [];
  for (let i = 0; i < count; i++) {
    const href = await links.nth(i).getAttribute('href');
    if (href) pdas.push(href.replace('/game/', ''));
  }
  return pdas;
}

/** Find a cash table with at least `minSeats` empty seats, parsed from lobby */
export async function findOpenCashTable(page: Page, minSeats = 2): Promise<string | null> {
  await page.goto(`${BASE_URL}`);
  await page.waitForTimeout(3000);
  const registerBtn = page.getByRole('button', { name: /Register.*Play/i });
  if (await registerBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await registerBtn.click();
    await page.waitForSelector('text=/Sit & Go|Cash Games/i', { timeout: 45000 });
    await page.waitForTimeout(2000);
  }

  // Switch to Cash Games tab and wait for tables to load
  const cashBtn = page.getByRole('button', { name: /Cash Games/i });
  await expect(cashBtn).toBeVisible({ timeout: 15000 });
  await cashBtn.click();
  const links = page.locator('a[href^="/game/"]');
  await links.first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);

  const count = await links.count();
  console.log(`  Found ${count} cash tables, need ${minSeats}+ empty seats...`);

  // Each table link's parent row contains "currentPlayers/maxPlayers" text
  for (let i = 0; i < count; i++) {
    const link = links.nth(i);
    const href = await link.getAttribute('href');
    if (!href) continue;
    const pda = href.replace('/game/', '');

    // The <a> wraps the entire table row — its text includes "N/M" player count
    const rowText = await link.textContent() || '';

    // Match patterns like "0/2", "1/6", "0/9"
    const matches = rowText.match(/(\d+)\s*\/\s*(\d+)/g) || [];
    let bestEmpty = 0;
    let bestCurrent = 0;
    let bestMax = 0;
    for (const m of matches) {
      const parts = m.split('/').map(Number);
      if (parts.length === 2 && parts[1] >= 2 && parts[1] <= 9) {
        const empty = parts[1] - parts[0];
        if (empty > bestEmpty) {
          bestEmpty = empty;
          bestCurrent = parts[0];
          bestMax = parts[1];
        }
      }
    }
    if (i < 5) console.log(`    [${i}] ${pda.slice(0, 8)}: "${rowText.replace(/\s+/g, ' ').trim().slice(0, 60)}" → ${bestCurrent}/${bestMax}`);
    if (bestEmpty >= minSeats) {
      console.log(`  ✓ Table ${pda.slice(0, 12)}: ${bestCurrent}/${bestMax} (${bestEmpty} empty)`);
      return pda;
    }
  }

  console.log('  ⚠ No table with enough empty seats found');
  return null;
}

/** Create a new cash table via the /my-tables/create form.
 *  Captures browser console logs to track the 3-phase setup progress.
 *  Returns table PDA on success, null on failure. */
export async function createCashTable(page: Page): Promise<string | null> {
  // Capture browser console for setup phase tracking
  const consoleLogs: string[] = [];
  const logHandler = (msg: any) => {
    const text = msg.text();
    if (text.includes('[') || text.includes('TX') || text.includes('phase') || text.includes('setup')) {
      consoleLogs.push(text.slice(0, 120));
    }
  };
  page.on('console', logHandler);

  try {
    await page.goto(`${BASE_URL}/my-tables/create`);
    await page.waitForTimeout(3000);

    // Scroll to bottom to find submit button
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
    const createBtn = page.getByRole('button', { name: /Create.*Setup.*Table/i });
    await expect(createBtn).toBeVisible({ timeout: 10000 });
    await expect(createBtn).toBeEnabled({ timeout: 5000 });
    console.log('  Clicking "Create & Setup Table"...');
    await createBtn.click();

    // Monitor the 2-phase setup via step progress text + console logs
    // Phase 1: "Approve: Create table (1/3)..."
    // Phase 2: "Approve: Init seats (2/3)..."
    // Done: "✓ Table setup complete!"
    let tablePda: string | null = null;
    let lastProgress = '';

    for (let i = 0; i < 150; i++) { // up to 5 min (2s per tick)
      // Check for completion
      const doneEl = page.getByText(/setup complete/i);
      if (await doneEl.isVisible({ timeout: 500 }).catch(() => false)) {
        console.log('  ✓ Table setup complete!');
        break;
      }

      // Check for redirect to /game/ (auto-redirect on success)
      const url = page.url();
      if (url.includes('/game/')) {
        const m = url.match(/\/game\/([A-Za-z0-9]+)/);
        if (m) { tablePda = m[1]; console.log(`  ✓ Redirected to game: ${tablePda.slice(0, 12)}`); break; }
      }

      // Check for error text (red text on the page)
      const errEl = page.locator('.text-red-400').first();
      if (await errEl.isVisible({ timeout: 200 }).catch(() => false)) {
        const errText = await errEl.textContent();
        if (errText && errText.length > 5 && !errText.includes('5% goes')) {
          console.log(`  ⚠ Setup error: ${errText.slice(0, 100)}`);
          consoleLogs.slice(-5).forEach(l => console.log(`    ${l}`));

          // Try resume: reload page → click Resume Setup (gets fresh blockhashes)
          console.log('  Retrying via Resume Setup...');
          await page.goto(`${BASE_URL}/my-tables/create`);
          await page.waitForTimeout(3000);

          // Check for "Go to Table" (table already exists on L1)
          const goBtn = page.getByRole('button', { name: /Go to Table/i });
          if (await goBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await goBtn.click();
            await page.waitForTimeout(5000);
            const url = page.url();
            const m = url.match(/\/game\/([A-Za-z0-9]+)/);
            if (m) { tablePda = m[1]; console.log(`  ✓ Table already live: ${tablePda.slice(0, 12)}`); break; }
          }

          // Click "Resume Setup"
          const resumeBtn = page.getByRole('button', { name: /Resume Setup|Resume/i });
          if (await resumeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await resumeBtn.click();
            console.log('  Resume clicked — continuing setup...');
            continue; // keep monitoring
          }

          return null; // no resume available
        }
      }

      // Extract table PDA from the page (shown during setup)
      if (!tablePda) {
        const pdaEl = page.locator('.font-mono.break-all');
        if (await pdaEl.isVisible({ timeout: 200 }).catch(() => false)) {
          const text = await pdaEl.textContent() || '';
          const m = text.match(/([A-Za-z1-9]{32,44})/);
          if (m) tablePda = m[1];
        }
      }

      // Log progress every 10s
      if (i % 5 === 0) {
        // Print new console logs
        const newLogs = consoleLogs.slice(-3);
        if (newLogs.length > 0) {
          const latest = newLogs[newLogs.length - 1];
          if (latest !== lastProgress) {
            console.log(`  [${i * 2}s] ${latest}`);
            lastProgress = latest;
          }
        }
      }

      await page.waitForTimeout(2000);
    }

    // Try to extract PDA from URL or page
    if (!tablePda) {
      const url = page.url();
      const m = url.match(/\/game\/([A-Za-z0-9]+)/);
      if (m) tablePda = m[1];
    }

    if (tablePda) {
      console.log(`  ✓ Table PDA: ${tablePda.slice(0, 12)}`);
    } else {
      console.log('  ⚠ Could not extract table PDA');
      consoleLogs.slice(-10).forEach(l => console.log(`    ${l}`));
    }
    return tablePda;

  } finally {
    page.off('console', logHandler);
  }
}

/** Check if player is seated at the table */
export async function isSeated(page: Page): Promise<boolean> {
  // When seated, "Leave Table" button appears. Allow up to 8s for state refresh.
  const leaveBtn = page.getByRole('button', { name: /Leave Table/i });
  return leaveBtn.isVisible({ timeout: 8000 }).catch(() => false);
}

/** Leave the cash game table */
export async function leaveTable(page: Page): Promise<void> {
  // Dismiss any open modals first
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  const leaveBtn = page.getByRole('button', { name: /Leave Table/i });
  if (await leaveBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await leaveBtn.click({ force: true });
    await page.waitForTimeout(5000);
  }
}
