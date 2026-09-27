import { expect, test } from '@playwright/test';

test('player: live prices -> slip -> placement resolves to accepted or an explicit rejection', async ({ page }) => {
  await page.goto('/');
  const prices = page.locator('button.price:not([disabled])');
  await expect(prices.first()).toBeVisible();
  await prices.first().click();
  await expect(page.locator('.slip__legs li')).toHaveCount(1);

  // If the price moved meanwhile, the requote panel must be handled explicitly.
  const accept = page.getByRole('button', { name: 'Принять новые коэффициенты' });
  if (await accept.isVisible()) await accept.click();

  await page.getByRole('button', { name: /Сделать ставки/ }).click();
  await expect(page.locator('[data-testid^="placement-"]:not([data-testid="placement-pending"])').first()).toBeVisible({
    timeout: 10_000,
  });
});

test('ops: bulk suspend requires a reason and lands in the audit trail', async ({ page }) => {
  await page.goto('/#/ops');
  const firstRow = page.locator('[data-testid^="ops-row-"]').first();
  await expect(firstRow).toBeVisible();
  await firstRow.getByRole('checkbox').check();
  const suspend = page.getByRole('button', { name: 'Приостановить' });
  await expect(suspend).toBeDisabled();
  await page.getByPlaceholder(/integrity alert/).fill('e2e integrity check');
  await suspend.click();
  await expect(page.locator('.audit__table')).toContainText('e2e integrity check');
});

test('mobile: bet slip is a bottom sheet @mobile', async ({ page }) => {
  await page.goto('/');
  const handle = page.locator('.slip__handle');
  await expect(handle).toBeVisible();
  await expect(handle).toHaveAttribute('aria-expanded', 'false');
  await page.locator('button.price:not([disabled])').first().click();
  await handle.click();
  await expect(handle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.slip__legs li')).toHaveCount(1);
});
