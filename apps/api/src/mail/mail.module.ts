import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

/**
 * Global because mail is a leaf: it depends on config and nothing else, and
 * every feature that grows a notification would otherwise re-import it.
 */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
