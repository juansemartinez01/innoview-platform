import {
  establishOperationContext,
  technicalOperation,
  transientFailure,
  TrustedOperationTransientError,
} from '../operations/operation-context.js';
import {
  CURRENT_FINGERPRINT_VERSION,
  operationFingerprint,
} from '../operations/fingerprint.js';
import type { OrganizationOperation } from '../operations/trusted-operation.js';
import {
  canonicalUuid,
  securityEvent,
  databaseFailure,
} from '../security/security-events.js';
import { hostname, userInfo } from 'node:os';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager, EntityNotFoundError } from 'typeorm';
import {
  Tenant,
  OrganizationalUnit,
  BusinessGroup,
  Company,
  Branch,
} from './entities/index.js';
import type {
  OrganizationKind,
  OrganizationStatus,
} from './organizations.types.js';

export class OrganizationOperationError extends Error {
  constructor() {
    super(
      'Organization operation rejected; verify structure, state and transaction constraints',
    );
  }
}

export class OrganizationOperationConflictError extends OrganizationOperationError {
  readonly code = 'REQUEST_ID_CONFLICT';
  constructor() {
    super();
    this.message = 'Organization operation rejected: REQUEST_ID_CONFLICT';
  }
}

@Injectable()
export class OrganizationsService {
  // Concrete native read capability. Parameters belong to the authorization
  // contract: tenant $1, exact type $5/unit $6. No private attributes exposed.
  authorizationUnitsSql(exact = false) {
    return `SELECT u.tenant_id,u.id,u.type FROM organizations.organizational_unit u
      JOIN organizations.tenant t ON t.id=u.tenant_id AND t.status='ACTIVE'
      JOIN organizations.business_group g ON g.tenant_id=u.tenant_id
      JOIN organizations.organizational_unit gu ON gu.tenant_id=g.tenant_id AND gu.id=g.id AND gu.type='GROUP' AND gu.status='ACTIVE'
      LEFT JOIN organizations.branch b ON b.tenant_id=u.tenant_id AND b.id=u.id AND u.type='BRANCH'
      LEFT JOIN organizations.company c ON c.tenant_id=u.tenant_id AND c.id=CASE WHEN u.type='COMPANY' THEN u.id ELSE b.company_id END
      LEFT JOIN organizations.organizational_unit cu ON cu.tenant_id=c.tenant_id AND cu.id=c.id AND cu.status='ACTIVE'
      WHERE u.tenant_id=$1 AND u.status='ACTIVE' ${exact ? 'AND u.type=$5 AND u.id=$6' : ''}
      AND ((u.type='GROUP' AND u.id=g.id) OR (u.type IN ('COMPANY','BRANCH') AND cu.id IS NOT NULL AND c.business_group_id=g.id))`;
  }
  async authorizedCompanyProjection(
    tenantId: string,
    unitId: string,
    manager: EntityManager,
  ) {
    if (
      manager.connection !== this.source ||
      !manager.queryRunner?.isTransactionActive
    )
      throw new Error('Active local transaction required');
    const [row] = await manager.query<{ id: string; name: string }[]>(
      `SELECT c.id,u.name FROM organizations.company c JOIN organizations.organizational_unit u ON u.tenant_id=c.tenant_id AND u.id=c.id WHERE c.tenant_id=$1 AND c.id=$2 AND u.type='COMPANY' AND u.status='ACTIVE'`,
      [tenantId, unitId],
    );
    return row ?? null;
  }
  constructor(@Inject(DataSource) private readonly source: DataSource) {}

