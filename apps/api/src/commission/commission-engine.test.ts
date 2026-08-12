import { CommissionMethod, CrewRole } from '@eztruckr/types';
import { describe, expect, it } from 'vitest';
import { computeCommissionChain, computeRateChain, type ChargeLine } from './commission-chain';
import { CommissionComputationError } from './commission-errors';
import {
  runCommissionStrategy,
  type StrategyContext,
  type StrategyRule,
} from './commission-strategies';
import {
  findMatchingRules,
  resolveCommissionRule,
  ruleSpecificity,
  type RuleCandidate,
} from './rule-resolver';

/**
 * The engine's arithmetic, asserted against the brief's worked example.
 *
 * Everything here is pure — no database, no Nest. The figures below are the
 * contract: a reviewer with a calculator must be able to reproduce each one
 * from the values on the row above it.
 */

const DRIVER_RATE = '0.1500';
const HELPER_RATE = '0.0750';
const GAS_RATE = '0.2500';

function charge(amount: string, isCommissionable = false): ChargeLine {
  return { amount, isCommissionable };
}

function rateRule(role: CrewRole, rate: string): StrategyRule {
  return {
    id: `rule-${role}`,
    name: role === CrewRole.DRIVER ? 'Driver baseline' : 'Helper baseline',
    method: CommissionMethod.PERCENT_OF_BASE,
    rate,
    fixedAmount: null,
    routeId: null,
    params: null,
  };
}

/** Builds a full strategy context around a chain, for the default model. */
function contextFor(
  rule: StrategyRule,
  options: {
    grossRate?: string;
    tpcRate?: string | null;
    tpcAmount?: string | null;
    gasRate?: string;
    billableExpenses?: ChargeLine[];
    additionalCharges?: ChargeLine[];
    role?: CrewRole;
    shipmentRouteId?: string | null;
  } = {},
): StrategyContext {
  const rates = computeRateChain({
    grossRate: options.grossRate ?? '18000.00',
    tpcRate: options.tpcRate === undefined ? '0.1000' : options.tpcRate,
    tpcAmount: options.tpcAmount ?? null,
  });

  const gasDeductionRate = options.gasRate ?? GAS_RATE;

  const chain = computeCommissionChain({
    netRate: rates.netRate,
    billableExpenses: options.billableExpenses ?? [],
    additionalCharges: options.additionalCharges ?? [],
    gasDeductionRate,
  });

  return {
    role: options.role ?? CrewRole.DRIVER,
    rule,
    chain,
    grossRate: rates.grossRate,
    tpcAmount: rates.tpcAmount,
    netRate: rates.netRate,
    gasDeductionRate,
    shipmentRouteId: options.shipmentRouteId ?? null,
  };
}

describe('the worked example from the brief', () => {
  const options = {
    grossRate: '18000.00',
    tpcRate: '0.1000',
    // The extra drop fee is NOT commissionable in the worked example.
    additionalCharges: [charge('1500.00', false)],
  };

  const driver = contextFor(rateRule(CrewRole.DRIVER, DRIVER_RATE), options);

  it('derives the rate chain: 18,000 gross less 10% = 16,200 net', () => {
    expect(driver.grossRate).toBe('18000.00');
    expect(driver.tpcAmount).toBe('1800.00');
    expect(driver.netRate).toBe('16200.00');
  });

  it('counts the non-commissionable fee as revenue but not as base', () => {
    expect(driver.chain.additionalChargesTotal).toBe('1500.00');
    expect(driver.chain.totalRevenue).toBe('17700.00');
    expect(driver.chain.commissionableCharges).toBe('0.00');
  });

  it('deducts 25% for gas and lands on a 12,150.00 base', () => {
    expect(driver.chain.grossForCommission).toBe('16200.00');
    expect(driver.chain.gasDeductionAmount).toBe('4050.00');
    expect(driver.chain.commissionableBase).toBe('12150.00');
  });

  it('pays the driver 1,822.50 at 15%', () => {
    expect(runCommissionStrategy(driver).amount).toBe('1822.50');
  });

  it('pays the helper 911.25 at 7.5%', () => {
    const helper = contextFor(rateRule(CrewRole.HELPER, HELPER_RATE), {
      ...options,
      role: CrewRole.HELPER,
    });

    expect(runCommissionStrategy(helper).amount).toBe('911.25');
  });

  it('reproduces the stored figures on a calculator', () => {
    // The self-verification the schema promises: base x rate = amount, using
    // only values stored on the row.
    const result = runCommissionStrategy(driver);

    expect(Number(driver.chain.commissionableBase) * Number(result.effectiveRate)).toBeCloseTo(
      Number(result.amount),
      2,
    );
  });
});

