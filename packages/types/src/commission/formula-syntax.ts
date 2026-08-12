/**
 * The FORMULA commission method: a small expression language over a fixed
 * catalog of shipment fields.
 *
 * THIS IS A SECURITY BOUNDARY. The expression is written by a user, stored in
 * the database, and evaluated later against real money. It is therefore
 * parsed by hand into an AST and walked — never handed to `eval`, `Function`,
 * `vm`, or any third-party expression evaluator. The grammar below is the
 * entire language; anything outside it is rejected at save time with a
 * message naming the offending token.
 *
 *   expression := term (('+' | '-') term)*
 *   term       := factor (('*' | '/') factor)*
 *   factor     := '-' factor | primary
 *   primary    := NUMBER | FIELD | '(' expression ')'
 *
 * There are no function calls, no property access, no variables beyond the
 * catalog, no strings, no comparison or bitwise operators, and no way to
 * name anything the catalog does not already contain. A parser that accepts
 * only this cannot be talked into reaching the host, because there is no
 * production that reaches anything at all.
 *
 * SYNTAX ONLY. This module parses and validates; it never touches money or a
 * shipment. Evaluating an AST against real values is commission computation
 * and lives in the API (`apps/api/src/commission`), so that the rule "all
 * financial computation lives in the backend" holds structurally rather than
 * by convention — the web app can import this to check an expression as it is
 * typed, and there is nothing here for it to compute a peso figure with.
 */

/**
 * Every field an expression may name, resolved from the shipment at
 * computation time.
 *
 * READ THE DOUBLE-COUNTING NOTE. `commissionable_base` already has the gas
 * deduction taken out of it. An expression that subtracts
 * `gas_deduction_amount` from `commissionable_base` deducts fuel twice, and
 * nothing in the evaluator can tell that apart from a deliberate choice —
 * it is arithmetic either way. The same trap sits between
 * `commissionable_charges` and the two charge totals it is derived from.
 * Composing a correct expression is the rule author's responsibility; the
 * descriptions here exist so the trap is visible on the screen where they
 * write it.
 */
export const FORMULA_FIELD_CATALOG = {
  gross_rate: 'Freight charged to the client, before the broker cut.',
  tpc_amount: 'Third-party (broker) commission in pesos. Zero for direct clients.',
  net_rate: 'gross_rate minus tpc_amount.',
  billable_expenses: 'Total of costs fronted and recovered from the client, commissionable or not.',
  additional_charges:
    'Total of fees and surcharges with no underlying cost, commissionable or not.',
  commissionable_charges:
    'Only the billable expenses and additional charges flagged commissionable. A subset of the two totals above — do not add all three together.',
  gas_deduction_rate:
    'The gas deduction rate applied to this shipment, as a multiplier (0.25 = 25%).',
  gas_deduction_amount:
    'Pesos removed from the commission base for fuel. Already reflected in commissionable_base.',
  commissionable_base:
    'The default model’s base: (net_rate + commissionable_charges) less the gas deduction. The deduction is ALREADY APPLIED here — subtracting gas_deduction_amount from it deducts fuel twice.',
} as const satisfies Readonly<Record<string, string>>;

export type FormulaField = keyof typeof FORMULA_FIELD_CATALOG;

export const FORMULA_FIELDS = Object.keys(FORMULA_FIELD_CATALOG) as readonly FormulaField[];

export function isFormulaField(name: string): name is FormulaField {
  return Object.prototype.hasOwnProperty.call(FORMULA_FIELD_CATALOG, name);
}

export type FormulaOperator = '+' | '-' | '*' | '/';

export type FormulaNode =
  | { readonly kind: 'number'; readonly literal: string }
  | { readonly kind: 'field'; readonly name: FormulaField }
  | { readonly kind: 'negate'; readonly operand: FormulaNode }
  | {
      readonly kind: 'binary';
      readonly operator: FormulaOperator;
      readonly left: FormulaNode;
      readonly right: FormulaNode;
    };

