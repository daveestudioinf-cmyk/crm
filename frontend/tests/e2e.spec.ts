import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const DB_URL = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/crm_dev?sslmode=disable';

test('E2E flujo CRM en español y cero scroll horizontal', async ({ page }, testInfo) => {
  const unique = `${Date.now()}-${testInfo.project.name}`;
  const email = `e2e-${unique}@koracrm.dev`;
  const orgName = `Org ${unique}`;

  // 1. Landing y sin desbordamiento horizontal
  await page.goto('/');
  await expect(page.getByText('KoraCRM').first()).toBeVisible();
  const landingOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(landingOverflow).toBe(false);

  // 2. Registro
  await page.goto('/signup');
  await page.getByPlaceholder('Comercial Acme').fill(orgName);
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

  // 7. Consola Super-Admin (S26), Suspensión y Sesión de Soporte TTL 1h
  execFileSync('psql', [
    DB_URL,
    '-c',
    `UPDATE users SET is_platform_admin = true WHERE email = '${email}';`,
  ]);
  await page.reload();

  if (testInfo.project.name === 'desktop') {
    await expect(page.getByRole('link', { name: 'Super-Admin' })).toBeVisible();
    await page.getByRole('link', { name: 'Super-Admin' }).click();
  } else {
    await page.getByRole('button', { name: 'Más' }).click();
    await expect(page.getByRole('link', { name: 'Super-Admin' })).toBeVisible();
    await page.getByRole('link', { name: 'Super-Admin' }).click();
  }

  await expect(page).toHaveURL(/\/admin/);
  await expect(page.getByRole('heading', { name: 'Consola Super-Admin' })).toBeVisible();

  const adminOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(adminOverflow).toBe(false);

  // Buscar nuestra organización y suspenderla
  await page.getByPlaceholder('Buscar organización por nombre o slug...').fill(orgName);
  await page.getByRole('button', { name: 'Buscar' }).click();
  await expect(page.locator('main').getByText(orgName).locator('visible=true').first()).toBeVisible();

  await page.getByRole('button', { name: 'Suspender' }).first().click();
  await expect(page.locator('main').getByText('Suspendido', { exact: true }).locator('visible=true').first()).toBeVisible();

  // Iniciar sesión de soporte (Solo lectura 1h) sobre el tenant suspendido
  await page.getByRole('button', { name: 'Soporte (1h)' }).first().click();
  await expect(page.getByRole('heading', { name: 'Iniciar sesión de soporte' })).toBeVisible();
  await page.locator('#support-reason').fill('Diagnóstico de incidente E2E');
  await page.getByRole('button', { name: 'Iniciar soporte (1h)' }).click();

  await expect(page).toHaveURL(/\/app\/inbox/);
  const banner = page.getByRole('status', { name: 'Sesión de soporte activa' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(orgName);

  // Verificar que la lectura (GET) funciona sobre el tenant suspendido en support_readonly
  await expect(page.getByText('Carlos Comprador').first()).toBeVisible();

  // Verificar que una mutación (POST) con X-Support-Session-ID es rechazada con 403 support_readonly
  const readonlyCheck = await page.evaluate(async () => {
    const token = localStorage.getItem('koracrm_access_token');
    const rawSess = sessionStorage.getItem('koracrm_support_session');
    const sess = rawSess ? JSON.parse(rawSess) : null;
    const res = await fetch('/api/v1/contacts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Support-Session-ID': sess?.id || '',
      },
      body: JSON.stringify({ name: 'Bloqueado en Readonly' }),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, error: body.error };
  });
  expect(readonlyCheck.status).toBe(403);
  expect(readonlyCheck.error).toBe('support_readonly');

  const bannerOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(bannerOverflow).toBe(false);

  // Cerrar sesión de soporte sin deadlock y reactivar el tenant
  await page.getByRole('button', { name: 'Salir de soporte' }).click();
  await expect(page).toHaveURL(/\/admin/);
  await expect(banner).toBeHidden();

  await page.getByPlaceholder('Buscar organización por nombre o slug...').fill(orgName);
  await page.getByRole('button', { name: 'Buscar' }).click();
  await page.getByRole('button', { name: 'Activar' }).first().click();
  await expect(page.locator('main').getByText('Activo', { exact: true }).locator('visible=true').first()).toBeVisible();
});
