import { test, expect } from '@playwright/test';

test('E2E flujo CRM en español y cero scroll horizontal', async ({ page }, testInfo) => {
  const unique = `${Date.now()}-${testInfo.project.name}`;
  const email = `e2e-${unique}@koracrm.dev`;

  // 1. Landing y sin desbordamiento horizontal
  await page.goto('/');
  await expect(page.getByText('KoraCRM').first()).toBeVisible();
  const landingOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(landingOverflow).toBe(false);

  // 2. Registro
  await page.goto('/signup');
  await page.getByPlaceholder('Comercial Acme').fill(`Org ${unique}`);
  await page.getByPlaceholder('Ana Silva').fill('Ana Prueba');
  await page.getByPlaceholder('ana@acme.com').fill(email);
  await page.getByPlaceholder('••••••••').fill('secret123');
  await page.getByRole('button', { name: 'Crear Espacio de Trabajo' }).click();
  await expect(page).toHaveURL(/\/app\/inbox/);

  if (testInfo.project.name === 'mobile') {
    await expect(page.getByRole('navigation', { name: 'Navegación móvil' })).toBeVisible();
  }

  // 3. Crear Contacto y abrir chat
  await page.goto('/app/contacts');
  await page.getByRole('button', { name: 'Nuevo Contacto' }).click();
  await page.getByPlaceholder('María Oliveira').fill('Carlos Comprador');
  await page.getByPlaceholder('+5215512345678').fill('+5215599998888');
  await page.getByRole('button', { name: 'Guardar Contacto' }).click();
  await expect(page.getByText('Carlos Comprador')).toBeVisible();

  await page.getByTitle('Abrir chat en Bandeja').first().click();
  await expect(page).toHaveURL(/\/app\/inbox/);

  if (testInfo.project.name === 'mobile') {
    await page.getByText('Carlos Comprador').first().click();
  }

  // 4. Enviar mensaje en Bandeja
  await page.getByPlaceholder('Escribe un mensaje de WhatsApp...').fill('Hola Carlos, bienvenido a KoraCRM!');
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByText('Hola Carlos, bienvenido a KoraCRM!').last()).toBeVisible();

  // 5. Embudo Kanban y cero scroll horizontal
  await page.goto('/app/kanban');
  await page.getByRole('button', { name: /Nuevo / }).click();
  await page.getByPlaceholder('Plan Empresarial').fill('Trato Anual');
  await page.locator('select').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Crear', exact: true }).click();
  const dealLocator = testInfo.project.name === 'mobile'
    ? page.getByText('Trato Anual').first()
    : page.getByText('Trato Anual').last();
  await expect(dealLocator).toBeVisible();

  const kanbanOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(kanbanOverflow).toBe(false);

  // 6. IA y Búsqueda Semántica RAG
  await page.goto('/app/ai');
  await page.getByPlaceholder('Título (ej. Políticas de Envío y Devolución)').fill('Política de Envíos');
  await page.getByPlaceholder('Pega preguntas frecuentes o políticas...').fill('Enviamos a todo el país en 48 horas por paquetería exprés.');
  await page.getByRole('button', { name: 'Indexar Conocimiento' }).click();
  await expect(page.getByText('Política de Envíos')).toBeVisible();

  await page.getByPlaceholder('Haz una pregunta como cliente...').fill('envíos paquetería exprés');
  await page.getByRole('button', { name: 'Buscar' }).click();
  await expect(page.getByText(/48 horas/)).toBeVisible();
});
