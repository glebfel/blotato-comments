import type pino from 'pino';

/** Minimal logging port so services do not depend on a concrete logger. */
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export function fromPino(log: pino.Logger): Logger {
  return {
    info: (msg, meta) => log.info(meta ?? {}, msg),
    warn: (msg, meta) => log.warn(meta ?? {}, msg),
    error: (msg, meta) => log.error(meta ?? {}, msg),
  };
}
