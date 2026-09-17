import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { Config, Effect } from 'effect';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..', '..');

// The repo-root .env is the single source of dev config (the widget dev
// server reads it via Vite's envDir too). `npm run dev` runs this process
// with cwd=server/, so dotenv's default lookup would miss it. This must run
// before the Config values below are read.
loadDotenv({ path: path.resolve(ROOT_DIR, '.env') });

const AppConfig = Config.all({
  port: Config.integer('PORT').pipe(Config.withDefault(8080)),
  nodeEnv: Config.string('NODE_ENV').pipe(Config.withDefault('development')),
  logLevel: Config.string('LOG_LEVEL').pipe(Config.withDefault('info')),
  corsOrigin: Config.string('CORS_ORIGIN').pipe(Config.withDefault('*')),
  widgetPort: Config.integer('WIDGET_PORT').pipe(Config.withDefault(4444)),
  baseUrl: Config.string('BASE_URL').pipe(Config.withDefault('')),
});

export const appConfig = Effect.runSync(AppConfig);

export const IS_DEV = appConfig.nodeEnv === 'development';
export const ASSETS_DIR = path.resolve(ROOT_DIR, 'assets');
