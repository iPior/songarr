/**
 * A scriptable fake Prowlarr API v1 server.
 *
 * Serves a fixed result set and a minimal bencoded `.torrent` body, so the pipeline's
 * "fetch the torrent file ourselves" path is exercised for real. A release can be made
 * magnet-only to drive the fallback path.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRelease {
  guid: string;
  title: string;
  indexer: string;
  indexerId: number;
  size: number;
  publishDate: string;
  seeders: number;
  leechers: number;
  protocol: string;
  downloadUrl: string | null;
  magnetUrl: string | null;
  infoHash: string | null;
}

export interface FakeProwlarrOptions {
  apiKey?: string;
  /**
   * Releases to serve. A function receives the fake's own base URL, so download URLs can
   * point back at the server without knowing its port in advance.
   */
  releases: FakeRelease[] | ((baseUrl: string) => FakeRelease[]);
  /** Serve something that is not a bencoded torrent, e.g. an HTML error page. */
  downloadReturnsHtml?: boolean;
  version?: string;
}

export interface FakeProwlarr {
  baseUrl: string;
  close(): Promise<void>;
  /** Search queries received, for assertions. */
  queries: string[];
  /** Number of .torrent downloads served. */
  downloads: number;
}

/** The smallest well-formed bencoded dictionary that starts with the expected "d" byte. */
function bencodedTorrent(): Buffer {
  return Buffer.from('d8:announce9:http://x4:infod4:name9:track.flac6:lengthi1024eee', 'utf8');
}

export async function startFakeProwlarr(options: FakeProwlarrOptions): Promise<FakeProwlarr> {
  const apiKey = options.apiKey ?? 'fake-prowlarr-key';
  const queries: string[] = [];
  let downloads = 0;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.headers['x-api-key'] !== apiKey) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }

    if (url.pathname === '/api/v1/system/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ appName: 'Prowlarr', version: options.version ?? '1.30.2.4939' }));
      return;
    }

    if (url.pathname === '/api/v1/search') {
      queries.push(url.searchParams.get('query') ?? '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(releases));
      return;
    }

    if (url.pathname.startsWith('/download/')) {
      downloads += 1;
      if (options.downloadReturnsHtml) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>Rate limited</body></html>');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/x-bittorrent' });
      res.end(bencodedTorrent());
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`Unhandled route ${url.pathname}`);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  // Resolved after binding so release URLs can reference this server.
  const releases = typeof options.releases === 'function' ? options.releases(baseUrl) : options.releases;

  return {
    baseUrl,
    queries,
    get downloads() {
      return downloads;
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

/** Convenience builder for a torrent release served by the fake. */
export function fakeRelease(baseUrlPlaceholder: string, overrides: Partial<FakeRelease> = {}): FakeRelease {
  return {
    guid: 'guid-1',
    title: 'Daft Punk - Homework (1997) [FLAC]',
    indexer: 'FakeTracker',
    indexerId: 1,
    size: 400 * 1024 * 1024,
    publishDate: new Date(Date.now() - 86_400_000).toISOString(),
    seeders: 42,
    leechers: 3,
    protocol: 'torrent',
    downloadUrl: `${baseUrlPlaceholder}/download/guid-1`,
    magnetUrl: null,
    infoHash: null,
    ...overrides,
  };
}
