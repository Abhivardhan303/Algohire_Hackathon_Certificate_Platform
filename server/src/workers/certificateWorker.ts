import { Worker } from 'bullmq';
import { CERTIFICATE_QUEUE, QUEUE_PREFIX, closeQueues } from '../queue/queues';
import { createRedisClient } from '../queue/connection';
import { resolveQueueMode } from '../queue/dispatch';
import { issueCertificatesForBatch } from '../services/certificateService';
import { prisma } from '../lib/prisma';
import { workerBlockedMessage } from './requirements';

async function main() {
  const info = await resolveQueueMode();
  if (info.mode !== 'bullmq') {
    console.error(workerBlockedMessage('worker:certificates', info));
    process.exit(1);
  }

  const worker = new Worker(
    CERTIFICATE_QUEUE,
    async (job) => {
      if (job.name !== 'issue-batch') return;
      const { batchId } = job.data as { batchId: string };
      console.log(`[worker:certificates] processing ${job.id} batch=${batchId} attempt=${job.attemptsMade + 1}`);
      const summary = await issueCertificatesForBatch(batchId);
      console.log(`[worker:certificates] done`, summary);
      return summary;
    },
    {
      connection: createRedisClient('worker-certificates'),
      prefix: QUEUE_PREFIX,
      concurrency: 2,
    },
  );

  worker.on('failed', (job, error) => {
    console.error(`[worker:certificates] job ${job?.id} failed: ${error.message}`);
  });
  worker.on('error', (error) => console.error(`[worker:certificates] ${error.message}`));

  console.log(`[worker:certificates] listening on "${CERTIFICATE_QUEUE}" (${info.reason})`);

  const shutdown = async (signal: string) => {
    console.log(`\n[worker:certificates] ${signal} received - waiting for active jobs to finish...`);
    await worker.close();
    await closeQueues();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (error) => {
  console.error('[worker:certificates] fatal', error);
  await prisma.$disconnect();
  process.exit(1);
});
