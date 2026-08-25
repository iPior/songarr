/**
 * A scriptable fake qBittorrent WebAPI v2 server.
 *
 * Models the behaviour the pipeline actually depends on, including the awkward parts:
 *
 *  - A stopped magnet torrent has NO file list. Only starting it produces metadata, which
 *    is the constraint that shapes the whole add-and-inspect flow.
 *  - A torrent added from `.torrent` bytes has its file list immediately, while stopped.
 *  - Per-file priorities gate which files make progress.
 *  - Foreign torrents (Sonarr/Radarr) are present, so the ownership rules are exercised
 *    against a realistic listing rather than an empty one.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeFile {
  name: string;
  size: number;
  progress: number;
  priority: number;
}

export interface FakeTorrent {
  hash: string;
  name: string;
  state: string;
  progress: number;
  category: string;
  tags: string;
  save_path: string;
  /** Files revealed once metadata is available. */
  files: FakeFile[];
  /** When true, the file list stays hidden until the torrent is started (magnet behaviour). */
  metadataPending: boolean;
}

export interface FakeQbittorrentOptions {
  username?: string;
  password?: string;
  webApiVersion?: string;
  appVersion?: string;
  savePath: string;
  /** Torrents that already exist, e.g. Sonarr's. */
  seedTorrents?: FakeTorrent[];
  /** Files a newly added torrent will have. */
  addedFiles: FakeFile[];
  /** Simulate a magnet: no file list until started. */
  addedMetadataPending?: boolean;
  /** How many polls of a started, enabled file it takes to reach full progress. */
  pollsToComplete?: number;
  /** Called when a file reaches full progress, so the test can materialise it on disk. */
  onFileComplete?: (file: FakeFile, torrent: FakeTorrent) => void | Promise<void>;
}

export interface FakeQbittorrent {
  baseUrl: string;
  close(): Promise<void>;
  /** Everything the fake currently holds, for assertions. */
  torrents(): FakeTorrent[];
  /** The torrent the pipeline added, if any. */
  added(): FakeTorrent | undefined;
  /** Ordered log of mutating calls, for asserting the sequence of operations. */
  calls: string[];
  /** Remove a torrent mid-run, simulating manual deletion. */
  removeAdded(): void;
  /** Force a state, simulating an error or a stall. */
  setAddedState(state: string): void;
}

/**
 * Real qBittorrent enables CSRF protection by default and rejects any request carrying
 * neither an Origin nor a Referer header, treating it as cross-site. The fake enforces the
 * same rule so a client that forgets those headers fails here rather than on a live server.
 */
function isCrossSiteRequest(req: import('node:http').IncomingMessage, baseUrl: string): boolean {
  const origin = req.headers['origin'];
  const referer = req.headers['referer'];
  if (!origin && !referer) return true;
  return ![origin, referer].some((value) => value && value.startsWith(baseUrl));
}

const SESSION_ID = 'fake-session-id';

