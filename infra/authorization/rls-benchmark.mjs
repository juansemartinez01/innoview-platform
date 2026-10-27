import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { disposableAuthorization } from './disposable.mjs';
import { seededUuid } from './dataset.mjs';
import { summarizePlan } from './candidates.mjs';
import { OrganizationsService } from '../../apps/api/dist/organizations/organizations.service.js';
import { securityInvariants } from '../../apps/api/dist/persistence/security-diagnostics.js';
const operation = () => ({
  actor: 'fixture:rls-upgrade',
  actorType: 'SYSTEM',
  reason: 'Disposable indexability benchmark',
  requestId: crypto.randomUUID(),
});
console.info(
  JSON.stringify({
    prediction:
      'v11 unfiltered identity RLS uses a scan/filter; v12 can use ix_membership_identity_status on UUID. Visibility must be identical; no optimizer hints.',
    memberships: 20000,
  }),
);
try {
  const report = await disposableAuthorization(
    async ({ sources }) => {
      const orgs = new OrganizationsService(sources.organizations);
      const t = await orgs.createTenant(
        'Indexability fixture',
        'Indexability group',
        operation(),
      );
      await orgs.createCompany(
        t.tenant.id,
        t.group.id,
        'Indexability company',
        null,
        operation(),
      );
      for (let offset = 0; offset < 20000; offset += 500) {
        const ids = Array.from({ length: 500 }, (_, i) =>
          seededUuid('rls-identity:' + (offset + i)),
        );
        await sources.app.query(
          `INSERT INTO identity.user_identity(id,issuer,external_subject) SELECT value,'https://rls-fixture.invalid',value::text FROM unnest($1::uuid[]) value`,
          [ids],
        );
        await sources.membership.transaction(async (m) => {
          await m.query(
            "SELECT set_config('innoview.membership_actor','fixture:rls-upgrade',true),set_config('innoview.membership_reason','Disposable indexability benchmark',true),set_config('innoview.membership_source','TRUSTED',true)",
          );
          await m.query(`DO $$ DECLARE identity_uuid uuid;BEGIN FOREACH identity_uuid IN ARRAY ARRAY[${ids.map((id) => `'${id}'::uuid`).join(',')}] LOOP
     PERFORM set_config('innoview.membership_request',gen_random_uuid()::text,true);
     INSERT INTO memberships.membership(tenant_id,user_identity_id) VALUES('${t.tenant.id}',identity_uuid);
    END LOOP;END $$`);
        });
      }
      await sources.migrator.query('VACUUM(ANALYZE) memberships.membership');
      const id = seededUuid('rls-identity:0');
      const capture = async () => {
        const results = [];
        for (const identity of [
          id,
          seededUuid('rls-identity:1'),
          seededUuid('unknown'),
          '',
          'invalid',
          id + '\n',
          id + ' ',
          'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
        ]) {
          results.push(
            await sources.app.transaction(async (m) => {
              await m.query('SET TRANSACTION READ ONLY');
              await m.query(
                "SELECT set_config('innoview.user_identity_id',$1,true),set_config('innoview.tenant_id',$2,true)",
                [identity, t.tenant.id],
              );
              const rows = await m.query(
                "SELECT user_identity_id FROM memberships.membership WHERE status='ACTIVE' ORDER BY user_identity_id",
              );
              const directory = await m.query(
                'SELECT tenant_id FROM organizations.tenant_directory ORDER BY tenant_id',
              );
              const companies = await m.query(
                'SELECT id FROM organizations.company ORDER BY id',
              );
              return { identity, rows, directory, companies };
            }),
          );
        }
        const plan = await sources.app.transaction(async (m) => {
          await m.query(
            "SELECT set_config('innoview.user_identity_id',$1,true)",
            [id],
          );
          const [
            {
              'QUERY PLAN': [p],
            },
          ] = await m.query(
            "EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) SELECT id FROM memberships.membership WHERE status='ACTIVE'",
          );
          return summarizePlan(p);
        });
        return { results, plan };
      };
      const before = await capture();
      assert.equal((await sources.migrator.runMigrations()).length, 1);
      const after = await capture();
      assert.deepEqual(after.results, before.results);
      assert.ok(after.plan.indexes.includes('ix_membership_identity_status'));
      const policies = await sources.migrator.query(
        "SELECT schemaname,tablename,policyname,qual,permissive FROM pg_policies WHERE (schemaname='memberships' AND policyname LIKE 'membership_app_%') OR (schemaname='organizations' AND tablename IN ('tenant','tenant_directory','organizational_unit','business_group','company','branch') AND policyname LIKE 'app_%') ORDER BY schemaname,tablename,policyname",
      );
      assert.equal(policies.length, 14);
      assert.ok(
        policies.every(
          (p) =>
            !/(?:user_identity_id|tenant_id|\bid)\)?\s*::text/.test(p.qual),
        ),
      );
      assert.deepEqual(
        (await securityInvariants(sources.organizations)).findings,
        [],
      );
      await sources.migrator.undoLastMigration();
      assert.deepEqual((await capture()).results, before.results);
      await sources.migrator.runMigrations();
      return {
        postgres: (await sources.migrator.query('SELECT version()'))[0].version,
        seed: 'innoview-authorization-20261026-v1',
        memberships: 20000,
        upgrade: '11 -> 12, transactional, revert/reapply disposable only',
        before,
        after,
        policies,
      };
    },
    { schema11: true },
  );
  await writeFile(
    new URL('./rls-benchmark-result.json', import.meta.url),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.info(
    JSON.stringify({
      completed: true,
      before: report.before.plan.indexes,
      after: report.after.plan.indexes,
      sameVisibility: true,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({ failed: true, code: error.code ?? 'ASSERTION' }),
  );
  process.exitCode = 1;
}
