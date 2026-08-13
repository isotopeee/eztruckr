import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@eztruckr/db';
import {
  AMOUNT_METHOD_MISMATCH_MESSAGE,
  CREW_ROLE_LABELS,
  EFFECTIVE_WINDOW_MESSAGE,
  hasAmountMatchingMethod,
  hasOrderedEffectiveWindow,
  hasRouteForRouteMethod,
  isCommissionMethod,
  isCrewRole,
  isImplementedCommissionMethod,
  ROUTE_METHOD_NEEDS_ROUTE_MESSAGE,
  UNIMPLEMENTED_METHOD_MESSAGE,
  type CommissionRule,
  type CreateCommissionRuleInput,
  type CrewRole,
  type FormulaParams,
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
        params: input.params ?? Prisma.DbNull,
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

    if (!hasRouteForRouteMethod(merged)) {
      throw badRequest('routeId', ROUTE_METHOD_NEEDS_ROUTE_MESSAGE);
    }

    if (!hasOrderedEffectiveWindow(merged)) {
      throw badRequest('effectiveTo', EFFECTIVE_WINDOW_MESSAGE);
    }

    await this.assertScopeExists(
      input.clientId === undefined ? null : input.clientId,
      input.routeId === undefined ? null : input.routeId,
    );

    // A rule losing its last live sibling stops commissions computing for that
    // role, and deactivating one is as effective at that as deleting it.
    if (input.isActive === false && current.isActive) {
      await this.assertRoleKeepsCoverage(id, current.role);
    }

    // Written out field by field rather than spread. Prisma's update input is
    // a union of the checked and unchecked forms, and a spread containing a
    // nullable scalar foreign key like `clientId` matches neither cleanly.
    const data: Prisma.CommissionRuleUncheckedUpdateInput = {};

    if (input.name !== undefined) data.name = input.name;
    if (input.role !== undefined) data.role = input.role;
    if (input.method !== undefined) data.method = input.method;
    if (input.rate !== undefined) data.rate = input.rate;
    if (input.fixedAmount !== undefined) data.fixedAmount = input.fixedAmount;
    if (input.clientId !== undefined) data.clientId = input.clientId;
    if (input.routeId !== undefined) data.routeId = input.routeId;
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.effectiveFrom !== undefined) data.effectiveFrom = input.effectiveFrom;
    if (input.effectiveTo !== undefined) data.effectiveTo = input.effectiveTo;
    if (input.isActive !== undefined) data.isActive = input.isActive;

    // `params` is a JSON column: `undefined` means "leave alone", while an
    // explicit null has to be spelled DbNull or Prisma stores the JSON value
    // `null` instead of clearing the column.
    if (input.params !== undefined) data.params = input.params ?? Prisma.DbNull;

    return toCommissionRule(await this.rules.update({ where: { id }, data }));
  }

  /**
   * Removing a rule cannot move money: every commission freezes the rate,
   * method and rule name it used, so the figures stand on their own.
   *
   * It can still break two things.
   *
   * THE PAST. Since commissions now record which rule produced them, a rule
   * that has paid anything is referenced by history, and the ordinary
   * deactivate-instead-of-delete rule applies — it stays in the table, visible
   * and inactive, so an auditor following `appliedRuleId` from a voucher
   * arrives somewhere. Before that link existed this probe had nothing to
   * count and a used rule would simply soft-delete.
   *
   * THE FUTURE. There is no fallback rate in this system, so a role left with
   * no live rule stops computing altogether — and the failure lands at
   * month-end, on a shipment, far from the click that caused it. Removing the
   * last rule for a role is therefore refused outright rather than reported as
   * an outcome: unlike deactivation, there is no lesser action that leaves the
   * system working.
   */
  async remove(id: string): Promise<RemovalResult> {
    const rule = await this.get(id);

    await this.assertRoleKeepsCoverage(id, rule.role);

    return removeRecord({
      probes: [
        {
          entity: 'commissions',
          // Counts live commissions only, which is what the extension gives
          // us. A soft-deleted commission is superseded working, not history
          // anyone will follow a link from.
          count: () => this.prisma.client.commission.count({ where: { appliedRuleId: id } }),
        },
      ],
      deactivate: () => this.rules.update({ where: { id }, data: { isActive: false } }),
      softDelete: () => this.rules.softDelete({ id }),
    });
  }

  /**
   * Refuses to leave a role with no live, active rule at all.
   *
   * Deliberately a coarse check — "is there at least one other" — rather than
   * a scope-aware one. A precise answer would have to enumerate every client
   * and route combination that could ever be shipped, which is not knowable
   * from the rules table. Coverage across scopes is the job of
   * `CommissionCoverageService`, which reports gaps as warnings; this only
   * stops the one case that is unambiguously fatal.
   */
  private async assertRoleKeepsCoverage(id: string, role: CrewRole): Promise<void> {
    const survivors = await this.rules.count({
      where: { role, isActive: true, id: { not: id } },
    });

    if (survivors === 0) {
      throw new ConflictException(
        `This is the last active commission rule for the ${CREW_ROLE_LABELS[role].toLowerCase()}. ` +
          `Removing it would stop commissions computing for every future shipment, and there is no ` +
          `default rate to fall back on. Create a replacement rule first.`,
      );
    }
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

/**
 * Narrows the JSON column to the one shape the API declares.
 *
 * A CHECK constraint already requires FORMULA rules to carry a non-empty
 * `expression`, so this is about the type rather than the data: `Prisma.Json`
 * is `any`-shaped, and returning it unchecked would let an unexpected column
 * value reach the client as though it had been validated.
 */
function toFormulaParams(value: Prisma.JsonValue): FormulaParams | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const expression = (value as Record<string, unknown>).expression;

  return typeof expression === 'string' ? { expression } : null;
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
    params: toFormulaParams(row.params),
    clientId: row.clientId,
    routeId: row.routeId,
    priority: row.priority,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: dateToIso(row.effectiveTo),
    isActive: row.isActive,
    ...auditFields(row),
  };
}
