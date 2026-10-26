import { initializeOrganizationsOperatorDataSource } from '../persistence/data-sources.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { DataSource } from 'typeorm';
import {
  IdentityService,
  IdentityReadTransactions,
} from '../identity/identity.module.js';
import { MembershipsService } from '../memberships/memberships.service.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { initializeMembershipOperatorDataSource } from '../persistence/data-sources.js';
import type { Environment } from '../persistence/connection.config.js';
import { ContextService, TenantReadTransactions } from './context.module.js';

export async function verifyContextPersistence(
  t: TestContext,
  app: DataSource,
  env: Environment,
) {
  const operator = await initializeMembershipOperatorDataSource(env);
  const organizationOperator =
    await initializeOrganizationsOperatorDataSource(env);
  try {
    const identities = new IdentityService(app);
    const memberships = new MembershipsService(app);
    const trusted = new MembershipsService(operator);
    const organizations = new OrganizationsService(organizationOperator);
    const transactions = new IdentityReadTransactions(app, identities);
    const contexts = new ContextService(
      transactions,
      memberships,
      new OrganizationsService(app),
      new TenantReadTransactions(
        transactions,
        memberships,
        new OrganizationsService(app),
      ),
    );
    const principal = {
      issuer: 'https://context-fixture.invalid',
      subject: randomUUID(),
      clientId: 'innoview-portal',
    };
    const identity = await identities.resolve(principal);
    const a = await organizations.createTenant(
      'Snapshot context A',
      'Snapshot group A',
    );
    const b = await organizations.createTenant(
      'Snapshot context B',
      'Snapshot group B',
    );
    const operation = () => ({
      actor: 'fixture:snapshot',
      reason: 'Discardable transaction verification',
      requestId: randomUUID(),
    });
    await trusted.register(a.tenant.id, identity.id, operation());
    await trusted.register(b.tenant.id, identity.id, operation());
    await t.test(
      'Context: module read contracts share one read-only snapshot across a concurrent revocation and organization change',
      async () => {
        assert.equal((await contexts.options(principal)).length, 2);
        await transactions.read(principal, async (manager) => {
          assert.equal(
            await identities.findReference(principal, manager),
            identity.id,
          );
          const refs = await memberships.activeTenantReferences(
            identity.id,
            manager,
          );
          await trusted.revoke(a.tenant.id, identity.id, operation());
          await organizations.setStatus(b.tenant.id, null, 'INACTIVE');
          // A READ COMMITTED query here would mix the new organization state with
          // the old membership list. Both contracts must keep the supplied snapshot.
          assert.equal(
            (
              await new OrganizationsService(app).availableContextSummaries(
                refs,
                manager,
              )
            ).length,
            2,
          );
          assert.equal(
            (await memberships.activeTenantReferences(identity.id, manager))
              .length,
            2,
          );
          const [isolation] = await manager.query<
            { transaction_isolation: string }[]
          >('SHOW transaction_isolation');
          const [readonly] = await manager.query<
            { transaction_read_only: string }[]
          >('SHOW transaction_read_only');
          assert.equal(isolation.transaction_isolation, 'repeatable read');
          assert.equal(readonly.transaction_read_only, 'on');
        });
        assert.deepEqual(await contexts.options(principal), []);
        await assert.rejects(
          contexts.validate(principal, a.tenant.id),
          /Context unavailable/,
        );
        await assert.rejects(
          contexts.validate(principal, randomUUID()),
          /Context unavailable/,
        );
      },
    );
    await t.test(
      'Context: no identity auto-registration or writes; transaction contracts reject an unbound manager',
      async () => {
        const before = await app.query<{ n: number }[]>(
          'SELECT count(*)::int AS n FROM identity.user_identity',
        );
        assert.deepEqual(
          await contexts.options({ ...principal, subject: randomUUID() }),
          [],
        );
        assert.deepEqual(
          await app.query(
            'SELECT count(*)::int AS n FROM identity.user_identity',
          ),
          before,
        );
        await assert.rejects(
          identities.findReference(principal, app.manager),
          /Active local transaction/,
        );
        await assert.rejects(
          app.transaction('REPEATABLE READ', async (manager) => {
            await manager.query('SET TRANSACTION READ ONLY');
            await manager.query(
              "INSERT INTO foundation.persistence_probe(value) VALUES('forbidden-context-write')",
            );
          }),
          (error) =>
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === '25006',
        );
      },
    );
  } finally {
    await organizationOperator.destroy();
    await operator.destroy();
  }
}
