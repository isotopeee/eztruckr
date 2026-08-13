import { randomUUID } from 'node:crypto';
import {
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env-schema';

export type StorageStatus = 'up' | 'down' | 'skipped';

export interface StoredObject {
  body: Buffer;
  contentType: string | null;
}

/**
 * S3-compatible object storage (MinIO in development, real S3 in production).
 *
 * WHY THE BYTES COME BACK THROUGH HERE rather than by a presigned link. A
 * presigned URL is a bearer token for the object: it outlives the request that
 * minted it and travels wherever the browser takes it, outside `RolesGuard` and
 * outside crew scoping. Receipts are exactly the kind of thing one crew member
 * may see and their colleague may not, so the read stays behind the same guard
 * as every other read. It also keeps `@aws-sdk/s3-request-presigner` out of the
 * dependency list, which is a smaller benefit but a real one.
 *
 * The database stores only the key. Nothing outside this class ever sees it.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client | null;
  private readonly bucket: string | undefined;

  constructor(private readonly config: ConfigService<Env, true>) {
    const endpoint = this.config.get('S3_ENDPOINT', { infer: true });
    const accessKeyId = this.config.get('S3_ACCESS_KEY_ID', { infer: true });
    const secretAccessKey = this.config.get('S3_SECRET_ACCESS_KEY', { infer: true });
    this.bucket = this.config.get('S3_BUCKET', { infer: true });

    if (!endpoint || !accessKeyId || !secretAccessKey || !this.bucket) {
      this.logger.warn('Object storage is not configured; storage checks will report "skipped"');
      this.client = null;
      return;
    }

    this.client = new S3Client({
      endpoint,
      region: this.config.get('S3_REGION', { infer: true }),
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: this.config.get('S3_FORCE_PATH_STYLE', { infer: true }),
    });
  }

  async check(): Promise<StorageStatus> {
    if (!this.client || !this.bucket) {
      return 'skipped';
    }

    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return 'up';
    } catch (error) {
      this.logger.error('Storage check failed', error instanceof Error ? error.message : error);
      return 'down';
    }
  }

  /**
   * Stores the bytes and returns the key they were stored under.
   *
   * The key is generated here, never taken from the upload. A filename arriving
   * from a browser is attacker-controlled text: `../` sequences, absolute
   * paths, and names that collide with an existing object are all things a
   * caller should not be able to choose. The original name is kept in the
   * database column, where it is data rather than an address.
   */
  async put(input: {
    prefix: string;
    fileName: string;
    contentType: string;
    body: Buffer;
  }): Promise<string> {
    const client = this.requireClient();
    const key = `${input.prefix}/${randomUUID()}${extensionOf(input.fileName)}`;

    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: input.body,
        ContentType: input.contentType,
      }),
    );

    return key;
  }

  async get(key: string): Promise<StoredObject> {
    const client = this.requireClient();

    const response = await client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));

    if (!response.Body) {
      throw new ServiceUnavailableException(`Object ${key} came back empty.`);
    }

    return {
      body: Buffer.from(await response.Body.transformToByteArray()),
      contentType: response.ContentType ?? null,
    };
  }

  /**
   * Refusing beats limping. An unconfigured bucket means an upload would report
   * success and leave a `receipt` row pointing at nothing — a receipt that
   * exists in the ledger and not in the world is worse than a failed upload.
   */
  private requireClient(): S3Client {
    if (!this.client || !this.bucket) {
      throw new ServiceUnavailableException(
        'Object storage is not configured, so attachments cannot be stored or read.',
      );
    }

    return this.client;
  }
}

/** The trailing `.jpg`, lowercased, or nothing. Cosmetic: keys stay opaque. */
function extensionOf(fileName: string): string {
  const match = /\.[A-Za-z0-9]{1,8}$/.exec(fileName);
  return match ? match[0].toLowerCase() : '';
}
