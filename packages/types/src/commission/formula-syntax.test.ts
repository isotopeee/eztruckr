import { describe, expect, it } from 'vitest';
import {
  FORMULA_FIELDS,
  FormulaError,
  formulaFieldsUsed,
  parseFormula,
  validateFormulaExpression,
} from './formula-syntax';

/**
 * The parser is a security boundary, so most of this file is about what it
 * REFUSES. A formula arrives as user input, is stored, and is later evaluated
 * against real money; the guarantee being tested is that nothing outside the
 * declared grammar survives the parse.
 */

describe('parseFormula — accepts the grammar', () => {
  it('parses the default model', () => {
    expect(parseFormula('commissionable_base * 0.15')).toEqual({
      kind: 'binary',
      operator: '*',
      left: { kind: 'field', name: 'commissionable_base' },
      right: { kind: 'number', literal: '0.15' },
    });
  });

  it('gives multiplication higher precedence than addition', () => {
    const ast = parseFormula('net_rate + gross_rate * 2');

    expect(ast).toEqual({
      kind: 'binary',
      operator: '+',
      left: { kind: 'field', name: 'net_rate' },
      right: {
        kind: 'binary',
        operator: '*',
        left: { kind: 'field', name: 'gross_rate' },
        right: { kind: 'number', literal: '2' },
      },
    });
  });

  it('lets parentheses override precedence', () => {
    const ast = parseFormula('(net_rate + gross_rate) * 2');

    expect(ast).toMatchObject({ kind: 'binary', operator: '*' });
  });

  it('parses unary minus', () => {
    expect(parseFormula('-net_rate')).toEqual({
      kind: 'negate',
      operand: { kind: 'field', name: 'net_rate' },
    });
  });

  it('accepts every field in the catalog', () => {
    for (const field of FORMULA_FIELDS) {
      expect(() => parseFormula(field)).not.toThrow();
    }
  });

  it('is insensitive to whitespace', () => {
    expect(parseFormula('  commissionable_base*0.15  ')).toEqual(
      parseFormula('commissionable_base * 0.15'),
    );
  });

  it('reports the fields an expression uses, in catalog order, without duplicates', () => {
    const ast = parseFormula('net_rate + commissionable_base - net_rate');

    expect(formulaFieldsUsed(ast)).toEqual(['net_rate', 'commissionable_base']);
  });
});

describe('parseFormula — rejects everything else', () => {
  /**
   * The injection cases. None of these can execute even if they parsed,
   * because there is no evaluator that reaches the host — but they must not
   * parse, so that a rule containing one is refused at save time rather than
   * stored and puzzled over later.
   */
  it.each([
    ['statement separator', 'net_rate; process.exit(1)'],
    ['bare call', 'process.exit(1)'],
    ['property access', 'net_rate.constructor'],
    ['template literal', '`${net_rate}`'],
    ['backtick', 'net_rate + `x`'],
    ['function call on a field', 'net_rate(1)'],
    ['arrow function', '() => 1'],
    ['comma sequence', 'net_rate, gross_rate'],
    ['assignment', 'net_rate = 1'],
    ['comparison', 'net_rate > 1'],
    ['ternary', 'net_rate ? 1 : 2'],
    ['bitwise or', 'net_rate | 1'],
    ['logical and', 'net_rate && 1'],
    ['modulo', 'net_rate % 2'],
    ['exponent operator', 'net_rate ** 2'],
    ['string literal', "'net_rate'"],
    ['object literal', '{}'],
    ['array index', 'net_rate[0]'],
    ['global reference', 'globalThis'],
    ['require', 'require("fs")'],
    ['comment', 'net_rate // 2'],
    ['block comment', 'net_rate /* x */'],
  ])('rejects %s', (_label, expression) => {
    expect(() => parseFormula(expression)).toThrow(FormulaError);
  });

  it('rejects an unknown field by name, and lists the ones that exist', () => {
    expect(() => parseFormula('mystery_field * 2')).toThrow(/Unknown field "mystery_field"/);
    expect(() => parseFormula('mystery_field * 2')).toThrow(/gross_rate/);
  });

  it('rejects a mis-cased field as unknown rather than as a syntax error', () => {
    expect(() => parseFormula('NET_RATE')).toThrow(/Unknown field "NET_RATE"/);
  });

  it('rejects exponent notation instead of reading it as a field', () => {
    expect(() => parseFormula('1e9')).toThrow(/Exponent notation is not supported/);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['dangling operator', 'net_rate *'],
    ['leading binary operator', '* net_rate'],
    ['unclosed paren', '(net_rate + 1'],
    ['unopened paren', 'net_rate + 1)'],
    ['empty parens', '()'],
    ['double decimal point', '1.2.3'],
    ['lone dot', '.'],
    ['unary plus', '+net_rate'],
  ])('rejects %s', (_label, expression) => {
    expect(() => parseFormula(expression)).toThrow(FormulaError);
  });

  it('refuses an over-long expression', () => {
    expect(() => parseFormula('net_rate + '.repeat(60) + 'net_rate')).toThrow(/limit is 500/);
  });

  it('refuses to nest deeper than the limit, rather than overflowing the stack', () => {
    const deep = '('.repeat(64) + 'net_rate' + ')'.repeat(64);

    expect(() => parseFormula(deep)).toThrow(/nests deeper than 32/);
  });

  it('carries the offset of the offending token', () => {
    try {
      parseFormula('net_rate + nope');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FormulaError);
      expect((error as FormulaError).position).toBe(11);
    }
  });
});

describe('validateFormulaExpression', () => {
  it('returns the trimmed expression when it parses', () => {
    expect(validateFormulaExpression('  net_rate * 0.1 ')).toBe('net_rate * 0.1');
  });

  it('throws rather than returning anything for an invalid expression', () => {
    expect(() => validateFormulaExpression('net_rate; drop table')).toThrow(FormulaError);
  });
});
