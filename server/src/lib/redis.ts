import IORedis from 'ioredis';
import { redisTarget } from '../config/env';

export interface RedisCheckResult {
  ok: boolean;
  host: string;
  port: number;
  tls: boolean;
  latencyMs?: number;
  error?: string;
}

/**
 * One-shot reachability probe. Never retries forever: connects with lazyConnect and
 * a bounded timeout so the API can explain the problem and fall back.
 */
export async function checkRedis(timeoutMs = 2500): Promise<RedisCheckResult> {
  const base = { host: redisTarget.host, port: redisTarget.port, tls: redisTarget.tls };
  const options = {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: timeoutMs,
    retryStrategy: () => null,
  };

  const client = redisTarget.url
    ? new IORedis(redisTarget.url, options)
    : new IORedis({
        ...options,
        host: redisTarget.host,
        port: redisTarget.port,
        password: redisTarget.password,
        ...(redisTarget.tls ? { tls: {} } : {}),
      });

  try {
    client.on('error', () => {
      /* handled below */
    });
    await client.connect();
    const started = Date.now();
    await client.ping();
    return { ...base, ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return { ...base, ok: false, error: (error as Error).message };
  } finally {
    client.disconnect();
  }
}

export function redisHint(host: string, port: number): string {
  return [
    `Redis is not reachable at ${host}:${port}${redisTarget.tls ? ' (TLS)' : ''}.`,
    'CertiFlow does NOT use Docker. Install a local Redis-compatible server, for example:',
    '  winget install Memurai.MemuraiDeveloper    (Redis-compatible Windows service)',
    '  or run redis-server.exe manually on Windows / use WSL "sudo service redis-server start".',
    '  or set REDIS_URL in server/.env (e.g. a rediss:// Upstash URL) to use a hosted Redis.',
    'Then confirm with: redis-cli ping  -> PONG',
    'Alternatively start the backend with QUEUE_MODE=sync to use the documented',
    'synchronous fallback (no BullMQ, no fake queue claims).',
  ].join('\n');
}
