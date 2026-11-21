import { env } from '../config/env';
import { redisHint } from '../lib/redis';
import type { QueueModeInfo } from '../queue/dispatch';

/** Clear, actionable message when a BullMQ worker cannot start. */
export function workerBlockedMessage(label: string, info: QueueModeInfo): string {
  const lines = [`[${label}] BullMQ worker NOT started.`];
  if (env.QUEUE_MODE === 'sync') {
    lines.push('QUEUE_MODE=sync is configured, so BullMQ is disabled by configuration.');
    lines.push('Set QUEUE_MODE=auto (with Redis running) or QUEUE_MODE=bullmq to run this worker.');
  } else {
    lines.push(redisHint(env.REDIS_HOST, env.REDIS_PORT));
  }
  lines.push(`Detected: ${info.reason}`);
  return lines.join('\n');
}
