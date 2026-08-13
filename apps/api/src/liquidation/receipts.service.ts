import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import {
  ALLOWED_RECEIPT_MIME_TYPES,
  MAX_RECEIPT_BYTES,
  UserRole,
  isAllowedReceiptMimeType,
  type OrphanSweepResult,
  type Receipt,
} from '@eztruckr/types';
import { withDeleted, withHardDelete, type Prisma } from '@eztruckr/db';
import type { RequestUser } from '../auth/request-user';
import { auditFields } from '../master-data/serialize';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

/**
 * The one upload path in the system.
 *
 * Every attachment — a liquidation receipt, proof that an allowance was
 * released, proof that a settlement moved — is a `receipt` row and an object in
 * the bucket. One table and one pipeline, because they are the same kind of
 * thing and a second one would be a second place to keep MIME limits, size
 * limits and bucket configuration in step.
 *
 * UPLOAD AND ATTACH ARE SEPARATE STEPS, deliberately. The file goes up first
 * and comes back as an id; the line, allowance or settlement then references
 * that id. Uploading inside the same request as the line it belongs to sounds
 * tidier and means a failed line validation has already put bytes in the
 * bucket, or that a retry uploads them twice.
 */
export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** Everything a receipt can hang off, for the read check. */
const ATTACHMENT_INCLUDE = {
  liquidationLines: { select: { liquidation: { select: { shipmentId: true } } } },
  billableExpenses: { select: { shipmentId: true } },
  allowances: { select: { shipmentId: true } },
  settlements: { select: { shipmentId: true } },
} satisfies Prisma.ReceiptInclude;

type ReceiptRow = Prisma.ReceiptGetPayload<Record<string, never>>;

