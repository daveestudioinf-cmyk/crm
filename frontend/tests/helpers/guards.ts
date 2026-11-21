import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

export function attachErrorGuards(page: Page): void {
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const txt = msg.text();
      if (txt.includes('ERR_INTERNET_DISCONNECTED')) return;
      throw new Error(`Console error on ${page.url()}: ${txt}`);
    }
  });

  page.on('response', (res) => {
    if (res.status() >= 500) {
      throw new Error(`HTTP ${res.status()} on ${res.request().method()} ${res.url()}`);
    }
  });
}

export async function assertZeroOverflow(page: Page): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(
    scrollWidth,
    `Horizontal overflow detected on ${page.url()}: scrollWidth=${scrollWidth} > innerWidth=${innerWidth}`
  ).toBeLessThanOrEqual(innerWidth);
}

export async function assertSpanishAndBrand(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const lang = document.documentElement.lang;
    const bodyText = document.body?.innerText ?? '';
    const html = document.documentElement.innerHTML ?? '';
    return {
      lang,
      hasDeskcommText: /deskcomm/i.test(bodyText),
      hasSupabaseText: /supabase/i.test(bodyText),
      hasDeskcommHtml: /deskcomm/i.test(html),
      hasSupabaseHtml: /supabase/i.test(html),
      hasOldBrandColor: /#006bff/i.test(html),
    };
  });

  expect(result.lang, `Expected <html lang="es"> on ${page.url()}`).toBe('es');
  expect(result.hasDeskcommText || result.hasDeskcommHtml, 'Found leaked "Deskcomm" brand reference').toBe(false);
  expect(result.hasSupabaseText || result.hasSupabaseHtml, 'Found leaked "Supabase" reference').toBe(false);
  expect(result.hasOldBrandColor, 'Found leaked "#006bff" color token').toBe(false);
}

export async function assertAccessibility(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious'
  );
  const summary = blocking
    .map((v) => `[${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} nodes)`)
    .join('\n');
  expect(blocking, `Accessibility violations on "${label}" (${page.url()}):\n${summary}`).toEqual([]);
}
