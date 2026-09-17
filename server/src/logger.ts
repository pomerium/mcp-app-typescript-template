import { Effect, Layer, Logger, LogLevel, ManagedRuntime } from 'effect';
import { appConfig, IS_DEV } from './config.js';

/**
 * Accepts pino-style level names (as documented in .env.example) plus
 * `silent`/`none` for fully quiet output (used by tests), and maps them onto
 * Effect's `LogLevel`.
 */
function parseLogLevel(level: string): LogLevel.LogLevel {
  switch (level.toLowerCase()) {
    case 'trace':
      return LogLevel.Trace;
    case 'debug':
      return LogLevel.Debug;
    case 'info':
      return LogLevel.Info;
    case 'warn':
    case 'warning':
      return LogLevel.Warning;
    case 'error':
      return LogLevel.Error;
    case 'fatal':
      return LogLevel.Fatal;
    case 'silent':
    case 'none':
      return LogLevel.None;
    default:
      return LogLevel.Info;
  }
}

const loggerLayer = Layer.merge(
  IS_DEV ? Logger.pretty : Logger.json,
  Logger.minimumLogLevel(parseLogLevel(appConfig.logLevel))
);

/**
 * Backs both the synchronous log helpers below and the Effect workflows in
 * server.ts (via `runtime.runPromise`), so every log line shares the same
 * level filtering and dev/prod formatting.
 */
export const runtime = ManagedRuntime.make(loggerLayer);

type LogFields = Record<string, unknown>;

function log(level: Effect.Effect<void>, fields: LogFields | undefined): void {
  runtime.runSync(fields ? level.pipe(Effect.annotateLogs(fields)) : level);
}

export const logTrace = (message: string, fields?: LogFields): void =>
  log(Effect.logTrace(message), fields);

export const logDebug = (message: string, fields?: LogFields): void =>
  log(Effect.logDebug(message), fields);

export const logInfo = (message: string, fields?: LogFields): void =>
  log(Effect.logInfo(message), fields);

export const logWarning = (message: string, fields?: LogFields): void =>
  log(Effect.logWarning(message), fields);

export const logError = (message: string, fields?: LogFields): void =>
  log(Effect.logError(message), fields);

export const logFatal = (message: string, fields?: LogFields): void =>
  log(Effect.logFatal(message), fields);
