import { stripVTControlCharacters } from 'node:util';
// Runs the same real PostgreSQL/Keycloak/browser suite before and after hardening.
// Store test names and outcomes only; driver output may contain sensitive data.
import { spawn } from 'node:child_process';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const phase = process.argv[2];
if (!['before', 'after', '3.1'].includes(phase))
  throw new Error('Use before, after or 3.1');
const measuredCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
if (
  process.env.GITHUB_ACTIONS === 'true' &&
  process.env.GITHUB_SHA !== measuredCommit
)
  throw new Error('CI SHA differs from checked out commit');
const command = process.platform === 'win32' ? 'cmd.exe' : 'pnpm';
const child = spawn(
  command,
  process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm test'] : ['test'],
  {
    shell: false,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let output = '';
for (const stream of [child.stdout, child.stderr])
  stream.on('data', (chunk) => {
    output += chunk.toString();
  });
const code = await new Promise((resolve) => child.once('exit', resolve));
const normalized = stripVTControlCharacters(output);
const matches = [
  ...normalized.matchAll(
    /(?:^|\n).*?(?:(ok|not ok) \d+ - |([✔✖]) )([^\r\n]+)/g,
  ),
];
const cases = matches.map((match) => ({
  name: match[3].replace(/ \([\d.]+m?s\)$/, ''),
  passed: match[1] === 'ok' || match[2] === '✔',
  layer: /JWT|HTTP|browser|login|logout|OIDC|runtime/i.test(match[3])
    ? 'HTTP/OIDC/runtime'
    : /effective|evaluator|grant|scope|permission|snapshot|Authorization access/i.test(
          match[3],
        )
      ? 'RBAC evaluator / trusted service'
      : /RLS|SQL|policy|policies|constraint|privilege|FK|pool|PostgreSQL/i.test(
            match[3],
          )
        ? 'PostgreSQL'
        : 'trusted service / regression',
}));
await mkdir('infra/authorization/evidence', { recursive: true });
await writeFile(
  `infra/authorization/evidence/adversarial-${phase}.json`,
  JSON.stringify(
    {
      phase,
      ci:
        process.env.GITHUB_ACTIONS === 'true'
          ? {
              sha: measuredCommit,
              runId: process.env.GITHUB_RUN_ID,
              url: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
            }
          : null,
      measurementSource:
        process.env.GITHUB_ACTIONS === 'true'
          ? 'actual CI execution on checked out SHA'
          : phase === 'before'
            ? 'approved base before control changes'
            : 'working tree at invocation; see CI run for published commit verification',
      baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
      command: 'pnpm test',
      exitCode: code,
      cases,
      limitations: [
        'Layer labels describe test coverage, not equivalent security boundaries; inspect individual assertions.',
        'RLS does not authenticate SQL operators who control their connection and GUCs.',
        'Same-tenant arbitrary SQL is not company/branch RBAC; HTTP operations must authorize in their transaction.',
      ],
    },
    null,
    2,
  ) + '\n',
);
console.info(
  JSON.stringify({
    phase,
    exitCode: code,
    results: cases.length,
    failed: cases.filter((item) => !item.passed).map((item) => item.name),
  }),
);
process.exitCode = cases.length > 0 ? (code ?? 1) : 1;

if (process.env.GITHUB_STEP_SUMMARY)
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `
3.1 matrix: ${cases.length} results, ${cases.filter((c) => !c.passed).length} failures, exit ${code}. Verified checkout SHA: ${measuredCommit}. Run: https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}
`,
  );
