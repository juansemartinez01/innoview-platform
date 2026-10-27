import { Inject, Injectable, Optional } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { hostname, userInfo } from 'node:os';
import { CURRENT_FINGERPRINT_VERSION } from '../operations/fingerprint.js';
import { authorizationFingerprint } from './fingerprint.js';
import {
  technicalOperation,
  establishOperationContext,
  transientFailure,
  TrustedOperationTransientError,
} from '../operations/operation-context.js';
import type { OrganizationOperation as TechnicalOperation } from '../operations/trusted-operation.js';
import {
  canonicalUuid,
  securityEvent,
  databaseFailure,
} from '../security/security-events.js';
import type { Scope } from './access.contract.js';

export interface AssignmentReferences {
  membershipActive(tenantId: string, membershipId: string): Promise<boolean>;
  scopeAvailable(
    tenantId: string,
    unitId: string,
    type: Scope['type'],
  ): Promise<boolean>;
}
export const ASSIGNMENT_REFERENCES = Symbol(
  'authorization.assignment-references',
);
export class AuthorizationOperationError extends Error {
  constructor(readonly code: string) {
    super(`Authorization operation rejected: ${code}`);
  }
}
export const permissionCode = (code: string) =>
  typeof code === 'string' &&
  code.length <= 160 &&
  !/\p{Cc}/u.test(code) &&
  /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(code);
function uuid(value: string) {
  if (typeof value !== 'string' || !canonicalUuid(value.toLowerCase()))
    throw new AuthorizationOperationError('INVALID_REFERENCE');
  return value.toLowerCase();
}
function text(value: string, max: number, empty = false) {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    /\p{Cc}/u.test(value) ||
    (!empty && !value.trim())
  )
    throw new AuthorizationOperationError('INVALID_INPUT');
  return value.trim();
}