@Injectable()
export class ReceiptsService {
  private readonly logger = new Logger(ReceiptsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Stores the bytes, then records the row.
   *
   * That order matters: a `receipt` row written before a failed upload points
   * at nothing, and nothing downstream can tell the difference between that and
   * a receipt somebody deleted from the bucket by hand.
   */
  async upload(file: UploadedFile | undefined): Promise<Receipt> {
    if (!file) {
      throw new BadRequestException('No file was uploaded. Send it as the `file` form field.');
    }

    if (file.size > MAX_RECEIPT_BYTES) {
      throw new PayloadTooLargeException(
        `That file is ${Math.round(file.size / 1024 / 1024)} MB. Receipts are limited to ${MAX_RECEIPT_BYTES / 1024 / 1024} MB.`,
      );
    }

    if (!isAllowedReceiptMimeType(file.mimetype)) {
      throw new UnsupportedMediaTypeException(
        `${file.mimetype} is not an accepted receipt format. Use one of: ${ALLOWED_RECEIPT_MIME_TYPES.join(', ')}.`,
      );
    }

    const storageKey = await this.storage.put({
      prefix: 'receipts',
      fileName: file.originalname,
      contentType: file.mimetype,
      body: file.buffer,
    });

    const row = await this.prisma.client.receipt.create({
      data: {
        storageKey,
        fileName: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
      },
    });

    return toReceipt(row);
  }

  async get(id: string): Promise<Receipt> {
    return toReceipt(await this.load(id));
  }

  /**
   * The bytes, for a caller who is allowed to see them.
   *
   * `mimeType` comes from the row rather than from the bucket, so what the
   * browser is told matches what was validated at upload.
   */
  async content(id: string, user: RequestUser) {
    await this.assertMayRead(id, user);

    const row = await this.load(id);
    const object = await this.storage.get(row.storageKey);

    return { body: object.body, mimeType: row.mimeType, fileName: row.fileName };
  }

  /**
   * A crew member may read a receipt attached to a trip they worked, or one
   * they uploaded themselves and have not attached yet.
   *
   * The second clause is not a loophole: between choosing a file and saving the
   * line there is a receipt belonging to nobody, and its uploader is the only
   * person who can meaningfully be shown it. Office roles see any receipt, as
   * they see any shipment.
   */
  async assertMayRead(id: string, user: RequestUser): Promise<void> {
    if (user.role !== UserRole.CREW) {
      return;
    }

    // A BROKEN CREW ACCOUNT IS NOT A PERMISSIVE ONE. Every other crew-scoping
    // site refuses outright when the link is missing; this one used the null
    // directly, and `driverId`/`helperId` are both nullable — so the query
    // below became "any trip with an unassigned slot", and served its receipts.
    if (!user.staffId) {
      throw new ForbiddenException('This crew account is not linked to a staff member.');
    }

    const row = await this.prisma.client.receipt.findFirst({
      where: { id },
      include: ATTACHMENT_INCLUDE,
    });

    if (!row) {
      throw new NotFoundException(`No receipt with id ${id}`);
    }

    const shipmentIds = [
      ...row.liquidationLines.map((line) => line.liquidation.shipmentId),
      ...row.billableExpenses.map((expense) => expense.shipmentId),
      ...row.allowances.map((allowance) => allowance.shipmentId),
      ...row.settlements.map((settlement) => settlement.shipmentId),
    ];

    if (shipmentIds.length === 0) {
      if (row.createdBy === user.id) return;

      throw new ForbiddenException('You can only view receipts on trips you worked on.');
    }

    const worked = await this.prisma.client.shipment.count({
      where: {
        id: { in: shipmentIds },
        OR: [{ driverId: user.staffId }, { helperId: user.staffId }],
      },
    });

    if (worked === 0) {
      throw new ForbiddenException('You can only view receipts on trips you worked on.');
    }
  }

  /**
   * A receipt id supplied on a line, an allowance or a settlement.
   *
   * Checked rather than trusted: without this, a request naming any receipt id
   * would attach somebody else's document to its own row, and the partial
   * unique index would then detach it from where it belonged.
   */
  async assertExists(receiptId: string | null | undefined): Promise<void> {
    if (!receiptId) return;

    const found = await this.prisma.client.receipt.findFirst({
      where: { id: receiptId },
      select: { id: true },
    });

    if (!found) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: [{ path: 'receiptId', message: `No receipt with id ${receiptId}` }],
      });
    }
  }

  /**
   * Removes receipts that nothing references and nobody attached.
   *
   * WHY THIS EXISTS. Upload and attach are separate requests, so every abandoned
   * form leaves bytes in the bucket and a row in the table that no screen can
   * ever reach. Nothing else in the system can collect them: a receipt is not
   * reachable from a shipment, so no cascade or removal probe passes near it.
   *
   * WHY IT IS AN ENDPOINT AND NOT A HOOK. There is no scheduler in this
   * application, and adding one — or sweeping opportunistically on each upload —
   * would make deletion a side effect of an unrelated request, which is a poor
   * property for the one operation here that destroys data. This is explicit,
   * role-guarded, reports exactly what it did, and is safe to run from whatever
   * runs schedules in the deployment.
   *
   * WHY IT HARD-DELETES. An orphan is unreferenced by definition, which is the
   * same test `removeRecord` applies before hard-deleting an expense category.
   * Soft-deleting instead would leave a row saying "somebody uploaded a file and
   * never used it", which answers no question and accumulates forever.
   */
  async sweepOrphans(olderThanHours: number): Promise<OrphanSweepResult> {
    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);

    const candidates = await this.prisma.client.receipt.findMany({
      where: { uploadedAt: { lt: cutoff } },
      select: { id: true, storageKey: true, sizeBytes: true },
    });

    let removed = 0;
    let stillAttached = 0;
    let failed = 0;
    let bytesReclaimed = 0;

    for (const candidate of candidates) {
      if ((await this.referenceCount(candidate.id)) > 0) {
        stillAttached += 1;
        continue;
      }

      try {
        // Object first, row second. A failure between the two leaves a receipt
        // the next sweep will retry; the other order leaks bytes that nothing
        // ever looks at again, because the row that named them is gone.
        await this.storage.remove(candidate.storageKey);

        await withHardDelete(async () => {
          await this.prisma.client.receipt.delete({ where: { id: candidate.id } });
        });

        removed += 1;
        bytesReclaimed += candidate.sizeBytes;
      } catch (error) {
        // One unreachable object must not abandon the rest of the run.
        this.logger.warn(
          `Could not sweep receipt ${candidate.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        failed += 1;
      }
    }

    return { examined: candidates.length, removed, stillAttached, failed, bytesReclaimed };
  }

  /**
   * How many rows point at this receipt, INCLUDING soft-deleted ones.
   *
   * The `withDeleted` is the whole correctness of the sweep. Every one of these
   * foreign keys is `ON DELETE SET NULL`, so hard-deleting a receipt that a
   * soft-deleted liquidation line still names would silently strip the
   * attachment off a row being kept precisely so the history stays readable.
   * The default filtered read cannot see that line, and would call the receipt
   * an orphan.
   */
  private async referenceCount(receiptId: string): Promise<number> {
    return withDeleted(async () => {
      const [lines, expenses, allowances, settlements] = await Promise.all([
        this.prisma.client.liquidationLine.count({ where: { receiptId } }),
        this.prisma.client.billableExpense.count({ where: { receiptId } }),
        this.prisma.client.allowance.count({ where: { receiptId } }),
        this.prisma.client.settlement.count({ where: { receiptId } }),
      ]);

      return lines + expenses + allowances + settlements;
    });
  }

  private async load(id: string): Promise<ReceiptRow> {
    const row = await this.prisma.client.receipt.findFirst({ where: { id } });

    if (!row) {
      throw new NotFoundException(`No receipt with id ${id}`);
    }

    return row;
  }
}

export function toReceipt(row: ReceiptRow): Receipt {
  return {
    id: row.id,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    uploadedAt: row.uploadedAt.toISOString(),
    ...auditFields(row),
  };
}
