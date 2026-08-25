/**
 * Prowlarr adapter (API v1).
 *
 * Only what the spike needs: a system-status probe for the connection test, a search, and
 * fetching the `.torrent` bytes for a chosen release. Deliberately not generalised to other
 * indexer managers (PRD 23.6).
 */

import { redactString, type Logger } from './log.ts';

/** Newznab/Torznab category 3000 is Audio. */
export const AUDIO_CATEGORY = 3000;

export class ProwlarrError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'ProwlarrError';
    this.code = code;
    this.status = status;
  }
}

/** The subset of a Prowlarr search result the spike uses. */
export interface ProwlarrRelease {
  guid: string;
  title: string;
  indexer: string;
  indexerId: number;
  size: number | null;
  publishDate: string | null;
  seeders: number | null;
  leechers: number | null;
  protocol: string;
  downloadUrl: string | null;
  magnetUrl: string | null;
  infoHash: string | null;
}

export interface ProwlarrSystemStatus {
  version: string;
  appName?: string;
}

export interface ProwlarrClientOptions {
  baseUrl: string;
  apiKey: string;
  logger: Logger;
  /** Per-request timeout. Search hits real indexers, so this is generous by default. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class ProwlarrClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ProwlarrClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.logger = options.logger.child('prowlarr');
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(pathname: string, params: Record<string, string> = {}): Promise<Response> {
    const url = new URL(`${this.baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    this.logger.debug('request', { url: redactString(url.toString()) });

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        // The API key goes in a header, never the query string, so it stays out of logs.
        headers: { 'X-Api-Key': this.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ProwlarrError('PROWLARR_UNREACHABLE', `Prowlarr is unreachable: ${reason}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new ProwlarrError('PROWLARR_UNAUTHORIZED', 'Prowlarr rejected the API key', response.status);
    }
    if (!response.ok) {
      const body = redactString((await response.text()).slice(0, 500));
      throw new ProwlarrError(
        'PROWLARR_ERROR',
        `Prowlarr returned ${response.status} for ${pathname}: ${body}`,
        response.status,
      );
    }

    return response;
  }

  /** Connection test (PRD 9.1.3). */
  async systemStatus(): Promise<ProwlarrSystemStatus> {
    const response = await this.request('/api/v1/system/status');
    const body = (await response.json()) as Record<string, unknown>;
    return {
      version: String(body['version'] ?? 'unknown'),
      appName: body['appName'] ? String(body['appName']) : undefined,
    };
  }

  /**
   * Search the configured indexers. Starts with the straightforward artist-and-title query
   * the PRD asks for (9.3); refining the query is a manual, user-driven action.
   */
  async search(query: string, options: { limit?: number } = {}): Promise<ProwlarrRelease[]> {
    const response = await this.request('/api/v1/search', {
      query,
      type: 'search',
      limit: String(options.limit ?? 100),
      categories: String(AUDIO_CATEGORY),
    });

    const body = (await response.json()) as unknown;
    if (!Array.isArray(body)) {
      throw new ProwlarrError('PROWLARR_BAD_RESPONSE', 'Prowlarr search did not return an array');
    }

    return body.map((raw) => normalizeRelease(raw as Record<string, unknown>));
  }

  /**
   * Download the `.torrent` bytes for a release.
   *
   * Songarr fetches these itself rather than handing qBittorrent a URL, because a torrent
   * added from a file already carries its metadata - which is what lets the torrent stay
   * stopped while the user picks a file. See docs/spike.md.
   */
  async fetchTorrentFile(release: ProwlarrRelease): Promise<Uint8Array> {
    if (!release.downloadUrl) {
      throw new ProwlarrError('RELEASE_HAS_NO_TORRENT_FILE', `Release "${release.title}" has no .torrent URL`);
    }

    this.logger.debug('fetching torrent file', { release: release.title });

    let response: Response;
    try {
      response = await this.fetchImpl(release.downloadUrl, {
        headers: { 'X-Api-Key': this.apiKey },
        redirect: 'follow',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ProwlarrError('TORRENT_FETCH_FAILED', `Could not fetch the .torrent file: ${reason}`);
    }

    if (!response.ok) {
      throw new ProwlarrError(
        'TORRENT_FETCH_FAILED',
        `Fetching the .torrent file returned ${response.status}`,
        response.status,
      );
    }

    const bytes = new Uint8Array(await response.arrayBuffer());

    // Some indexers answer a .torrent request with an HTML error page or a magnet redirect.
    // A bencoded torrent always starts with "d" (a dictionary).
    if (bytes.length === 0 || bytes[0] !== 0x64) {
      throw new ProwlarrError(
        'TORRENT_FETCH_NOT_BENCODED',
        'The indexer did not return a bencoded .torrent file (it may be magnet-only)',
      );
    }

    return bytes;
  }
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeRelease(raw: Record<string, unknown>): ProwlarrRelease {
  return {
    guid: String(raw['guid'] ?? raw['downloadUrl'] ?? raw['title'] ?? ''),
    title: String(raw['title'] ?? 'Untitled release'),
    indexer: String(raw['indexer'] ?? 'unknown'),
    indexerId: numberOrNull(raw['indexerId']) ?? 0,
    size: numberOrNull(raw['size']),
    publishDate: raw['publishDate'] ? String(raw['publishDate']) : null,
    seeders: numberOrNull(raw['seeders']),
    leechers: numberOrNull(raw['leechers']),
    protocol: String(raw['protocol'] ?? 'unknown'),
    downloadUrl: raw['downloadUrl'] ? String(raw['downloadUrl']) : null,
    magnetUrl: raw['magnetUrl'] ? String(raw['magnetUrl']) : null,
    infoHash: raw['infoHash'] ? String(raw['infoHash']) : null,
  };
}

/** The straightforward starting query from PRD 9.3. */
export function buildSearchQuery(request: { artist: string; title: string; version?: string | null }): string {
  return [request.artist, request.title, request.version].filter(Boolean).join(' ').trim();
}
