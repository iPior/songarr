/**
 * qBittorrent WebAPI v2 adapter.
 *
 * Two compatibility problems this deliberately absorbs, because the deployed qBittorrent
 * version is not something Songarr gets to choose:
 *
 *  - WebAPI 2.11 (qBittorrent 5.0) renamed pause/resume to stop/start and the `paused` add
 *    parameter to `stopped`. Both spellings are still accepted by 5.x, but 4.x knows only
 *    the old ones, so `resolveCapabilities` picks per version.
 *  - `files[].index` only exists from WebAPI 2.8.2. Before that the array position is the
 *    index, which is exactly what `filePrio` expects anyway.
 *
 * Every mutating call goes through the ownership guard first (PRD 20.6).
 */

import { assertOwned, selectOwned, type OwnableTorrent, type OwnershipClaim } from './ownership.ts';
import { redactString, type Logger } from './log.ts';

export class QbittorrentError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'QbittorrentError';
    this.code = code;
    this.status = status;
  }
}

/** qBittorrent per-file priorities. 0 is the "do not download" the PRD relies on. */
export const FilePriority = {
  DoNotDownload: 0,
  Normal: 1,
  High: 6,
  Maximum: 7,
} as const;

export interface TorrentInfo extends OwnableTorrent {
  hash: string;
  name: string;
  state: string;
  progress: number;
  category: string;
  tags: string;
  save_path: string;
  content_path?: string;
  amount_left?: number;
  downloaded?: number;
  dlspeed?: number;
}

export interface TorrentFile {
  index: number;
  name: string;
  size: number;
  progress: number;
  priority: number;
}

export interface Capabilities {
  webApiVersion: string;
  /** WebAPI >= 2.11: `start`/`stop` instead of `resume`/`pause`. */
  startEndpoint: 'start' | 'resume';
  stopEndpoint: 'stop' | 'pause';
  /** WebAPI >= 2.11: the add parameter is `stopped`, not `paused`. */
  addStoppedParam: 'stopped' | 'paused';
  /** WebAPI >= 2.8.2: `files[].index` is present rather than implied by array position. */
  filesHaveIndex: boolean;
}

/** Compare dotted numeric versions. Returns <0, 0 or >0 like a comparator. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function resolveCapabilities(webApiVersion: string): Capabilities {
  const modernLifecycle = compareVersions(webApiVersion, '2.11.0') >= 0;
  return {
    webApiVersion,
    startEndpoint: modernLifecycle ? 'start' : 'resume',
    stopEndpoint: modernLifecycle ? 'stop' : 'pause',
    addStoppedParam: modernLifecycle ? 'stopped' : 'paused',
    filesHaveIndex: compareVersions(webApiVersion, '2.8.2') >= 0,
  };
}

export interface AddTorrentOptions {
  category: string;
  tag: string;
  savePath: string;
  /** Raw `.torrent` bytes. Preferred: metadata is present immediately while stopped. */
  torrentFile?: Uint8Array | null;
  /** Magnet or `.torrent` URL. Fallback only - a stopped magnet fetches no metadata. */
  url?: string | null;
}

export interface QbittorrentClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  logger: Logger;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class QbittorrentClient {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  /** qBittorrent authenticates with an SID cookie; we keep it rather than re-logging in. */
  private cookie: string | null = null;
  private capabilities: Capabilities | null = null;

  constructor(options: QbittorrentClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.username = options.username;
    this.password = options.password;
    this.logger = options.logger.child('qbittorrent');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async call(
    pathname: string,
    init: { method?: 'GET' | 'POST'; body?: FormData | URLSearchParams; params?: Record<string, string> } = {},
    retryOnAuthFailure = true,
  ): Promise<Response> {
    const url = new URL(`${this.baseUrl}/api/v2${pathname}`);
    for (const [key, value] of Object.entries(init.params ?? {})) url.searchParams.set(key, value);

    // qBittorrent's CSRF protection (on by default) treats a request carrying neither an
    // Origin nor a Referer header as cross-site and rejects it. Both must match the Web UI's
    // own address, so they are sent on every request rather than only on login.
    const headers: Record<string, string> = { Referer: this.baseUrl, Origin: this.baseUrl };
    if (this.cookie) headers['Cookie'] = this.cookie;

    this.logger.debug('request', { method: init.method ?? 'GET', path: pathname });

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: init.method ?? 'GET',
        headers,
        body: init.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new QbittorrentError('QBITTORRENT_UNREACHABLE', `qBittorrent is unreachable: ${reason}`);
    }

    // A stale SID looks like a 403; log in once more before giving up.
    if (response.status === 403 && retryOnAuthFailure) {
      this.logger.debug('session expired, re-authenticating');
      this.cookie = null;
      await this.login();
      return this.call(pathname, init, false);
    }

    if (response.status === 403) {
      throw new QbittorrentError('QBITTORRENT_UNAUTHORIZED', 'qBittorrent rejected the session', 403);
    }
    if (!response.ok) {
      const body = redactString((await response.text()).slice(0, 500));
      throw new QbittorrentError(
        'QBITTORRENT_ERROR',
        `qBittorrent returned ${response.status} for ${pathname}: ${body}`,
        response.status,
      );
    }

    return response;
  }

