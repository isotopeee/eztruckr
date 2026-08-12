import {
  FormulaError,
  formulaFieldsUsed,
  type FormulaField,
  type FormulaNode,
} from '@eztruckr/types';
import {
  rationalAdd,
  rationalDivide,
  rationalFromDecimalString,
  rationalIsNegative,
  rationalMultiply,
  rationalNegate,
  rationalSubtract,
  rationalToFixed,
  type Rational,
} from './rational';

/**
 * Evaluating a parsed formula against one shipment's figures.
 *
 * The parser lives in @eztruckr/types because checking an expression is
 * syntax, and the authoring screen benefits from doing it as the user types.
 * This half stays in the API: it is the part that touches money, and
 * financial computation does not leave the backend.
 */

/** Field values as plain decimal strings, exactly as Prisma renders DECIMAL. */
export type FormulaContext = Readonly<Record<FormulaField, string>>;

export interface FormulaResult {
  /** The commission amount, rounded once, to 2dp. */
  readonly amount: string;
  /**
   * The field values the expression actually read, as they stood at
   * computation. Frozen onto the commission so the figure can be reproduced
   * by hand years later, when the shipment itself may have moved on.
   */
  readonly resolvedFields: Readonly<Partial<Record<FormulaField, string>>>;
}

/**
 * Arithmetic is exact throughout (see rational.ts) and rounds exactly once,
 * at the end. Two conditions are errors rather than results:
 *
 *   - division by zero, which means the expression asked something the
 *     shipment cannot answer;
 *   - a negative total, because a commission is a payment. A negative one
 *     would assert the crew owes the company money through a mechanism that
 *     has no way to collect it. Crew debts are CrewDeduction rows, and they
 *     are settled at payout, not by inverting a commission.
 *
 * Both surface to the caller rather than being clamped to zero. A silent zero
 * is the worst outcome available here: it looks like a computed figure.
 */
export function evaluateFormula(node: FormulaNode, context: FormulaContext): FormulaResult {
  const walk = (current: FormulaNode): Rational => {
    switch (current.kind) {
      case 'number':
        return rationalFromDecimalString(current.literal);

      case 'field': {
        const raw = context[current.name];

        if (raw === undefined || raw === null) {
          throw new FormulaError(`Field "${current.name}" is not available on this shipment.`);
        }

        return rationalFromDecimalString(raw);
      }

      case 'negate':
        return rationalNegate(walk(current.operand));

      case 'binary': {
        const left = walk(current.left);
        const right = walk(current.right);

        switch (current.operator) {
          case '+':
            return rationalAdd(left, right);
          case '-':
            return rationalSubtract(left, right);
          case '*':
            return rationalMultiply(left, right);
          case '/':
            if (right.numerator === 0n) {
              throw new FormulaError('The formula divides by zero on this shipment.');
            }
            return rationalDivide(left, right);
        }
      }
    }
  };

  const value = walk(node);

  if (rationalIsNegative(value)) {
    throw new FormulaError(
      `The formula produces a negative commission (${rationalToFixed(value, 2)}) on this shipment.`,
    );
  }

  return {
    amount: rationalToFixed(value, 2),
    resolvedFields: Object.fromEntries(
      formulaFieldsUsed(node).map((field) => [field, context[field]]),
    ),
  };
}
