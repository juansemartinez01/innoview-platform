import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';
import { disposableAuthorization } from '../authorization/disposable.mjs';
import { backupDatabase, restoreArchive } from './backup.mjs';
import { signedFixture } from '../identity/signed-fixture.mjs';
import { IdentityVerifier } from '../../apps/api/dist/authentication/authentication.module.js';
import {
  IdentityService,
  IdentityReadTransactions,
} from '../../apps/api/dist/identity/identity.module.js';
import { MembershipsService } from '../../apps/api/dist/memberships/memberships.service.js';
import { OrganizationsService } from '../../apps/api/dist/organizations/organizations.service.js';
import { repairDirectory } from '../../apps/api/dist/organizations/directory-repair.js';
import { AuthorizationService } from '../../apps/api/dist/authorization/authorization.service.js';
import {
  AuthorizationReads,
  AuthorizationEvaluator,
} from '../../apps/api/dist/authorization/access.runtime.js';
import { TenantReadTransactions } from '../../apps/api/dist/context/context.module.js';
import {
  securityInvariants,
  directoryDifferences,
} from '../../apps/api/dist/persistence/security-diagnostics.js';
import { provisionDatabase } from '../../apps/api/dist/persistence/provision.js';
import { establishOperationContext } from '../../apps/api/dist/operations/operation-context.js';

