import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { env } from './config/env';
import { prisma } from './lib/prisma';
import { checkRedis } from './lib/redis';
import { getResolvedQueueMode, resolveQueueMode } from './queue/dispatch';
import authRoutes from './routes/auth';
import batchRoutes from './routes/batches';
import certificateRoutes from './routes/certificates';
import verifyRoutes from './routes/verify';
import { errorHandler } from './middleware/errorHandler';

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  const storagePath = path.resolve(process.cwd(), env.STORAGE_DIR);
  app.use('/storage', express.static(storagePath));

  app.get('/api/health', async (_req, res) => {
    let database = 'down';
    try {
      await prisma.$queryRaw`SELECT 1`;
      database = 'up';
    } catch {
      database = 'down';
    }
    const redis = await checkRedis(800);
    const queue = getResolvedQueueMode();
    res.status(database === 'up' ? 200 : 503).json({
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      redis: redis.ok ? 'up' : 'down',
      redisError: redis.ok ? undefined : redis.error,
      queueMode: queue?.mode ?? 'unresolved',
      queueReason: queue?.reason ?? 'not resolved yet',
      whatsappMode: env.WHATSAPP_MODE,
    });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/batches', batchRoutes);
  app.use('/api/certificates', certificateRoutes);
  app.use('/api/verify', verifyRoutes);

  app.use((_req, res) => {
    res.status(404).json({ error: { message: 'Route not found', code: 'NOT_FOUND', details: null } });
  });

  app.use(errorHandler);
  return app;
}

export async function startServer() {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    console.error('\n[certiflow] PostgreSQL is not reachable.');
    console.error(`  DATABASE_URL = ${env.DATABASE_URL}`);
    console.error('  Make sure the local PostgreSQL Windows service is running and the database exists:');
    console.error('    Get-Service postgresql*');
    console.error('    npm run db:migrate');
    console.error(`  ${(error as Error).message}\n`);
    process.exit(1);
  }

  let queueMode = 'sync';
  try {
    const info = await resolveQueueMode();
    queueMode = info.mode;
    console.log(`[certiflow] queue mode: ${info.mode} - ${info.reason}`);
    if (info.mode === 'sync') {
      console.warn(
        '[certiflow] REDIS NOT IN USE. Certificate issuance and WhatsApp delivery run in-process (documented fallback).',
      );
    }
  } catch (error) {
    console.error(`[certiflow] ${(error as Error).message}`);
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`[certiflow] API listening on http://localhost:${env.PORT}`);
    console.log(`[certiflow] Storage directory: ${path.resolve(process.cwd(), env.STORAGE_DIR)}`);
    console.log(`[certiflow] Frontend URL for verification links: ${env.PUBLIC_BASE_URL}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`\n[certiflow] ${signal} received, shutting down...`);
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  return { app, server, queueMode };
}
