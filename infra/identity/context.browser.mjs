import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { apiEnvironment } from '../api/environment.mjs';
import policy from '../../apps/api/src/runtime-environment.policy.json' with { type: 'json' };

export async function verifyContextBrowser({ env, userPassword, a, b }) {
  // The test browser receives OS settings, not fixture/administrative secrets.
  const os = Object.fromEntries(
    Object.entries(apiEnvironment(process.env)).filter(([key]) =>
      policy.system.includes(key),
    ),
  );
  let browser;
  let stage = 'start Chromium';
  try {
    browser = await chromium.launch({ headless: true, env: os });
    async function login(origin, username) {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      await page.goto(origin);
      await page
        .getByRole('button', { name: 'Iniciar sesión', exact: true })
        .click();
      await page.locator('input[name="username"]').fill(username);
      await page.locator('input[name="password"]').fill(userPassword);
      await page.locator('#kc-login').click();
      await page
        .getByRole('heading', { name: 'Sesión iniciada', exact: true })
        .waitFor();
      return { context, page };
    }
    stage = 'Portal login';
    const { context, page } = await login(env.PORTAL_ORIGIN, 'runtime-test');
    stage = 'Portal selection';
    const choice = page.getByLabel('Organización disponible', { exact: true });
    await choice.waitFor();
    assert.equal(await choice.locator('option').count(), 2);
    await choice.selectOption(a.tenant.id);
    await page
      .getByRole('button', { name: 'Seleccionar organización', exact: true })
      .click();
    await page
      .getByText(`Organización seleccionada: ${a.tenant.name}`, { exact: true })
      .waitFor();
    await choice.selectOption(b.tenant.id);
    await page
      .getByRole('button', { name: 'Seleccionar organización', exact: true })
      .click();
    await page
      .getByText(`Organización seleccionada: ${b.tenant.name}`, { exact: true })
      .waitFor();
    stage = 'Portal navigation and clear';
    await page.reload();
    await page
      .getByText(`Organización seleccionada: ${b.tenant.name}`, { exact: true })
      .waitFor();
    await page
      .getByRole('button', { name: 'Limpiar selección', exact: true })
      .click();
    await page
      .getByText('Sin organización seleccionada.', { exact: true })
      .waitFor();
    await page
      .getByRole('button', { name: 'Cerrar sesión local', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Iniciar sesión', exact: true })
      .waitFor();
    await context.close();
    stage = 'Portal without memberships';
    const empty = await login(env.PORTAL_ORIGIN, 'runtime-legacy');
    await empty.page
      .getByText('No tenés organizaciones disponibles.', { exact: true })
      .waitFor();
    await empty.context.close();
    stage = 'Control Center technical screen';
    const control = await login(env.CONTROL_ORIGIN, 'runtime-test');
    assert.equal(
      await control.page
        .getByRole('heading', { name: 'Contexto organizacional', exact: true })
        .count(),
      0,
    );
    await control.context.close();
  } catch {
    // Playwright action diagnostics can include a password fill. Never propagate
    // its exception, request URLs, traces, credentials or serialized page state.
    throw new Error(
      `Browser context verification failed at ${stage}; sensitive details omitted`,
    );
  } finally {
    if (browser) await browser.close();
  }
}