  async login(): Promise<void> {
    const body = new URLSearchParams({ username: this.username, password: this.password });

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/v2/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: this.baseUrl,
          Origin: this.baseUrl,
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new QbittorrentError('QBITTORRENT_UNREACHABLE', `qBittorrent is unreachable: ${reason}`);
    }

    if (response.status === 403) {
      throw new QbittorrentError(
        'QBITTORRENT_BANNED',
        'qBittorrent has temporarily banned this client after too many failed logins',
        403,
      );
    }

    const text = (await response.text()).trim();
    if (!response.ok || text.toLowerCase().startsWith('fail')) {
      throw new QbittorrentError('QBITTORRENT_UNAUTHORIZED', 'qBittorrent rejected the username or password');
    }

    const setCookie = response.headers.get('set-cookie');
    const sid = setCookie?.match(/SID=([^;]+)/)?.[1];
    if (sid) {
      this.cookie = `SID=${sid}`;
    } else if (text.toLowerCase() === 'ok.') {
      // Bypassed auth for localhost is configured; no cookie is issued and none is needed.
      this.logger.debug('logged in without a session cookie (auth bypass is enabled)');
      this.cookie = null;
    } else {
      throw new QbittorrentError('QBITTORRENT_NO_SESSION', 'qBittorrent did not return a session cookie');
    }

