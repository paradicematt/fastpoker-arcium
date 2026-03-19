import { test, expect, registerIfNeeded } from './fixtures/wallet';

test.describe('Page Navigation', () => {
  test('landing page renders without errors', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/FAST POKER/);
    // No console errors
    const errors: string[] = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.waitForTimeout(2000);
    // Filter out known benign errors on localnet
    const real = errors.filter(e =>
      !e.includes('Failed to fetch operator') &&
      !e.includes('coingecko') &&
      !e.includes('CORS') &&
      !e.includes('net::ERR_FAILED') &&
      !e.includes('404')
    );
    expect(real).toHaveLength(0);
  });

  test('staking page loads', async ({ page }) => {
    await page.goto('/staking');
    await expect(page).toHaveTitle(/FAST POKER/);
    await expect(page.getByText(/Staking/i).first()).toBeVisible();
  });

  test('auctions page loads', async ({ page }) => {
    await page.goto('/auctions');
    await expect(page).toHaveTitle(/FAST POKER/);
    await expect(page.getByText(/Auction/i).first()).toBeVisible();
  });

  test('how-to-play page loads with content', async ({ page }) => {
    await page.goto('/how-to-play');
    await expect(page).toHaveTitle(/FAST POKER/);
    await expect(page.getByText(/Texas Hold/i).first()).toBeVisible();
    await expect(page.getByText(/Hand Rankings/i).first()).toBeVisible();
  });

  test('my-tables page loads', async ({ page }) => {
    await page.goto('/my-tables');
    await expect(page).toHaveTitle(/FAST POKER/);
  });

  test('listings page loads', async ({ page }) => {
    await page.goto('/listings');
    await expect(page).toHaveTitle(/FAST POKER/);
  });

  test('game page loads table view', async ({ page }) => {
    // First get a table ID from the lobby
    await page.goto('/');
    await registerIfNeeded(page);
    await expect(page.getByRole('button', { name: /Cash Games/i })).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: /Cash Games/i }).click();
    const tableLink = page.locator('a[href^="/game/"]').first();
    const hasTable = await tableLink.isVisible({ timeout: 10000 }).catch(() => false);
    if (!hasTable) {
      console.log('  No cash tables on localnet — skipping game page test');
      test.skip(true, 'No cash tables available on localnet');
      return;
    }
    const href = await tableLink.getAttribute('href');
    expect(href).toBeTruthy();

    // Navigate to game page
    await page.goto(href!);
    // Should show game header (Cash Game or SNG)
    await expect(page.getByText(/Cash Game|SNG|Sit.*Go/i).first()).toBeVisible({ timeout: 15000 });
    // Should show ON-CHAIN badge
    await expect(page.getByText('ON-CHAIN')).toBeVisible();
  });
});
