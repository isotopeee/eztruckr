import {
  COMMISSION_METHOD_LABELS,
  CREW_ROLE_CODES,
  CREW_ROLE_LABELS,
  IMPLEMENTED_COMMISSION_METHODS,
  STAFF_ROLE_CODES,
  STAFF_ROLE_LABELS,
  UserRole,
  type Client,
  type CommissionRule,
  type ExpenseCategory,
  type Route,
  type Staff,
  type ThirdParty,
  type Truck,
} from '@eztruckr/types';
import type { ResourceSpec } from '@/lib/resource-spec';
import { formatDate } from '@/lib/format';

/**
 * The seven master data screens, as data.
 *
 * Every label for an enumerated value is imported from `@eztruckr/types`, not
 * written here — the code sets own their labels, and a second copy in the UI
 * would be the first thing to fall out of step with the database.
 */

const WRITE_OPERATIONAL = [UserRole.ADMINISTRATOR, UserRole.OPERATIONS] as const;
const WRITE_FINANCIAL = [UserRole.ADMINISTRATOR, UserRole.ACCOUNTING] as const;

/** Renders a nullable cell without printing "null" at anyone. */
const text = (value: string | null | undefined) => value ?? '—';

/** ISO instant to a `<input type="date">` value, or "" for null. */
const dateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : '');

export const truckResource: ResourceSpec<Truck> = {
  key: 'trucks',
  apiPath: '/trucks',
  title: 'Trucks',
  singular: 'Truck',
  description: 'The fleet. Deactivate a truck that has been sold rather than removing it.',
  writeRoles: WRITE_OPERATIONAL,
  columns: [
    {
      key: 'plateNumber',
      label: 'Plate',
      render: (row) => <span className="font-medium">{row.plateNumber}</span>,
    },
    {
      key: 'make',
      label: 'Make / model',
      render: (row) => text([row.make, row.model].filter(Boolean).join(' ') || null),
    },
    { key: 'bodyType', label: 'Body', render: (row) => text(row.bodyType) },
    {
      key: 'capacityKg',
      label: 'Capacity (kg)',
      numeric: true,
      render: (row) => text(row.capacityKg),
    },
    {
      key: 'registrationExpiry',
      label: 'Registration expires',
      render: (row) => (row.registrationExpiry ? formatDate(row.registrationExpiry) : '—'),
    },
  ],
  fields: [
    {
      name: 'plateNumber',
      label: 'Plate number',
      type: 'text',
      required: true,
      help: 'Stored uppercase. Must be unique among live trucks.',
    },
    { name: 'make', label: 'Make', type: 'text' },
    { name: 'model', label: 'Model', type: 'text' },
    { name: 'modelYear', label: 'Model year', type: 'integer' },
    { name: 'bodyType', label: 'Body type', type: 'text', placeholder: '10-wheeler wing van' },
    {
      name: 'capacityKg',
      label: 'Payload capacity',
      type: 'quantity',
      help: 'Kilograms, e.g. 12000.00',
    },
    { name: 'registrationExpiry', label: 'Registration expiry', type: 'date' },
    { name: 'isActive', label: 'Offered for new shipments', type: 'boolean' },
  ],
  toFormValues: (row) => ({
    plateNumber: row.plateNumber,
    make: row.make,
    model: row.model,
    modelYear: row.modelYear,
    bodyType: row.bodyType,
    capacityKg: row.capacityKg,
    registrationExpiry: dateInput(row.registrationExpiry),
    isActive: row.isActive,
  }),
};

