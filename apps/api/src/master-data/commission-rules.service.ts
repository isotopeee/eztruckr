import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@eztruckr/db';
import {
  AMOUNT_METHOD_MISMATCH_MESSAGE,
  EFFECTIVE_WINDOW_MESSAGE,
  hasAmountMatchingMethod,
  hasOrderedEffectiveWindow,
  isCommissionMethod,
  isCrewRole,
  isImplementedCommissionMethod,
  UNIMPLEMENTED_METHOD_MESSAGE,
  type CommissionRule,
  type CreateCommissionRuleInput,
  type MasterDataListQuery,
  type Page,
  type RemovalResult,
  type UpdateCommissionRuleInput,
} from '@eztruckr/types';
import { PrismaService } from '../prisma/prisma.service';
import { removeRecord } from './removal';
import { auditFields, dateToIso, decimalToString } from './serialize';

type CommissionRuleRow = Prisma.CommissionRuleGetPayload<Record<string, never>>;

@Injectable()
export class CommissionRulesService {
  constructor(private readonly prisma: PrismaService) {}

  private get rules() {
    return this.prisma.client.commissionRule;
  }

  async list(query: MasterDataListQuery): Promise<Page<CommissionRule>> {
    const where: Prisma.CommissionRuleWhereInput = {
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
    };

    const [rows, total] = await Promise.all([
      this.rules.findMany({
        where,
        // Mirrors how the Phase 4 engine will resolve them — most specific and
        // most recent first — so the list reads in the order that decides.
        orderBy: [{ isActive: 'desc' }, { priority: 'desc' }, { effectiveFrom: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.rules.count({ where }),
    ]);

    return {
      items: rows.map(toCommissionRule),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async get(id: string): Promise<CommissionRule> {
    const row = await this.rules.findFirst({ where: { id } });

    if (!row) {
      throw new NotFoundException(`No commission rule with id ${id}`);
    }

    return toCommissionRule(row);
  }

  async create(input: CreateCommissionRuleInput): Promise<CommissionRule> {
    await this.assertScopeExists(input.clientId, input.routeId);

    const row = await this.rules.create({
      data: {
        name: input.name,
        role: input.role,
        method: input.method,
        rate: input.rate,
        fixedAmount: input.fixedAmount,
        clientId: input.clientId,
        routeId: input.routeId,
        priority: input.priority,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo,
        isActive: input.isActive,
      },
    });

    return toCommissionRule(row);
  }

  /**
   * Re-runs the create-time rules against the patch merged onto the stored
   * row. A PATCH that changes only `method` would otherwise leave a rule whose
   * amount column no longer matches what its method reads — a rule that looks
   * like it pays a flat fee and silently pays nothing.
   */
  async update(id: string, input: UpdateCommissionRuleInput): Promise<CommissionRule> {
    const current = await this.get(id);
    const merged = { ...current, ...input };

    if (!isImplementedCommissionMethod(merged.method)) {
      throw badRequest('method', UNIMPLEMENTED_METHOD_MESSAGE);
    }

    if (!hasAmountMatchingMethod(merged)) {
      throw badRequest('rate', AMOUNT_METHOD_MISMATCH_MESSAGE);
    }

    if (!hasOrderedEffectiveWindow(merged)) {
      throw badRequest('effectiveTo', EFFECTIVE_WINDOW_MESSAGE);
    }

    await this.assertScopeExists(
      input.clientId === undefined ? null : input.clientId,
      input.routeId === undefined ? null : input.routeId,
    );

    return toCommissionRule(await this.rules.update({ where: { id }, data: input }));
  }

  /**
   * A rule is a template, not a record of anything: every commission freezes
   * the rate it actually used onto itself, so removing the rule cannot move
   * money that has already been computed. Nothing holds a foreign key to it,
   * so an unreferenced rule simply soft-deletes.
   */
  async remove(id: string): Promise<RemovalResult> {
    await this.get(id);

    return removeRecord({
      probes: [],
      deactivate: () => this.rules.update({ where: { id }, data: { isActive: false } }),
      softDelete: () => this.rules.softDelete({ id }),
    });
  }

  /**
   * A scope pointing at a deleted or non-existent client or route would make
   * the rule unresolvable and, worse, invisible: it would sit in the table
   * looking active while matching nothing.
   */
  private async assertScopeExists(clientId: string | null, routeId: string | null): Promise<void> {
    if (clientId) {
      const client = await this.prisma.client.client.findFirst({ where: { id: clientId } });
      if (!client) {
        throw badRequest('clientId', `No client with id ${clientId}`);
      }
    }

    if (routeId) {
      const route = await this.prisma.client.route.findFirst({ where: { id: routeId } });
      if (!route) {
        throw badRequest('routeId', `No route with id ${routeId}`);
      }
    }
  }
}

function badRequest(path: string, message: string): BadRequestException {
  return new BadRequestException({
    message: 'Validation failed',
    errors: [{ path, message }],
  });
}

function toCommissionRule(row: CommissionRuleRow): CommissionRule {
  if (!isCrewRole(row.role) || !isCommissionMethod(row.method)) {
    // Both columns carry CHECK constraints, so this is unreachable short of
    // someone writing raw SQL past them. Failing loudly beats returning a rule
    // the engine cannot interpret.
    throw new Error(`Commission rule ${row.id} has an unrecognised role or method code`);
  }

  return {
    id: row.id,
    name: row.name,
    role: row.role,
    method: row.method,
    rate: decimalToString(row.rate),
    fixedAmount: decimalToString(row.fixedAmount),
    clientId: row.clientId,
    routeId: row.routeId,
    priority: row.priority,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: dateToIso(row.effectiveTo),
    isActive: row.isActive,
    ...auditFields(row),
  };
}
