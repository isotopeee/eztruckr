import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MailService } from './mail.service';

/**
 * What the transport does with a message, and — the part that matters — what it
 * does when it cannot send one.
 *
 * `MailService` returns a RESULT rather than throwing, because a failed invite
 * email must still leave a valid invitation behind to be resent. These pin that
 * contract: every failure path returns `sent: false` with something an
 * administrator can read, and none of them throw.
 *
 * No network. `fetch` is stubbed, so a green run here proves the request shape
 * and the error handling without depending on Resend being reachable.
 */

type Settings = {
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  MAIL_LOG_INSTEAD_OF_SENDING?: boolean;
};

function serviceWith(settings: Settings): MailService {
  const config = {
    get: (key: keyof Settings) =>
      ({
        MAIL_FROM: 'EZTruckr <no-reply@eztruckr.ph>',
        MAIL_LOG_INSTEAD_OF_SENDING: false,
        ...settings,
      })[key],
  } as unknown as ConfigService;

  return new MailService(config as never);
}

const message = {
  to: 'joel.bautista@eztruckr.ph',
  subject: 'Set your EZTruckr password',
  html: '<p>hello</p>',
  text: 'hello',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sending through Resend', () => {
  it('posts the message and reports success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await serviceWith({ RESEND_API_KEY: 'test-key' }).send(message);

    expect(result).toEqual({ sent: true });
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');

    // `to` is an ARRAY in Resend's API. A bare string is accepted by the type
    // system and rejected by the service, which is the kind of thing only a
    // real request or this assertion catches.
    expect(JSON.parse(init.body as string)).toMatchObject({
      from: 'EZTruckr <no-reply@eztruckr.ph>',
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  });

  /**
   * A text part is not decoration — an HTML-only message is a spam signal, and
   * the one email in this system that must not land in a junk folder is the one
   * without which nobody can sign in.
   */
  it('always sends both a text and an html part', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await serviceWith({ RESEND_API_KEY: 'test-key' }).send(message);

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.text).toBeTruthy();
    expect(body.html).toBeTruthy();
  });

  it('surfaces the reason Resend refused, not just the status', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ message: 'The domain is not verified' }), { status: 403 }),
        ),
    );

    const result = await serviceWith({ RESEND_API_KEY: 'test-key' }).send(message);

    expect(result.sent).toBe(false);
    // "403" alone is not actionable; the domain being unverified is.
    expect(result.sent === false && result.error).toContain('The domain is not verified');
  });

  it('does not throw when the error body is not json', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>gateway timeout</html>', { status: 504 })),
    );

    const result = await serviceWith({ RESEND_API_KEY: 'test-key' }).send(message);

    expect(result.sent).toBe(false);
    expect(result.sent === false && result.error).toContain('504');
  });

  it('turns a network failure into a result rather than an exception', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND')));

    const result = await serviceWith({ RESEND_API_KEY: 'test-key' }).send(message);

    expect(result).toEqual({ sent: false, error: 'getaddrinfo ENOTFOUND' });
  });
});

describe('with no api key configured', () => {
  /**
   * THE DEFAULT IS TO FAIL. A deployment that forgets its key must not look
   * like one that is working — the invitation records the error and the
   * administrator sees "invite not sent" rather than a silent success.
   */
  it('fails loudly by default, and sends nothing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await serviceWith({}).send(message);

    expect(result.sent).toBe(false);
    expect(result.sent === false && result.error).toContain('RESEND_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs instead of sending only when explicitly told to', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await serviceWith({ MAIL_LOG_INSTEAD_OF_SENDING: true }).send(message);

    expect(result).toEqual({ sent: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
