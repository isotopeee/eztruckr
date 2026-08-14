import { z } from 'zod';

/**
 * Environment contract for the API. Validated once at boot so a
 * misconfiguration fails loudly on startup instead of at the first request.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  /** Comma-separated list of origins allowed to call the API. */
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  /**
   * Signs session cookies and tokens. Required — an app that boots without it
   * would either refuse every login or, worse, sign with a predictable key.
   * Generate with: openssl rand -base64 32
   */
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, 'BETTER_AUTH_SECRET must be at least 32 characters (openssl rand -base64 32)'),
  /** Origin the auth endpoints are reached at, used to build callback URLs. */
  BETTER_AUTH_URL: z.string().url().default('http://localhost:4000'),

  // S3-compatible storage (MinIO in development).
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** MinIO needs path-style addressing; real S3 does not. */
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  APP_TIMEZONE: z.string().default('Asia/Manila'),

  // Outbound mail (Resend). Optional so the stack still boots without a key.
  RESEND_API_KEY: z.string().optional(),
  /**
   * With no API key, write invite emails to the log instead of failing.
   *
   * AN EXPLICIT OPT-IN, not derived from `NODE_ENV`, because the development
   * compose stack deliberately runs `NODE_ENV=production` — it builds and runs
   * the production images — so keying off that would disable this exactly where
   * it is needed and enable nothing anywhere.
   *
   * Defaults to FALSE so a real deployment that forgets its key gets a loud
   * delivery failure rather than a quiet one. Turning it on writes invite links
   * to the log, which is a credential in a log file; only ever do that locally.
   */
  MAIL_LOG_INSTEAD_OF_SENDING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** Must be a verified sender on the Resend account. */
  MAIL_FROM: z.string().default('EZTruckr <onboarding@resend.dev>'),
  /**
   * Where the WEB app is reached, for links inside emails. Distinct from
   * `BETTER_AUTH_URL`, which is the API's own origin: an invite link that
   * pointed at the API would land on a JSON 404.
   */
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
});

export type Env = z.infer<typeof envSchema>;

/** Used as @nestjs/config's `validate` hook. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return result.data;
}
