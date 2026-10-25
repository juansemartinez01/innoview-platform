export type App = 'portal' | 'control';
export type Env = Readonly<Record<string, string | undefined>>;

function value(env: Env, name: string): string {
  if (!env[name])
    throw new Error(`Missing authentication configuration: ${name}`);
  return env[name];
}

export function configuration(app: App, env: Env = process.env) {
  const prefix = app.toUpperCase();
  const origin = new URL(value(env, `${prefix}_ORIGIN`));
  const issuer = new URL(value(env, 'OIDC_ISSUER'));
  const api = new URL(value(env, 'AUTH_API_ORIGIN'));
  const http = env.AUTH_ALLOW_HTTP === 'true' && env.AUTH_ENV === 'development';
  for (const url of [origin, issuer, api]) {
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(http && url.protocol === 'http:' && url.hostname === '127.0.0.1'))
    )
      throw new Error(
        'Authentication requires HTTPS; HTTP is limited to explicit loopback development',
      );
  }
  if (
    origin.pathname !== '/' ||
    api.pathname !== '/' ||
    issuer.pathname.endsWith('/')
  )
    throw new Error('Invalid authentication URL paths');
  const cookiePassword = value(env, `${prefix}_COOKIE_PASSWORD`);
  const encryption = value(env, `${prefix}_TOKEN_PASSWORD`);
  if (
    cookiePassword.length < 32 ||
    !/^[a-f0-9]{64}$/.test(encryption) ||
    cookiePassword === encryption
  )
    throw new Error('Independent cookie and 256-bit token keys required');
  const other = app === 'portal' ? 'CONTROL' : 'PORTAL';
  if (
    cookiePassword === env[`${other}_COOKIE_PASSWORD`] ||
    encryption === env[`${other}_TOKEN_PASSWORD`]
  )
    throw new Error('Application keys must be independent');
  const port = Number(value(env, 'DB_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid session database port');
  const ssl = value(env, 'DB_SSL');
  if (!['require', 'disable'].includes(ssl) || (!http && ssl !== 'require'))
    throw new Error('Invalid session database TLS');
  const dbPassword = value(env, `DB_${prefix}_PASSWORD`);
  if (dbPassword.length < 16)
    throw new Error('Invalid session database credential');
  const cookieName = `${origin.protocol === 'https:' ? '__Host-' : ''}innoview.${app}.sid`;
  return {
    app,
    origin: origin.origin,
    issuer: issuer.href,
    apiOrigin: api.origin,
    clientId: app === 'portal' ? 'innoview-portal' : 'innoview-control-center',
    schema: app === 'portal' ? 'portal_sessions' : 'control_sessions',
    encryption: Buffer.from(encryption, 'hex'),
    cookie: {
      cookieName,
      password: cookiePassword,
      ttl: 28800,
      cookieOptions: {
        httpOnly: true,
        secure: origin.protocol === 'https:',
        sameSite: 'lax' as const,
        path: '/',
        maxAge: 28800,
      },
    },
    database: {
      host: value(env, 'DB_HOST'),
      port,
      database: value(env, 'DB_NAME'),
      username: value(env, `DB_${prefix}_USER`),
      password: dbPassword,
      ssl: ssl === 'require' ? { rejectUnauthorized: true } : (false as const),
    },
    http,
  };
}
export type Config = ReturnType<typeof configuration>;
