import IORedis from 'ioredis';
import { redisTarget } from '../config/env';

/** Shared Redis connection factory for queue producers and BullMQ workers. */
export function createRedisClient(connectionName: string): IORedis {
  const options = {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectionName: `certiflow:${connectionName}`,
    retryStrategy: (times: number) => Math.min(times * 200, 2000),
  };

  // A URL (including rediss:// TLS URLs such as Upstash) enables TLS automatically.
  const client = redisTarget.url
    ? new IORedis(redisTarget.url, options)
    : new IORedis({
        ...options,
        host: redisTarget.host,
        port: redisTarget.port,
        password: redisTarget.password,
        ...(redisTarget.tls ? { tls: {} } : {}),
      });

  client.on('error', (error) => {
    console.error(`[redis:${connectionName}] ${error.message}`);
  });
  return client;
}
