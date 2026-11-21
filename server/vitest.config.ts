import path from 'node:path';
import dotenv from 'dotenv';
import { defineConfig } from 'vitest/config';

// Load server/.env, then point this test run at the dedicated certiflow_test database.
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
const baseUrl = process.env.DATABASE_URL ?? 'postgresql://certiflow:certiflow_dev@127.0.0.1:5432/certiflow';
const testDatabaseUrl = baseUrl.replace(/\/([^/?]+)(\?.*)?$/, (_match, _db, tail) => `/certiflow_test${tail ?? ''}`);
process.env.TEST_DATABASE_URL = testDatabaseUrl;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testDatabaseUrl,
      QUEUE_MODE: 'sync',
      // mixed mode: phone ending 7 = permanent failure, 8 = timeout, 9 = temporary failure
      WHATSAPP_MODE: 'mixed',
      WHATSAPP_MAX_ATTEMPTS: '3',
      STORAGE_DIR: './storage-test/certificates',
      PUBLIC_BASE_URL: 'http://localhost:5173',
      JWT_SECRET: 'test-secret-certiflow',
    },
  },
});
