import { existsSync } from 'node:fs';
import { loadConfig, type Config } from './config.js';
import { createLogger } from './log.js';
import { openStore } from './store/db.js';
import { TokenService } from './oauth/tokens.js';
import { readKeyPair } from './crypto/seal.js';
import type { Deps } from './deps.js';
import { join } from 'node:path';

export function buildDeps(env: NodeJS.ProcessEnv = process.env, { requireKeys = true } = {}): Deps {
  const cfg: Config = loadConfig(env);
  const log = createLogger(cfg.LOG_LEVEL, cfg.LOG_FILE);
  const store = openStore(cfg.DB_PATH);
  const tokens = new TokenService(cfg, store);
  const deps: Deps = { cfg, store, tokens, log };
  if (existsSync(join(cfg.KEYS_DIR, 'server.sk'))) {
    deps.keys = readKeyPair(cfg.KEYS_DIR);
  } else if (requireKeys) {
    throw new Error(`No key pair in ${cfg.KEYS_DIR}. Run: rc-connector keygen --out ${cfg.KEYS_DIR}`);
  } else {
    log.warn({ keysDir: cfg.KEYS_DIR }, 'no key pair found; mail tools disabled until keygen runs');
  }
  return deps;
}
