import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { DataSource } from 'typeorm';
import { canonicalArgumentsV2 } from '../operations/fingerprint.js';
import { technicalOperation } from '../operations/operation-context.js';
import type { OrganizationOperation } from '../operations/trusted-operation.js';
import { canonicalUuid } from '../security/security-events.js';
import { directoryDifferences } from '../persistence/security-diagnostics.js';

export interface BackupManifest {
  version: 1;
  postgresMajor: 18;
  database: string;
  host: string;
  port: number;
  archive: string;
  sha256: string;
  createdAt: string;
}
export async function verifyDirectoryBackup(
  source: DataSource,
  manifestPath: string,
) {
  const manifest = JSON.parse(
    await readFile(manifestPath, 'utf8'),
  ) as BackupManifest;
  if (
    manifest.version !== 1 ||
    manifest.postgresMajor !== 18 ||
    manifest.database !== source.options.database ||
    manifest.host !==
      ('host' in source.options ? source.options.host : undefined) ||
    manifest.port !==
      ('port' in source.options ? source.options.port : undefined) ||
    !/^[0-9a-f]{64}$/.test(manifest.sha256) ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    typeof manifest.archive !== 'string'
  )
    throw new Error('Backup proof does not match repair source');
  const archive = await readFile(
    resolve(dirname(manifestPath), manifest.archive),
  );
  if (
    archive.subarray(0, 5).toString() !== 'PGDMP' ||
    createHash('sha256').update(archive).digest('hex') !== manifest.sha256
  )
    throw new Error('Backup archive integrity verification failed');
  return manifest;
}

// Explicit maintenance operation, never a provider of the HTTP application.
export async function repairDirectory(
  source: DataSource,
  tenantId: string,
  input: OrganizationOperation,
  manifestPath: string,
) {
  if (!canonicalUuid(tenantId))
    throw new Error('Canonical repair tenant required');
  const backup = await verifyDirectoryBackup(source, manifestPath),
    op = technicalOperation(input);
  const fingerprint = createHash('sha256')
    .update(
      canonicalArgumentsV2({
        module: 'organizations.directory-repair',
        version: 1,
        actorType: op.actorType,
        tenantId,
        backup: backup.sha256,
      }),
    )
    .digest('hex');
  return source.transaction('READ COMMITTED', async (manager) => {
    const [role] = await manager.query<{ valid: boolean }[]>(
      "SELECT shobj_description(oid,'pg_authid')='innoview:'||current_database()||':directory_maintenance' AS valid FROM pg_roles WHERE rolname=current_user",
    );
    if (!role?.valid)
      throw new Error('Isolated directory maintenance role required');
    await manager.query(
      "SELECT set_config('innoview.tenant_id',$1,true),set_config('innoview.directory_request',$2,true),set_config('innoview.directory_actor',$3,true),set_config('innoview.directory_reason',$4,true),set_config('innoview.directory_actor_type',$5,true),set_config('lock_timeout','8s',true)",
      [tenantId, op.requestId, op.actor, op.reason, op.actorType],
    );
    await manager.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('innoview:directory-request:'||$1,0))",
      [op.requestId],
    );
    const inserted = await manager.query<{ request_id: string }[]>(
      'INSERT INTO organizations.directory_repair_operation(request_id,tenant_id,actor,reason,fingerprint,backup_sha256,actor_type) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(request_id) DO NOTHING RETURNING request_id',
      [
        op.requestId,
        tenantId,
        op.actor,
        op.reason,
        fingerprint,
        backup.sha256,
        op.actorType,
      ],
    );
    if (!inserted.length) {
      const [old] = await manager.query<
        {
          fingerprint: string;
          actor: string;
          reason: string;
          result: { changes: number };
          completed_at: Date;
        }[]
      >(
        'SELECT fingerprint,actor,reason,result,completed_at FROM organizations.directory_repair_operation WHERE request_id=$1 AND tenant_id=$2',
        [op.requestId, tenantId],
      );
      if (
        !old ||
        old.fingerprint !== fingerprint ||
        old.actor !== op.actor ||
        old.reason !== op.reason ||
        !old.completed_at
      )
        throw new Error('REQUEST_ID_CONFLICT');
      return old.result;
    }
    await manager.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('innoview:organization-write:'||$1,0))",
      [tenantId],
    );
    // READ COMMITTED takes a new snapshot after the gate. Every source write
    // acquires this same gate in its invoker trigger, including direct SQL.
    const before = (await directoryDifferences(manager)).filter(
      (row) => row.tenant_id === tenantId,
    );
    let changes = 0;
    if (before.length) {
      const [expected] = await manager.query<
        {
          tenant_id: string;
          tenant_name: string;
          group_id: string;
          group_name: string;
          available: boolean;
        }[]
      >(
        `SELECT t.id AS tenant_id,t.name AS tenant_name,g.id AS group_id,u.name AS group_name,t.status='ACTIVE' AND u.status='ACTIVE' AS available FROM organizations.tenant t JOIN organizations.business_group g ON g.tenant_id=t.id JOIN organizations.organizational_unit u ON u.tenant_id=g.tenant_id AND u.id=g.id AND u.type='GROUP' WHERE t.id=$1`,
        [tenantId],
      );
      if (expected)
        await manager.query(
          `INSERT INTO organizations.tenant_directory(tenant_id,tenant_name,group_id,group_name,available) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id) DO UPDATE SET tenant_name=excluded.tenant_name,group_id=excluded.group_id,group_name=excluded.group_name,available=excluded.available`,
          [
            expected.tenant_id,
            expected.tenant_name,
            expected.group_id,
            expected.group_name,
            expected.available,
          ],
        );
      else {
        const [tenant] = await manager.query<{ id: string }[]>(
          'SELECT id FROM organizations.tenant WHERE id=$1',
          [tenantId],
        );
        if (tenant)
          throw new Error(
            'Authoritative organization structure incomplete; repair refused',
          );
        await manager.query(
          'DELETE FROM organizations.tenant_directory WHERE tenant_id=$1',
          [tenantId],
        );
      }
      changes = before.length;
    }
    if (
      (await directoryDifferences(manager)).some(
        (row) => row.tenant_id === tenantId,
      )
    )
      throw new Error('Repair verification failed');
    const result = {
      changes,
      issueTypes: [...new Set(before.flatMap((row) => row.issues))],
    };
    await manager.query(
      'UPDATE organizations.directory_repair_operation SET result=$2,completed_at=clock_timestamp() WHERE request_id=$1',
      [op.requestId, JSON.stringify(result)],
    );
    return result;
  });
}
