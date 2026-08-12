import { Injectable } from '@nestjs/common';
import {
  CREW_ROLE_LABELS,
  CrewRole,
  type RuleCoverageGap,
  type RuleCoverageReport,
  type CrewRole as CrewRoleCode,
} from '@eztruckr/types';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Answers "will the next shipment be payable?" before it is asked the hard
 * way.
 *
 * Removing the fallback rates was the right call, but it turned a silently
 * wrong number into a hard failure, and a hard failure at month-end on someone
 * else's shipment is a bad place to discover that a rule expired. Two things
 * open that hole:
 *
 *   - somebody deactivates or deletes the last rule for a role. That one is
 *     refused outright by CommissionRulesService, because no lesser action
 *     leaves the system working;
 *   - a rule simply reaches its `effectiveTo`. Nobody clicks anything, so
 *     nothing can refuse it. It has to be noticed in advance instead.
 *
 * This handles the second: it reports gaps that exist now and gaps that will
 * open within a horizon, so they surface on a calm afternoon rather than as a
 * failed computation. It never blocks anything — it is a warning, and the
 * engine's own refusal remains the thing that guarantees correctness.
 */

const DEFAULT_HORIZON_DAYS = 30;

interface BaselineRule {
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
}

/** The half-open window, matching the resolver exactly. */
function coversInstant(rule: BaselineRule, at: Date): boolean {
  if (rule.effectiveFrom.getTime() > at.getTime()) return false;
  return rule.effectiveTo === null || rule.effectiveTo.getTime() > at.getTime();
}

@Injectable()
export class CommissionCoverageService {
  constructor(private readonly prisma: PrismaService) {}

  async report(horizonDays: number = DEFAULT_HORIZON_DAYS): Promise<RuleCoverageReport> {
    const now = new Date();
    const horizon = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);

    const gaps: RuleCoverageGap[] = [];

    for (const role of [CrewRole.DRIVER, CrewRole.HELPER] as CrewRoleCode[]) {
      gaps.push(...(await this.gapsForRole(role, now, horizon)));
    }

    return { checkedAt: now.toISOString(), horizonDays, gaps };
  }

  private async gapsForRole(
    role: CrewRoleCode,
    now: Date,
    horizon: Date,
  ): Promise<RuleCoverageGap[]> {
    const roleLabel = CREW_ROLE_LABELS[role];

    /**
     * Only the unscoped rules are checked.
     *
     * A rule naming a client or a route covers that client or route and
     * nothing else, so scoped-only coverage is a gap for every combination
     * nobody thought of — which is not enumerable from this table. The
     * company-wide baseline is the thing that makes any shipment payable, so
     * that is what is worth watching.
     */
    const baselines = await this.prisma.client.commissionRule.findMany({
      where: { role, isActive: true, clientId: null, routeId: null },
      select: { effectiveFrom: true, effectiveTo: true },
    });

    const scope = 'any client, any route';
    const active = baselines.filter((rule) => coversInstant(rule, now));

    if (active.length === 0) {
      const upcoming = baselines
        .filter((rule) => rule.effectiveFrom.getTime() > now.getTime())
        .sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime())[0];

      return [
        {
          role,
          roleLabel,
          scope,
          reason:
            baselines.length === 0
              ? `No company-wide commission rule exists for the ${roleLabel.toLowerCase()}. Any shipment computed now will be refused, because there is no default rate to fall back on.`
              : upcoming
                ? `The company-wide ${roleLabel.toLowerCase()} rule does not take effect until ${upcoming.effectiveFrom.toISOString()}. Shipments computed before then will be refused.`
                : `Every company-wide ${roleLabel.toLowerCase()} rule has expired. Shipments computed now will be refused.`,
          lapsesAt: null,
        },
      ];
    }

    // Coverage exists today. Does it survive the horizon? An open-ended rule
    // always does, so only a fully bounded set can lapse.
    if (baselines.some((rule) => coversInstant(rule, horizon))) {
      return [];
    }

    const lapsesAt = active
      .map((rule) => rule.effectiveTo)
      .filter((date): date is Date => date !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0];

    return [
      {
        role,
        roleLabel,
        scope,
        reason: `The company-wide ${roleLabel.toLowerCase()} rule expires within the next ${Math.round(
          (horizon.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
        )} days and nothing replaces it. Shipments dispatched after that will not compute.`,
        lapsesAt: lapsesAt?.toISOString() ?? null,
      },
    ];
  }
}
