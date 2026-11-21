import { Queue, type JobsOptions } from 'bullmq';
import { createRedisClient } from './connection';

export const QUEUE_PREFIX = 'certiflow';
export const CERTIFICATE_QUEUE = 'certificate-issuance';
export const DELIVERY_QUEUE = 'whatsapp-delivery';

export const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 },
};

let certificateQueue: Queue | undefined;
let deliveryQueue: Queue | undefined;

export function getCertificateQueue(): Queue {
  certificateQueue ??= new Queue(CERTIFICATE_QUEUE, {
    connection: createRedisClient('producer-certificates'),
    prefix: QUEUE_PREFIX,
    defaultJobOptions,
  });
  return certificateQueue;
}

export function getDeliveryQueue(): Queue {
  deliveryQueue ??= new Queue(DELIVERY_QUEUE, {
    connection: createRedisClient('producer-deliveries'),
    prefix: QUEUE_PREFIX,
    defaultJobOptions: {
      ...defaultJobOptions,
      attempts: 4,
      backoff: { type: 'exponential', delay: 1500 },
    },
  });
  return deliveryQueue;
}

export async function closeQueues(): Promise<void> {
  await certificateQueue?.close();
  await deliveryQueue?.close();
  certificateQueue = undefined;
  deliveryQueue = undefined;
}
