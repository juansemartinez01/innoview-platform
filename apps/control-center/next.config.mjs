/** @type {import('next').NextConfig} */
const config = {
  transpilePackages: ['@innoview/identity-bff'],
  serverExternalPackages: ['typeorm', 'pg'],
  distDir:
    process.env.AUTH_TEST_ARTIFACTS === 'true' ? '.next-runtime-test' : '.next',
  logging: { incomingRequests: false, fetches: { fullUrl: false } },
  poweredByHeader: false,
};
export default config;