describe('a commissionable charge included in the base', () => {
  const options = {
    grossRate: '18000.00',
    tpcRate: '0.1000',
    additionalCharges: [charge('1500.00', true)],
  };

  it('raises the base to 13,275.00', () => {
    const context = contextFor(rateRule(CrewRole.DRIVER, DRIVER_RATE), options);

    expect(context.chain.commissionableCharges).toBe('1500.00');
    expect(context.chain.grossForCommission).toBe('17700.00');
    expect(context.chain.gasDeductionAmount).toBe('4425.00');
    expect(context.chain.commissionableBase).toBe('13275.00');
  });

  it('pays the driver 1,991.25', () => {
    const context = contextFor(rateRule(CrewRole.DRIVER, DRIVER_RATE), options);

    expect(runCommissionStrategy(context).amount).toBe('1991.25');
  });

  /**
   * THE CANONICAL ROUNDING PROOF. 13,275.00 x 0.075 = 995.625 exactly, and
   * half-up must take it to 995.63. A half-even or truncating implementation
   * gives 995.62 and every other figure in the system still looks right, which
   * is what makes this worth asserting on its own.
   */
  it('pays the helper 995.63, not 995.62 — 995.625 rounds half-up', () => {
    const context = contextFor(rateRule(CrewRole.HELPER, HELPER_RATE), {
      ...options,
      role: CrewRole.HELPER,
    });

    expect(runCommissionStrategy(context).amount).toBe('995.63');
  });
});

describe('third-party commission', () => {
  it('leaves net equal to gross for a direct client with no TPC', () => {
    const context = contextFor(rateRule(CrewRole.DRIVER, DRIVER_RATE), {
      grossRate: '18000.00',
      tpcRate: null,
      tpcAmount: null,
    });

    expect(context.tpcAmount).toBe('0.00');
    expect(context.netRate).toBe('18000.00');
    expect(context.chain.commissionableBase).toBe('13500.00');
    expect(runCommissionStrategy(context).amount).toBe('2025.00');
  });

  it('accepts a flat TPC amount instead of a percentage', () => {
    const chain = computeRateChain({ grossRate: '18000.00', tpcRate: null, tpcAmount: '2500.00' });

    expect(chain.tpcAmount).toBe('2500.00');
    expect(chain.netRate).toBe('15500.00');
    expect(chain.appliedTpcRate).toBeNull();
  });

  it('records the rate when the cut was a percentage', () => {
    const chain = computeRateChain({ grossRate: '18000.00', tpcRate: '0.1000' });

    expect(chain.appliedTpcRate).toBe('0.1000');
  });
});

describe('the gas deduction rate', () => {
  it('honours a per-shipment override', () => {
    const context = contextFor(rateRule(CrewRole.DRIVER, DRIVER_RATE), { gasRate: '0.3000' });

    expect(context.chain.gasDeductionAmount).toBe('4860.00');
    expect(context.chain.commissionableBase).toBe('11340.00');
    expect(runCommissionStrategy(context).amount).toBe('1701.00');
  });

  it('deducts nothing at a zero rate, leaving the base equal to gross', () => {
    const context = contextFor(rateRule(CrewRole.DRIVER, DRIVER_RATE), { gasRate: '0.0000' });

    expect(context.chain.gasDeductionAmount).toBe('0.00');
    expect(context.chain.commissionableBase).toBe('16200.00');
    expect(runCommissionStrategy(context).amount).toBe('2430.00');
  });

  it('takes the whole base at a rate of 1', () => {
    const context = contextFor(rateRule(CrewRole.DRIVER, DRIVER_RATE), { gasRate: '1.0000' });

    expect(context.chain.commissionableBase).toBe('0.00');
    expect(runCommissionStrategy(context).amount).toBe('0.00');
  });
});

