import 'reflect-metadata';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { DataSource } from 'typeorm';
import pg from 'pg';
import type { Config } from './config.js';

export const random = () => randomBytes(32).toString('base64url');
export const hash = (id: string) =>
  createHash('sha256').update(id).digest('hex');
export interface Payload {
  csrf: string;
  state?: string;
  nonce?: string;
  verifier?: string;
  issuer?: string;
  subject?: string;
  access?: string;
  refresh?: string;
  idToken?: string;
}
export interface Row {
  id_hash: string;
  kind: 'anonymous' | 'login' | 'session' | 'logout';
  encrypted: string;
  expires_at: Date;
  idle_until: Date;
  access_until: Date | null;
  lease_id: string | null;
  lease_until: Date | null;
  version: number;
}

export class Store {
  readonly source: DataSource;
  readonly table: string;
  constructor(readonly config: Config) {
    this.table = `${config.schema}.sessions`;
    this.source = new DataSource({
      type: 'postgres',
      driver: pg,
      ...config.database,
      entities: [],
      synchronize: false,
      migrationsRun: false,
      logging: false,
      poolSize: 5,
      connectTimeoutMS: 5000,
    });
  }
  async open() {
    await this.source.initialize();
    try {
      const [role] = await this.source.query<{ unsafe: boolean }[]>(
        `SELECT (
        r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
        OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid)
        OR EXISTS (SELECT 1 FROM pg_class WHERE relowner=r.oid)
        OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner=r.oid)
        OR EXISTS (SELECT 1 FROM pg_database WHERE datdba=r.oid)
        OR has_database_privilege(current_user,current_database(),'CREATE')
        OR has_database_privilege(current_user,current_database(),'TEMP')
        OR EXISTS (SELECT 1 FROM pg_namespace WHERE has_schema_privilege(current_user,oid,'CREATE'))
        OR has_schema_privilege(current_user, $1, 'USAGE')
      ) AS unsafe FROM pg_roles r WHERE rolname=current_user`,
        [this.config.app === 'portal' ? 'control_sessions' : 'portal_sessions'],
      );
      if (!role || role.unsafe) throw new Error('Unsafe session database role');
      return this;
    } catch {
      await this.source.destroy();
      throw new Error('Session database role validation failed');
    }
  }
  seal(payload: Payload, idHash: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.config.encryption, iv);
    cipher.setAAD(Buffer.from(`${this.config.clientId}:${idHash}`));
    const data = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
  }
  unseal(row: Row): Payload {
    const data = Buffer.from(row.encrypted, 'base64url');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.config.encryption,
      data.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(`${this.config.clientId}:${row.id_hash}`));
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        decipher.update(data.subarray(28)),
        decipher.final(),
      ]).toString('utf8'),
    ) as Payload;
  }
  async create(
    kind: Row['kind'],
    payload: Payload,
    seconds: number,
    accessSeconds?: number,
  ) {
    // Bounded opportunistic expiry cleanup; no token material is returned to clients.
    await this.source.query(
      `DELETE FROM ${this.table} WHERE id_hash IN (SELECT id_hash FROM ${this.table} WHERE expires_at < now() OR idle_until < now() LIMIT 100)`,
    );
    const id = random();
    await this.source.query(
      `INSERT INTO ${this.table}(id_hash,kind,encrypted,expires_at,idle_until,access_until) VALUES ($1,$2,$3,now()+$4*interval '1 second',now()+$5*interval '1 second',now()+$6*interval '1 second')`,
      [
        hash(id),
        kind,
        this.seal(payload, hash(id)),
        seconds,
        Math.min(seconds, 1800),
        accessSeconds ?? null,
      ],
    );
    return id;
  }
  async read(id: string) {
    const [row] = await this.source.query<Row[]>(
      `SELECT * FROM ${this.table} WHERE id_hash=$1 AND expires_at>now() AND idle_until>now()`,
      [hash(id)],
    );
    return row;
  }
  async consume(id: string) {
    const [rows] = await this.source.query<[Row[], number]>(
      `DELETE FROM ${this.table} WHERE id_hash=$1 AND expires_at>now() AND idle_until>now() RETURNING *`,
      [hash(id)],
    );
    return rows[0];
  }
  async revoke(id: string) {
    await this.source.query(`DELETE FROM ${this.table} WHERE id_hash=$1`, [
      hash(id),
    ]);
  }
}
