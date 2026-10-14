import pino from 'pino';

export function createLogger(level: string, file?: string) {
  const redact = {
    paths: ['req.headers.authorization', 'authorization', 'sealed', 'password', 'code', 'refresh_token', 'access_token', 'token', 'client_secret'],
    censor: '[redacted]',
  };
  if (file) {
    return pino({ level, redact }, pino.destination({ dest: file, sync: false }));
  }
  return pino({ level, redact });
}

export type Logger = ReturnType<typeof createLogger>;
