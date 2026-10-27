import type { MembershipsService } from '../memberships/memberships.service.js';
import type { OrganizationsService } from '../organizations/organizations.service.js';
// Owner-supplied native transactional relations, never SQL to private tables
// authored by a business module. No generic query/UoW framework.
export function accessQueries(
  members: MembershipsService,
  orgs: OrganizationsService,
) {
  const member = members.authorizationMembershipSql();
  const grants = `SELECT r.tenant_id,r.id AS role_id,p.id AS permission_id,p.code,p.status AS permission_status FROM "authorization".role r JOIN "authorization".role_permission rp ON rp.tenant_id=r.tenant_id AND rp.role_id=r.id AND rp.status='ACTIVE' JOIN "authorization".permission p ON p.id=rp.permission_id WHERE r.tenant_id=$1 AND r.status='ACTIVE'`;
  const listing = `WITH current_member AS MATERIALIZED (${member}),
    available_units AS MATERIALIZED (${orgs.authorizationUnitsSql()}),
    assignments AS MATERIALIZED (SELECT a.tenant_id,a.role_id,a.scope_type,a.scope_unit_id FROM "authorization".role_assignment a JOIN current_member m ON m.tenant_id=a.tenant_id AND m.id=a.membership_id WHERE a.tenant_id=$1 AND a.membership_id=$2 AND a.status='ACTIVE'),
    grants AS MATERIALIZED (${grants}),
    effective AS (SELECT g.permission_id,g.code,g.permission_status,a.scope_type,a.scope_unit_id FROM assignments a JOIN grants g ON g.tenant_id=a.tenant_id AND g.role_id=a.role_id JOIN available_units u ON u.tenant_id=a.tenant_id AND u.id=a.scope_unit_id AND u.type=a.scope_type)`;
  return {
    can: `SELECT p.status,CASE WHEN p.status='ACTIVE' THEN EXISTS(
      SELECT 1 FROM "authorization".role_assignment a
      JOIN (${member}) m ON m.tenant_id=a.tenant_id AND m.id=a.membership_id
      JOIN "authorization".role r ON r.tenant_id=a.tenant_id AND r.id=a.role_id AND r.status='ACTIVE'
      JOIN "authorization".role_permission rp ON rp.tenant_id=r.tenant_id AND rp.role_id=r.id AND rp.permission_id=p.id AND rp.status='ACTIVE'
      JOIN (${orgs.authorizationUnitsSql(true)}) u ON u.tenant_id=a.tenant_id AND u.id=a.scope_unit_id AND u.type=a.scope_type
      WHERE a.tenant_id=$1 AND a.membership_id=$2 AND a.scope_type=$5 AND a.scope_unit_id=$6 AND a.status='ACTIVE'
    ) ELSE false END AS allowed FROM "authorization".permission p WHERE p.code=$4`,
    permissions: `${listing} SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('id',permission_id,'code',code)) FILTER(WHERE permission_status='ACTIVE'),'[]') AS values,COALESCE(bool_or(permission_status='DEPRECATED'),false) AS deprecated FROM effective`,
    scopes: `${listing} SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('type',scope_type,'unitId',scope_unit_id)) FILTER(WHERE permission_status='ACTIVE'),'[]') AS values,EXISTS(SELECT 1 FROM "authorization".permission WHERE code=$4 AND status='DEPRECATED') AS deprecated FROM effective WHERE code=$4`,
  };
}
