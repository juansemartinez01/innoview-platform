import { randomUUID } from 'node:crypto';
import type { OrganizationOperation } from './trusted-operation.js';
export const organizationOperation = (): OrganizationOperation => ({
  actor: 'fixture:trusted-operator',
  actorType: 'SYSTEM',
  reason: 'Discardable integration fixture',
  requestId: randomUUID(),
});