export const staffResource: ResourceSpec<Staff> = {
  key: 'staff',
  apiPath: '/staff',
  title: 'Staff',
  singular: 'Staff member',
  description:
    'Everyone who works here. Eligibility says what someone may be engaged as; the role filled on a trip comes from the trip. A dispatch manager holds a trip’s cash without driving it.',
  writeRoles: WRITE_OPERATIONAL,
  columns: [
    {
      key: 'staffCode',
      label: 'Code',
      render: (row) => <span className="font-medium">{row.staffCode}</span>,
    },
    { key: 'name', label: 'Name', render: (row) => `${row.lastName}, ${row.firstName}` },
    {
      key: 'eligibleRoles',
      label: 'Eligible as',
      render: (row) => row.eligibleRoles.map((role) => STAFF_ROLE_LABELS[role]).join(', ') || '—',
    },
    { key: 'phone', label: 'Phone', render: (row) => text(row.phone) },
    { key: 'licenseNumber', label: 'Licence', render: (row) => text(row.licenseNumber) },
  ],
  fields: [
    { name: 'staffCode', label: 'Staff code', type: 'text', required: true },
    { name: 'firstName', label: 'First name', type: 'text', required: true },
    { name: 'lastName', label: 'Last name', type: 'text', required: true },
    {
      name: 'eligibleRoles',
      label: 'Eligible roles',
      type: 'multiselect',
      required: true,
      // Listed from the code set rather than by hand, so a role appended to
      // StaffRole cannot be declared and then quietly unofferable here.
      options: STAFF_ROLE_CODES.map((role) => ({
        value: role,
        label: STAFF_ROLE_LABELS[role],
      })),
      help: 'Anyone eligible to drive needs a licence number on file. A dispatch manager may hold a trip’s cash without being assigned to it, and earns no commission.',
    },
    { name: 'phone', label: 'Phone', type: 'text' },
    { name: 'address', label: 'Address', type: 'text' },
    { name: 'dateHired', label: 'Date hired', type: 'date' },
    { name: 'licenseNumber', label: 'Licence number', type: 'text' },
    { name: 'licenseExpiry', label: 'Licence expiry', type: 'date' },
    { name: 'isActive', label: 'Offered for new assignments', type: 'boolean' },
  ],
  toFormValues: (row) => ({
    staffCode: row.staffCode,
    firstName: row.firstName,
    lastName: row.lastName,
    eligibleRoles: row.eligibleRoles.map(String),
    phone: row.phone,
    address: row.address,
    dateHired: dateInput(row.dateHired),
    licenseNumber: row.licenseNumber,
    licenseExpiry: dateInput(row.licenseExpiry),
    isActive: row.isActive,
  }),
};

export const clientResource: ResourceSpec<Client> = {
  key: 'clients',
  apiPath: '/clients',
  title: 'Clients',
  singular: 'Client',
  description: 'Companies whose freight is hauled.',
  writeRoles: WRITE_OPERATIONAL,
  columns: [
    {
      key: 'code',
      label: 'Code',
      render: (row) => <span className="font-medium">{row.code}</span>,
    },
    { key: 'name', label: 'Name', render: (row) => row.name },
    { key: 'contactName', label: 'Contact', render: (row) => text(row.contactName) },
    { key: 'phone', label: 'Phone', render: (row) => text(row.phone) },
    { key: 'tin', label: 'TIN', render: (row) => text(row.tin) },
  ],
  fields: [
    { name: 'code', label: 'Code', type: 'text', required: true, placeholder: 'CLT-SMT' },
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'contactName', label: 'Contact person', type: 'text' },
    { name: 'phone', label: 'Phone', type: 'text' },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'address', label: 'Address', type: 'text' },
    {
      name: 'tin',
      label: 'TIN',
      type: 'text',
      help: 'Taxpayer identification number, as printed on invoices.',
    },
    { name: 'isActive', label: 'Offered for new shipments', type: 'boolean' },
  ],
  toFormValues: (row) => ({
    code: row.code,
    name: row.name,
    contactName: row.contactName,
    phone: row.phone,
    email: row.email,
    address: row.address,
    tin: row.tin,
    isActive: row.isActive,
  }),
};