/**
 * A rejected expression or a failed computation. Carries a character offset
 * where one is known, so the UI can point at the problem rather than saying
 * the whole expression is bad.
 */
export class FormulaError extends Error {
  constructor(
    message: string,
    readonly position?: number,
  ) {
    super(message);
    this.name = 'FormulaError';
  }
}

/**
 * Bounds, so a pathological expression cannot cost more than it is worth.
 * Both are far above any real formula: the default model is 24 characters.
 */
const MAX_EXPRESSION_LENGTH = 500;
const MAX_NESTING_DEPTH = 32;

type Token =
  | { kind: 'number'; text: string; position: number }
  | { kind: 'identifier'; text: string; position: number }
  | { kind: 'operator'; text: FormulaOperator; position: number }
  | { kind: 'paren'; text: '(' | ')'; position: number };

const OPERATORS = new Set<string>(['+', '-', '*', '/']);

function isDigit(character: string): boolean {
  return character >= '0' && character <= '9';
}

/** Identifier characters. Uppercase is accepted so that a mis-cased field
 * name fails as "unknown field", which is actionable, rather than as an
 * unexpected-character error, which is not. */
function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_]/.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_]/.test(character);
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  // charAt rather than [] throughout: it is typed `string` and yields '' past
  // the end, which matches none of the predicates below. Indexing would be
  // `string | undefined` and would litter the scanner with non-null
  // assertions, in the one file where sloppiness is least affordable.
  const at = (position: number): string => expression.charAt(position);

  while (index < expression.length) {
    const character = at(index);

    if (/\s/.test(character)) {
      index += 1;
      continue;
    }

    if (OPERATORS.has(character)) {
      tokens.push({ kind: 'operator', text: character as FormulaOperator, position: index });
      index += 1;
      continue;
    }

    if (character === '(' || character === ')') {
      tokens.push({ kind: 'paren', text: character, position: index });
      index += 1;
      continue;
    }

    if (isDigit(character) || character === '.') {
      const start = index;
      let seenDot = false;

      while (index < expression.length && (isDigit(at(index)) || at(index) === '.')) {
        if (at(index) === '.') {
          if (seenDot) {
            throw new FormulaError('Number has more than one decimal point.', index);
          }
          seenDot = true;
        }
        index += 1;
      }

      const text = expression.slice(start, index);

      if (text === '.') {
        throw new FormulaError('A lone "." is not a number.', start);
      }

      // Catches exponent notation ("1e9") and "2x" before they reach the
      // parser as a number followed by a mystery identifier.
      if (index < expression.length && isIdentifierPart(at(index))) {
        throw new FormulaError(
          `Unexpected "${at(index)}" directly after the number "${text}". Exponent notation is not supported.`,
          index,
        );
      }

      tokens.push({ kind: 'number', text, position: start });
      continue;
    }

    if (isIdentifierStart(character)) {
      const start = index;

      while (index < expression.length && isIdentifierPart(at(index))) {
        index += 1;
      }

      tokens.push({ kind: 'identifier', text: expression.slice(start, index), position: start });
      continue;
    }

    throw new FormulaError(`Unexpected character "${character}".`, index);
  }

  return tokens;
}

/**
 * Parses an expression into an AST, or throws.
 *
 * Call this whenever a FORMULA rule is created or edited. A rule that has not
 * parsed is never persisted, so computation never has to cope with a
 * malformed expression — by then the only failures possible are arithmetic
 * ones (divide-by-zero, a negative result).
 */
