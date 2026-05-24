#!/usr/bin/env node
import '../server/load-env.js';
import { initializeDatabase, userDb } from '../server/database/db.js';
import { syncSavedRemoteHostSnapshot } from '../server/providers/remote-host/full-sync.js';

function parseArgs(argv) {
  const options = {
    username: null,
    hostId: null,
    label: null,
    host: null,
    outputDir: null,
    workspaceRoots: [],
    includePlatformSecrets: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const nextValue = argv[index + 1];

    if (token === '--username' && nextValue) {
      options.username = nextValue;
      index += 1;
      continue;
    }

    if (token === '--host-id' && nextValue) {
      options.hostId = nextValue;
      index += 1;
      continue;
    }

    if (token === '--label' && nextValue) {
      options.label = nextValue;
      index += 1;
      continue;
    }

    if (token === '--host' && nextValue) {
      options.host = nextValue;
      index += 1;
      continue;
    }

    if (token === '--output-dir' && nextValue) {
      options.outputDir = nextValue;
      index += 1;
      continue;
    }

    if (token === '--workspace-root' && nextValue) {
      options.workspaceRoots.push(nextValue);
      index += 1;
      continue;
    }

    if (token === '--include-platform-secrets') {
      options.includePlatformSecrets = true;
      continue;
    }

    if (token === '--help') {
      options.help = true;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return options;
}

function printHelp() {
  console.log(`
Usage:
  node scripts/remote-host-full-sync.js --label <saved-host-label> [options]
  node scripts/remote-host-full-sync.js --host-id <saved-host-id> [options]
  node scripts/remote-host-full-sync.js --host <saved-host-address> [options]

Options:
  --username <name>              Use a specific platform user. Defaults to the first active user.
  --workspace-root <path>        Restrict sync to specific saved remote workspace roots. Repeatable.
  --output-dir <path>            Write the snapshot bundle to this local directory.
  --include-platform-secrets     Include stored agent tokens and SSH secrets in platform-state.json.
  --help                         Show this help message.
`.trim());
}

async function resolveUser(username) {
  if (username) {
    const user = userDb.getUserByUsername(username);
    if (!user) {
      throw new Error(`Platform user not found: ${username}`);
    }
    return user;
  }

  const firstUser = userDb.getFirstUser();
  if (!firstUser) {
    throw new Error('No active platform user was found in the database');
  }

  return firstUser;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (!options.hostId && !options.label && !options.host) {
    throw new Error('A saved remote host identifier is required. Use --host-id, --label, or --host.');
  }

  await initializeDatabase();
  const user = await resolveUser(options.username);
  const result = await syncSavedRemoteHostSnapshot(
    user.id,
    {
      hostId: options.hostId,
      label: options.label,
      host: options.host,
    },
    {
      workspaceRoots: options.workspaceRoots,
      outputDir: options.outputDir,
      includePlatformSecrets: options.includePlatformSecrets,
    },
  );

  console.log(JSON.stringify({
    success: true,
    userId: user.id,
    username: user.username,
    ...result,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
