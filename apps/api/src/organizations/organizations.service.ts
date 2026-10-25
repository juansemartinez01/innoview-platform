import { Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  Tenant,
  OrganizationalUnit,
  BusinessGroup,
  Company,
  Branch,
} from './entities/index.js';
import type {
  OrganizationKind,
  OrganizationStatus,
} from './organizations.types.js';

export class OrganizationOperationError extends Error {
  constructor() {
    super(
      'Organization operation rejected; verify structure, state and transaction constraints',
    );
  }
}

@Injectable()
export class OrganizationsService {
  constructor(@Inject(DataSource) private readonly source: DataSource) {}

  private name(value: string) {
    if (typeof value !== 'string' || !value.trim() || value.length > 200)
      throw new OrganizationOperationError();
    return value.trim();
  }
  private async write<T>(
    operation: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.source.transaction(operation);
    } catch {
      throw new OrganizationOperationError();
    }
  }
  private async lock(manager: EntityManager, tenantId: string, active = true) {
    const tenant = await manager.getRepository(Tenant).findOne({
      where: { id: tenantId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!tenant || (active && tenant.status !== 'ACTIVE'))
      throw new OrganizationOperationError();
    return tenant;
  }
  private async unit(
    manager: EntityManager,
    tenantId: string,
    type: OrganizationKind,
    name: string,
  ) {
    return manager.save(
      OrganizationalUnit,
      manager.create(OrganizationalUnit, {
        tenantId,
        type,
        name: this.name(name),
        status: 'ACTIVE',
      }),
    );
  }

  async createTenant(name: string, groupName: string) {
    return this.write(async (manager) => {
      const tenant = await manager.save(
        Tenant,
        manager.create(Tenant, { name: this.name(name), status: 'ACTIVE' }),
      );
      const unit = await this.unit(manager, tenant.id, 'GROUP', groupName);
      const group = await manager.save(
        BusinessGroup,
        manager.create(BusinessGroup, { tenantId: tenant.id, id: unit.id }),
      );
      return { tenant, group, unit };
    });
  }

  async createCompany(
    tenantId: string,
    businessGroupId: string,
    name: string,
    taxId: string | null = null,
  ) {
    return this.write(async (manager) => {
      await this.lock(manager, tenantId);
      const parent = await manager.findOneBy(OrganizationalUnit, {
        tenantId,
        id: businessGroupId,
        type: 'GROUP',
        status: 'ACTIVE',
      });
      if (
        !parent ||
        (taxId !== null &&
          (typeof taxId !== 'string' || !taxId.trim() || taxId.length > 80))
      )
        throw new OrganizationOperationError();
      const unit = await this.unit(manager, tenantId, 'COMPANY', name);
      const company = await manager.save(
        Company,
        manager.create(Company, {
          tenantId,
          id: unit.id,
          businessGroupId,
          taxId,
        }),
      );
      return { company, unit };
    });
  }

  async createBranch(tenantId: string, companyId: string, name: string) {
    return this.write(async (manager) => {
      await this.lock(manager, tenantId);
      const parent = await manager.findOneBy(OrganizationalUnit, {
        tenantId,
        id: companyId,
        type: 'COMPANY',
        status: 'ACTIVE',
      });
      if (!parent) throw new OrganizationOperationError();
      const unit = await this.unit(manager, tenantId, 'BRANCH', name);
      const branch = await manager.save(
        Branch,
        manager.create(Branch, { tenantId, id: unit.id, companyId }),
      );
      return { branch, unit };
    });
  }

  async setStatus(
    tenantId: string,
    unitId: string | null,
    status: OrganizationStatus,
  ) {
    if (!['ACTIVE', 'INACTIVE', 'ARCHIVED'].includes(status))
      throw new OrganizationOperationError();
    return this.write(async (manager) => {
      const tenant = await this.lock(manager, tenantId, false);
      if (unitId === null) {
        if (tenant.status !== status)
          await manager.update(Tenant, { id: tenantId }, { status });
        return manager.findOneByOrFail(Tenant, { id: tenantId });
      }
      const unit = await manager.findOneByOrFail(OrganizationalUnit, {
        tenantId,
        id: unitId,
      });
      if (unit.status !== status)
        await manager.update(
          OrganizationalUnit,
          { tenantId, id: unitId },
          { status },
        );
      return manager.findOneByOrFail(OrganizationalUnit, {
        tenantId,
        id: unitId,
      });
    });
  }

  // Internal persistence contract, NOT an authorization boundary. Explicit
  // tenant filters will need membership validation and RLS before exposure.
  async getStructure(tenantId: string) {
    return this.source.transaction('REPEATABLE READ', async (manager) => {
      const tenant = await manager.findOneByOrFail(Tenant, { id: tenantId });
      const group = await manager.findOneByOrFail(BusinessGroup, { tenantId });
      const companies = await manager.findBy(Company, { tenantId });
      const branches = await manager.findBy(Branch, { tenantId });
      const units = await manager.findBy(OrganizationalUnit, { tenantId });
      const parents = new Map<string, string>([
        ...companies.map((c) => [c.id, c.businessGroupId] as const),
        ...branches.map((b) => [b.id, b.companyId] as const),
      ]);
      return {
        tenant,
        group,
        companies,
        branches,
        units: units.map((unit) => ({
          ...unit,
          parentId: parents.get(unit.id) ?? null,
        })),
      };
    });
  }
}