export async function startFakeQbittorrent(options: FakeQbittorrentOptions): Promise<FakeQbittorrent> {
  const username = options.username ?? 'admin';
  const password = options.password ?? 'adminadmin';
  const webApiVersion = options.webApiVersion ?? '2.11.2';
  const pollsToComplete = options.pollsToComplete ?? 2;

  const torrents: FakeTorrent[] = [...(options.seedTorrents ?? [])];
  const calls: string[] = [];
  let addedHash: string | null = null;
  let progressPolls = 0;

  const findAdded = (): FakeTorrent | undefined => torrents.find((t) => t.hash === addedHash);

  /** Set once the server is listening, so the CSRF check can compare against it. */
  let selfUrl = '';

  const server: Server = createServer((req, res) => {
    void handle(req.url ?? '/', req, res);
  });

  async function readBody(req: import('node:http').IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  async function handle(
    rawUrl: string,
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    const url = new URL(rawUrl, 'http://localhost');
    const route = url.pathname;

    if (isCrossSiteRequest(req, selfUrl)) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }

    const text = (status: number, body: string): void => {
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end(body);
    };
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (route === '/api/v2/auth/login') {
      const body = new URLSearchParams((await readBody(req)).toString());
      if (body.get('username') !== username || body.get('password') !== password) {
        return text(200, 'Fails.');
      }
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Set-Cookie': `SID=${SESSION_ID}; HttpOnly; path=/`,
      });
      res.end('Ok.');
      return;
    }

    // Everything past login requires the session cookie.
    if (!(req.headers.cookie ?? '').includes(`SID=${SESSION_ID}`)) {
      return text(403, 'Forbidden');
    }

    if (route === '/api/v2/app/webapiVersion') return text(200, webApiVersion);
    if (route === '/api/v2/app/version') return text(200, options.appVersion ?? 'v5.0.4');

    if (route === '/api/v2/torrents/info') {
      const category = url.searchParams.get('category');
      const tag = url.searchParams.get('tag');
      const hashes = url.searchParams.get('hashes');

      let result = torrents;
      if (category !== null) result = result.filter((t) => t.category === category);
      if (tag !== null) result = result.filter((t) => t.tags.split(',').map((s) => s.trim()).includes(tag));
      if (hashes !== null) {
        const wanted = new Set(hashes.split('|').map((h) => h.toLowerCase()));
        result = result.filter((t) => wanted.has(t.hash.toLowerCase()));
      }
      return json(200, result.map(({ files, metadataPending, ...rest }) => rest));
    }

    if (route === '/api/v2/torrents/add') {
      calls.push('add');
      const body = (await readBody(req)).toString();
      // Crude multipart inspection - enough to record what was sent.
      const field = (name: string): string | null => {
        const match = body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`));
        return match ? match[1]! : null;
      };
      const isFileUpload = body.includes('name="torrents"');
      calls.push(isFileUpload ? 'add:file' : 'add:url');
      // Whichever spelling the client used, honour it.
      const stopped = field('stopped') === 'true' || field('paused') === 'true';
      calls.push(stopped ? 'add:stopped' : 'add:running');

      addedHash = 'a'.repeat(40);
      const metadataPending = options.addedMetadataPending ?? false;
      torrents.push({
        hash: addedHash,
        name: 'Added Release',
        state: stopped ? 'stoppedDL' : 'downloading',
        progress: 0,
        category: field('category') ?? '',
        tags: field('tags') ?? '',
        save_path: field('savepath') ?? options.savePath,
        files: options.addedFiles.map((file) => ({ ...file })),
        metadataPending,
      });
      return text(200, 'Ok.');
    }

    if (route === '/api/v2/torrents/files') {
      const hash = url.searchParams.get('hash') ?? '';
      const torrent = torrents.find((t) => t.hash.toLowerCase() === hash.toLowerCase());
      if (!torrent) return json(200, []);
      // A stopped magnet has no metadata yet, so no files.
      if (torrent.metadataPending) return json(200, []);

      // Advance progress for enabled files while the torrent is running.
      if (torrent.state === 'downloading') {
        progressPolls += 1;
        for (const file of torrent.files) {
          if (file.priority === 0 || file.progress >= 1) continue;
          const next = Math.min(1, progressPolls / pollsToComplete);
          file.progress = next;
          if (next >= 1) await options.onFileComplete?.(file, torrent);
        }
      }

      return json(
        200,
        torrent.files.map((file, index) => ({
          index,
          name: file.name,
          size: file.size,
          progress: file.progress,
          priority: file.priority,
        })),
      );
    }

    if (route === '/api/v2/torrents/filePrio') {
      calls.push('filePrio');
      const body = new URLSearchParams((await readBody(req)).toString());
      const torrent = torrents.find((t) => t.hash.toLowerCase() === (body.get('hash') ?? '').toLowerCase());
      if (!torrent) return text(404, 'Not found');
      const priority = Number(body.get('priority'));
      for (const raw of (body.get('id') ?? '').split('|')) {
        const file = torrent.files[Number(raw)];
        if (file) file.priority = priority;
      }
      return text(200, 'Ok.');
    }

    if (route === '/api/v2/torrents/start' || route === '/api/v2/torrents/resume') {
      calls.push('start');
      const body = new URLSearchParams((await readBody(req)).toString());
      const torrent = torrents.find((t) => t.hash.toLowerCase() === (body.get('hashes') ?? '').toLowerCase());
      if (torrent) {
        torrent.state = 'downloading';
        // Starting is what makes magnet metadata arrive.
        torrent.metadataPending = false;
      }
      return text(200, 'Ok.');
    }

    if (route === '/api/v2/torrents/stop' || route === '/api/v2/torrents/pause') {
      calls.push('stop');
      const body = new URLSearchParams((await readBody(req)).toString());
      const torrent = torrents.find((t) => t.hash.toLowerCase() === (body.get('hashes') ?? '').toLowerCase());
      if (torrent) torrent.state = 'stoppedDL';
      return text(200, 'Ok.');
    }

    return text(404, `Unhandled route ${route}`);
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  selfUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl: selfUrl,
    calls,
    torrents: () => torrents,
    added: () => findAdded(),
    removeAdded: () => {
      const index = torrents.findIndex((t) => t.hash === addedHash);
      if (index >= 0) torrents.splice(index, 1);
    },
    setAddedState: (state: string) => {
      const torrent = findAdded();
      if (torrent) torrent.state = state;
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}
