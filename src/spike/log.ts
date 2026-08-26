/**
 * Minimal structured logger with secret redaction (PRD 17, 18.3).
 *
 * The spike logs to stderr so that stdout stays clean for the interactive prompts.
 * Redaction is deliberately aggressive: an authenticated indexer download URL leaks an API
 * key in a query string, and a magnet link leaks what was downloaded.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Registered at startup so config secrets are scrubbed from any message that echoes them. */
const knownSecrets = new Set<string>();

/** Query-string keys whose values are secrets wherever they appear. */
const SECRET_QUERY_KEYS = ['apikey', 'api_key', 'apitoken', 'token', 'passkey', 'password', 'rss_key', 'authkey'];

/** Object keys whose values are never safe to log. */
const SECRET_FIELD_KEYS =
  /^(password|api[-_]?key|apikey|token|passkey|authkey|cookie|set-cookie|sid|secret|authorization)$/i;

export function registerSecret(secret: string | null | undefined): void {
  if (secret && secret.trim().length >= 4) knownSecrets.add(secret.trim());
}

/** Forget every registered secret. Test-only; the CLI registers once at startup. */
export function clearSecrets(): void {
  knownSecrets.clear();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Redact secrets from an arbitrary string: registered values, URLs, magnets, cookies. */
export function redactString(input: string): string {
  let out = input;

  for (const secret of knownSecrets) {
    out = out.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
  }

  // Magnet links identify the payload and often carry a tracker passkey.
  out = out.replace(/magnet:\?[^\s"']+/gi, 'magnet:?[REDACTED]');

  // Secret-bearing query parameters, wherever they appear in a URL.
  for (const key of SECRET_QUERY_KEYS) {
    out = out.replace(new RegExp(`([?&]${key}=)[^&\\s"']+`, 'gi'), '$1[REDACTED]');
  }

  // Indexer download URLs embed a per-user token in the path; keep only origin + path shape.
  out = out.replace(/\bhttps?:\/\/[^\s"']*\/(?:download|dl|torrent)\/[^\s"']+/gi, (match) => {
    try {
      const url = new URL(match);
      return `${url.origin}/${url.pathname.split('/')[1] ?? ''}/[REDACTED]`;
    } catch {
      return '[REDACTED_URL]';
    }
  });

  // Cookie headers, including qBittorrent's legacy and current session names.
  out = out.replace(/\b(QBT_SID_[A-Za-z0-9_-]+|SID|Cookie|Set-Cookie)\s*[:=]\s*[^;\s,]+/gi, '$1=[REDACTED]');

  return out;
}

/** Deep-redact a value for logging: secret-named keys blanked, strings scrubbed. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_FIELD_KEYS.test(key) ? '[REDACTED]' : redactValue(item, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
  child(component: string): Logger;
}

export function createLogger(level: LogLevel = 'info', component = 'spike'): Logger {
  const threshold = LEVEL_ORDER[level];

  const emit = (messageLevel: LogLevel, message: string, detail?: unknown): void => {
    if (LEVEL_ORDER[messageLevel] < threshold) return;
    const line = [
      new Date().toISOString(),
      messageLevel.toUpperCase().padEnd(5),
      `[${component}]`,
      redactString(message),
    ].join(' ');
    const suffix = detail === undefined ? '' : ` ${JSON.stringify(redactValue(detail))}`;
    process.stderr.write(`${line}${suffix}\n`);
  };

  return {
    debug: (message, detail) => emit('debug', message, detail),
    info: (message, detail) => emit('info', message, detail),
    warn: (message, detail) => emit('warn', message, detail),
    error: (message, detail) => emit('error', message, detail),
    child: (childComponent) => createLogger(level, childComponent),
  };
}

export function isLogLevel(value: string): value is LogLevel {
  return value in LEVEL_ORDER;
}
