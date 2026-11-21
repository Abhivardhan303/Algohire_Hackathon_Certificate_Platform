import { Worker } from 'bullmq';
import { DELIVERY_QUEUE, QUEUE_PREFIX, closeQueues } from '../queue/queues';
import { createRedisClient } from '../queue/connection';
import { resolveQueueMode } from '../queue/dispatch';
import { processDelivery } from '../services/deliveryService';
import { prisma } from '../lib/prisma';
import { workerBlockedMessage } from './requirements';

async function main() {
  const info = await resolveQueueMode();
  if (info.mode !== 'bullmq') {
    console.error(workerBlockedMessage('worker:notifications', info));
    process.exit(1);
  }

  const worker = new Worker(
    DELIVERY_QUEUE,
    async (job) => {
      if (job.name !== 'deliver') return;
      const { deliveryJobId } = job.data as { deliveryJobId: string };
      console.log(`[worker:notifications] processing ${job.id} delivery=${deliveryJobId} attempt=${job.attemptsMade + 1}`);
      await processDelivery(deliveryJobId);
    },
    {
      connection: createRedisClient('worker-notifications'),
      prefix: QUEUE_PREFIX,
      concurrency: 3,
    },
  );

  worker.on('failed', (job, error) => {
    console.error(`[worker:notifications] job ${job?.id} failed: ${error.message}`);
  });
  worker.on('error', (error) => console.error(`[worker:notifications] ${error.message}`));

  console.log(`[worker:notifications] listening on "${DELIVERY_QUEUE}" (${info.reason})`);

  const shutdown = async (signal: string) => {
    console.log(`\n[worker:notifications] ${signal} received - waiting for active jobs to finish...`);
    await worker.close();
    await closeQueues();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (error) => {
  console.error('[worker:notifications] fatal', error);
  await prisma.$disconnect();
  process.exit(1);
});
