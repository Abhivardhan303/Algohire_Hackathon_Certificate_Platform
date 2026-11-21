#!/usr/bin/env node
/**
 * One-time local database setup (Windows, no Docker).
 *
 * - asks for your PostgreSQL superuser password (typed in this terminal, never stored)
 * - creates the application role + databases (certiflow, certiflow_test)
 * - writes DATABASE_URL into server/.env
 * - runs Prisma migrations and seeds the demo users
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const readline = require('node:readline');

const HOST = process.env.PG_HOST || '127.0.0.1';
const PORT = process.env.PG_PORT || '5432';
const SUPERUSER = process.env.PG_SUPERUSER || 'postgres';
const APP_USER = process.env.PG_APP_USER || 'certiflow';
const APP_PASSWORD = process.env.PG_APP_PASSWORD || 'certiflow_dev';
const APP_DB = process.env.PG_APP_DB || 'certiflow';
const TEST_DB = `${APP_DB}_test`;
const SERVER_DIR = path.resolve(__dirname, '..', 'server');

function findPsql() {
  if (process.env.PSQL_PATH && fs.existsSync(process.env.PSQL_PATH)) return process.env.PSQL_PATH;
  const roots = ['C:\\Program Files\\PostgreSQL', 'C:\\Program Files (x86)\\PostgreSQL'];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const version of fs.readdirSync(root).sort().reverse()) {
      const candidate = path.join(root, version, 'bin', 'psql.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return 'psql';
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const original = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (text) => {
      if (text.includes(question)) process.stdout.write(text);
    };
    rl.question(question, (answer) => {
      rl._writeToOutput = original;
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

function psql(psqlPath, password, args) {
  const result = spawnSync(
    psqlPath,
    ['-h', HOST, '-p', PORT, '-U', SUPERUSER, '-v', 'ON_ERROR_STOP=1', ...args],
    { env: { ...process.env, PGPASSWORD: password }, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || '').trim();
    throw new Error(`psql failed (exit ${result.status}): ${message}`);
  }
  return (result.stdout || '').trim();
}

function run(command, args, env) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: SERVER_DIR, stdio: 'inherit', shell: true, env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function main() {
  const psqlPath = findPsql();
  console.log('CertiFlow local database setup (PostgreSQL, no Docker)');
  console.log(`  psql:        ${psqlPath}`);
  console.log(`  server:      ${HOST}:${PORT}`);
  console.log(`  app role:    ${APP_USER}`);
  console.log(`  databases:   ${APP_DB}, ${TEST_DB}\n`);

  const password = process.env.PGPASSWORD || (await promptHidden(`Password for PostgreSQL superuser "${SUPERUSER}": `));
  if (!password) {
    console.error('No password provided.');
    process.exit(1);
  }

  try {
    psql(psqlPath, password, ['-d', 'postgres', '-tAc', 'SELECT 1']);
  } catch (error) {
    console.error(`\nCould not connect as "${SUPERUSER}". ${error.message}`);
    console.error('Check the password and that the PostgreSQL Windows service is running (Get-Service postgresql*).');
    process.exit(1);
  }

  const roleSql = [
    `DO $$ BEGIN`,
    `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_USER}') THEN`,
    `    CREATE ROLE ${APP_USER} LOGIN CREATEDB PASSWORD '${APP_PASSWORD}';`,
    `  ELSE`,
    `    ALTER ROLE ${APP_USER} WITH LOGIN CREATEDB PASSWORD '${APP_PASSWORD}';`,
    `  END IF;`,
    `END $$;`,
  ].join('\n');
  psql(psqlPath, password, ['-d', 'postgres', '-c', roleSql]);
  console.log(`Role "${APP_USER}" ready.`);

  for (const db of [APP_DB, TEST_DB]) {
    const exists = psql(psqlPath, password, [
      '-d',
      'postgres',
      '-tAc',
      `SELECT 1 FROM pg_database WHERE datname = '${db}'`,
    ]);
    if (exists !== '1') {
      psql(psqlPath, password, ['-d', 'postgres', '-c', `CREATE DATABASE ${db} OWNER ${APP_USER}`]);
      console.log(`Database "${db}" created.`);
    } else {
      console.log(`Database "${db}" already exists.`);
    }
    psql(psqlPath, password, ['-d', db, '-c', `ALTER SCHEMA public OWNER TO ${APP_USER}`]);
  }

  const databaseUrl = `postgresql://${APP_USER}:${APP_PASSWORD}@${HOST}:${PORT}/${APP_DB}`;
  const envPath = path.join(SERVER_DIR, '.env');
  let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  if (/^DATABASE_URL=.*$/m.test(envContent)) {
    envContent = envContent.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${databaseUrl}`);
  } else {
    envContent += `\nDATABASE_URL=${databaseUrl}\n`;
  }
  if (!/:5432\//.test(databaseUrl)) {
    console.warn('Note: non-default port in use - update REDIS_PORT/PORT settings if needed.');
  }
  fs.writeFileSync(envPath, envContent, 'utf8');
  console.log(`\nserver/.env updated with DATABASE_URL=${databaseUrl}`);

  const env = { ...process.env, DATABASE_URL: databaseUrl, PGPASSWORD: '' };
  run('npx', ['prisma', 'generate'], env);

  // Create the initial migration from the schema without needing a shadow database
  // (works even when the role cannot create databases).
  const migrationsDir = path.join(SERVER_DIR, 'prisma', 'migrations');
  const initMigration = path.join(migrationsDir, '0_init', 'migration.sql');
  if (!fs.existsSync(initMigration)) {
    fs.mkdirSync(path.dirname(initMigration), { recursive: true });
    fs.writeFileSync(path.join(migrationsDir, 'migration_lock.toml'), 'provider = "postgresql"\n', 'utf8');
    run(
      'npx',
      [
        'prisma',
        'migrate',
        'diff',
        '--from-empty',
        '--to-schema-datamodel',
        'prisma/schema.prisma',
        '--script',
        '--output',
        'prisma/migrations/0_init/migration.sql',
      ],
      env,
    );
  }

  run('npx', ['prisma', 'migrate', 'deploy'], env);
  run('npx', ['tsx', 'prisma/seed.ts'], env);

  console.log('\nDatabase setup complete.');
  console.log(`  Development DB: ${databaseUrl}`);
  console.log(`  Test DB:        ${databaseUrl.replace(`/${APP_DB}`, `/${TEST_DB}`)}`);
  console.log('\nNext: npm run dev (API + frontend) and optionally the workers when Redis is running.');
}

main().catch((error) => {
  console.error('\nSetup failed:', error.message);
  process.exit(1);
});