    this.logger.info('authenticated');
  }

  async webApiVersion(): Promise<string> {
    const response = await this.call('/app/webapiVersion');
    return (await response.text()).trim();
  }

  async appVersion(): Promise<string> {
    const response = await this.call('/app/version');
    return (await response.text()).trim();
  }

  /** Detected once and cached; every version-dependent call reads it. */
  async getCapabilities(): Promise<Capabilities> {
    if (!this.capabilities) {
      this.capabilities = resolveCapabilities(await this.webApiVersion());
      this.logger.debug('resolved capabilities', this.capabilities);
    }
    return this.capabilities;
  }

  /** Torrents matching a category and/or tag. Never called without at least one filter. */
  async listTorrents(filter: { category?: string; tag?: string; hashes?: string }): Promise<TorrentInfo[]> {
    const params: Record<string, string> = {};
    if (filter.category !== undefined) params['category'] = filter.category;
    if (filter.tag !== undefined) params['tag'] = filter.tag;
    if (filter.hashes !== undefined) params['hashes'] = filter.hashes;

    const response = await this.call('/torrents/info', { params });
    const body = (await response.json()) as unknown;
    if (!Array.isArray(body)) {
      throw new QbittorrentError('QBITTORRENT_BAD_RESPONSE', '/torrents/info did not return an array');
    }
    return body as TorrentInfo[];
  }

  /**
   * Add a torrent in the stopped state, under our category and unique tag.
   *
   * Prefers the raw `.torrent` bytes so the file list is available while stopped. Falls back
   * to a URL (typically a magnet), for which the caller must handle metadata separately.
   */
  async addTorrent(options: AddTorrentOptions): Promise<void> {
    const capabilities = await this.getCapabilities();
    const form = new FormData();

    form.set('category', options.category);
    form.set('tags', options.tag);
    form.set('savepath', options.savePath);
    // Automatic torrent management would override savepath with the category's own path.
    form.set('autoTMM', 'false');
    form.set(capabilities.addStoppedParam, 'true');
    // Keep both spellings: 5.x accepts the legacy one, and this survives a downgrade.
    form.set(capabilities.addStoppedParam === 'stopped' ? 'paused' : 'stopped', 'true');

    if (options.torrentFile) {
      form.set(
        'torrents',
        new Blob([options.torrentFile], { type: 'application/x-bittorrent' }),
        'release.torrent',
      );
    } else if (options.url) {
      form.set('urls', options.url);
    } else {
      throw new QbittorrentError('ADD_TORRENT_NO_SOURCE', 'Neither torrent bytes nor a URL were provided');
    }

    const response = await this.call('/torrents/add', { method: 'POST', body: form });
    const text = (await response.text()).trim();
    if (text.toLowerCase().startsWith('fail')) {
      throw new QbittorrentError('ADD_TORRENT_REJECTED', 'qBittorrent refused to add the torrent');
    }

    this.logger.info('torrent submitted', { category: options.category, tag: options.tag });
  }

  /**
   * Find our torrent by its unique tag (PRD 9.4). Returns null while it is still being
   * added; throws if the tag matched more than one torrent.
   */
  async findOwnedTorrent(claim: OwnershipClaim): Promise<TorrentInfo | null> {
    const torrents = await this.listTorrents({ category: claim.category, tag: claim.tag });
    return selectOwned(torrents, claim) as TorrentInfo | null;
  }

  /** Re-read our torrent by hash, still proving ownership. Null when it has been removed. */
  async getOwnedTorrent(claim: OwnershipClaim & { hash: string }): Promise<TorrentInfo | null> {
    const torrents = await this.listTorrents({ hashes: claim.hash });
    const match = torrents.find((torrent) => torrent.hash.toLowerCase() === claim.hash.toLowerCase());
    if (!match) return null;
    assertOwned(match, claim);
    return match;
  }

  /**
   * List a torrent's files. Empty while magnet metadata is still pending.
   * Fills in `index` from the array position on pre-2.8.2 WebAPI.
   */
  async listFiles(claim: OwnershipClaim & { hash: string }): Promise<TorrentFile[]> {
    // Reading is harmless, but proving ownership first keeps the rule uniform.
    const torrent = await this.getOwnedTorrent(claim);
    if (!torrent) {
      throw new QbittorrentError('TORRENT_MISSING', `Torrent ${claim.hash} is no longer in qBittorrent`);
    }

    const response = await this.call('/torrents/files', { params: { hash: claim.hash } });
    const body = (await response.json()) as unknown;
    if (!Array.isArray(body)) {
      throw new QbittorrentError('QBITTORRENT_BAD_RESPONSE', '/torrents/files did not return an array');
    }

    return body.map((raw, position) => {
      const file = raw as Record<string, unknown>;
      return {
        index: typeof file['index'] === 'number' ? (file['index'] as number) : position,
        name: String(file['name'] ?? ''),
        size: Number(file['size'] ?? 0),
        progress: Number(file['progress'] ?? 0),
        priority: Number(file['priority'] ?? FilePriority.Normal),
      };
    });
  }

  /** Set one priority across a set of file indices (PRD 9.5). */
  async setFilePriority(
    claim: OwnershipClaim & { hash: string },
    indices: readonly number[],
    priority: number,
  ): Promise<void> {
    if (indices.length === 0) return;

    const torrent = await this.getOwnedTorrent(claim);
    if (!torrent) {
      throw new QbittorrentError('TORRENT_MISSING', `Torrent ${claim.hash} is no longer in qBittorrent`);
    }

    const body = new URLSearchParams({
      hash: claim.hash,
      id: indices.join('|'),
      priority: String(priority),
    });

    await this.call('/torrents/filePrio', {
      method: 'POST',
      body,
      // URLSearchParams sets the form content type itself.
    });

    this.logger.debug('set file priority', { count: indices.length, priority });
  }

  async start(claim: OwnershipClaim & { hash: string }): Promise<void> {
    await this.lifecycle(claim, 'start');
  }

  async stop(claim: OwnershipClaim & { hash: string }): Promise<void> {
    await this.lifecycle(claim, 'stop');
  }

  private async lifecycle(claim: OwnershipClaim & { hash: string }, action: 'start' | 'stop'): Promise<void> {
    const torrent = await this.getOwnedTorrent(claim);
    if (!torrent) {
      throw new QbittorrentError('TORRENT_MISSING', `Torrent ${claim.hash} is no longer in qBittorrent`);
    }

    const capabilities = await this.getCapabilities();
    const endpoint = action === 'start' ? capabilities.startEndpoint : capabilities.stopEndpoint;

    await this.call(`/torrents/${endpoint}`, {
      method: 'POST',
      body: new URLSearchParams({ hashes: claim.hash }),
    });

    this.logger.info(`torrent ${action}ed`, { hash: claim.hash });
  }
}

/** qBittorrent states that mean the torrent will never finish without intervention. */
const ERROR_STATES = new Set(['error', 'missingFiles', 'unknown']);

export function isErrorState(state: string): boolean {
  return ERROR_STATES.has(state);
}

/** States meaning "metadata is still being fetched", so the file list is legitimately empty. */
export function isMetadataState(state: string): boolean {
  return state === 'metaDL' || state === 'forcedMetaDL' || state === 'checkingResumeData';
}

/**
 * A file is done when qBittorrent reports full progress for it. Torrent-level progress is
 * the wrong signal: pieces straddle file boundaries, so the torrent may report extra bytes
 * downloaded and still never reach 100% with files disabled (PRD 9.5).
 */
export function isFileComplete(file: TorrentFile): boolean {
  return file.progress >= 1;
}
