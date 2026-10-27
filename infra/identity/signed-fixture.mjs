// Disposable cryptographically verified principals for PG tests/benchmark.
// HTTP runtime coverage uses the real disposable Keycloak instead.
import { createServer } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
export async function signedFixture() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: 'discardable-fixture',
    alg: 'RS256',
    use: 'sig',
  };
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const issuer = `http://127.0.0.1:${server.address().port}/realms/fixture`;
  return {
    issuer,
    token: (subject, overrides = {}) =>
      new SignJWT({ typ: 'Bearer', azp: 'innoview-portal' })
        .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
        .setIssuer(overrides.issuer ?? issuer)
        .setSubject(subject)
        .setAudience(overrides.audience ?? 'innoview-api')
        .setIssuedAt()
        .setExpirationTime('2m')
        .sign(privateKey),
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
