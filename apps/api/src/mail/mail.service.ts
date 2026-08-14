import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env-schema';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * What happened when we handed a message to the transport.
 *
 * A RESULT, not an exception, because every caller here has something to record
 * either way: a failed invite email must still leave a valid invitation behind,
 * so the administrator can resend rather than re-provision the account. Throwing
 * would make the natural implementation roll the whole thing back.
 */
export type MailResult = { sent: true } | { sent: false; error: string };

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** Resend is an HTTP API, so `fetch` is the whole client. */
interface ResendErrorBody {
  message?: string;
  name?: string;
}

/**
 * Outbound mail through Resend.
 *
 * WHY NOT SMTP. An SMTP client is a dependency (nodemailer) plus a container to
 * talk to in development; Resend is one POST, so the transport costs no
 * dependency at all — the project has added none since Phase 3, and this was
 * not the feature to break that for.
 *
 * WHAT HAPPENS WITHOUT A KEY, which is the part worth knowing:
 *
 * - By default an unconfigured transport is a configuration error. Messages
 *   fail with a result saying so, and the invitation records `deliveryError`.
 *   Nothing silently succeeds.
 * - With `MAIL_LOG_INSTEAD_OF_SENDING=true`, the message is LOGGED IN FULL,
 *   invite link included, and reported as sent. That is how the flow is
 *   demonstrable on a laptop with no Resend account.
 *
 * THE FLAG IS EXPLICIT RATHER THAN DERIVED FROM `NODE_ENV`, which would be the
 * obvious way to do it and would be wrong here: the development compose stack
 * runs `NODE_ENV=production` because it builds the production images. Keying
 * off that would turn the fallback off in the one place it is for.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  private get apiKey(): string | undefined {
    return this.config.get('RESEND_API_KEY', { infer: true });
  }

  private get logInsteadOfSending(): boolean {
    return this.config.get('MAIL_LOG_INSTEAD_OF_SENDING', { infer: true });
  }

  async send(message: MailMessage): Promise<MailResult> {
    const apiKey = this.apiKey;

    if (!apiKey) {
      return this.sendWithoutTransport(message);
    }

    try {
      const response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.config.get('MAIL_FROM', { infer: true }),
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
      });

      if (!response.ok) {
        // Resend reports failures in the body; the status alone does not say
        // whether it was a bad sender, an unverified domain or a rate limit,
        // and an administrator staring at "500" cannot act on it.
        const detail = await this.describeFailure(response);
        this.logger.error(`Resend refused a message to ${message.to}: ${detail}`);
        return { sent: false, error: detail };
      }

      return { sent: true };
    } catch (error) {
      // A network failure, not a refusal. Same handling: the caller records it
      // and the invite stays valid to be resent.
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Could not reach Resend for a message to ${message.to}: ${detail}`);
      return { sent: false, error: detail };
    }
  }

  private async describeFailure(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as ResendErrorBody;
      const message = body.message ?? body.name;
      return message ? `${response.status} ${message}` : `${response.status}`;
    } catch {
      // A non-JSON error body is still a failure worth naming.
      return `${response.status} ${response.statusText}`.trim();
    }
  }

  private sendWithoutTransport(message: MailMessage): MailResult {
    if (!this.logInsteadOfSending) {
      const error = 'RESEND_API_KEY is not set, so no mail can be sent';
      this.logger.error(`${error} — message to ${message.to} was not delivered`);
      return { sent: false, error };
    }

    this.logger.warn(
      [
        'RESEND_API_KEY is not set and MAIL_LOG_INSTEAD_OF_SENDING is on —',
        'logging this message instead of sending it. Never do this in a real deployment.',
        `  To:      ${message.to}`,
        `  Subject: ${message.subject}`,
        '',
        message.text,
      ].join('\n'),
    );

    return { sent: true };
  }
}