  async availableContextSummaries(tenantIds: string[], manager: EntityManager) {
    if (
      manager.connection !== this.source ||
      !manager.queryRunner?.isTransactionActive
    ) {
      securityEvent('SECURITY_CONTEXT_MISSING');
      throw new Error('Active local transaction required');
    }
    if (!tenantIds.length) return [];
    const rows = await manager.query<
      { id: string; name: string; group_id: string; group_name: string }[]
    >(
      `SELECT tenant_id AS id,tenant_name AS name,group_id,group_name FROM organizations.tenant_directory WHERE tenant_id=ANY($1::uuid[]) AND available ORDER BY tenant_name,tenant_id`,
      [tenantIds],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      group: { id: row.group_id, name: row.group_name },
    }));
  }

  private name(value: string) {
    if (typeof value !== 'string' || !value.trim() || value.length > 200)
      throw new OrganizationOperationError();
    return value.trim();
  }
  private uuid(value: string): string {
    if (typeof value !== 'string' || !canonicalUuid(value.toLowerCase()))
      throw new OrganizationOperationError();
    return value.toLowerCase();
  }
  private async write<T>(
    type: string,
    tenantId: string | null,
    args: Record<string, unknown>,
    context: OrganizationOperation,
    operation: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    let replay = false;
    try {
      if (
        !context ||
        !['INNOVIEW_OPERATOR', 'SYSTEM'].includes(context.actorType) ||
        context.userIdentityId !== undefined ||
        typeof context.actor !== 'string' ||
        typeof context.reason !== 'string' ||
        !context.actor.trim() ||
        !context.reason.trim() ||
        context.actor.length > 200 ||
        context.reason.length > 500 ||
        /\p{Cc}/u.test(context.actor + context.reason)
      )
        throw new OrganizationOperationError();
      const requestId = this.uuid(context.requestId);
      const actor = context.actor.trim(),
        reason = context.reason.trim();
      const fingerprint = operationFingerprint(
        CURRENT_FINGERPRINT_VERSION,
        type,
        args,
      );
      const result = await this.source.transaction(
        'READ COMMITTED',
        async (manager) => {
          const [role] = await manager.query<{ trusted: boolean }[]>(
            "SELECT shobj_description(oid,'pg_authid')='innoview:'||current_database()||':organizations' AS trusted FROM pg_roles WHERE rolname=current_user",
          );
          if (!role?.trusted) throw new OrganizationOperationError();
          await establishOperationContext(
            manager,
            'organizations',
            technicalOperation(context),
          );
          // Lock the tenant before the operation's FK takes KEY SHARE: upgrading
          // several concurrent FK locks to FOR UPDATE would otherwise deadlock.
          if (tenantId)
            await manager.query(
              'SELECT id FROM organizations.tenant WHERE id=$1 FOR UPDATE',
              [tenantId],
            );
          const inserted = await manager.query<{ request_id: string }[]>(
            `INSERT INTO organizations.operation(request_id,tenant_id,operation_type,fingerprint,actor,actor_type,reason,technical_source,fingerprint_version)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(request_id) DO NOTHING RETURNING request_id`,
            [
              requestId,
              tenantId,
              type,
              fingerprint,
              actor,
              context.actorType,
              reason,
              `${hostname()}:${userInfo().username}`,
              CURRENT_FINGERPRINT_VERSION,
            ],
          );
          if (!inserted.length) {
            // A fresh READ COMMITTED statement sees the concurrently committed row.
            const [existing] = await manager.query<
              {
                fingerprint: string;
                fingerprint_version: number;
                actor: string;
                actor_type: string;
                reason: string;
                result: T;
                completed_at: Date | null;
              }[]
            >(
              'SELECT fingerprint,fingerprint_version,actor,actor_type,reason,result,completed_at FROM organizations.operation WHERE request_id=$1',
              [requestId],
            );
            if (
              !existing ||
              existing.fingerprint !==
                operationFingerprint(
                  existing.fingerprint_version,
                  type,
                  args,
                ) ||
              existing.actor !== actor ||
              existing.actor_type !== context.actorType ||
              existing.reason !== reason
            )
              throw new OrganizationOperationConflictError();
            if (!existing.completed_at || existing.result === null)
              throw new OrganizationOperationError();
            replay = true;
            return existing.result;
          }
          const value = await operation(manager);
          const payload = JSON.stringify(value);
          const affected =
            type === 'CREATE_TENANT'
              ? (value as { tenant: { id: string } }).tenant.id
              : tenantId;
          const [stored] = await manager.query<[{ result: T }[], number]>(
            'UPDATE organizations.operation SET tenant_id=$2,result=$3::jsonb,completed_at=clock_timestamp() WHERE request_id=$1 RETURNING result',
            [requestId, affected, payload],
          );
          return stored[0].result;
        },
      );
      // Both first execution and replay return the same detached representation.
      const restored = JSON.parse(
        JSON.stringify(result),
        (key: string, value: unknown) =>
          ['createdAt', 'updatedAt'].includes(key) && typeof value === 'string'
            ? new Date(value)
            : value,
      ) as T;
      if (replay)
        securityEvent(
          'TRUSTED_OPERATION_REPLAY',
          context.requestId.toLowerCase(),
        );
      return restored;
    } catch (error) {
      const transient = transientFailure(error);
      if (transient) {
        securityEvent('TRUSTED_OPERATION_CONTENTION', context?.requestId);
        throw new TrustedOperationTransientError(transient);
      }
      securityEvent(
        error instanceof OrganizationOperationConflictError
          ? 'TRUSTED_OPERATION_CONFLICT'
          : 'TRUSTED_OPERATION_REJECTED',
        context?.requestId,
      );
      if (error instanceof OrganizationOperationConflictError) throw error;
      if (!(error instanceof OrganizationOperationError))
        securityEvent(databaseFailure(error), context?.requestId);
      throw new OrganizationOperationError();
    }
  }
  private async lock(manager: EntityManager, tenantId: string, active = true) {
    const tenant = await manager.getRepository(Tenant).findOne({
      where: { id: tenantId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!tenant || (active && tenant.status !== 'ACTIVE'))
      throw new OrganizationOperationError();
    return tenant;
  }
  private async unit(
    manager: EntityManager,
    tenantId: string,
    type: OrganizationKind,
    name: string,
  ) {
    return manager.save(
      OrganizationalUnit,
      manager.create(OrganizationalUnit, {
        tenantId,
        type,
        name: this.name(name),
        status: 'ACTIVE',
      }),
    );
  }

  async createTenant(
    name: string,
    groupName: string,
    operation: OrganizationOperation,
  ) {
    name = this.name(name);
    groupName = this.name(groupName);
    return this.write(
      'CREATE_TENANT',
      null,
      { name, groupName },
      operation,
      async (manager) => {
        const tenant = await manager.save(
          Tenant,
          manager.create(Tenant, { name: this.name(name), status: 'ACTIVE' }),
        );
        const unit = await this.unit(manager, tenant.id, 'GROUP', groupName);
        const group = await manager.save(
          BusinessGroup,
          manager.create(BusinessGroup, { tenantId: tenant.id, id: unit.id }),
        );
        return { tenant, group, unit };
      },
    );
  }

  async createCompany(
    tenantId: string,
    businessGroupId: string,
    name: string,
    taxId: string | null | undefined,
    operation: OrganizationOperation,
  ) {
    tenantId = this.uuid(tenantId);
    businessGroupId = this.uuid(businessGroupId);
    name = this.name(name);
    if (
      taxId !== undefined &&
      taxId !== null &&
      (typeof taxId !== 'string' || !taxId.trim() || taxId.length > 80)
    )
      throw new OrganizationOperationError();
    const taxFingerprint =
      taxId === undefined
        ? { kind: 'omitted' }
        : taxId === null
          ? { kind: 'null' }
          : { kind: 'value', value: taxId };
    return this.write(
      'CREATE_COMPANY',
      tenantId,
      { tenantId, businessGroupId, name, taxId: taxFingerprint },
      operation,
      async (manager) => {
        await this.lock(manager, tenantId);
        const parent = await manager.findOneBy(OrganizationalUnit, {
          tenantId,
          id: businessGroupId,
          type: 'GROUP',
          status: 'ACTIVE',
        });
        if (
          !parent ||
          (taxId !== null &&
            taxId !== undefined &&
            (typeof taxId !== 'string' || !taxId.trim() || taxId.length > 80))
        )
          throw new OrganizationOperationError();
        const unit = await this.unit(manager, tenantId, 'COMPANY', name);
        const company = await manager.save(
          Company,
          manager.create(Company, {
            tenantId,
            id: unit.id,
            businessGroupId,
            taxId: taxId ?? null,
          }),
        );
        return { company, unit };
      },
    );
  }

  async createBranch(
    tenantId: string,
    companyId: string,
    name: string,
    operation: OrganizationOperation,
  ) {
    tenantId = this.uuid(tenantId);
    companyId = this.uuid(companyId);
    name = this.name(name);
    return this.write(
      'CREATE_BRANCH',
      tenantId,
      { tenantId, companyId, name },
      operation,
      async (manager) => {
        await this.lock(manager, tenantId);
        const parent = await manager.findOneBy(OrganizationalUnit, {
          tenantId,
          id: companyId,
          type: 'COMPANY',
          status: 'ACTIVE',
        });
        if (!parent) throw new OrganizationOperationError();
        const unit = await this.unit(manager, tenantId, 'BRANCH', name);
        const branch = await manager.save(
          Branch,
          manager.create(Branch, { tenantId, id: unit.id, companyId }),
        );
        return { branch, unit };
      },
    );
  }

  async setStatus(
    tenantId: string,
    unitId: string | null,
    status: OrganizationStatus,
    operation: OrganizationOperation,
  ) {
    tenantId = this.uuid(tenantId);
    unitId = unitId === null ? null : this.uuid(unitId);
    if (!['ACTIVE', 'INACTIVE', 'ARCHIVED'].includes(status))
      throw new OrganizationOperationError();
    return this.write(
      'SET_STATUS',
      tenantId,
      { tenantId, unitId, status },
      operation,
      async (manager) => {
        const tenant = await this.lock(manager, tenantId, false);
        if (unitId === null) {
          if (tenant.status !== status)
            await manager.update(Tenant, { id: tenantId }, { status });
          return manager.findOneByOrFail(Tenant, { id: tenantId });
        }
        const unit = await manager.findOneByOrFail(OrganizationalUnit, {
          tenantId,
          id: unitId,
        });
        if (unit.status !== status)
          await manager.update(
            OrganizationalUnit,
            { tenantId, id: unitId },
            { status },
          );
        return manager.findOneByOrFail(OrganizationalUnit, {
          tenantId,
          id: unitId,
        });
      },
    );
  }

  // Minimal owner contract for technical assignment provisioning. Uses only
  // this module's source; no EntityManager/credentials are transferred to Auth.
  async availableScopeReference(
    tenantId: string,
    unitId: string,
    type: OrganizationKind,
  ): Promise<boolean> {
    tenantId = this.uuid(tenantId);
    unitId = this.uuid(unitId);
    return this.source
      .transaction('REPEATABLE READ', async (manager) => {
        await manager.query('SET TRANSACTION READ ONLY');
        const structure = await this.getStructure(tenantId, manager);
        if (structure.tenant.status !== 'ACTIVE') return false;
        const units = new Map(structure.units.map((unit) => [unit.id, unit]));
        if (units.get(structure.group.id)?.status !== 'ACTIVE') return false;
        const target = units.get(unitId);
        if (!target || target.type !== type || target.status !== 'ACTIVE')
          return false;
        if (type === 'GROUP') return unitId === structure.group.id;
        const company =
          type === 'COMPANY'
            ? structure.companies.find((row) => row.id === unitId)
            : structure.companies.find(
                (row) =>
                  row.id ===
                  structure.branches.find((branch) => branch.id === unitId)
                    ?.companyId,
              );
        return (
          !!company &&
          company.businessGroupId === structure.group.id &&
          units.get(company.id)?.status === 'ACTIVE'
        );
      })
      .catch((error: unknown) => {
        if (error instanceof EntityNotFoundError) return false;
        throw error;
      });
  }

  // Internal read contract. API consumers must supply the validated tenant scope;
  // membership and RLS do not replace future business permission checks.
  async getStructure(tenantId: string, manager: EntityManager) {
    if (
      !manager ||
      manager.connection !== this.source ||
      !manager.queryRunner?.isTransactionActive
    ) {
      securityEvent('SECURITY_CONTEXT_MISSING');
      throw new Error('Active local transaction required');
    }
    const read = async (manager: EntityManager) => {
      const tenant = await manager.findOneByOrFail(Tenant, { id: tenantId });
      const group = await manager.findOneByOrFail(BusinessGroup, { tenantId });
      const companies = await manager.findBy(Company, { tenantId });
      const branches = await manager.findBy(Branch, { tenantId });
      const units = await manager.findBy(OrganizationalUnit, { tenantId });
      const parents = new Map<string, string>([
        ...companies.map((c) => [c.id, c.businessGroupId] as const),
        ...branches.map((b) => [b.id, b.companyId] as const),
      ]);
      return {
        tenant,
        group,
        companies,
        branches,
        units: units.map((unit) => ({
          ...unit,
          parentId: parents.get(unit.id) ?? null,
        })),
      };
    };
    const [scope] = await manager.query<
      { trusted: boolean; identity: string | null; tenant: string | null }[]
    >(
      "SELECT shobj_description(oid,'pg_authid')='innoview:'||current_database()||':organizations' AS trusted,NULLIF(current_setting('innoview.user_identity_id',true),'') AS identity,NULLIF(current_setting('innoview.tenant_id',true),'') AS tenant FROM pg_roles WHERE rolname=current_user",
    );
    if (
      !scope?.trusted &&
      (!canonicalUuid(scope?.identity) || scope.tenant !== tenantId)
    ) {
      securityEvent('SECURITY_CONTEXT_MISSING');
      throw new Error('Validated tenant transaction required');
    }
    return read(manager);
  }
}
