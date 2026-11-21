import { prisma } from '../src/lib/prisma';

const centres = [
  { code: 'PUN-C1', name: 'Pune Skills Academy', district: 'Pune' },
  { code: 'NAG-C1', name: 'Nagpur Vocational Institute', district: 'Nagpur' },
];

const users = [
  { name: 'Anika', email: 'anika@certiflow.test', role: 'TRAINING_CENTRE' as const, centreCode: 'PUN-C1' },
  { name: 'Dev', email: 'dev@certiflow.test', role: 'DISTRICT_OFFICER' as const, district: 'Pune' },
  { name: 'Meera', email: 'meera@certiflow.test', role: 'DISTRICT_OFFICER' as const, district: 'Pune' },
  { name: 'Kabir', email: 'kabir@certiflow.test', role: 'DISTRICT_OFFICER' as const, district: 'Nagpur' },
  { name: 'Neha', email: 'neha@certiflow.test', role: 'QUALITY_TEAM' as const },
  { name: 'Farah', email: 'farah@certiflow.test', role: 'STATE_OFFICE' as const },
];

async function main() {
  const centreIds = new Map<string, string>();
  for (const centre of centres) {
    const record = await prisma.trainingCentre.upsert({
      where: { code: centre.code },
      update: { name: centre.name, district: centre.district },
      create: centre,
    });
    centreIds.set(centre.code, record.id);
  }

  for (const user of users) {
    const trainingCentreId = user.centreCode ? centreIds.get(user.centreCode) : undefined;
    await prisma.user.upsert({
      where: { email: user.email },
      update: {
        name: user.name,
        role: user.role,
        district: user.district ?? null,
        trainingCentreId: trainingCentreId ?? null,
      },
      create: {
        name: user.name,
        email: user.email,
        role: user.role,
        district: user.district ?? null,
        trainingCentreId: trainingCentreId ?? null,
      },
    });
  }

  const seededUsers = await prisma.user.findMany({ orderBy: { name: 'asc' } });
  console.log('Seeded demo users:');
  for (const user of seededUsers) {
    console.log(
      `  ${user.name.padEnd(6)} ${user.role.padEnd(18)} district=${(user.district ?? '-').padEnd(7)} ${user.email}`,
    );
  }
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
