import { execFileSync } from 'node:child_process';
import path from 'node:path';

const serverDir = path.resolve(process.cwd());

export default function globalSetup() {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('TEST_DATABASE_URL was not resolved by vitest.config.ts');
  }
  console.log(`[tests] applying Prisma migrations to ${databaseUrl.replace(/:[^:@/]+@/, ':***@')}`);
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: serverDir,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}
