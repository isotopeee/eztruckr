import { Injectable } from '@nestjs/common';
import { Prisma } from '@eztruckr/db';
import type { SettingChange, SystemSetting, UpdateSystemSettingInput } from '@eztruckr/types';
import type { RequestUser } from '../auth/request-user';
import { auditFields } from '../master-data/serialize';
import { PrismaService } from '../prisma/prisma.service';

type SystemSettingRow = Prisma.SystemSettingGetPayload<Record<string, never>>;

/** The row's own id, and the entity id every audit entry is filed under. */
const SINGLETON_ID = 'singleton';

const AUDIT_ENTITY_TYPE = 'SystemSetting';
const AUDIT_ACTION = 'system-setting.update';

/** The fields this service will record changes for, in display order. */
const AUDITED_FIELDS = [
  'gasExpenseDeductionRate',
  'driverCommissionRate',
  'helperCommissionRate',
] as const;

type AuditedField = (typeof AUDITED_FIELDS)[number];

/**
 * Scale of the rate columns, `Decimal(5, 4)`.
 *
 * Every rate is rendered to exactly this many places, on the way out and in
 * the audit trail alike. Prisma's `Decimal.toString()` gives the shortest form
 * — 0.2500 comes back as "0.25" — so without this a history entry reads
 * "0.25 → 0.2500", which looks like a change and is not one.
 */
const RATE_SCALE = 4;

function formatRate(value: Prisma.Decimal): string {
  return value.toFixed(RATE_SCALE);
}

export interface RequestOrigin {
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * System-wide defaults, and the record of who changed them.
 *
 * WHY THE AUDIT MATTERS HERE SPECIFICALLY. The gas deduction rate is an input
 * to every commission the system computes. Commissions freeze the values they
 * used, so changing this rate never retroactively moves money — but it does
 * mean two trips computed a week apart can legitimately differ, and when
 * someone asks why their pay changed, "the rate was 0.25 until the 14th, when
 * Grace set it to 0.30" is the only answer that settles it. A settings table
 * with no history cannot produce that sentence.
 *
 * The trail is written to AuditLog rather than inferred from `updatedAt` /
 * `updatedBy`, which only ever remember the most recent change and would erase
 * a rate that was set and then reverted.
 */
@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<SystemSetting> {
    return toSystemSetting(await this.row());
  }

  /**
   * Applies the change and records one audit entry describing it.
   *
   * The read, the write and the audit entry share a transaction: a settings
   * change that lands without its audit row is worse than one that fails
   * outright, because it looks exactly like a value that was always that way.
   */
  async update(
    input: UpdateSystemSettingInput,
    actor: RequestUser,
    origin: RequestOrigin,
  ): Promise<SystemSetting> {
    const current = await this.row();

    // Compared as decimals, never as strings: "0.25" and "0.2500" are the same
    // rate, and treating them as different would fill the one log that has to
    // stay readable with changes that never happened.
    const changes = AUDITED_FIELDS.flatMap((field) => {
      const raw = input[field];
      if (raw === undefined) return [];

      const next = new Prisma.Decimal(raw);
      if (next.equals(current[field])) return [];

      return [
        {
          field,
          previousValue: formatRate(current[field]),
          newValue: formatRate(next),
        },
      ];
    });

    if (changes.length === 0) {
      // Nothing actually differs. Writing an audit entry saying a rate changed
      // from 0.2500 to 0.2500 would be noise in the one log that has to stay
      // readable.
      return toSystemSetting(current);
    }

    const updated = await this.prisma.client.$transaction(async (tx) => {
      const row = await tx.systemSetting.update({
        where: { id: SINGLETON_ID },
        data: Object.fromEntries(changes.map((change) => [change.field, change.newValue])),
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: AUDIT_ACTION,
          entityType: AUDIT_ENTITY_TYPE,
          entityId: SINGLETON_ID,
          // Rates are serialised as strings, exactly as they cross the API —
          // a JSON number here would round the very value being recorded.
          before: Object.fromEntries(changes.map((c) => [c.field, c.previousValue])),
          after: Object.fromEntries(changes.map((c) => [c.field, c.newValue])),
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        },
      });

      return row;
    });

    return toSystemSetting(updated);
  }

  /**
   * The change history, newest first, flattened to one entry per field.
   *
   * One update touching two rates is stored as a single audit row with two
   * keys in `before` / `after`; a history table reads better with a line per
   * field, so the flattening happens here rather than in the UI.
   */
  async history(limit = 50): Promise<SettingChange[]> {
    const rows = await this.prisma.client.auditLog.findMany({
      where: { entityType: AUDIT_ENTITY_TYPE, entityId: SINGLETON_ID },
      orderBy: { occurredAt: 'desc' },
      take: limit,
      include: { actor: true },
    });

    return rows.flatMap((row) => {
      const before = asRecord(row.before);
      const after = asRecord(row.after);

      return Object.keys(after).map((field) => ({
        id: `${row.id}:${field}`,
        occurredAt: row.occurredAt.toISOString(),
        actorId: row.actorId,
        // `actor` is a to-one relation, which the soft-delete extension
        // deliberately does not filter — so a change made by someone since
        // removed still shows their name instead of a blank.
        actorName: row.actor?.name ?? null,
        field,
        previousValue: before[field] ?? null,
        newValue: after[field] ?? null,
      }));
    });
  }

  /**
   * The singleton, created on first read if it is somehow absent.
   *
   * Every column has a schema default, so this materialises the documented
   * defaults rather than inventing anything. It exists because a fresh
   * database that has not been seeded should show a settings screen, not a
   * 404.
   */
  private async row(): Promise<SystemSettingRow> {
    const existing = await this.prisma.client.systemSetting.findFirst({
      where: { id: SINGLETON_ID },
    });

    return existing ?? (await this.prisma.client.systemSetting.create({ data: {} }));
  }
}

function asRecord(value: Prisma.JsonValue | null): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => typeof entry === 'string')
      .map(([key, entry]) => [key, entry as string]),
  );
}

function toSystemSetting(row: SystemSettingRow): SystemSetting {
  return {
    id: SINGLETON_ID,
    gasExpenseDeductionRate: formatRate(row.gasExpenseDeductionRate),
    driverCommissionRate: formatRate(row.driverCommissionRate),
    helperCommissionRate: formatRate(row.helperCommissionRate),
    currencyCode: row.currencyCode,
    timezone: row.timezone,
    ...auditFields(row),
  };
}

export type { AuditedField };
