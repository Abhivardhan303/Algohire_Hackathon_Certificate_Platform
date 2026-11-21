import { env, redisTarget } from '../config/env';
import { checkRedis, redisHint } from '../lib/redis';

async function main() {
  const result = await checkRedis();
  console.log({
    ...result,
    tls: redisTarget.tls,
    source: redisTarget.url ? 'REDIS_URL' : 'REDIS_HOST/REDIS_PORT',
    queueMode: env.QUEUE_MODE,
  });

  if (!result.ok) {
    console.error(`\n${redisHint(result.host, result.port)}`);
    process.exit(1);
  }
  console.log(`\nRedis OK - ${result.latencyMs}ms. BullMQ can be used (QUEUE_MODE=auto/bullmq).`);
}

void main();
