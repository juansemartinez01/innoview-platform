import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  type ArgumentsHost,
} from '@nestjs/common';
import { correlation } from './security-events.js';
import { HttpSecurityErrors } from './http-security.js';
import {
  CompanyDemonstrationGuard,
  AuthorizationDemonstrationController,
} from '../authorization/demonstration.js';
import type { ExecutionContext } from '@nestjs/common';

export async function verifyHttpErrors(t: TestContext) {
  await t.test(
    'Company demonstration Guard cannot be reused on another controller or resource handler',
    async () => {
      const guard = new CompanyDemonstrationGuard(
        undefined as never,
        undefined as never,
        undefined as never,
      );
      for (const [controller, handler] of [
        [
          class ForeignResource {},
          AuthorizationDemonstrationController.prototype.company,
        ],
        [AuthorizationDemonstrationController, () => {}],
      ])
        await assert.rejects(
          guard.canActivate({
            getClass: () => controller,
            getHandler: () => handler,
            switchToHttp: () => ({
              getRequest: () => ({ params: {}, url: '/foreign' }),
            }),
          } as unknown as ExecutionContext),
          (error) => error instanceof NotFoundException,
        );
    },
  );
  await t.test(
    'HTTP: authentication, denials, genuine outage and internal bug have distinct safe correlated responses',
    () => {
      const logs: string[] = [];
      const info = console.info;
      console.info = (line: unknown) => {
        logs.push(String(line));
      };
      try {
        for (const [error, expected, retry, event] of [
          [new UnauthorizedException(), 401, false, undefined],
          [new ForbiddenException(), 403, false, 'AUTHORIZATION_REJECTED'],
          [new NotFoundException(), 404, false, undefined],
          [
            Object.assign(new Error('private SQL/credential'), {
              code: '55P03',
            }),
            503,
            true,
            'DATABASE_UNAVAILABLE',
          ],
          [
            new TypeError('private SQL/credential'),
            500,
            false,
            'INTERNAL_ERROR',
          ],
        ] as const) {
          let status = 0,
            body: unknown;
          const headers = new Map<string, string>();
          const response = {
            status(value: number) {
              status = value;
              return this;
            },
            json(value: unknown) {
              body = value;
            },
            setHeader(name: string, value: string) {
              headers.set(name, value);
            },
          };
          const id = randomUUID(),
            start = logs.length;
          correlation.run(id, () =>
            new HttpSecurityErrors().catch(error, {
              switchToHttp: () => ({ getResponse: () => response }),
            } as unknown as ArgumentsHost),
          );
          assert.equal(status, expected);
          assert.equal(headers.has('Retry-After'), retry);
          assert.equal(headers.get('Cache-Control'), 'no-store');
          assert.equal((body as { correlationId: string }).correlationId, id);
          assert.ok(!JSON.stringify(body).includes('private'));
          const emitted = logs
            .slice(start)
            .map(
              (line) =>
                JSON.parse(line) as { event: string; correlationId: string },
            );
          if (event)
            assert.ok(
              emitted.some(
                (line) => line.event === event && line.correlationId === id,
              ),
            );
          assert.ok(logs.every((line) => !line.includes('private')));
        }
      } finally {
        console.info = info;
      }
    },
  );
}
