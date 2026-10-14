#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { generateKeyPair, writeKeyPair, encodePublicKey, readKeyPair, seal } from './crypto/seal.js';
import { loadConfig } from './config.js';
import { openStore } from './store/db.js';
import { VERSION } from './version.js';

const USAGE = `rc-connector ${VERSION}

Usage:
  rc-connector keygen --out <dir> [--force]      Create server.sk / server.pk and print the public key
  rc-connector pubkey --keys <dir>               Print the public key of an existing key pair
  rc-connector migrate                           Create or upgrade the SQLite schema (uses DB_PATH)
  rc-connector purge [--audit-days 90]           Delete expired requests/tokens and old audit rows
  rc-connector seal --keys <dir> --text <s>      Seal a string (for tests / fixtures); prints base64
  rc-connector serve                             Start the HTTP server (same as node dist/server.js)
  rc-connector stdio --url <mcp-url> --token <t> Local stdio proxy for clients without HTTP support
  rc-connector --version | --help
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      keys: { type: 'string' },
      force: { type: 'boolean', default: false },
      text: { type: 'string' },
      url: { type: 'string' },
      token: { type: 'string' },
      'audit-days': { type: 'string' },
      version: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  const cmd = positionals[0];
  if (values.version) { console.log(VERSION); return 0; }
  if (values.help || !cmd) { console.log(USAGE); return cmd ? 0 : 1; }

  switch (cmd) {
    case 'keygen': {
      const out = values.out ?? process.env['KEYS_DIR'];
      if (!out) throw new Error('--out <dir> is required');
      const kp = await generateKeyPair();
      await writeKeyPair(out, kp, { force: values.force });
      console.log(`Key pair written to ${out}/server.sk (0600) and ${out}/server.pk`);
      console.log('');
      console.log('Public key for the Roundcube plugin config (rc_connector_server_pubkey):');
      console.log(encodePublicKey(kp.publicKey));
      return 0;
    }
    case 'pubkey': {
      const dir = values.keys ?? process.env['KEYS_DIR'];
      if (!dir) throw new Error('--keys <dir> is required');
      console.log(encodePublicKey(readKeyPair(dir).publicKey));
      return 0;
    }
    case 'migrate': {
      const cfg = loadConfig();
      const store = openStore(cfg.DB_PATH);
      const v = store.migrate();
      store.close();
      console.log(`schema at version ${v} (${cfg.DB_PATH})`);
      return 0;
    }
    case 'purge': {
      const cfg = loadConfig();
      const store = openStore(cfg.DB_PATH);
      const res = store.purge({ auditRetentionDays: Number(values['audit-days'] ?? 90) });
      store.close();
      console.log(JSON.stringify(res));
      return 0;
    }
    case 'seal': {
      const dir = values.keys ?? process.env['KEYS_DIR'];
      if (!dir || values.text === undefined) throw new Error('--keys <dir> and --text <s> are required');
      const kp = readKeyPair(dir);
      console.log(Buffer.from(await seal(values.text, kp.publicKey)).toString('base64'));
      return 0;
    }
    case 'serve': {
      const { startServer } = await import('./server.js');
      startServer();
      return -1; // keep running
    }
    case 'stdio': {
      const { runStdioProxy } = await import('./stdio.js');
      const url = values.url ?? process.env['RC_CONNECTOR_URL'];
      const token = values.token ?? process.env['RC_CONNECTOR_TOKEN'];
      if (!url || !token) throw new Error('--url and --token (or RC_CONNECTOR_URL / RC_CONNECTOR_TOKEN) are required');
      await runStdioProxy(url, token);
      return -1;
    }
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(USAGE);
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => { if (code >= 0) process.exit(code); })
  .catch((err: unknown) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