const operation = () => ({
  actor: 'fixture:recovery-operator',
  actorType: 'SYSTEM',
  reason: 'Disposable recovery drill',
  requestId: randomUUID(),
});
async function technicalCli(env, purpose, args) {
  const child = spawn(
    process.execPath,
    ['infra/operations/runtime.mjs', purpose, ...args],
    {
      env: { ...process.env, ...env },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const chunks = [];
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => chunks.push(chunk.toString()));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  const output = chunks.join('');
  for (const [key, value] of Object.entries(env))
    if (key.endsWith('PASSWORD'))
      assert.ok(
        !output.includes(value),
        'Technical CLI must never disclose credentials',
      );
  assert.equal(code, 0, 'Technical launcher/CLI operation must succeed');
  return JSON.parse(output.trim().split('\n').at(-1));
}
const compose = (sources) => {
  const organizations = new OrganizationsService(
      sources.organizations,
      sources.provisioner,
    ),
    members = new MembershipsService(sources.membership),
    identities = new IdentityService(sources.app);
  const appMembers = new MembershipsService(sources.app),
    appOrgs = new OrganizationsService(sources.app);
  return {
    organizations,
    members,
    identities,
    writer: new AuthorizationService(sources.authorization, {
      membershipActive: (tenant, id) =>
        members.activeMembershipReference(tenant, id),
      scopeAvailable: (tenant, id, type) =>
        organizations.availableScopeReference(tenant, id, type),
    }),
    reads: new AuthorizationReads(
      sources.app,
      new TenantReadTransactions(
        new IdentityReadTransactions(sources.app, identities),
        appMembers,
        appOrgs,
      ),
      appMembers,
    ),
    evaluator: new AuthorizationEvaluator(sources.app, appMembers, appOrgs),
    appOrgs,
  };
};
const diagnose = (source) =>
  source.transaction('REPEATABLE READ', async (manager) => {
    await manager.query('SET TRANSACTION READ ONLY');
    return directoryDifferences(manager);
  });

await test('Recovery: real pg_dump/pg_restore, supported audited directory repair and protected HTTP after restore', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'innoview-recovery-')),
    issuer = await signedFixture();
  const old = {
    OIDC_ISSUER: process.env.OIDC_ISSUER,
    AUTH_ENV: process.env.AUTH_ENV,
    AUTH_ALLOW_HTTP: process.env.AUTH_ALLOW_HTTP,
  };
  process.env.OIDC_ISSUER = issuer.issuer;
  process.env.AUTH_ENV = 'development';
  process.env.AUTH_ALLOW_HTTP = 'true';
  const verifier = new IdentityVerifier();
  for (const [key, value] of Object.entries(old))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  try {
    await disposableAuthorization(async ({ env, sources }) => {
      const services = compose(sources),
        create = operation(),
        roleOp = operation();
      const tenant = await services.organizations.createTenant(
        'Recovery tenant',
        'Recovery group',
        create,
      );
      const company = await services.organizations.createCompany(
        tenant.tenant.id,
        tenant.group.id,
        'Recovery company',
        null,
        operation(),
      );
      await services.organizations.createBranch(
        tenant.tenant.id,
        company.company.id,
        'Recovery branch',
        operation(),
      );
      const token = await issuer.token(randomUUID()),
        principal = await verifier.verify(token),
        identity = await services.identities.resolve(principal);
      const membership = await services.members.register(
        tenant.tenant.id,
        identity.id,
        operation(),
      );
      const role = await services.writer.createRole(
        tenant.tenant.id,
        'Recovery reader',
        'Synthetic only',
        roleOp,
      );
      await services.writer.grantPermission(
        tenant.tenant.id,
        role.id,
        'foundation.probe.read',
        operation(),
      );
      await services.writer.assign(
        tenant.tenant.id,
        membership.membership.id,
        role.id,
        { type: 'COMPANY', unitId: company.company.id },
        operation(),
      );
      await t.test(
        'Technical CLI: independent pretenant credential provisions once and directory diagnostics are read-only',
        async () => {
          const op = operation(),
            args = [
              '--name',
              'CLI recovery tenant',
              '--group',
              'CLI group',
              '--actor',
              op.actor,
              '--reason',
              op.reason,
              '--request-id',
              op.requestId,
            ];
          const first = await technicalCli(env, 'provision-tenant', args);
          assert.deepEqual(
            await technicalCli(env, 'provision-tenant', args),
            first,
          );
          assert.notEqual(first.tenantId, tenant.tenant.id);
          assert.deepEqual(
            await technicalCli(env, 'directory', [
              '--tenant',
              tenant.tenant.id,
            ]),
            { differences: [] },
          );
        },
      );
      const before = await technicalCli(env, 'backup', [
        '--directory',
        directory,
        '--project',
        process.env.FOUNDATION_COMPOSE_PROJECT ?? 'innoview-platform-test',
        '--service',
        'postgres-test',
      ]);
      const fault = async (action, faultTenant = tenant.tenant.id) =>
        sources.maintenance.transaction(async (manager) => {
          const op = operation();
          await manager.query(
            "SELECT set_config('innoview.tenant_id',$1,true),set_config('innoview.directory_request',$2,true),set_config('innoview.directory_actor',$3,true),set_config('innoview.directory_reason',$4,true),set_config('innoview.directory_actor_type','SYSTEM',true)",
            [faultTenant, op.requestId, op.actor, op.reason],
          );
          await manager.query(
            "INSERT INTO organizations.directory_repair_operation(request_id,tenant_id,actor,reason,fingerprint,backup_sha256,actor_type) VALUES($1,$2,$3,$4,$5,$6,'SYSTEM')",
            [
              op.requestId,
              faultTenant,
              op.actor,
              op.reason,
              '0'.repeat(64),
              before.sha256,
            ],
          );
          await action(manager);
          await manager.query(
            "UPDATE organizations.directory_repair_operation SET result='{}',completed_at=clock_timestamp() WHERE request_id=$1",
            [op.requestId],
          );
        });
      await t.test(
        'Directory: missing and incorrect projections repaired, replay immutable and failed transactions roll back',
        async () => {
          await assert.rejects(
            fault(async (manager) => {
              await manager.query(
                'DELETE FROM organizations.tenant_directory WHERE tenant_id=$1',
                [tenant.tenant.id],
              );
              throw new Error('Synthetic rollback');
            }),
          );
          assert.deepEqual(await diagnose(sources.maintenance), []);
          const missing = randomUUID();
          await assert.rejects(
            fault(
              (manager) =>
                manager.query(
                  "INSERT INTO organizations.tenant_directory(tenant_id,tenant_name,group_id,group_name,available) VALUES($1,'Unexpected fixture',$2,'Invalid reference',true)",
                  [missing, tenant.group.id],
                ),
              missing,
            ),
            (error) => error.code === '23503',
          );
          assert.deepEqual(await diagnose(sources.maintenance), []);
          for (const sql of [
            'DELETE FROM organizations.tenant_directory WHERE tenant_id=$1',
            "UPDATE organizations.tenant_directory SET tenant_name='Synthetic divergence',available=false WHERE tenant_id=$1",
          ]) {
            await fault((manager) => manager.query(sql, [tenant.tenant.id]));
            assert.equal((await diagnose(sources.maintenance)).length, 1);
            const op = { ...operation(), actorType: 'INNOVIEW_OPERATOR' },
              first = await technicalCli(env, 'directory', [
                '--confirm-repair',
                '--tenant',
                tenant.tenant.id,
                '--actor',
                op.actor,
                '--reason',
                op.reason,
                '--request-id',
                op.requestId,
                '--backup',
                before.manifest,
              ]);
            assert.deepEqual(
              first,
              await repairDirectory(
                sources.maintenance,
                tenant.tenant.id,
                op,
                before.manifest,
              ),
            );
            assert.equal(first.changes, 1);
            assert.deepEqual(
              await repairDirectory(
                sources.maintenance,
                tenant.tenant.id,
                op,
                before.manifest,
              ),
              first,
            );
            await assert.rejects(
              repairDirectory(
                sources.maintenance,
                tenant.tenant.id,
                { ...op, reason: 'Changed' },
                before.manifest,
              ),
              /REQUEST_ID_CONFLICT/,
            );
            assert.deepEqual(await diagnose(sources.maintenance), []);
          }
          const corrupt = JSON.parse(await readFile(before.manifest, 'utf8'));
          corrupt.sha256 = '0'.repeat(64);
          const invalid = join(directory, 'invalid-manifest.json');
          await writeFile(invalid, JSON.stringify(corrupt));
          await assert.rejects(
            repairDirectory(
              sources.maintenance,
              tenant.tenant.id,
              operation(),
              invalid,
            ),
            /integrity/,
          );
          assert.deepEqual(
            (await securityInvariants(sources.maintenance)).findings,
            [],
          );
        },
      );
      await t.test(
        'Directory: repair waits for the same source-write gate and compares after the writer commits',
        async () => {
          const runner = sources.organizations.createQueryRunner();
          await runner.connect();
          await runner.startTransaction();
          const op = operation();
          let pending;
          try {
            await establishOperationContext(
              runner.manager,
              'organizations',
              op,
              tenant.tenant.id,
            );
            await runner.query(
              "INSERT INTO organizations.operation(request_id,tenant_id,operation_type,fingerprint,actor,actor_type,reason,technical_source) VALUES($1,$2,'SET_STATUS',$3,$4,$5,$6,'fixture:concurrent-repair')",
              [
                op.requestId,
                tenant.tenant.id,
                '0'.repeat(64),
                op.actor,
                op.actorType,
                op.reason,
              ],
            );
            await runner.query(
              "UPDATE organizations.tenant SET status='INACTIVE' WHERE id=$1",
              [tenant.tenant.id],
            );
            await runner.query(
              "UPDATE organizations.operation SET result='{}',completed_at=clock_timestamp() WHERE request_id=$1",
              [op.requestId],
            );
            const [{ pid }] = await runner.query(
              'SELECT pg_backend_pid() AS pid',
            );
            pending = repairDirectory(
              sources.maintenance,
              tenant.tenant.id,
              operation(),
              before.manifest,
            );
            let waiting = false;
            for (let i = 0; i < 50; i++) {
              const [locks] = await sources.migrator.query(
                `SELECT EXISTS(SELECT 1 FROM pg_locks w JOIN pg_locks h ON h.locktype=w.locktype AND h.database=w.database AND h.classid=w.classid AND h.objid=w.objid AND h.objsubid=w.objsubid WHERE w.locktype='advisory' AND NOT w.granted AND h.granted AND h.pid=$1) AS waiting`,
                [pid],
              );
              if (locks.waiting) {
                waiting = true;
                break;
              }
              await pause(50);
            }
            assert.ok(
              waiting,
              'Repair must wait at the source-write gate, not compare a stale source',
            );
            await runner.commitTransaction();
            assert.equal(
              (await pending).changes,
              0,
              'Deferred source trigger already derived the committed directory',
            );
            assert.deepEqual(await diagnose(sources.maintenance), []);
          } finally {
            if (runner.isTransactionActive) await runner.rollbackTransaction();
            await pending?.catch(() => {});
            await runner.release();
          }
          await services.organizations.setStatus(
            tenant.tenant.id,
            null,
            'ACTIVE',
            operation(),
          );
        },
      );
      const backup = await backupDatabase(env, directory);
      await disposableAuthorization(
        async ({ env: target, sources: restored }) => {
          assert.notEqual(target.DB_NAME, env.DB_NAME);
          await restoreArchive(backup, target);
          const mapping = new Map(
            Object.keys(env)
              .filter((key) => key.startsWith('DB_') && key.endsWith('_USER'))
              .map((key) => [env[key], target[key]]),
          );
          const policies = await restored.migrator.query(
            'SELECT schemaname,tablename,policyname,roles::text[] AS roles FROM pg_policies',
          );
          for (const p of policies) {
            assert.ok(
              p.roles.every((role) => mapping.has(role)),
              'Unexpected source policy actor',
            );
            const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
            await restored.migrator.query(
              `ALTER POLICY ${quote(p.policyname)} ON ${quote(p.schemaname)}.${quote(p.tablename)} TO ${p.roles.map((role) => quote(mapping.get(role))).join(',')}`,
            );
          }
          await restored.migrator.query(
            'UPDATE platform_meta.typeorm_metadata SET "database"=current_database() WHERE "database"=$1',
            [env.DB_NAME],
          );
          await provisionDatabase(target);
          const recovered = compose(restored);
          await t.test(
            'Restore: exact ACL/RLS/FK/triggers, historical replay/audit and effective evaluation preserved',
            async () => {
              assert.deepEqual(
                (await securityInvariants(restored.maintenance)).findings,
                [],
              );
              assert.deepEqual(await diagnose(restored.maintenance), []);
              const [invalid] = await restored.migrator.query(
                "SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname IN ('organizations','memberships','authorization') AND NOT convalidated",
              );
              assert.equal(invalid.n, 0);
              assert.equal(await restored.migrator.showMigrations(), false);
              assert.deepEqual(
                (await restored.migrator.driver.createSchemaBuilder().log())
                  .upQueries,
                [],
              );
              assert.deepEqual(
                await recovered.writer.createRole(
                  tenant.tenant.id,
                  'Recovery reader',
                  'Synthetic only',
                  roleOp,
                ),
                role,
              );
              assert.equal(
                (
                  await recovered.organizations.createTenant(
                    'Recovery tenant',
                    'Recovery group',
                    create,
                  )
                ).tenant.id,
                tenant.tenant.id,
              );
              await recovered.reads.read(
                principal,
                tenant.tenant.id,
                async (ctx) => {
                  assert.equal(
                    (
                      await recovered.evaluator.can(
                        ctx,
                        'foundation.probe.read',
                        { type: 'COMPANY', unitId: company.company.id },
                      )
                    ).allowed,
                    true,
                  );
                  assert.deepEqual(
                    await recovered.appOrgs.authorizedCompanyProjection(
                      ctx.tenantId,
                      company.company.id,
                      ctx.manager,
                    ),
                    { id: company.company.id, name: 'Recovery company' },
                  );
                },
              );
              for (const table of [
                'operation',
                'audit_event',
                'directory_repair_operation',
                'directory_repair_event',
              ]) {
                const sql = `SELECT count(*)::int AS n FROM organizations.${table}`;
                if (table.startsWith('directory_repair')) {
                  const count = (source) =>
                    source.transaction(async (m) => {
                      await m.query(
                        "SELECT set_config('innoview.tenant_id',$1,true)",
                        [tenant.tenant.id],
                      );
                      return m.query(sql);
                    });
                  assert.deepEqual(
                    await count(restored.maintenance),
                    await count(sources.maintenance),
                  );
                } else
                  assert.deepEqual(
                    await restored.maintenance.query(sql),
                    await sources.maintenance.query(sql),
                  );
              }
            },
          );
          await t.test(
            'Restore: real API permits authorized JWT and uniformly denies a foreign candidate',
            async () => {
              const socket = createServer();
              await new Promise((resolve) =>
                socket.listen(0, '127.0.0.1', resolve),
              );
              const port = socket.address().port;
              await new Promise((resolve) => socket.close(resolve));
              const child = spawn(
                process.execPath,
                ['infra/api/runtime.mjs', 'start'],
                {
                  env: {
                    ...process.env,
                    ...target,
                    OIDC_ISSUER: issuer.issuer,
                    AUTH_ENV: 'development',
                    AUTH_ALLOW_HTTP: 'true',
                    API_PORT: String(port),
                  },
                  shell: false,
                  windowsHide: true,
                  stdio: ['ignore', 'pipe', 'pipe'],
                },
              );
              const logs = [];
              for (const stream of [child.stdout, child.stderr])
                stream.on('data', (chunk) => logs.push(chunk.toString()));
              try {
                let ready = false;
                for (let i = 0; i < 150; i++) {
                  try {
                    if ((await fetch(`http://127.0.0.1:${port}/`)).ok) {
                      ready = true;
                      break;
                    }
                  } catch {
                    /* server not listening yet */
                  }
                  await pause(100);
                }
                assert.ok(ready, 'Restored API startup');
                const path = `http://127.0.0.1:${port}/authorization/demo/tenants/${tenant.tenant.id}/companies/${company.company.id}`;
                const response = await fetch(path, {
                  headers: { authorization: `Bearer ${token}` },
                });
                assert.equal(response.status, 200);
                assert.equal(response.headers.get('cache-control'), 'no-store');
                assert.deepEqual(await response.json(), {
                  id: company.company.id,
                  name: 'Recovery company',
                });
                assert.equal((await fetch(path)).status, 401);
                assert.equal(
                  (
                    await fetch(path.replace(tenant.tenant.id, randomUUID()), {
                      headers: { authorization: `Bearer ${token}` },
                    })
                  ).status,
                  404,
                );
                for (const [key, value] of Object.entries(target))
                  if (key.endsWith('PASSWORD'))
                    assert.ok(
                      !logs.join('').includes(value),
                      'No operational secret in restored API logs',
                    );
              } finally {
                if (
                  child.pid &&
                  child.exitCode === null &&
                  child.signalCode === null
                ) {
                  // Wait for the launcher AND its server tree before dropping
                  // the restored database. Linux SIGTERM is asynchronous.
                  const stopped = new Promise((resolve, reject) => {
                    const deadline = setTimeout(
                      () => reject(new Error('Restored API did not stop')),
                      8000,
                    );
                    deadline.unref();
                    child.once('exit', () => {
                      clearTimeout(deadline);
                      resolve();
                    });
                  });
                  if (process.platform === 'win32') {
                    await new Promise((resolve) => {
                      const killer = spawn(
                        'taskkill',
                        ['/pid', String(child.pid), '/t', '/f'],
                        { windowsHide: true, stdio: 'ignore' },
                      );
                      killer.on('exit', resolve);
                    });
                  } else child.kill('SIGTERM');
                  await stopped;
                }
              }
            },
          );
        },
        { empty: true },
      );
    });
  } finally {
    await issuer.close();
    const target = resolve(directory),
      parent = resolve(tmpdir());
    assert.ok(target.startsWith(join(parent, 'innoview-recovery-')));
    await rm(target, { recursive: true, force: true });
  }
});