describe('rounding to two decimal places', () => {
  it('rounds each stored step, so the chain reconciles on a calculator', () => {
    // 10,000.01 less 33.33% gas. 10000.01 x 0.3333 = 3333.003333 -> 3333.00
    const context = contextFor(rateRule(CrewRole.DRIVER, DRIVER_RATE), {
      grossRate: '10000.01',
      tpcRate: null,
      gasRate: '0.3333',
    });

    expect(context.chain.gasDeductionAmount).toBe('3333.00');
    expect(context.chain.commissionableBase).toBe('6667.01');
    // 6667.01 x 0.15 = 1000.0515 -> 1000.05
    expect(runCommissionStrategy(context).amount).toBe('1000.05');
  });

  it('rounds a half-centavo up', () => {
    // 70.10 x 0.15 = 10.515 -> 10.52
    const context = contextFor(rateRule(CrewRole.DRIVER, DRIVER_RATE), {
      grossRate: '70.10',
      tpcRate: null,
      gasRate: '0.0000',
    });

    expect(runCommissionStrategy(context).amount).toBe('10.52');
  });

  it('sums charges at 2dp', () => {
    const chain = computeCommissionChain({
      netRate: '0.00',
      billableExpenses: [charge('0.005', true), charge('0.005', true)],
      additionalCharges: [],
      gasDeductionRate: '0.0000',
    });

    // Each line rounds as it is read, so 0.01 + 0.01, not 0.01.
    expect(chain.commissionableCharges).toBe('0.02');
  });
});

