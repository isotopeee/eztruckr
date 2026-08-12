import { describe, expect, it } from 'vitest';
import { formatMoney, formatRate, money, multiplyByRate, sum, toDecimalString } from './money';

/**
 * These tests pin down the money boundary itself. The commission chain that
 * consumes it arrives in Phase 2; what matters here is that the primitives
 * behave exactly as the engineering rules assume.
 */
describe('money boundary', () => {
  it('serialises to a plain fixed-2 string suitable for a Decimal column', () => {
    // Must be "1822.50" — no thousands separator, no symbol, always 2dp.
    expect(toDecimalString(money('1822.5'))).toBe('1822.50');
    expect(toDecimalString(money('18000'))).toBe('18000.00');
    expect(toDecimalString(money('0'))).toBe('0.00');
  });

  it('accepts the string form of a Prisma Decimal', () => {
    // Prisma hands back Decimal; `.toString()` gives the 4dp column form.
    const fromPrisma = { toString: () => '16200.0000' };
    expect(toDecimalString(money(fromPrisma))).toBe('16200.00');
  });

  it('rounds half-up at 2dp when multiplying by a rate', () => {
    // 13,275.00 x 7.5% = 995.625 -> 995.63, per the brief's worked example.
    expect(toDecimalString(multiplyByRate('13275.00', '0.075'))).toBe('995.63');
  });

  it('reproduces the worked example rate chain exactly', () => {
    const grossRate = money('18000.00');
    const tpc = multiplyByRate(grossRate, '0.10');
    expect(toDecimalString(tpc)).toBe('1800.00');

    const netRate = grossRate.subtract(tpc);
    expect(toDecimalString(netRate)).toBe('16200.00');

    const gasDeduction = multiplyByRate(netRate, '0.25');
    expect(toDecimalString(gasDeduction)).toBe('4050.00');

    const commissionableBase = netRate.subtract(gasDeduction);
    expect(toDecimalString(commissionableBase)).toBe('12150.00');

    expect(toDecimalString(multiplyByRate(commissionableBase, '0.15'))).toBe('1822.50');
    expect(toDecimalString(multiplyByRate(commissionableBase, '0.075'))).toBe('911.25');
  });

  it('stays exact where naive float arithmetic would not', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754; it must here.
    expect(toDecimalString(money('0.1').add(money('0.2')))).toBe('0.30');
    expect(toDecimalString(sum(['1000.10', '2000.20', '3000.30']))).toBe('6000.60');
  });

  it('formats for display without affecting stored values', () => {
    expect(formatMoney('1822.5')).toBe('₱1,822.50');
    expect(formatRate('0.075')).toBe('7.5%');
    expect(formatRate('0.25')).toBe('25%');
  });
});
