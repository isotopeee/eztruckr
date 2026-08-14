import { INVITATION_TTL_DAYS } from '@eztruckr/types';
import type { MailMessage } from './mail.service';

export interface InvitationEmailInput {
  to: string;
  /** The person's name, for the greeting. */
  name: string;
  /** The full accept URL, token included. */
  url: string;
}

/**
 * The invite email, as text and HTML.
 *
 * Both parts carry the same link and the same words. A text part is not
 * decoration: a message with only an HTML body is a strong spam signal, and the
 * one email in this system that must not land in a junk folder is the one
 * without which nobody can sign in.
 *
 * Deliberately plain HTML with inline styles and no images — mail clients strip
 * stylesheets, and an invite that renders as unstyled text is still usable
 * while one whose only call to action was a background image is not.
 */
export function invitationEmail({ to, name, url }: InvitationEmailInput): MailMessage {
  const subject = 'Set your EZTruckr password';

  const text = [
    `Hi ${name},`,
    '',
    'An EZTruckr account has been created for you. Choose a password to activate it:',
    '',
    url,
    '',
    `This link expires in ${INVITATION_TTL_DAYS} days and can be used once.`,
    'If you were not expecting this, you can ignore this email — the account cannot be used until someone sets a password.',
    '',
    'EZTruckr',
  ].join('\n');

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.5; color: #111;">
      <p>Hi ${escapeHtml(name)},</p>
      <p>An EZTruckr account has been created for you. Choose a password to activate it:</p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(url)}"
           style="background: #111; color: #fff; padding: 12px 20px; border-radius: 6px; text-decoration: none; display: inline-block;">
          Set your password
        </a>
      </p>
      <p style="color: #555; font-size: 13px;">
        Or paste this into your browser:<br />
        <span style="word-break: break-all;">${escapeHtml(url)}</span>
      </p>
      <p style="color: #555; font-size: 13px;">
        This link expires in ${INVITATION_TTL_DAYS} days and can be used once.
        If you were not expecting this, you can ignore this email — the account
        cannot be used until someone sets a password.
      </p>
      <p style="color: #555; font-size: 13px;">EZTruckr</p>
    </div>
  `.trim();

  return { to, subject, html, text };
}

/**
 * The name comes from a form an administrator typed into, so it is not trusted
 * markup. Escaped rather than stripped: someone genuinely called "Miller & Co"
 * should read as themselves.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
