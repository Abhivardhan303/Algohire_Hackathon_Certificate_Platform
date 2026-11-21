import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(8).default('certiflow-local-dev-secret'),
  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional().default(''),
  // Preferred when set (supports rediss:// TLS URLs, e.g. Upstash). Overrides HOST/PORT/PASSWORD.
  REDIS_URL: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined)),
  QUEUE_MODE: z.enum(['auto', 'bullmq', 'sync']).default('auto'),
  STORAGE_DIR: z.string().default('./storage/certificates'),
  PUBLIC_BASE_URL: z.string().default('http://localhost:5173'),
  WHATSAPP_MODE: z.enum(['mixed', 'success', 'failure', 'timeout']).default('mixed'),
  WHATSAPP_MAX_ATTEMPTS: z.coerce.number().min(1).default(4),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('[config] Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

export interface RedisTarget {
  /** Full connection URL when REDIS_URL is set (rediss:// enables TLS). */
  url?: string;
  host: string;
  port: number;
  password?: string;
  tls: boolean;
}

function describeRedisTarget(): RedisTarget {
  if (env.REDIS_URL) {
    try {
      const parsedUrl = new URL(env.REDIS_URL);
      return {
        url: env.REDIS_URL,
        host: parsedUrl.hostname,
        port: Number(parsedUrl.port || 6379),
        password: parsedUrl.password ? decodeURIComponent(parsedUrl.password) : undefined,
        tls: parsedUrl.protocol === 'rediss:',
      };
    } catch {
      console.error('[config] REDIS_URL is not a valid URL - falling back to REDIS_HOST/REDIS_PORT.');
    }
  }
  return {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD ? env.REDIS_PASSWORD : undefined,
    tls: false,
  };
}

export const redisTarget = describeRedisTarget();

/** Host/port/password options (no TLS flag) - kept for simple display purposes. */
export const redisConnectionOptions = {
  host: redisTarget.host,
  port: redisTarget.port,
  password: redisTarget.password,
};
