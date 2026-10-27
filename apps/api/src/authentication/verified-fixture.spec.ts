import { randomUUID } from 'node:crypto';
import { after } from 'node:test';
import { signedFixture } from '../../../../infra/identity/signed-fixture.mjs';
import { IdentityVerifier } from './authentication.module.js';

// Every admitted fixture principal passes the real RS256/JWKS verifier. No
// registration hook, structural cast or provenance bypass is available.
const fixture = signedFixture().then((issuer) => {
  const keys = ['OIDC_ISSUER', 'AUTH_ENV', 'AUTH_ALLOW_HTTP'] as const;
  const previous = keys.map((key) => process.env[key]);
  let verifier: IdentityVerifier;
  try {
    process.env.OIDC_ISSUER = issuer.issuer;
    process.env.AUTH_ENV = 'development';
    process.env.AUTH_ALLOW_HTTP = 'true';
    verifier = new IdentityVerifier();
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
  return { issuer, verifier };
});
after(async () => (await fixture).issuer.close());

export async function verifiedPrincipal(subject: string = randomUUID()) {
  const { issuer, verifier } = await fixture;
  return verifier.verify(await issuer.token(subject));
}
export async function invalidPrincipalFixture(overrides: {
  issuer?: string;
  audience?: string;
}) {
  const { issuer, verifier } = await fixture;
  return verifier.verify(await issuer.token(randomUUID(), overrides));
}
