/**
 * Spike configuration, read entirely from the environment.
 *
 * Nothing secret is committed: `npm run spike` loads `.env` via Node's own
 * `--env-file-if-exists`, and `.env` is gitignored. `.env.example` holds placeholders only.
 */

import { access, constants, stat } from 'node:fs/promises';
import path from 'node:path';

import { isLogLevel, registerSecret, type LogLevel } from './log.ts';
import { isQualityPreference, type QualityPreference } from './quality.ts';

export interface SpikeConfig {
  prowlarr: {
    baseUrl: string;
    apiKey: string;
  };
  qbittorrent: {
    baseUrl: string;
    username: string;
    password: string;
  };
  /** qBittorrent category Songarr owns. Ownership checks depend on it. */
  category: string;
  /**
   * Save path handed to qBittorrent *and* the root Songarr reads completed files from.
   * Remote path mapping is a PRD non-goal, so both services must see this same path.
   */
  downloadRoot: string;
  /** null when SONGARR_READY_ROOT is unset, which is only valid with --skip-publish. */
  readyRoot: string | null;
  preferredQuality: QualityPreference;
  metadataTimeoutSec: number;
  pollIntervalSec: number;
  /** Give up on a download that has made no progress for this long. */
  stallTimeoutSec: number;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  readonly code = 'CONFIG_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new ConfigError(`${key} is required. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

function optional(env: Env, key: string, fallback: string): string {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function positiveInt(env: Env, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${key} must be a positive integer, received "${raw}"`);
  }
  return value;
}

/** Strip a trailing slash so `${baseUrl}/api/v1/...` never doubles up. */
function normalizeBaseUrl(key: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${key} must be an absolute URL, received "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${key} must use http or https, received "${url.protocol}"`);
  }
  return url.toString().replace(/\/+$/, '');
}

function absolutePath(key: string, raw: string): string {
  if (!path.isAbsolute(raw)) {
    throw new ConfigError(`${key} must be an absolute path, received "${raw}"`);
  }
  return path.resolve(raw);
}

export function loadConfig(env: Env = process.env): SpikeConfig {
  const preferredQualityRaw = optional(env, 'SONGARR_PREFERRED_QUALITY', 'any');
  if (!isQualityPreference(preferredQualityRaw)) {
    throw new ConfigError(
      `SONGARR_PREFERRED_QUALITY must be one of flac, mp3_320, any - received "${preferredQualityRaw}"`,
    );
  }

  const logLevelRaw = optional(env, 'SONGARR_LOG_LEVEL', 'info');
  if (!isLogLevel(logLevelRaw)) {
    throw new ConfigError(
      `SONGARR_LOG_LEVEL must be one of debug, info, warn, error - received "${logLevelRaw}"`,
    );
  }

  const config: SpikeConfig = {
    prowlarr: {
      baseUrl: normalizeBaseUrl('PROWLARR_URL', required(env, 'PROWLARR_URL')),
      apiKey: required(env, 'PROWLARR_API_KEY'),
    },
    qbittorrent: {
      baseUrl: normalizeBaseUrl('QBITTORRENT_URL', required(env, 'QBITTORRENT_URL')),
      username: required(env, 'QBITTORRENT_USERNAME'),
      password: required(env, 'QBITTORRENT_PASSWORD'),
    },
    category: optional(env, 'SONGARR_CATEGORY', 'songarr'),
    downloadRoot: absolutePath('SONGARR_DOWNLOAD_ROOT', required(env, 'SONGARR_DOWNLOAD_ROOT')),
    readyRoot: env['SONGARR_READY_ROOT']?.trim()
      ? absolutePath('SONGARR_READY_ROOT', env['SONGARR_READY_ROOT']!.trim())
      : null,
    preferredQuality: preferredQualityRaw,
    metadataTimeoutSec: positiveInt(env, 'SONGARR_METADATA_TIMEOUT_SEC', 120),
    pollIntervalSec: positiveInt(env, 'SONGARR_POLL_INTERVAL_SEC', 5),
    stallTimeoutSec: positiveInt(env, 'SONGARR_STALL_TIMEOUT_SEC', 900),
    logLevel: logLevelRaw,
  };

  // Everything logged from here on has these scrubbed out of it.
  registerSecret(config.prowlarr.apiKey);
  registerSecret(config.qbittorrent.password);

  return config;
}

export interface VerifyPathsOptions {
  /**
   * Skip the local checks on both roots. Set when the spike drives a qBittorrent on another
   * host: the download root is that host's path, not one this machine can see, and the ready
   * root is unused. The paths are still sent to qBittorrent, which enforces its own end.
   */
  skipLocalChecks?: boolean;
}

/** Verify the configured roots exist and are writable before we add anything to qBittorrent. */
export async function verifyPaths(config: SpikeConfig, options: VerifyPathsOptions = {}): Promise<void> {
  if (options.skipLocalChecks) return;

  if (!config.readyRoot) {
    throw new ConfigError(
      'SONGARR_READY_ROOT is required. Copy .env.example to .env and fill it in, or pass ' +
        '--skip-publish to stop after the download.',
    );
  }

  for (const [key, dir] of [
    ['SONGARR_DOWNLOAD_ROOT', config.downloadRoot],
    ['SONGARR_READY_ROOT', config.readyRoot],
  ] as const) {
    let info;
    try {
      info = await stat(dir);
    } catch {
      throw new ConfigError(`${key} "${dir}" does not exist. Create it before running the spike.`);
    }
    if (!info.isDirectory()) {
      throw new ConfigError(`${key} "${dir}" is not a directory.`);
    }
    // The download root only needs reading; the ready root is written to.
    const mode = key === 'SONGARR_READY_ROOT' ? constants.W_OK | constants.X_OK : constants.R_OK | constants.X_OK;
    try {
      await access(dir, mode);
    } catch {
      throw new ConfigError(`${key} "${dir}" is not accessible with the required permissions.`);
    }
  }
}
