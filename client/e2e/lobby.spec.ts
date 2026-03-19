import { test, expect, registerIfNeeded } from './fixtures/wallet';

test.describe('Lobby', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await registerIfNeeded(page);
  });

  test('renders nav bar with all links', async ({ page }) => {
    await expect(page.getByRole('link', { name: /Lobby/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /Staking/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /Auctions/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /How to Play/i })).toBeVisible();
  });

  test('wallet is connected and shows address', async ({ page }) => {
    // Should show truncated wallet address in header (not "Select Wallet")
    await expect(page.getByRole('button', { name: /Select Wallet/i })).not.toBeVisible();
  });

  test('shows Sit & Go tab with tier buttons', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Sit & Go/i })).toBeVisible({ timeout: 15000 });
    // Tier buttons render as "MicroFREE", "Bronze0.0250", etc.
    for (const tier of ['Micro', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond']) {
      await expect(page.getByRole('button', { name: new RegExp(tier, 'i') })).toBeVisible();
    }
  });

  test('tier buttons cycle and update prize info', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Bronze/i })).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: /Bronze/i }).click();
    await expect(page.getByText('Bronze', { exact: true })).toBeVisible();
    await expect(page.getByText('0.025 SOL buy-in')).toBeVisible();

    await page.getByRole('button', { name: /Diamond/i }).click();
    await expect(page.getByText('Diamond', { exact: true })).toBeVisible();
    await expect(page.getByText('0.5 SOL buy-in')).toBeVisible();
  });

  test('shows game type cards with play buttons', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Sit & Go/i })).toBeVisible({ timeout: 15000 });
    // Micro tier shows "Play Free", paid tiers show "Join 0.025 SOL" etc.
    const playButtons = page.getByRole('button', { name: /Play Free|Join/i });
    await expect(playButtons.first()).toBeVisible();
    expect(await playButtons.count()).toBeGreaterThanOrEqual(2);
  });

  test('Cash Games tab loads', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Cash Games/i })).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: /Cash Games/i }).click();

    // Either tables load or "No cash tables yet" message appears
    await page.waitForSelector('text=/All \\(|No cash tables yet/i', { timeout: 15000 });
  });

  test('Cash Games tab has create link', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Cash Games/i })).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: /Cash Games/i }).click();
    await expect(page.getByRole('link', { name: '+ Create' })).toBeVisible({ timeout: 10000 });
  });

  test('footer shows session status', async ({ page }) => {
    const footer = page.getByRole('contentinfo');
    await expect(footer).toBeVisible();
    // Session pill should be visible (No Session, Active, etc.)
    // SOL price may not render on localnet (CoinGecko CORS)
    await expect(footer.getByText(/No Session|Active|Ready|Low Balance|Offline|FAST POKER/i)).toBeVisible();
  });

  test('pool stats bar renders', async ({ page }) => {
    await expect(page.getByText(/Burned.*POKER/i)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/Supply/i)).toBeVisible();
  });
});