export function parseFormula(expression: string): FormulaNode {
  if (typeof expression !== 'string') {
    throw new FormulaError('A formula must be a string.');
  }

  const trimmed = expression.trim();

  if (trimmed.length === 0) {
    throw new FormulaError('A formula rule needs an expression.');
  }

  if (trimmed.length > MAX_EXPRESSION_LENGTH) {
    throw new FormulaError(
      `Expression is ${trimmed.length} characters; the limit is ${MAX_EXPRESSION_LENGTH}.`,
    );
  }

  const tokens = tokenize(trimmed);

  if (tokens.length === 0) {
    throw new FormulaError('A formula rule needs an expression.');
  }

  let cursor = 0;
  let depth = 0;

  const peek = (): Token | undefined => tokens[cursor];

  const parseExpression = (): FormulaNode => {
    let left = parseTerm();

    for (;;) {
      const token = peek();

      if (token?.kind !== 'operator' || (token.text !== '+' && token.text !== '-')) {
        return left;
      }

      cursor += 1;
      left = { kind: 'binary', operator: token.text, left, right: parseTerm() };
    }
  };

  const parseTerm = (): FormulaNode => {
    let left = parseFactor();

    for (;;) {
      const token = peek();

      if (token?.kind !== 'operator' || (token.text !== '*' && token.text !== '/')) {
        return left;
      }

      cursor += 1;
      left = { kind: 'binary', operator: token.text, left, right: parseFactor() };
    }
  };

  const parseFactor = (): FormulaNode => {
    const token = peek();

    if (token?.kind === 'operator' && token.text === '-') {
      cursor += 1;
      return { kind: 'negate', operand: parseFactor() };
    }

    // Unary plus is not in the grammar. Accepting it would mean silently
    // treating "+ 5" as meaningful in a language where it never is.
    return parsePrimary();
  };

  const parsePrimary = (): FormulaNode => {
    const token = peek();

    if (!token) {
      throw new FormulaError('Expression ends early — a value was expected here.', trimmed.length);
    }

    if (token.kind === 'number') {
      cursor += 1;
      return { kind: 'number', literal: token.text };
    }

    if (token.kind === 'identifier') {
      cursor += 1;

      if (!isFormulaField(token.text)) {
        throw new FormulaError(
          `Unknown field "${token.text}". Available fields: ${FORMULA_FIELDS.join(', ')}.`,
          token.position,
        );
      }

      return { kind: 'field', name: token.text };
    }

    if (token.kind === 'paren' && token.text === '(') {
      depth += 1;

      if (depth > MAX_NESTING_DEPTH) {
        throw new FormulaError(
          `Expression nests deeper than ${MAX_NESTING_DEPTH} parentheses.`,
          token.position,
        );
      }

      cursor += 1;
      const inner = parseExpression();
      const closing = peek();

      if (closing?.kind !== 'paren' || closing.text !== ')') {
        throw new FormulaError('Unclosed "(".', token.position);
      }

      cursor += 1;
      depth -= 1;
      return inner;
    }

    throw new FormulaError(`Unexpected "${token.text}".`, token.position);
  };

  const ast = parseExpression();
  const leftover = peek();

  if (leftover) {
    // Where a statement separator would have gone in a language that had
    // them. "net_rate; process.exit(1)" stops here.
    throw new FormulaError(
      `Unexpected "${leftover.text}" after the end of the expression.`,
      leftover.position,
    );
  }

  return ast;
}

/** Every catalog field the expression actually names, in catalog order. */
export function formulaFieldsUsed(node: FormulaNode): FormulaField[] {
  const found = new Set<FormulaField>();

  const walk = (current: FormulaNode): void => {
    switch (current.kind) {
      case 'field':
        found.add(current.name);
        return;
      case 'negate':
        walk(current.operand);
        return;
      case 'binary':
        walk(current.left);
        walk(current.right);
        return;
      default:
        return;
    }
  };

  walk(node);

  return FORMULA_FIELDS.filter((field) => found.has(field));
}

/**
 * Save-time validation. Returns the normalised expression to persist, or
 * throws a FormulaError naming what is wrong with it.
 */
export function validateFormulaExpression(expression: string): string {
  parseFormula(expression);
  return expression.trim();
}
