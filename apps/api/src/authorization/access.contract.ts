import type { EntityManager } from 'typeorm';
declare const verifiedContext: unique symbol;
export interface AuthorizationContext {
  readonly [verifiedContext]: true;
  readonly identityId: string;
  readonly tenantId: string;
  readonly manager: EntityManager;
}
export type Scope = {
  readonly type: 'GROUP' | 'COMPANY' | 'BRANCH';
  readonly unitId: string;
};
export type AuthorizationDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'NO_GRANT' | 'UNAVAILABLE_CONTEXT' | 'UNKNOWN_PERMISSION';
    };
export type PermissionSummary = { id: string; code: string };
export interface AuthorizationAccessV1 {
  can(
    context: AuthorizationContext,
    permission: string,
    scope: Scope,
  ): Promise<AuthorizationDecision>;
  permissionsFor(context: AuthorizationContext): Promise<PermissionSummary[]>;
  scopesFor(
    context: AuthorizationContext,
    permission: string,
  ): Promise<Scope[]>;
}
// Runtime provider registered in 2.4. Contexts are issued only for the current
// authenticated read transaction; copying public fields conveys no authority.
export const AUTHORIZATION_ACCESS_V1 = Symbol('authorization.access@1');
