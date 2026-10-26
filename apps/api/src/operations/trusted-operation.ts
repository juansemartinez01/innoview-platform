export interface TrustedOperation {
  actor: string;
  reason: string;
  requestId: string;
}
export type ActorType = 'INNOVIEW_OPERATOR' | 'USER_IDENTITY' | 'SYSTEM';
export interface OrganizationOperation extends TrustedOperation {
  actorType: ActorType;
  userIdentityId?: string;
}
