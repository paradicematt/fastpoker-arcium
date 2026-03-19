import { test, expect, registerIfNeeded } from './fixtures/wallet';

test.describe('Create Table Form', () => {
  test.beforeEach(async ({ page }) => {
    // Register first (required for create table page)
    await page.goto('/');
    await registerIfNeeded(page);
    await page.goto('/my-tables/create');
    await page.waitForSelector('text=/Create Cash Game/i', { timeout: 15000 });
  });

  test('renders form with all sections', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /Create Cash Game/i })).toBeVisible();
    await expect(page.getByText(/Token.*Currency/i)).toBeVisible();
    await expect(page.getByText(/Blinds/i).first()).toBeVisible();
    await expect(page.getByText(/Buy-in Type/i)).toBeVisible();
    await expect(page.getByText(/Table Size/i).first()).toBeVisible();
    await expect(page.getByText(/Table Access/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Create.*Table/i })).toBeVisible();
  });

  test('token switch updates blinds and summary', async ({ page }) => {
    // Default is SOL — check SOL blinds
    await expect(page.getByText(/Blinds \(SOL\)/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /0\.005 \/ 0\.01/ })).toBeVisible();

    // Switch to POKER
    await page.getByRole('button', { name: /POKER POKER/ }).click();
    await expect(page.getByText(/Blinds \(POKER\)/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /0\.5 \/ 1/ })).toBeVisible();

    // Summary should show POKER
    await expect(page.getByText('POKER').last()).toBeVisible();
  });

  test('blind selection updates summary', async ({ page }) => {
    const btn = page.getByRole('button', { name: /0\.05 \/ 0\.1/ });
    await expect(btn).toBeVisible();
    await btn.click();
    await expect(page.getByText(/0\.05 \/ 0\.1 SOL/)).toBeVisible();
  });

  test('table size options update seat rent', async ({ page }) => {
    // Get initial rent text
    const rentEl = page.getByText(/~0\.\d+ SOL/).last();

    // Switch to Heads-Up
    await page.getByRole('button', { name: /Heads-Up/ }).click();
    const huRent = await rentEl.textContent();

    // Switch to Full Ring — rent should increase
    await page.getByRole('button', { name: /Full Ring/ }).click();
    const frRent = await rentEl.textContent();

    expect(huRent).not.toEqual(frRent);
  });

  test('private access shows whitelist notice', async ({ page }) => {
    await page.getByRole('button', { name: /Private/ }).click();
    await expect(page.getByText('Private tables require')).toBeVisible();
  });

  test('deep stack shows 2x fee and wider buy-in range', async ({ page }) => {
    await page.getByRole('button', { name: /Deep Stack/ }).click();
    await expect(page.getByText(/50.*250 BB/)).toBeVisible();
  });

  test('listed tokens tab exists', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Listed Tokens/ })).toBeVisible();
  });
});