@Injectable()
export class AuthorizationService {
  constructor(
    @Inject(DataSource) private readonly source: DataSource,
    @Optional()
    @Inject(ASSIGNMENT_REFERENCES)
    private readonly references?: AssignmentReferences,
  ) {}
  private async operationContext(
    manager: EntityManager,
    tenantId: string,
    op: TechnicalOperation,
  ) {
    const [role] = await manager.query<{ trusted: boolean }[]>(
      "SELECT shobj_description(oid,'pg_authid')='innoview:'||current_database()||':authorization' AS trusted FROM pg_roles WHERE rolname=current_user",
    );
    if (!role?.trusted)
      throw new AuthorizationOperationError('OPERATOR_REQUIRED');
    await establishOperationContext(manager, 'authorization', op, tenantId);
  }
  private async previous<T>(
    manager: EntityManager,
    tenantId: string,
    op: TechnicalOperation,
    type: string,
    args: Record<string, unknown>,
  ): Promise<{ result: T } | undefined> {
    const [old] = await manager.query<
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
      'SELECT fingerprint,fingerprint_version,actor,actor_type,reason,result,completed_at FROM "authorization".operation WHERE tenant_id=$1 AND request_id=$2',
      [tenantId, op.requestId],
    );
    if (!old) return undefined;
    if (
      old.fingerprint !==
        authorizationFingerprint(old.fingerprint_version, type, args) ||
      old.actor !== op.actor ||
      old.actor_type !== op.actorType ||
      old.reason !== op.reason
    )
      throw new AuthorizationOperationError('REQUEST_ID_CONFLICT');
    if (!old.completed_at || old.result === null)
      throw new AuthorizationOperationError('INCOMPLETE_OPERATION');
    return { result: old.result };
  }
  private async write<T>(
    tenantId: string,
    type: string,
    args: Record<string, unknown>,
    input: TechnicalOperation,
    action: (manager: EntityManager) => Promise<T>,
    prepare?: () => Promise<void>,
  ): Promise<T> {
    let replay = false;
    try {
      tenantId = uuid(tenantId);
      const op = technicalOperation(input);
      const fingerprint = authorizationFingerprint(
        CURRENT_FINGERPRINT_VERSION,
        type,
        args,
      );
      let preparationError: unknown;
      let preparationFailed = false;
      if (prepare) {
        const previous = await this.source.transaction(
          'READ COMMITTED',
          async (manager) => {
            await manager.query('SET TRANSACTION READ ONLY');
            await this.operationContext(manager, tenantId, op);
            return this.previous<T>(manager, tenantId, op, type, args);
          },
        );
        if (previous) {
          securityEvent('TRUSTED_OPERATION_REPLAY', op.requestId);
          return previous.result;
        }
        // No Authorization connection/transaction is held during owner reads.
        // A failure is deferred until UNIQUE has resolved a concurrent replay.
        try {
          await prepare();
        } catch (error) {
          preparationFailed = true;
          preparationError = error;
        }
      }
      const result = await this.source.transaction(
        'READ COMMITTED',
        async (manager) => {
          await this.operationContext(manager, tenantId, op);
          const inserted = await manager.query<{ request_id: string }[]>(
            `INSERT INTO "authorization".operation(request_id,tenant_id,operation_type,fingerprint,fingerprint_version,actor,actor_type,reason,technical_source)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(request_id) DO NOTHING RETURNING request_id`,
            [
              op.requestId,
              tenantId,
              type,
              fingerprint,
              CURRENT_FINGERPRINT_VERSION,
              op.actor,
              op.actorType,
              op.reason,
              `${hostname()}:${userInfo().username}`,
            ],
          );
          if (!inserted.length) {
            const old = await this.previous<T>(
              manager,
              tenantId,
              op,
              type,
              args,
            );
            if (!old)
              throw new AuthorizationOperationError('REQUEST_ID_CONFLICT');
            replay = true;
            return old.result;
          }
          if (preparationFailed) throw preparationError;
          await manager.query(
            'INSERT INTO "authorization".tenant_revision(tenant_id) VALUES($1) ON CONFLICT(tenant_id) DO NOTHING',
            [tenantId],
          );
          await manager.query(
            'SELECT revision FROM "authorization".tenant_revision WHERE tenant_id=$1 FOR UPDATE',
            [tenantId],
          );
          const value = await action(manager);
          const [stored] = await manager.query<[{ result: T }[], number]>(
            'UPDATE "authorization".operation SET result=$3::jsonb,completed_at=clock_timestamp() WHERE tenant_id=$1 AND request_id=$2 RETURNING result',
            [tenantId, op.requestId, JSON.stringify(value)],
          );
          return stored[0].result;
        },
      );
      if (replay) securityEvent('TRUSTED_OPERATION_REPLAY', op.requestId);
      return result;
    } catch (error) {
      const transient = transientFailure(error);
      if (transient) {
        securityEvent('TRUSTED_OPERATION_CONTENTION', input?.requestId);
        throw new TrustedOperationTransientError(transient);
      }
      securityEvent(
        error instanceof AuthorizationOperationError &&
          error.code === 'REQUEST_ID_CONFLICT'
          ? 'TRUSTED_OPERATION_CONFLICT'
          : 'TRUSTED_OPERATION_REJECTED',
        input?.requestId,
      );
      if (error instanceof AuthorizationOperationError) throw error;
      securityEvent(databaseFailure(error), input?.requestId);
      throw new AuthorizationOperationError('PERSISTENCE_REJECTED');
    }
  }
  createRole(
    tenantId: string,
    name: string,
    description: string,
    operation: TechnicalOperation,
  ) {
    tenantId = uuid(tenantId);
    name = text(name, 120);
    description = text(description, 500, true);
    return this.write(
      tenantId,
      'CREATE_ROLE',
      { tenantId, name, description },
      operation,
      async (manager) => {
        const [role] = await manager.query<
          { id: string; name: string; status: string }[]
        >(
          'INSERT INTO "authorization".role(tenant_id,name,description) VALUES($1,$2,$3) RETURNING id,name,status',
          [tenantId, name, description],
        );
        return role;
      },
    );
  }
  setRoleStatus(
    tenantId: string,
    roleId: string,
    status: 'ACTIVE' | 'INACTIVE',
    operation: TechnicalOperation,
  ) {
    tenantId = uuid(tenantId);
    roleId = uuid(roleId);
    if (!['ACTIVE', 'INACTIVE'].includes(status))
      throw new AuthorizationOperationError('INVALID_STATE');
    return this.write(
      tenantId,
      'SET_ROLE',
      { tenantId, roleId, status },
      operation,
      async (manager) => {
        const [rows] = await manager.query<
          [{ id: string; status: string }[], number]
        >(
          'UPDATE "authorization".role SET status=$3 WHERE tenant_id=$1 AND id=$2 RETURNING id,status',
          [tenantId, roleId, status],
        );
        if (!rows[0])
          throw new AuthorizationOperationError('REFERENCE_UNAVAILABLE');
        return rows[0];
      },
    );
  }
  grantPermission(
    tenantId: string,
    roleId: string,
    code: string,
    operation: TechnicalOperation,
  ) {
    tenantId = uuid(tenantId);
    roleId = uuid(roleId);
    if (!permissionCode(code))
      throw new AuthorizationOperationError('INVALID_PERMISSION_CODE');
    return this.write(
      tenantId,
      'GRANT_PERMISSION',
      { tenantId, roleId, code },
      operation,
      async (manager) => {
        const [permission] = await manager.query<{ id: string }[]>(
          'SELECT id FROM "authorization".permission WHERE code=$1 AND status=\'ACTIVE\'',
          [code],
        );
        if (!permission)
          throw new AuthorizationOperationError('REFERENCE_UNAVAILABLE');
        const [grant] = await manager.query<{ id: string; status: string }[]>(
          'INSERT INTO "authorization".role_permission(tenant_id,role_id,permission_id) VALUES($1,$2,$3) RETURNING id,status',
          [tenantId, roleId, permission.id],
        );
        return grant;
      },
    );
  }
  assign(
    tenantId: string,
    membershipId: string,
    roleId: string,
    scope: Scope,
    operation: TechnicalOperation,
  ) {
    tenantId = uuid(tenantId);
    membershipId = uuid(membershipId);
    roleId = uuid(roleId);
    const unitId = uuid(scope.unitId);
    const type = scope.type;
    if (!['GROUP', 'COMPANY', 'BRANCH'].includes(type))
      throw new AuthorizationOperationError('INVALID_SCOPE');
    return this.write(
      tenantId,
      'ASSIGN',
      { tenantId, membershipId, roleId, scope: { type, unitId } },
      operation,
      async (manager) => {
        const [assignment] = await manager.query<
          { id: string; status: string }[]
        >(
          'INSERT INTO "authorization".role_assignment(tenant_id,membership_id,role_id,scope_unit_id,scope_type) VALUES($1,$2,$3,$4,$5) RETURNING id,status',
          [tenantId, membershipId, roleId, unitId, type],
        );
        return assignment;
      },
      async () => {
        // Separate owner snapshots before persistence: TOCTOU remains explicit.
        // 2.4 must revalidate availability before granting effective access.
        if (
          !this.references ||
          !(await this.references.membershipActive(tenantId, membershipId)) ||
          !(await this.references.scopeAvailable(tenantId, unitId, type))
        )
          throw new AuthorizationOperationError('REFERENCE_UNAVAILABLE');
      },
    );
  }
  revokeAssignment(
    tenantId: string,
    id: string,
    operation: TechnicalOperation,
  ) {
    return this.revoke(
      'role_assignment',
      'REVOKE_ASSIGNMENT',
      tenantId,
      id,
      operation,
    );
  }
  revokePermission(
    tenantId: string,
    id: string,
    operation: TechnicalOperation,
  ) {
    return this.revoke(
      'role_permission',
      'REVOKE_PERMISSION',
      tenantId,
      id,
      operation,
    );
  }
  private revoke(
    table: 'role_assignment' | 'role_permission',
    type: string,
    tenantId: string,
    id: string,
    operation: TechnicalOperation,
  ) {
    tenantId = uuid(tenantId);
    id = uuid(id);
    return this.write(
      tenantId,
      type,
      { tenantId, id },
      operation,
      async (manager) => {
        const [rows] = await manager.query<
          [{ id: string; status: string }[], number]
        >(
          `UPDATE "authorization".${table} SET status='REVOKED' WHERE tenant_id=$1 AND id=$2 RETURNING id,status`,
          [tenantId, id],
        );
        if (!rows[0])
          throw new AuthorizationOperationError('REFERENCE_UNAVAILABLE');
        return rows[0];
      },
    );
  }
}
