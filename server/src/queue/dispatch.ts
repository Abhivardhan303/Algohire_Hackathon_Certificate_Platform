import { env } from '../config/env';
import { checkRedis, redisHint } from '../lib/redis';
import { CERTIFICATE_QUEUE, DELIVERY_QUEUE, getCertificateQueue, getDeliveryQueue } from './queues';

export type QueueMode = 'bullmq' | 'sync';

export interface QueueModeInfo {
  mode: QueueMode;
  reason: string;
}

let cached: QueueModeInfo | null = null;

/**
 * Resolves the dispatch mode once:
 *  - QUEUE_MODE=sync   -> explicit synchronous fallback (documented, no BullMQ claims)
 *  - QUEUE_MODE=bullmq -> requires Redis, throws a helpful error when unreachable
 *  - QUEUE_MODE=auto   -> BullMQ when Redis answers PING, otherwise sync fallback
 */
export async function resolveQueueMode(): Promise<QueueModeInfo> {
  if (cached) return cached;

  if (env.QUEUE_MODE === 'sync') {
    cached = { mode: 'sync', reason: 'QUEUE_MODE=sync - synchronous fallback (BullMQ disabled)' };
    return cached;
  }

  const probe = await checkRedis();
  if (probe.ok) {
    cached = { mode: 'bullmq', reason: `BullMQ via Redis ${probe.host}:${probe.port} (${probe.latencyMs}ms)` };
    return cached;
  }

  if (env.QUEUE_MODE === 'bullmq') {
    throw new Error(`QUEUE_MODE=bullmq but Redis is unavailable.\n${redisHint(probe.host, probe.port)}`);
  }

  cached = { mode: 'sync', reason: `Redis unreachable (${probe.error}) - using synchronous fallback` };
  return cached;
}

export function getResolvedQueueMode(): QueueModeInfo | null {
  return cached;
}

const pendingSyncTasks = new Set<Promise<void>>();

/** Used by tests / scripts to await the synchronous fallback. */
export async function waitForSyncIdle(): Promise<void> {
  while (pendingSyncTasks.size > 0) {
    await Promise.all([...pendingSyncTasks]);
  }
}

function runSync(label: string, task: () => Promise<void>, attempts: number, delayMs: number): void {
  const promise = (async () => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await task();
        return;
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** (attempt - 1)));
        }
      }
    }
    console.error(`[sync-fallback] ${label} failed:`, (lastError as Error)?.message ?? lastError);
  })();

  pendingSyncTasks.add(promise);
  void promise.finally(() => pendingSyncTasks.delete(promise));
}

export async function enqueueCertificateIssuance(batchId: string): Promise<QueueModeInfo> {
  const info = await resolveQueueMode();
  if (info.mode === 'bullmq') {
    await getCertificateQueue().add(
      'issue-batch',
      { batchId },
      { jobId: `issue-batch-${batchId}`, attempts: 5, backoff: { type: 'exponential', delay: 2000 } },
    );
    console.log(`[queue] ${CERTIFICATE_QUEUE} <- issue-batch ${batchId}`);
    return info;
  }

  console.warn(`[sync-fallback] issuing certificates for batch ${batchId} in-process (no BullMQ)`);
  runSync(
    `certificate issuance ${batchId}`,
    async () => {
      const { issueCertificatesForBatch } = await import('../services/certificateService');
      await issueCertificatesForBatch(batchId);
    },
    2,
    800,
  );
  return info;
}

export async function enqueueDelivery(deliveryJobId: string): Promise<QueueModeInfo> {
  const info = await resolveQueueMode();
  if (info.mode === 'bullmq') {
    await getDeliveryQueue().add(
      'deliver',
      { deliveryJobId },
      { jobId: `delivery-${deliveryJobId}`, attempts: env.WHATSAPP_MAX_ATTEMPTS, backoff: { type: 'exponential', delay: 1500 } },
    );
    console.log(`[queue] ${DELIVERY_QUEUE} <- deliver ${deliveryJobId}`);
    return info;
  }

  runSync(
    `whatsapp delivery ${deliveryJobId}`,
    async () => {
      const { processDelivery } = await import('../services/deliveryService');
      await processDelivery(deliveryJobId);
    },
    env.WHATSAPP_MAX_ATTEMPTS,
    400,
  );
  return info;
}

/** Test helper: reset cached mode so a different QUEUE_MODE can be applied. */
export function resetQueueModeCache(): void {
  cached = null;
}