export const thirdPartyResource: ResourceSpec<ThirdParty> = {
  key: 'third-parties',
  apiPath: '/third-parties',
  title: 'Third parties',
  singular: 'Third party',
  description: 'Brokers and agents who bring freight and take a cut of the gross rate.',
  writeRoles: WRITE_OPERATIONAL,
  columns: [
    {
      key: 'code',
      label: 'Code',
      render: (row) => <span className="font-medium">{row.code}</span>,
    },
    { key: 'name', label: 'Name', render: (row) => row.name },
    { key: 'contactName', label: 'Contact', render: (row) => text(row.contactName) },
    {
      key: 'defaultCommissionRate',
      label: 'Default cut',
      numeric: true,
      render: (row) =>
        row.defaultCommissionRate
          ? `${(Number(row.defaultCommissionRate) * 100).toFixed(2)}%`
          : '—',
    },
  ],
  fields: [
    { name: 'code', label: 'Code', type: 'text', required: true, placeholder: 'TPB-001' },
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'contactName', label: 'Contact person', type: 'text' },
    { name: 'phone', label: 'Phone', type: 'text' },
    { name: 'email', label: 'Email', type: 'email' },
    {
      name: 'defaultCommissionRate',
      label: 'Default commission rate',
      type: 'rate',
      placeholder: '0.1000',
      help: 'A multiplier between 0 and 1 — 0.1000 is 10%. Only a default; each shipment freezes its own.',
    },
    { name: 'isActive', label: 'Offered for new shipments', type: 'boolean' },
  ],
  toFormValues: (row) => ({
    code: row.code,
    name: row.name,
    contactName: row.contactName,
    phone: row.phone,
    email: row.email,
    defaultCommissionRate: row.defaultCommissionRate,
    isActive: row.isActive,
  }),
};

export const routeResource: ResourceSpec<Route> = {
  key: 'routes',
  apiPath: '/routes',
  title: 'Routes',
  singular: 'Route',
  description: 'Regular lanes, with an indicative rate used to prefill a shipment.',
  writeRoles: WRITE_OPERATIONAL,
  columns: [
    {
      key: 'code',
      label: 'Code',
      render: (row) => <span className="font-medium">{row.code}</span>,
    },
    { key: 'name', label: 'Name', render: (row) => row.name },
    { key: 'lane', label: 'Lane', render: (row) => `${row.origin} → ${row.destination}` },
    {
      key: 'distanceKm',
      label: 'Distance (km)',
      numeric: true,
      render: (row) => text(row.distanceKm),
    },
    {
      key: 'standardRate',
      label: 'Standard rate',
      numeric: true,
      render: (row) => text(row.standardRate),
    },
    {
      key: 'standardAllowance',
      label: 'Standard allowance',
      numeric: true,
      render: (row) => text(row.standardAllowance),
    },
  ],
  fields: [
    { name: 'code', label: 'Code', type: 'text', required: true, placeholder: 'RTE-MNL-BTG' },
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'origin', label: 'Origin', type: 'text', required: true },
    { name: 'destination', label: 'Destination', type: 'text', required: true },
    { name: 'distanceKm', label: 'Distance', type: 'quantity', help: 'Kilometres.' },
    {
      name: 'standardRate',
      label: 'Standard rate',
      type: 'money',
      help: 'Pesos. Indicative only — the shipment freezes what was actually agreed.',
    },
    {
      name: 'standardAllowance',
      label: 'Standard allowance',
      type: 'money',
      help: "Pesos. Prefills the trip's first allowance and stays editable there; variance is measured against what was actually released.",
    },
    { name: 'isActive', label: 'Offered for new shipments', type: 'boolean' },
  ],
  toFormValues: (row) => ({
    code: row.code,
    name: row.name,
    origin: row.origin,
    destination: row.destination,
    distanceKm: row.distanceKm,
    standardRate: row.standardRate,
    standardAllowance: row.standardAllowance,
    isActive: row.isActive,
  }),
};