describe('the other four strategies', () => {
  const base = { grossRate: '18000.00', tpcRate: '0.1000' };

  it('PERCENT_OF_NET_RATE skips the gas deduction entirely', () => {
    const rule: StrategyRule = {
      ...rateRule(CrewRole.DRIVER, '0.1000'),
      method: CommissionMethod.PERCENT_OF_NET_RATE,
    };
    const result = runCommissionStrategy(contextFor(rule, base));

    // 16,200 x 10% — not the 12,150 base.
    expect(result.amount).toBe('1620.00');
    expect(result.effectiveRate).toBe('0.1000');
  });

  it('FIXED_PER_TRIP pays the flat amount and reports a derived rate', () => {
    const rule: StrategyRule = {
      ...rateRule(CrewRole.DRIVER, DRIVER_RATE),
      method: CommissionMethod.FIXED_PER_TRIP,
      rate: null,
      fixedAmount: '1500.0000',
    };
    const result = runCommissionStrategy(contextFor(rule, base));

    expect(result.amount).toBe('1500.00');
    // 1500 / 12150 = 0.123456...
    expect(result.effectiveRate).toBe('0.1235');
  });

  it('FIXED_PER_ROUTE pays when the shipment is on the rule’s route', () => {
    const rule: StrategyRule = {
      ...rateRule(CrewRole.DRIVER, DRIVER_RATE),
      method: CommissionMethod.FIXED_PER_ROUTE,
      rate: null,
      fixedAmount: '2000.0000',
      routeId: 'route-manila-batangas',
    };
    const result = runCommissionStrategy(
      contextFor(rule, { ...base, shipmentRouteId: 'route-manila-batangas' }),
    );

    expect(result.amount).toBe('2000.00');
  });

  it('FIXED_PER_ROUTE refuses a rule that names no route', () => {
    const rule: StrategyRule = {
      ...rateRule(CrewRole.DRIVER, DRIVER_RATE),
      method: CommissionMethod.FIXED_PER_ROUTE,
      rate: null,
      fixedAmount: '2000.0000',
      routeId: null,
    };

    expect(() => runCommissionStrategy(contextFor(rule, base))).toThrow(/not scoped to a route/);
  });

  it('FORMULA reproduces the PERCENT_OF_BASE result exactly', () => {
    const formulaRule: StrategyRule = {
      ...rateRule(CrewRole.DRIVER, DRIVER_RATE),
      method: CommissionMethod.FORMULA,
      rate: null,
      params: { expression: 'commissionable_base * 0.15' },
    };

    const viaFormula = runCommissionStrategy(contextFor(formulaRule, base));
    const viaPercent = runCommissionStrategy(
      contextFor(rateRule(CrewRole.DRIVER, DRIVER_RATE), base),
    );

    expect(viaFormula.amount).toBe(viaPercent.amount);
    expect(viaFormula.amount).toBe('1822.50');
  });

  it('FORMULA freezes the expression and the values it read', () => {
    const rule: StrategyRule = {
      ...rateRule(CrewRole.DRIVER, DRIVER_RATE),
      method: CommissionMethod.FORMULA,
      rate: null,
      params: { expression: 'gross_rate * 0.05' },
    };
    const result = runCommissionStrategy(contextFor(rule, base));

    expect(result.amount).toBe('900.00');
    expect(result.formula).toEqual({
      expression: 'gross_rate * 0.05',
      resolvedFields: { gross_rate: '18000.00' },
    });
    // Derived against net_rate, per the brief: 900 / 16200.
    expect(result.effectiveRate).toBe('0.0556');
  });

  it('FORMULA surfaces a bad expression as a computation error, naming the rule', () => {
    const rule: StrategyRule = {
      ...rateRule(CrewRole.DRIVER, DRIVER_RATE),
      method: CommissionMethod.FORMULA,
      rate: null,
      params: { expression: 'net_rate / 0' },
    };

    expect(() => runCommissionStrategy(contextFor(rule, base))).toThrow(CommissionComputationError);
    expect(() => runCommissionStrategy(contextFor(rule, base))).toThrow(
      /Driver baseline.*divides by zero/,
    );
  });

  it('FORMULA refuses a rule with no expression', () => {
    const rule: StrategyRule = {
      ...rateRule(CrewRole.DRIVER, DRIVER_RATE),
      method: CommissionMethod.FORMULA,
      rate: null,
      params: null,
    };

    expect(() => runCommissionStrategy(contextFor(rule, base))).toThrow(/carries no expression/);
  });

  it('reports no rate rather than a fake one when the base is zero', () => {
    const rule: StrategyRule = {
      ...rateRule(CrewRole.DRIVER, DRIVER_RATE),
      method: CommissionMethod.FIXED_PER_TRIP,
      rate: null,
      fixedAmount: '500.0000',
    };
    const result = runCommissionStrategy(
      contextFor(rule, { grossRate: '0.00', tpcRate: null, gasRate: '0.0000' }),
    );

    // A flat fee on a zero-rated backhaul is real work and gets paid; the
    // reporting rate is simply undefined, and null says so.
    expect(result.amount).toBe('500.00');
    expect(result.effectiveRate).toBeNull();
  });
});

