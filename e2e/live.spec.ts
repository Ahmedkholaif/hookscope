import { expect, test } from '@playwright/test';

test('requests appear live, without reloading', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create an inspection URL' }).click();
  await expect(page.getByText('● live')).toBeVisible();
  const endpoint = (await page.getByTestId('endpoint').textContent())!;
  const path = new URL(endpoint).pathname;

  await request.post(`${path}/orders?src=e2e`, { data: { order: 42, status: 'paid' } });
  await expect(page.getByRole('button', { name: /POST \/orders\?src=e2e/ })).toBeVisible();
  await expect(page.locator('pre.code')).toContainText('"status": "paid"');

  // filter is applied as you type
  await request.post(`${path}/refunds`, { data: { refund: 1 } });
  await page.getByLabel('Filter requests').fill('refund');
  await expect(page.getByRole('button', { name: /POST \/orders/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /POST \/refunds/ })).toBeVisible();
});

test('simulated failure is applied and survives a reload', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create an inspection URL' }).click();
  await expect(page.getByText('● live')).toBeVisible();
  await page.getByLabel('Respond with').selectOption('503');
  await expect(page.getByText('Simulating HTTP 503')).toBeVisible();

  const path = new URL((await page.getByTestId('endpoint').textContent())!).pathname;
  await expect.poll(async () => (await request.post(path, { data: {} })).status()).toBe(503);

  await page.reload();
  await expect(page.getByLabel('Respond with')).toHaveValue('503');
});
