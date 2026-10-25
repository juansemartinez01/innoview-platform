export type Environment = Readonly<Record<string, string | undefined>>;
export type DatabasePurpose =
  'app' | 'migrator' | 'bootstrap' | 'portal' | 'control';

export interface ConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: false | { rejectUnauthorized: true };
  connectionTimeoutMillis: number;
}

export function identifier(value: string, field: string): string {
  if (!/^[a-z_][a-z0-9_]{2,62}$/.test(value)) {
    throw new Error(`Invalid database configuration: ${field}`);
  }
  return value;
}

function required(env: Environment, key: string): string {
  const value = env[key];
  if (!value || value.includes('\0')) {
    throw new Error(`Missing or invalid database configuration: ${key}`);
  }
  return value;
}

export function connectionConfig(
  purpose: DatabasePurpose,
  env: Environment = process.env,
): ConnectionConfig {
  const host = required(env, 'DB_HOST');
  if (!/^[a-zA-Z0-9.:-]+$/.test(host)) throw new Error('Invalid DB_HOST');
  const portText = required(env, 'DB_PORT');
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
    throw new Error('Invalid DB_PORT');
  }
  const tls = required(env, 'DB_SSL');
  if (tls !== 'disable' && tls !== 'require') throw new Error('Invalid DB_SSL');
  const prefix = `DB_${purpose.toUpperCase()}`;
  const user = identifier(required(env, `${prefix}_USER`), `${prefix}_USER`);
  const password = required(
    env,
    purpose === 'bootstrap'
      ? 'PLATFORM_POSTGRES_PASSWORD'
      : `${prefix}_PASSWORD`,
  );
  if (password.length < 16)
    throw new Error(`Invalid ${prefix}_PASSWORD: minimum 16 characters`);
  return {
    host,
    port,
    database: identifier(required(env, 'DB_NAME'), 'DB_NAME'),
    user,
    password,
    ssl: tls === 'require' ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 5000,
  };
}
