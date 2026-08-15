import type { ReactNode } from 'react';
import type { UserRole } from '@eztruckr/types';

/**
 * A declarative description of a master data screen.
 *
 * Seven of these screens are the same screen: a searchable table, a create and
 * edit form, and a Delete that may turn out to mean Deactivate. Writing them
 * seven times would guarantee they drift — one forgets the inactive filter,
 * another reports a deactivation as a deletion. So the behaviour lives once in
 * `ResourcePage` and each screen supplies only what genuinely differs: its
 * columns, its fields, and who may write to it.
 */

export type FieldType =
  | 'text'
  | 'email'
  | 'integer'
  | 'rate'
  | 'money'
  | 'quantity'
  | 'date'
  | 'boolean'
  | 'select'
  | 'multiselect'
  | 'password';

export interface FieldOption {
  value: string | number;
  label: string;
}

export interface FieldSpec {
  name: string;
  label: string;
  type: FieldType;
  /** Marks the label and skips the "leave blank to clear" affordance. */
  required?: boolean;
  options?: FieldOption[];
  placeholder?: string;
  /** Shown under the input. Use for units and for rules the API enforces. */
  help?: string;
  /** Hidden when editing — e.g. the initial password on a new login. */
  createOnly?: boolean;
}

export interface ColumnSpec<TRow> {
  key: string;
  label: string;
  render: (row: TRow) => ReactNode;
  /** Right-aligns numeric columns. */
  numeric?: boolean;
}

export interface ResourceSpec<TRow> {
  /** URL segment and TanStack Query key. */
  key: string;
  /** Path under the API, e.g. `/trucks`. */
  apiPath: string;
  title: string;
  /** Used in dialog titles: "New truck", "Edit truck". */
  singular: string;
  description: string;
  columns: ColumnSpec<TRow>[];
  fields: FieldSpec[];
  /**
   * Roles permitted to OPEN the screen at all, from `PAGE_ROLES` in `nav.ts`.
   *
   * Separate from `writeRoles` and not implied by it, because the API's read
   * guard is wider than either: master data has to be readable to be
   * selectable, so a dispatcher who types /trucks would otherwise get the whole
   * fleet screen with the buttons greyed out. This is what makes the missing
   * navigation link mean something.
   */
  pageRoles: readonly UserRole[];
  /** Roles permitted to create, edit and remove. Reads are broader. */
  writeRoles: readonly UserRole[];
  /** Turns a row into form state for the edit dialog. */
  toFormValues: (row: TRow) => Record<string, unknown>;
  /** Extra sentence in the remove dialog, where the rule is unusual. */
  removalNote?: string;
}

export type FormValues = Record<string, unknown>;
