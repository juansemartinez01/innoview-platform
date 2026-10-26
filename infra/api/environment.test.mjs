import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { apiEnvironment } from './environment.mjs';
import policy from '../../apps/api/src/runtime-environment.policy.json' with { type: 'json' };
import { assertApiRuntimeEnvironment } from '../../apps/api/dist/runtime-environment.js';

const rejected = [
  'DB_BOOTSTRAP_USER',
  'PLATFORM_POSTGRES_PASSWORD',
  'DB_MIGRATOR_USER',
  'DB_MIGRATOR_PASSWORD',
  'DB_MEMBERSHIP_USER',
  'DB_MEMBERSHIP_PASSWORD',
  'KEYCLOAK_ADMIN_PASSWORD',
  'KC_BOOTSTRAP_ADMIN_PASSWORD',
  'IDENTITY_POSTGRES_PASSWORD',
  'PGPASSWORD',
  'POSTGRES_PASSWORD',
  'DB_PORTAL_PASSWORD',
  'DB_CONTROL_PASSWORD',
  'PORTAL_COOKIE_PASSWORD',
  'PORTAL_TOKEN_PASSWORD',
  'CONTROL_COOKIE_PASSWORD',
  'CONTROL_TOKEN_PASSWORD',
  'TEST_POSTGRES_PASSWORD',
  'TEST_KEYCLOAK_ADMIN_PASSWORD',
  'UNEXPECTED_RUNTIME_SECRET',
  'DOTENV_CONFIG_PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
];
test('API allowlist admits only application configuration and OS essentials, never file-based OS/Node options', () => {
  const forbidden = Object.fromEntries(
    rejected.map((key) => [key, 'excluded-fixture']),
  );
  const source = {
    ...forbidden,
    DB_HOST: 'parent-host',
    DB_APP_PASSWORD: 'application-fixture',
    Path: 'trusted-path',
    UNRELATED: 'excluded',
  };
  const file = {
    ...forbidden,
    DB_HOST: 'file-host',
    DB_PORT: '12345',
    PATH: 'file-injection',
    SYSTEMROOT: 'file-injection',
  };
  const result = apiEnvironment(source, file);
  assert.equal(result.DB_HOST, 'parent-host');
  assert.equal(result.DB_PORT, '12345');
  assert.equal(result.PATH, 'trusted-path');
  assert.equal(result.DB_APP_PASSWORD, 'application-fixture');
  assert.equal('SYSTEMROOT' in result, false);
  for (const key of rejected) assert.equal(key in result, false, key);
  assert.equal('UNRELATED' in result, false);
  assertApiRuntimeEnvironment(result);
  assert.ok(
    Object.keys(result).every((key) =>
      [...policy.system, ...policy.configuration].includes(key),
    ),
  );
});
test('API startup guard rejects privileged configuration, unknown secrets and case variants without disclosing values', () => {
  const value = randomBytes(32).toString('hex');
  for (const key of rejected) {
    for (const name of [key, key.toLowerCase()]) {
      assert.throws(
        () => assertApiRuntimeEnvironment({ [name]: value }),
        (error) => {
          assert.ok(error.message.includes(name));
          assert.ok(!error.message.includes(value));
          return true;
        },
      );
    }
  }
});
test('direct compiled entry with an accidental full env file fails before NestJS loads or connects', () => {
  const directory = mkdtempSync(join(tmpdir(), 'innoview-runtime-env-'));
  const path = join(directory, '.env');
  const value = randomBytes(32).toString('hex');
  try {
    writeFileSync(
      path,
      `DB_HOST=127.0.0.1\nDB_PORT=9\nDB_NAME=invalid_fixture\nDB_SSL=disable\nDB_APP_USER=fixture_app\nDB_APP_PASSWORD=${value}\nDB_MIGRATOR_PASSWORD=${value}\nDB_MEMBERSHIP_PASSWORD=${value}\nPLATFORM_POSTGRES_PASSWORD=${value}\n`,
    );
    const { status, stdout, stderr } = spawnSync(
      process.execPath,
      [
        `--env-file=${path}`,
        fileURLToPath(new URL('../../apps/api/dist/main.js', import.meta.url)),
      ],
      {
        env: apiEnvironment({
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
        }),
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      },
    );
    assert.equal(status, 1);
    assert.match(stderr, /Forbidden API runtime variables:/);
    assert.ok(
      !stdout.includes('[Nest]') &&
        !stdout.includes('API runtime admitted variables'),
    );
    assert.ok(!(stdout + stderr).includes(value));
  } finally {
    rmSync(path, { force: true });
    rmdirSync(directory);
  }
});
test('API grandchildren inherit the sanitized environment without Node preload or env-file flags', () => {
  const source = {
    ...process.env,
    ...Object.fromEntries(rejected.map((key) => [key, 'excluded-fixture'])),
  };
  const script = `import {spawnSync} from 'node:child_process'; const r=spawnSync(process.execPath,['-e','console.log(JSON.stringify(Object.keys(process.env).sort()))'],{encoding:'utf8'});process.stdout.write(r.stdout);process.exitCode=r.status;`;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { env: apiEnvironment(source), encoding: 'utf8', windowsHide: true },
  );
  assert.equal(result.status, 0);
  const keys = JSON.parse(result.stdout);
  for (const key of rejected) assert.ok(!keys.includes(key), key);
  assert.ok(
    keys.every((key) =>
      [...policy.system, ...policy.configuration].includes(key.toUpperCase()),
    ),
  );
});
