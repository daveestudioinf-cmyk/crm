import { test, expect } from '@playwright/test';

test('E2E core CRM flow & zero horizontal overflow', async ({ page }, testInfo) => {
  const unique = `${Date.now()}-${testInfo.project.name}`;
  const email = `e2e-${unique}@koracrm.dev`;

  // 1. Landing page & overflow check
  await page.goto('/');
  await expect(page.getByText('KoraCRM')).toBeVisible();
  const landingOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(landingOverflow).toBe(false);

  // 2. Signup
  await page.goto('/signup');
  await page.getByPlaceholder('Acme Commerce').fill(`Org ${unique}`);
  await page.getByPlaceholder('Ana Silva').fill('Ana Test');
  await page.getByPlaceholder('ana@acme.com').fill(email);
  await page.getByPlaceholder('••••••••').fill('secret123');
  await page.getByRole('button', { name: 'Create Workspace' }).click();
  await expect(page).toHaveURL(/\/app\/inbox/);

  // Mobile bottom nav check
  if (testInfo.project.name === 'mobile') {
    await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeVisible();
  }

  // 3. Create Contact & Start Chat
  await page.goto('/app/contacts');
  await page.getByRole('button', { name: 'New Contact' }).click();
  await page.getByPlaceholder('Maria Oliveira').fill('Carlos Buyer');
  await page.getByPlaceholder('+5511999998888').fill('+5511988887777');
  await page.getByRole('button', { name: 'Save Contact' }).click();
  await expect(page.getByText('Carlos Buyer')).toBeVisible();

  await page.getByTitle('Open Inbox Chat').first().click();
  await expect(page).toHaveURL(/\/app\/inbox/);

  if (testInfo.project.name === 'mobile') {
    await page.getByText('Carlos Buyer').first().click();
  }

  // 4. Send message in Inbox
  await page.getByPlaceholder('Type a WhatsApp message...').fill('Hello Carlos, welcome to KoraCRM!');
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByText('Hello Carlos, welcome to KoraCRM!').last()).toBeVisible();

  // 5. Kanban Pipeline & zero overflow
  await page.goto('/app/kanban');
  await page.getByRole('button', { name: /New / }).click();
  await page.getByPlaceholder('Enterprise Plan').fill('Annual Deal');
  await page.locator('select').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const dealLocator = testInfo.project.name === 'mobile'
    ? page.getByText('Annual Deal').first()
    : page.getByText('Annual Deal').last();
  await expect(dealLocator).toBeVisible();

  const kanbanOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(kanbanOverflow).toBe(false);

  // 6. AI & RAG Knowledge Search
  await page.goto('/app/ai');
  await page.getByPlaceholder('Title (e.g. Shipping & Returns FAQ)').fill('Shipping Policy');
  await page.getByPlaceholder('Paste FAQ or policy text...').fill('We ship worldwide within 48 hours via express courier.');
  await page.getByRole('button', { name: 'Index Knowledge' }).click();
  await expect(page.getByText('Shipping Policy')).toBeVisible();

  await page.getByPlaceholder('Ask a customer question...').fill('express courier shipping');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByText(/48 hours/)).toBeVisible();
});
