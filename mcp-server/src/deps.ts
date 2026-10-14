import type { Config } from './config.js';
import type { Store } from './store/db.js';
import type { TokenService } from './oauth/tokens.js';
import type { Logger } from './log.js';
import type { KeyPair } from './crypto/seal.js';

export interface Deps {
  cfg: Config;
  store: Store;
  tokens: TokenService;
  log: Logger;
  /** Present once keys are loaded; mail tools refuse to run without it. */
  keys?: KeyPair;
}
