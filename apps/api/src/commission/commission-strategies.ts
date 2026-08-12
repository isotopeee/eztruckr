import {
  CommissionMethod,
  CREW_ROLE_LABELS,
  FormulaError,
  money,
  multiplyByRate,
  parseFormula,
  toDecimalString,
  type CrewRole,
  type FormulaField,
} from '@eztruckr/types';
import type { CommissionChain } from './commission-chain';
import { CommissionComputationError } from './commission-errors';
import { evaluateFormula, type FormulaContext } from './formula-evaluator';
import {
  rationalDivide,
  rationalFromDecimalString,
  rationalToFixed,
  type Rational,
} from './rational';

/**
 * The five commission methods, as a dispatch table rather than a branch.
 *
 * Every strategy takes the same shipment context and returns the same shape:
 * an amount, and a rate the voucher can print. The Commission row stores both,
 * so a reader never has to fetch the rule — or worse, re-derive the rate —
 * to understand what was paid. That is why this returns `effectiveRate`
 * rather than a rule id.
 *
 * Adding a sixth method means appending a code, writing a strategy, and
 * registering it here. Nothing else in the engine branches on method.
 */

export interface StrategyRule {
  readonly id: string;
  readonly name: string;
  readonly method: CommissionMethod;
  readonly rate: string | null;
  readonly fixedAmount: string | null;
  readonly routeId: string | null;
  readonly params: unknown;
}

export interface StrategyContext {
  readonly role: CrewRole;
  readonly rule: StrategyRule;
  readonly chain: CommissionChain;
  readonly grossRate: string;
  readonly tpcAmount: string;
  readonly netRate: string;
  readonly gasDeductionRate: string;
  readonly shipmentRouteId: string | null;
}

export interface StrategyResult {
  /** Money, 2dp. Never negative. */
  readonly amount: string;
  /**
   * 4dp, or null when no honest figure exists. For the percent methods this
   * is the rule's own rate and is an operand; for the others it is derived
   * after the fact so reports have something to show.
   */
  readonly effectiveRate: string | null;
  /** FORMULA only — frozen onto the commission for reproducibility. */
  readonly formula?: {
    readonly expression: string;
    readonly resolvedFields: Readonly<Partial<Record<FormulaField, string>>>;
  };
}

type Strategy = (context: StrategyContext) => StrategyResult;

/**
 * `Commission.appliedRate` is DECIMAL(9,4): five digits ahead of the point.
 * A derived rate wider than that is not wrong, just unrepresentable, and a
 * null there means "no meaningful figure" — which is true — where a truncated
 * one would be a quiet lie.
 */
function fitsAppliedRateColumn(text: string): boolean {
  const [whole = ''] = text.replace('-', '').split('.');
  return whole.length <= 5;
}

/**
 * amount / denominator, to 4dp, or null when that says nothing useful.
 *
 * Null on a zero denominator rather than an error: a flat fee on a zero-rated
 * backhaul is a real thing to pay, and refusing to record it because the
 * *reporting* rate is undefined would block legitimate work over a display
 * concern. The amount is authoritative either way.
 */
function deriveEffectiveRate(amount: string, denominator: string): string | null {
  const divisor = rationalFromDecimalString(denominator);

  if (divisor.numerator === 0n) {
    return null;
  }

  const ratio: Rational = rationalDivide(rationalFromDecimalString(amount), divisor);

  if (ratio.numerator < 0n) {
    // Only reachable from a negative base, which the caller already refuses.
    return null;
  }

  const text = rationalToFixed(ratio, 4);

  return fitsAppliedRateColumn(text) ? text : null;
}

function requireRate(context: StrategyContext): string {
  if (context.rule.rate === null) {
    throw new CommissionComputationError(
      `Rule "${context.rule.name}" is a percentage method but has no rate set.`,
      CREW_ROLE_LABELS[context.role].toUpperCase() as 'DRIVER' | 'HELPER',
    );
  }

  return context.rule.rate;
}

function requireFixedAmount(context: StrategyContext): string {
  if (context.rule.fixedAmount === null) {
    throw new CommissionComputationError(
      `Rule "${context.rule.name}" is a fixed-amount method but has no amount set.`,
      CREW_ROLE_LABELS[context.role].toUpperCase() as 'DRIVER' | 'HELPER',
    );
  }

  return context.rule.fixedAmount;
}

const percentOfBase: Strategy = (context) => {
  const rate = requireRate(context);

  return {
    amount: toDecimalString(multiplyByRate(context.chain.commissionableBase, rate)),
    effectiveRate: rate,
  };
};

