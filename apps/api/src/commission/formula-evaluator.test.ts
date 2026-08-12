import { FormulaError, parseFormula, type FormulaField } from '@eztruckr/types';
import { describe, expect, it } from 'vitest';
import { evaluateFormula, type FormulaContext } from './formula-evaluator';
import { rationalFromDecimalString, rationalToFixed } from './rational';

/**
 * The worked example from the brief, as Prisma would hand the values over:
 * plain decimal strings at the column's scale.
 */
const WORKED_EXAMPLE: FormulaContext = {
  gross_rate: '18000.0000',
  tpc_amount: '1800.0000',
  net_rate: '16200.0000',
  billable_expenses: '0.0000',
  additional_charges: '1500.0000',
  commissionable_charges: '0.0000',
  gas_deduction_rate: '0.2500',
  gas_deduction_amount: '4050.0000',
  commissionable_base: '12150.0000',
};

function evaluate(expression: string, context: FormulaContext = WORKED_EXAMPLE) {
  return evaluateFormula(parseFormula(expression), context);
}

describe('evaluateFormula', () => {
  it('reproduces the PERCENT_OF_BASE driver result exactly', () => {
    // The canonical equivalence: a FORMULA rule spelling out the default model
    // must agree with the built-in strategy to the centavo.
    expect(evaluate('commissionable_base * 0.15').amount).toBe('1822.50');
  });

  it('reproduces the PERCENT_OF_BASE helper result exactly', () => {
    expect(evaluate('commissionable_base * 0.075').amount).toBe('911.25');
  });

  it('computes a gross-rate formula', () => {
    expect(evaluate('gross_rate * 0.10').amount).toBe('1800.00');
  });

  it('rounds the final result half-up, matching currency.js', () => {
    // 13275 x 0.075 = 995.625 -> 995.63, never 995.62. Same figure the
    // PERCENT_OF_BASE strategy produces for a commissionable charge.
    const withCharge: FormulaContext = { ...WORKED_EXAMPLE, commissionable_base: '13275.0000' };

    expect(evaluate('commissionable_base * 0.075', withCharge).amount).toBe('995.63');
  });

  it('keeps intermediates exact and rounds only once', () => {
    // Rounding each step to 2dp would give 5400.00 x 0.075 = 405.00.
    // Exact throughout: 16200/3 x 0.075 = 405.00 as well, but the thirds in
    // between are 5400 exactly — so use a divisor that does not divide
    // cleanly. 16200/7 = 2314.2857142857... x 0.075 = 173.5714285... -> 173.57
    expect(evaluate('net_rate / 7 * 0.075').amount).toBe('173.57');
  });

  it('does not let a 2dp intermediate destroy a small multiplier', () => {
    // The reason this evaluator does not run on currency.js at precision 2:
    // 0.075 would round to 0.08 the moment it became money, and this would
    // come out as 1296.00 instead of 1215.00.
    expect(evaluate('net_rate * 0.075').amount).toBe('1215.00');
  });

  it('applies operator precedence to the arithmetic, not just the parse', () => {
    // net_rate + (gross_rate x 0) = 16200
    expect(evaluate('net_rate + gross_rate * 0').amount).toBe('16200.00');
    expect(evaluate('(net_rate + gross_rate) * 0').amount).toBe('0.00');
  });

  it('handles a compound expression over several fields', () => {
    // (16200 + 1500 - 0) x 0.15 = 2655.00
    expect(evaluate('(net_rate + additional_charges - billable_expenses) * 0.15').amount).toBe(
      '2655.00',
    );
  });

  it('records the resolved values of the fields it read, and no others', () => {
    const result = evaluate('commissionable_base * 0.15 + net_rate * 0');

    expect(result.resolvedFields).toEqual({
      net_rate: '16200.0000',
      commissionable_base: '12150.0000',
    });
  });

  it('surfaces division by zero rather than swallowing it', () => {
    const noCharges: FormulaContext = { ...WORKED_EXAMPLE, commissionable_charges: '0.0000' };

    expect(() => evaluate('net_rate / commissionable_charges', noCharges)).toThrow(
      /divides by zero/,
    );
    expect(() => evaluate('net_rate / commissionable_charges', noCharges)).toThrow(FormulaError);
  });

  it('surfaces division by a zero literal', () => {
    expect(() => evaluate('net_rate / 0')).toThrow(/divides by zero/);
  });

  it('refuses a negative commission rather than clamping it to zero', () => {
    expect(() => evaluate('net_rate - gross_rate')).toThrow(/negative commission \(-1800.00\)/);
  });

  it('allows a negative intermediate as long as the total is not negative', () => {
    // (16200 - 18000) x -1 = 1800
    expect(evaluate('(net_rate - gross_rate) * -1').amount).toBe('1800.00');
  });

  it('permits a zero commission', () => {
    expect(evaluate('net_rate * 0').amount).toBe('0.00');
  });
});

describe('rational arithmetic', () => {
  it('parses decimal strings exactly', () => {
    expect(rationalFromDecimalString('0.075')).toEqual({ numerator: 3n, denominator: 40n });
    expect(rationalFromDecimalString('16200.0000')).toEqual({ numerator: 16200n, denominator: 1n });
    expect(rationalFromDecimalString('-0.5')).toEqual({ numerator: -1n, denominator: 2n });
  });

  it('rounds halves toward positive infinity, as Math.round does', () => {
    // currency.js rounds with Math.round; these must agree or FORMULA and
    // PERCENT_OF_BASE would disagree on the same figure.
    expect(rationalToFixed(rationalFromDecimalString('995.625'), 2)).toBe('995.63');
    expect(rationalToFixed(rationalFromDecimalString('995.615'), 2)).toBe('995.62');
    expect(rationalToFixed(rationalFromDecimalString('0.005'), 2)).toBe('0.01');
    // Toward +infinity, so -0.005 lands on negative zero, which renders
    // unsigned — the same string currency.js gives, since Math.round(-0.5) is
    // -0 and (-0).toFixed(2) is "0.00".
    expect(rationalToFixed(rationalFromDecimalString('-0.005'), 2)).toBe('0.00');
    expect(rationalToFixed(rationalFromDecimalString('-0.015'), 2)).toBe('-0.01');
  });

  it('pads correctly below one peso', () => {
    expect(rationalToFixed(rationalFromDecimalString('0.1'), 2)).toBe('0.10');
    expect(rationalToFixed(rationalFromDecimalString('0'), 2)).toBe('0.00');
  });

  it('refuses input that is not a plain decimal', () => {
    expect(() => rationalFromDecimalString('1e9')).toThrow(/not a plain decimal/);
    expect(() => rationalFromDecimalString('abc')).toThrow(/not a plain decimal/);
    expect(() => rationalFromDecimalString('')).toThrow(/not a plain decimal/);
  });

  it('stays exact across a long chain that floats would drift on', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754.
    const context = { ...WORKED_EXAMPLE, net_rate: '0.1000' } as Record<FormulaField, string>;

    expect(evaluateFormula(parseFormula('net_rate + 0.2'), context).amount).toBe('0.30');
  });
});
