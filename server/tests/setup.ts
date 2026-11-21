import { afterAll, beforeEach } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { resetDatabase } from './helpers';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});
