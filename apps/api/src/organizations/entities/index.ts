import { Tenant } from './tenant.entity.js';
import { OrganizationalUnit } from './organizational-unit.entity.js';
import { BusinessGroup } from './business-group.entity.js';
import { Company } from './company.entity.js';
import { Branch } from './branch.entity.js';
export { Tenant, OrganizationalUnit, BusinessGroup, Company, Branch };
export const organizationEntities = [
  Tenant,
  OrganizationalUnit,
  BusinessGroup,
  Company,
  Branch,
];
