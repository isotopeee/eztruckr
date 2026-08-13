import { Controller, Get, Param, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { MAX_RECEIPT_BYTES, type Receipt } from '@eztruckr/types';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import type { RequestUser } from '../auth/request-user';
import { CAN_READ_SHIPMENTS, CAN_UPLOAD_RECEIPTS } from '../auth/role-policy';
import { ReceiptsService, type UploadedFile as ReceiptFile } from './receipts.service';

/**
 * Upload and read back an attachment.
 *
 * MEMORY STORAGE, with the limit applied by multer as well as by the service.
 * multer's limit refuses the request while it is still streaming, so a 400 MB
 * upload is dropped rather than buffered and then rejected; the service's check
 * is what makes the rule true for any other caller.
 *
 * The bytes come back through `content` rather than by a presigned URL — see
 * `StorageService` for why. The short version: a presigned link is a bearer
 * token that outlives the request and travels outside the role guard, and a
 * receipt is exactly the sort of thing one crew member may see and their
 * colleague may not.
 */
@Controller('receipts')
export class ReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  @Post()
  @Roles(...CAN_UPLOAD_RECEIPTS)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_RECEIPT_BYTES } }))
  upload(@UploadedFile() file: ReceiptFile | undefined): Promise<Receipt> {
    return this.receipts.upload(file);
  }

  @Get(':id')
  @Roles(...CAN_READ_SHIPMENTS, ...CAN_UPLOAD_RECEIPTS)
  async get(@Param('id') id: string, @CurrentUser() user: RequestUser): Promise<Receipt> {
    await this.receipts.assertMayRead(id, user);

    return this.receipts.get(id);
  }

  /**
   * `inline` rather than `attachment`, so a receipt opens in a tab instead of
   * landing in the downloads folder. The filename is still sent, quoted, for
   * whoever does save it.
   */
  @Get(':id/content')
  @Roles(...CAN_READ_SHIPMENTS, ...CAN_UPLOAD_RECEIPTS)
  async content(
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.receipts.content(id, user);

    response.setHeader('Content-Type', file.mimeType);
    response.setHeader(
      'Content-Disposition',
      `inline; filename="${file.fileName.replace(/"/g, '')}"`,
    );
    // The object is immutable once uploaded — a correction is a new receipt —
    // so it can be cached hard, and privately: this passed a role check.
    response.setHeader('Cache-Control', 'private, max-age=3600');
    response.send(file.body);
  }
}
