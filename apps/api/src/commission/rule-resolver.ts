import { CREW_ROLE_LABELS, type CrewRole } from '@eztruckr/types';
import { CommissionComputationError } from './commission-errors';

/**
 * Choosing which CommissionRule governs a shipment.
 *
 * Kept as a pure function over a candidate list so the precedence order is
 * testable without a database, and so the ordering lives in one readable place
 * rather than spread across a SQL ORDER BY.
 *
 * THERE IS NO FALLBACK. If nothing matches, this raises. That is a deliberate
 * design decision, not an oversight: the system used to carry default rates on
 * SystemSetting and they were removed, because a default cannot answer "what
 * was the helper rate in March?" and, worse, fails silently — an expired or
 * mis-scoped rule quietly pays the default, freezes that number onto a
 * commission, and nobody finds out until a payout is disputed. A loud failure
 * on a calm afternoon beats a quiet wrong number at month-end.
 */

export interface RuleCandidate {
  readonly id: string;
  readonly name: string;
  readonly role: number;
  readonly clientId: string | null;
  readonly routeId: string | null;
  readonly priority: number;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
  readonly isActive: boolean;
}

export interface RuleScope {
  readonly clientId: string;
  readonly routeId: string | null;
  /** The date the rule window is tested against. */
  readonly on: Date;
}

/**
 * How specific a rule is about where it applies. Higher wins.
 *
 * A null scope column means "matches anything", so a rule naming both the
 * client and the route is the most deliberate statement available and beats
 * one naming only a client, and so on down to the company-wide baseline.
 */
export function ruleSpecificity(rule: Pick<RuleCandidate, 'clientId' | 'routeId'>): number {
  if (rule.clientId !== null && rule.routeId !== null) return 3;
  if (rule.clientId !== null) return 2;
  if (rule.routeId !== null) return 1;
  return 0;
}

/**
 * Whether a rule applies at all.
 *
 * The window is half-open, [effectiveFrom, effectiveTo): a rule that ends on
 * the first of the month does not pay on the first. Closed windows would make
 * consecutive rules overlap for one instant, and that instant is exactly where
 * two rules would both match and the tie-break would silently pick one.
 */
export function ruleMatches(rule: RuleCandidate, role: CrewRole, scope: RuleScope): boolean {
  if (!rule.isActive || rule.role !== role) return false;
  if (rule.effectiveFrom.getTime() > scope.on.getTime()) return false;
  if (rule.effectiveTo !== null && rule.effectiveTo.getTime() <= scope.on.getTime()) return false;
  if (rule.clientId !== null && rule.clientId !== scope.clientId) return false;
  if (rule.routeId !== null && rule.routeId !== scope.routeId) return false;

  return true;
}

/**
 * Orders matching rules best-first: specificity, then priority, then the most
 * recently effective, then id purely so the answer is stable when a human has
 * left two rules genuinely indistinguishable.
 */
export function compareRules(a: RuleCandidate, b: RuleCandidate): number {
  const bySpecificity = ruleSpecificity(b) - ruleSpecificity(a);
  if (bySpecificity !== 0) return bySpecificity;

  const byPriority = b.priority - a.priority;
  if (byPriority !== 0) return byPriority;

  const byEffectiveFrom = b.effectiveFrom.getTime() - a.effectiveFrom.getTime();
  if (byEffectiveFrom !== 0) return byEffectiveFrom;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function findMatchingRules<T extends RuleCandidate>(
  candidates: readonly T[],
  role: CrewRole,
  scope: RuleScope,
): T[] {
  return candidates.filter((rule) => ruleMatches(rule, role, scope)).sort(compareRules);
}

/** The winning rule, or an error naming precisely what was looked for. */
export function resolveCommissionRule<T extends RuleCandidate>(
  candidates: readonly T[],
  role: CrewRole,
  scope: RuleScope,
): T {
  const [winner] = findMatchingRules(candidates, role, scope);

  if (!winner) {
    const label = CREW_ROLE_LABELS[role].toLowerCase();

    throw new CommissionComputationError(
      `No active commission rule covers the ${label} on this shipment as at ${scope.on.toISOString()}. ` +
        `Commission rates have no system-wide default by design, so this has to be fixed by adding or ` +
        `re-activating a rule rather than by falling back to one.`,
      CREW_ROLE_LABELS[role].toUpperCase() as 'DRIVER' | 'HELPER',
    );
  }

  return winner;
}
