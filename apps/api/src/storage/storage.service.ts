import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env-schema';

export type StorageStatus = 'up' | 'down' | 'skipped';

/**
 * S3-compatible object storage (MinIO in development, real S3 in production).
 *
 * Phase 1 only proves connectivity; upload/presign helpers for receipts and
 * liquidation attachments arrive with the modules that need them.
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
}
