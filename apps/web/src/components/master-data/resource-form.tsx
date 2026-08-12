'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { FieldSpec, FormValues } from '@/lib/resource-spec';
import { cn } from '@/lib/utils';

/**
 * Renders a form from a field spec.
 *
 * Deliberately uncontrolled of validation: the API's Zod schemas are the rules,
 * and re-implementing them here would produce two definitions that disagree.
 * What this does instead is present whatever the API complained about next to
 * the field it complained about, using the `path` in the error payload.
 */
export function ResourceForm({
  fields,
  values,
  errors,
  disabled,
  onChange,
}: {
  fields: FieldSpec[];
  values: FormValues;
  errors: Record<string, string>;
  disabled?: boolean;
  onChange: (name: string, value: unknown) => void;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {fields.map((field) => (
        <Field
          key={field.name}
          field={field}
          value={values[field.name]}
          error={errors[field.name]}
          disabled={disabled}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

function Field({
  field,
  value,
  error,
  disabled,
  onChange,
}: {
  field: FieldSpec;
  value: unknown;
  error?: string;
  disabled?: boolean;
  onChange: (name: string, value: unknown) => void;
}) {
  const id = `field-${field.name}`;
  // Booleans and multi-selects are tall; letting them span keeps the grid from
  // developing ragged holes.
  const spansFullWidth = field.type === 'boolean' || field.type === 'multiselect';

  return (
    <div className={cn('space-y-2', spansFullWidth && 'sm:col-span-2')}>
      <Label htmlFor={id}>
        {field.label}
        {field.required ? <span className="text-destructive ml-0.5">*</span> : null}
      </Label>

      <FieldControl
        id={id}
        field={field}
        value={value}
        disabled={disabled}
        invalid={!!error}
        onChange={onChange}
      />

      {error ? (
        <p className="text-destructive text-xs">{error}</p>
      ) : field.help ? (
        <p className="text-muted-foreground text-xs">{field.help}</p>
      ) : null}
    </div>
  );
}

function FieldControl({
  id,
  field,
  value,
  disabled,
  invalid,
  onChange,
}: {
  id: string;
  field: FieldSpec;
  value: unknown;
  disabled?: boolean;
  invalid: boolean;
  onChange: (name: string, value: unknown) => void;
}) {
  const invalidClass = invalid ? 'border-destructive' : undefined;

  if (field.type === 'boolean') {
    return (
      <div className="flex items-center gap-2">
        <Switch
          id={id}
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(checked) => onChange(field.name, checked)}
        />
        <span className="text-muted-foreground text-sm">
          {value === true ? 'Active' : 'Inactive'}
        </span>
      </div>
    );
  }

  if (field.type === 'select') {
    return (
      <Select
        disabled={disabled}
        value={value === null || value === undefined ? '' : String(value)}
        onValueChange={(next) => onChange(field.name, next)}
      >
        <SelectTrigger id={id} className={cn('w-full', invalidClass)}>
          <SelectValue placeholder={field.placeholder ?? 'Select…'} />
        </SelectTrigger>
        <SelectContent>
          {field.options?.map((option) => (
            <SelectItem key={String(option.value)} value={String(option.value)}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (field.type === 'multiselect') {
    const selected = Array.isArray(value) ? value.map(String) : [];

    return (
      <div className="flex flex-wrap gap-2">
        {field.options?.map((option) => {
          const key = String(option.value);
          const isOn = selected.includes(key);

          return (
            <button
              key={key}
              type="button"
              disabled={disabled}
              aria-pressed={isOn}
              onClick={() =>
                onChange(
                  field.name,
                  isOn ? selected.filter((entry) => entry !== key) : [...selected, key],
                )
              }
              className={cn(
                'rounded-md border px-3 py-1.5 text-sm transition-colors',
                isOn
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background hover:bg-accent',
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <Input
      id={id}
      type={inputType(field.type)}
      // A null from the API becomes "" so React keeps the input controlled;
      // the form turns it back into null on submit.
      value={value === null || value === undefined ? '' : String(value)}
      placeholder={field.placeholder}
      disabled={disabled}
      // Catches an empty required field in the browser, before a round trip
      // that would come back with a type error rather than a useful sentence.
      required={field.required}
      className={invalidClass}
      // Rates and money are decimal strings all the way to the API — never
      // parsed into a JS number here, which would reintroduce float error at
      // the last possible moment.
      inputMode={
        field.type === 'money' || field.type === 'rate' || field.type === 'quantity'
          ? 'decimal'
          : undefined
      }
      onChange={(event) => onChange(field.name, event.target.value)}
    />
  );
}

function inputType(type: FieldSpec['type']): string {
  switch (type) {
    case 'email':
      return 'email';
    case 'password':
      return 'password';
    case 'date':
      return 'date';
    case 'integer':
      return 'number';
    default:
      return 'text';
  }
}
