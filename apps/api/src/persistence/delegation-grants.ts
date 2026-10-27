const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';

export async function grantDelegation(
  r: { query(sql: string): Promise<unknown> },
  role: string,
) {
  const d = quote(role);
  await r.query(`GRANT USAGE ON SCHEMA identity,memberships,organizations,"authorization" TO ${d};
    GRANT SELECT(id,issuer,external_subject) ON identity.user_identity TO ${d};
    GRANT SELECT(id,tenant_id,user_identity_id,status) ON memberships.membership TO ${d};
    GRANT SELECT(id,status) ON organizations.tenant TO ${d};
    GRANT SELECT(id,tenant_id) ON organizations.business_group TO ${d};
    GRANT SELECT(id,tenant_id,type,status) ON organizations.organizational_unit TO ${d};
    GRANT SELECT(id,tenant_id,business_group_id) ON organizations.company TO ${d};
    GRANT SELECT(id,tenant_id,company_id) ON organizations.branch TO ${d};
    GRANT SELECT ON "authorization".permission,"authorization".catalog_version,"authorization".role,"authorization".role_permission,"authorization".role_assignment,"authorization".tenant_revision,"authorization".operation TO ${d};
    GRANT INSERT(tenant_id,membership_id,role_id,scope_type,scope_unit_id) ON "authorization".role_assignment TO ${d};
    GRANT INSERT(request_id,tenant_id,operation_type,fingerprint,fingerprint_version,actor,actor_type,reason,technical_source,actor_membership_id,actor_user_identity_id) ON "authorization".operation TO ${d};
    GRANT INSERT(tenant_id,operation_request_id,record_type,record_id,action,old_status,new_status,actor,actor_type,reason,technical_source,db_actor) ON "authorization".audit_event TO ${d};
    GRANT UPDATE(result,completed_at) ON "authorization".operation TO ${d};
    GRANT UPDATE(revision) ON "authorization".tenant_revision TO ${d};
    GRANT EXECUTE ON FUNCTION "authorization".require_operation(),"authorization".delegation_allowed(uuid,uuid,uuid,uuid,text,uuid,uuid) TO ${d};`);
}