const percentOfNetRate: Strategy = (context) => {
  const rate = requireRate(context);

  return {
    // Deliberately skips the gas deduction: this method pays on the freight
    // itself, which is the entire reason it exists as a separate method.
    amount: toDecimalString(multiplyByRate(context.netRate, rate)),
    effectiveRate: rate,
  };
};

const fixedPerTrip: Strategy = (context) => {
  const amount = toDecimalString(money(requireFixedAmount(context)));

  return {
    amount,
    // Reported against the base the default model would have used, so a
    // fixed-fee trip and a percentage trip can be compared on one report.
    effectiveRate: deriveEffectiveRate(amount, context.chain.commissionableBase),
  };
};

const fixedPerRoute: Strategy = (context) => {
  if (context.rule.routeId === null) {
    throw new CommissionComputationError(
      `Rule "${context.rule.name}" pays a fixed amount per route but is not scoped to a route, so it would pay the same on every trip.`,
    );
  }

  if (context.shipmentRouteId !== context.rule.routeId) {
    // Unreachable through the resolver, which only offers scope-matching
    // rules. Loud beats paying a route rate on the wrong route.
    throw new CommissionComputationError(
      `Rule "${context.rule.name}" is scoped to a different route than this shipment.`,
    );
  }

  const amount = toDecimalString(money(requireFixedAmount(context)));

  return {
    amount,
    effectiveRate: deriveEffectiveRate(amount, context.chain.commissionableBase),
  };
};

/** The catalog, resolved from the shipment. See FORMULA_FIELD_CATALOG. */
function formulaContextFrom(context: StrategyContext): FormulaContext {
  return {
    gross_rate: context.grossRate,
    tpc_amount: context.tpcAmount,
    net_rate: context.netRate,
    billable_expenses: context.chain.billableExpensesTotal,
    additional_charges: context.chain.additionalChargesTotal,
    commissionable_charges: context.chain.commissionableCharges,
    gas_deduction_rate: context.gasDeductionRate,
    gas_deduction_amount: context.chain.gasDeductionAmount,
    commissionable_base: context.chain.commissionableBase,
  };
}

function expressionOf(rule: StrategyRule): string {
  const params = rule.params;

  if (typeof params !== 'object' || params === null || !('expression' in params)) {
    throw new CommissionComputationError(
      `Rule "${rule.name}" is a formula rule but carries no expression.`,
    );
  }

  const expression = (params as { expression: unknown }).expression;

  if (typeof expression !== 'string' || expression.trim() === '') {
    throw new CommissionComputationError(
      `Rule "${rule.name}" has a formula expression that is not text.`,
    );
  }

  return expression;
}

const formula: Strategy = (context) => {
  const expression = expressionOf(context.rule);

  try {
    // Re-parsed at computation rather than trusted. The expression was
    // validated before it was stored, but it has been sitting in a mutable
    // column since; parsing again costs microseconds and means a row edited
    // past the API cannot reach the evaluator unchecked.
    const result = evaluateFormula(parseFormula(expression), formulaContextFrom(context));

    return {
      amount: result.amount,
      effectiveRate: deriveEffectiveRate(result.amount, context.netRate),
      formula: { expression, resolvedFields: result.resolvedFields },
    };
  } catch (error) {
    if (error instanceof FormulaError) {
      throw new CommissionComputationError(`Rule "${context.rule.name}": ${error.message}`);
    }

    throw error;
  }
};

const STRATEGIES: Readonly<Record<CommissionMethod, Strategy>> = {
  [CommissionMethod.PERCENT_OF_BASE]: percentOfBase,
  [CommissionMethod.FIXED_PER_TRIP]: fixedPerTrip,
  [CommissionMethod.FIXED_PER_ROUTE]: fixedPerRoute,
  [CommissionMethod.PERCENT_OF_NET_RATE]: percentOfNetRate,
  [CommissionMethod.FORMULA]: formula,
};

/**
 * Runs the strategy for the rule's method.
 *
 * The negative check is here rather than in each strategy so it cannot be
 * forgotten by a method added later: a commission is a payment, and a negative
 * one would assert a debt through a mechanism that has no way to collect it.
 * Crew debts are CrewDeduction rows, settled at payout.
 */
export function runCommissionStrategy(context: StrategyContext): StrategyResult {
  const strategy = STRATEGIES[context.rule.method];

  if (!strategy) {
    throw new CommissionComputationError(
      `Rule "${context.rule.name}" uses commission method ${context.rule.method}, which has no strategy.`,
    );
  }

  const result = strategy(context);

  if (money(result.amount).intValue < 0) {
    throw new CommissionComputationError(
      `Rule "${context.rule.name}" produces a negative commission (${result.amount}) on this shipment.`,
    );
  }

  return result;
}