describe('rule resolution', () => {
  const day = (iso: string): Date => new Date(iso);

  function candidate(overrides: Partial<RuleCandidate> & Pick<RuleCandidate, 'id'>): RuleCandidate {
    return {
      name: overrides.id,
      role: CrewRole.DRIVER,
      clientId: null,
      routeId: null,
      priority: 0,
      effectiveFrom: day('2026-01-01T00:00:00Z'),
      effectiveTo: null,
      isActive: true,
      ...overrides,
    };
  }

  const scope = { clientId: 'client-a', routeId: 'route-a', on: day('2026-06-01T00:00:00Z') };

  it('ranks specificity: client+route, client, route, unscoped', () => {
    expect(ruleSpecificity({ clientId: 'c', routeId: 'r' })).toBe(3);
    expect(ruleSpecificity({ clientId: 'c', routeId: null })).toBe(2);
    expect(ruleSpecificity({ clientId: null, routeId: 'r' })).toBe(1);
    expect(ruleSpecificity({ clientId: null, routeId: null })).toBe(0);
  });

  it('prefers the most specific match over a higher priority', () => {
    const rules = [
      candidate({ id: 'unscoped-high-priority', priority: 100 }),
      candidate({ id: 'client-and-route', clientId: 'client-a', routeId: 'route-a' }),
    ];

    expect(resolveCommissionRule(rules, CrewRole.DRIVER, scope).id).toBe('client-and-route');
  });

  it('breaks a specificity tie on priority', () => {
    const rules = [
      candidate({ id: 'low', clientId: 'client-a', priority: 1 }),
      candidate({ id: 'high', clientId: 'client-a', priority: 5 }),
    ];

    expect(resolveCommissionRule(rules, CrewRole.DRIVER, scope).id).toBe('high');
  });

  it('breaks a priority tie on the latest effectiveFrom', () => {
    const rules = [
      candidate({ id: 'older', effectiveFrom: day('2026-01-01T00:00:00Z') }),
      candidate({ id: 'newer', effectiveFrom: day('2026-05-01T00:00:00Z') }),
    ];

    expect(resolveCommissionRule(rules, CrewRole.DRIVER, scope).id).toBe('newer');
  });

  it('breaks a total tie on id, so the answer is stable', () => {
    const rules = [candidate({ id: 'bbb' }), candidate({ id: 'aaa' })];

    expect(resolveCommissionRule(rules, CrewRole.DRIVER, scope).id).toBe('aaa');
  });

  it('ignores rules for the other role', () => {
    const rules = [candidate({ id: 'helper-rule', role: CrewRole.HELPER })];

    expect(() => resolveCommissionRule(rules, CrewRole.DRIVER, scope)).toThrow(
      CommissionComputationError,
    );
  });

  it('ignores deactivated rules', () => {
    const rules = [candidate({ id: 'off', isActive: false })];

    expect(findMatchingRules(rules, CrewRole.DRIVER, scope)).toHaveLength(0);
  });

  it('treats the effective window as half-open', () => {
    const endsToday = candidate({
      id: 'ends-today',
      effectiveTo: day('2026-06-01T00:00:00Z'),
    });
    const startsToday = candidate({
      id: 'starts-today',
      effectiveFrom: day('2026-06-01T00:00:00Z'),
    });

    // A rule ending at the instant the shipment dispatches does not apply...
    expect(findMatchingRules([endsToday], CrewRole.DRIVER, scope)).toHaveLength(0);
    // ...and the one starting at that instant does. No overlap, no ambiguity.
    expect(findMatchingRules([startsToday], CrewRole.DRIVER, scope)).toHaveLength(1);
  });

  it('does not match a rule scoped to another client', () => {
    const rules = [candidate({ id: 'other-client', clientId: 'client-z' })];

    expect(findMatchingRules(rules, CrewRole.DRIVER, scope)).toHaveLength(0);
  });

  it('does not match a route-scoped rule on a shipment with no route', () => {
    const rules = [candidate({ id: 'route-scoped', routeId: 'route-a' })];

    expect(findMatchingRules(rules, CrewRole.DRIVER, { ...scope, routeId: null })).toHaveLength(0);
  });

  it('raises rather than inventing a rate when nothing matches', () => {
    expect(() => resolveCommissionRule([], CrewRole.HELPER, scope)).toThrow(
      /No active commission rule covers the helper/,
    );
    // The message has to point at the fix, because there is no fallback to
    // quietly absorb this.
    expect(() => resolveCommissionRule([], CrewRole.HELPER, scope)).toThrow(
      /adding or re-activating a rule/,
    );
  });
});
