/**
 * Exact rational arithmetic on BigInt, used only by the formula evaluator.
 *
 * WHY THIS EXISTS, given the project rule that money arithmetic goes through
 * currency.js.
 *
 * currency.js is configured once at precision 2, which is correct for the
 * commission chain: every step of that chain is a stored value, so every step
 * rounds. A formula is different. `(gross_rate - tpc_amount) * 0.075` has no
 * stored intermediates at all — only its final result is stored — and the
 * brief is explicit that division "defines its own precision" with the result
 * rounded once at the end. Feeding those intermediates through a 2dp type
 * would quietly destroy them: the literal 0.075 alone becomes 0.08.
 *
 * So the AST is walked in exact arithmetic and rounded exactly once, at the
 * boundary, into money. A rational never approximates: + - and * are exact by
 * construction, and division is exact because it just becomes a denominator.
 * There is no float anywhere in this file, which is the whole point — an
 * evaluator that reintroduced IEEE-754 would undo the reason the schema uses
 * DECIMAL in the first place.
 *
 * Fractions are kept in lowest terms after every operation. Without that,
 * denominators compound multiplicatively and a long expression ends up doing
 * arithmetic on numbers thousands of digits wide.
 */

export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;

  while (y !== 0n) {
    [x, y] = [y, x % y];
  }

  return x;
}

/** Normalises the sign onto the numerator and reduces to lowest terms. */
function make(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) {
    throw new RangeError('rational with zero denominator');
  }

  const sign = denominator < 0n ? -1n : 1n;
  const n = numerator * sign;
  const d = denominator * sign;
  const divisor = gcd(n, d);

  // gcd(0, d) is d, so zero reduces to 0/1 rather than tripping on a zero
  // divisor here.
  return divisor === 0n
    ? { numerator: 0n, denominator: 1n }
    : { numerator: n / divisor, denominator: d / divisor };
}

export const RATIONAL_ZERO: Rational = { numerator: 0n, denominator: 1n };

/**
 * Parses a plain decimal string ("16200.0000", "-0.075", ".5") exactly.
 *
 * Deliberately refuses exponent notation. Every value reaching this function
 * is either a Postgres DECIMAL rendered by Prisma or a literal the author
 * typed into a rule, and neither has any business being in scientific form.
 */
export function rationalFromDecimalString(value: string): Rational {
  const text = value.trim();
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text);

  if (!match || (match[2] === '' && (match[3] ?? '') === '')) {
    throw new RangeError(`not a plain decimal number: ${value}`);
  }

  const [, sign, whole, fraction = ''] = match;
  const digits = `${whole === '' ? '0' : whole}${fraction}`;
  const numerator = BigInt(digits) * (sign === '-' ? -1n : 1n);

  return make(numerator, 10n ** BigInt(fraction.length));
}

export function rationalAdd(a: Rational, b: Rational): Rational {
  return make(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}

export function rationalSubtract(a: Rational, b: Rational): Rational {
  return make(
    a.numerator * b.denominator - b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}

export function rationalMultiply(a: Rational, b: Rational): Rational {
  return make(a.numerator * b.numerator, a.denominator * b.denominator);
}

/** Throws on a zero divisor; the caller turns that into a computation error. */
export function rationalDivide(a: Rational, b: Rational): Rational {
  if (b.numerator === 0n) {
    throw new RangeError('division by zero');
  }

  return make(a.numerator * b.denominator, a.denominator * b.numerator);
}

export function rationalNegate(a: Rational): Rational {
  return { numerator: -a.numerator, denominator: a.denominator };
}

export function rationalIsNegative(a: Rational): boolean {
  return a.numerator < 0n;
}

/**
 * Renders the value at `scale` decimal places, rounding halves toward positive
 * infinity.
 *
 * That tie rule is not a preference — it is what `currency.js` does, because
 * currency.js rounds with `Math.round`. The two have to agree exactly, or the
 * FORMULA method and the PERCENT_OF_BASE method would disagree on the same
 * figure: 995.625 has to become 995.63 down both paths.
 */
export function rationalToFixed(value: Rational, scale: number): string {
  const factor = 10n ** BigInt(scale);
  const scaled = value.numerator * factor;
  const d = value.denominator;

  // floor(scaled/d + 1/2), computed in integers. BigInt division truncates
  // toward zero, so the negative branch is adjusted to floor separately.
  const doubled = 2n * scaled + d;
  const twiceD = 2n * d;
  let rounded = doubled / twiceD;

  if (doubled % twiceD !== 0n && doubled < 0n) {
    rounded -= 1n;
  }

  const negative = rounded < 0n;
  const digits = (negative ? -rounded : rounded).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale === 0 ? '' : `.${digits.slice(digits.length - scale)}`;

  return `${negative ? '-' : ''}${whole}${fraction}`;
}