export const expenseCategoryResource: ResourceSpec<ExpenseCategory> = {
  key: 'expense-categories',
  apiPath: '/expense-categories',
  title: 'Expense categories',
  singular: 'Expense category',
  description: 'How spend is classified on liquidations and billable expenses.',
  writeRoles: WRITE_FINANCIAL,
  removalNote:
    'A category nothing has been filed under is deleted outright. Once a liquidation line or billable expense uses it, it is deactivated instead so those records keep reading correctly.',
  columns: [
    {
      key: 'code',
      label: 'Code',
      render: (row) => <span className="font-medium">{row.code}</span>,
    },
    { key: 'name', label: 'Name', render: (row) => row.name },
    {
      key: 'requiresReceipt',
      label: 'Receipt required',
      render: (row) => (row.requiresReceipt ? 'Yes' : 'No'),
    },
    {
      key: 'defaultCommissionable',
      label: 'Commissionable by default',
      render: (row) => (row.defaultCommissionable ? 'Yes' : 'No'),
    },
    { key: 'sortOrder', label: 'Order', numeric: true, render: (row) => row.sortOrder },
  ],
  fields: [
    { name: 'code', label: 'Code', type: 'text', required: true, placeholder: 'FUEL' },
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'requiresReceipt', label: 'Requires a receipt', type: 'boolean' },
    {
      name: 'defaultCommissionable',
      label: 'Commissionable by default',
      type: 'boolean',
      help: 'The per-expense flag still wins over this.',
    },
    {
      name: 'sortOrder',
      label: 'Sort order',
      type: 'integer',
      help: 'Lower appears first on expense forms. Leave it blank for 10 — the standard categories are spaced 10 apart, so there is room to slot one between two others.',
    },
    { name: 'isActive', label: 'Offered on new liquidations', type: 'boolean' },
  ],
  toFormValues: (row) => ({
    code: row.code,
    name: row.name,
    requiresReceipt: row.requiresReceipt,
    defaultCommissionable: row.defaultCommissionable,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
  }),
};

export const commissionRuleResource: ResourceSpec<CommissionRule> = {
  key: 'commission-rules',
  apiPath: '/commission-rules',
  title: 'Commission rules',
  singular: 'Commission rule',
  description:
    'What crew are paid. A narrower scope wins; ties break on priority, highest first. Commissions freeze the rate they used, so editing a rule never moves money already computed.',
  writeRoles: WRITE_FINANCIAL,
  columns: [
    {
      key: 'name',
      label: 'Name',
      render: (row) => <span className="font-medium">{row.name}</span>,
    },
    { key: 'role', label: 'Role', render: (row) => CREW_ROLE_LABELS[row.role] },
    { key: 'method', label: 'Method', render: (row) => COMMISSION_METHOD_LABELS[row.method] },
    {
      key: 'amount',
      label: 'Amount',
      numeric: true,
      render: (row) =>
        row.rate !== null ? `${(Number(row.rate) * 100).toFixed(2)}%` : text(row.fixedAmount),
    },
    { key: 'priority', label: 'Priority', numeric: true, render: (row) => row.priority },
    {
      key: 'effectiveFrom',
      label: 'Effective from',
      render: (row) => formatDate(row.effectiveFrom),
    },
  ],
  fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    {
      name: 'role',
      label: 'Role',
      type: 'select',
      required: true,
      options: [
        // The CREW subset, not every staff role: a commission rule decides what
        // somebody is paid for a trip, and a dispatch manager earns none.
        ...CREW_ROLE_CODES.map((role) => ({ value: role, label: CREW_ROLE_LABELS[role] })),
      ],
    },
    {
      name: 'method',
      label: 'Method',
      type: 'select',
      required: true,
      options: IMPLEMENTED_COMMISSION_METHODS.map((method) => ({
        value: method,
        label: COMMISSION_METHOD_LABELS[method],
      })),
      help: 'A percentage method needs a rate; a fixed method needs an amount. Not both.',
    },
    {
      name: 'rate',
      label: 'Rate',
      type: 'rate',
      placeholder: '0.1500',
      help: 'A multiplier between 0 and 1 — 0.1500 is 15%.',
    },
    {
      name: 'fixedAmount',
      label: 'Fixed amount',
      type: 'money',
      help: 'Pesos, for the fixed methods.',
    },
    {
      name: 'priority',
      label: 'Priority',
      type: 'integer',
      help: 'Higher wins when two rules are equally specific.',
    },
    { name: 'effectiveFrom', label: 'Effective from', type: 'date', required: true },
    {
      name: 'effectiveTo',
      label: 'Effective to',
      type: 'date',
      help: 'Exclusive. Leave blank for open-ended.',
    },
    { name: 'isActive', label: 'Used when resolving commissions', type: 'boolean' },
  ],
  toFormValues: (row) => ({
    name: row.name,
    role: String(row.role),
    method: String(row.method),
    rate: row.rate,
    fixedAmount: row.fixedAmount,
    priority: row.priority,
    effectiveFrom: dateInput(row.effectiveFrom),
    effectiveTo: dateInput(row.effectiveTo),
    isActive: row.isActive,
  }),
};
