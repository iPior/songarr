/**
 * End-to-end pipeline tests against the fake Prowlarr and qBittorrent servers.
 *
 * These drive the real `runPipeline` over real HTTP, with the two human decisions supplied
 * by a scripted prompter. They are the closest thing to the live run that can be executed
 * offline, and they are what proves the ordering guarantees the PRD cares about: the
 * torrent stays stopped until a file is confirmed, unwanted files are disabled *before* the
 * start, and nothing outside the ready root is ever written.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, describe } from 'node:test';
import { promisify } from 'node:util';

import { createLogger } from '../src/spike/log.ts';
import { createScriptedPrompter, PromptAbortedError, type Choice } from '../src/spike/prompt.ts';
import { ProwlarrClient } from '../src/spike/prowlarr.ts';
import { QbittorrentClient } from '../src/spike/qbittorrent.ts';
import { PipelineError, runPipeline, type PipelineInput } from '../src/spike/pipeline.ts';
import { fakeRelease, startFakeProwlarr, type FakeProwlarr } from './fakes/prowlarr.ts';
import { startFakeQbittorrent, type FakeFile, type FakeQbittorrent } from './fakes/qbittorrent.ts';

const execFileAsync = promisify(execFile);

const MB = 1024 * 1024;
const TORRENT_DIR = 'Daft Punk - Homework';
const TRACK = `${TORRENT_DIR}/07 - Around the World.flac`;

/** Silent logger: these tests assert on behaviour, not output. */
const logger = createLogger('error');

const closers: Array<() => Promise<void>> = [];
after(async () => {
  for (const close of closers) await close().catch(() => {});
});

interface Harness {
  prowlarr: FakeProwlarr;
  qbittorrent: FakeQbittorrent;
  downloadRoot: string;
  readyRoot: string;
  input: PipelineInput;
  deps: { prowlarr: ProwlarrClient; qbittorrent: QbittorrentClient; logger: typeof logger };
}

interface HarnessOptions {
  files?: FakeFile[];
  magnetOnly?: boolean;
  downloadReturnsHtml?: boolean;
  downloadRedirectsToMagnet?: boolean;
  webApiVersion?: string;
  pollsToComplete?: number;
  /** Skip materialising the completed file, to test the missing-source path. */
  skipMaterialise?: boolean;
  /** Write a non-audio file instead of real audio, to test ffprobe rejection. */
  materialiseGarbage?: boolean;
}

const ALBUM_FILES: FakeFile[] = [
  { name: `${TORRENT_DIR}/01 - Daftendirekt.flac`, size: 30 * MB, progress: 0, priority: 1 },
  { name: TRACK, size: 40 * MB, progress: 0, priority: 1 },
  { name: `${TORRENT_DIR}/08 - Around the World (Live).flac`, size: 45 * MB, progress: 0, priority: 1 },
  { name: `${TORRENT_DIR}/folder.jpg`, size: 200 * 1024, progress: 0, priority: 1 },
];

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const base = await mkdtemp(path.join(tmpdir(), 'songarr-e2e-'));
  const downloadRoot = path.join(base, 'downloads');
  const readyRoot = path.join(base, 'ready');
  await mkdir(downloadRoot);
  await mkdir(readyRoot);

  const files = options.files ?? ALBUM_FILES.map((file) => ({ ...file }));

  const qbittorrent = await startFakeQbittorrent({
    savePath: downloadRoot,
    addedFiles: files,
    addedMetadataPending: options.magnetOnly || options.downloadRedirectsToMagnet || false,
    webApiVersion: options.webApiVersion,
    pollsToComplete: options.pollsToComplete ?? 2,
    seedTorrents: [
      // A foreign torrent, so ownership filtering has something to exclude.
      {
        hash: 'f'.repeat(40),
        name: 'Some.TV.Show.S01E01',
        state: 'downloading',
        progress: 0.5,
        category: 'tv-sonarr',
        tags: '',
        save_path: '/downloads/tv',
        files: [],
        metadataPending: false,
      },
    ],
    // Materialise the file on disk the moment qBittorrent reports it complete.
    onFileComplete: async (file) => {
      if (options.skipMaterialise) return;
      const target = path.join(downloadRoot, file.name);
      await mkdir(path.dirname(target), { recursive: true });
      if (options.materialiseGarbage) {
        await writeFile(target, 'not audio at all\n'.repeat(200));
      } else {
        await execFileAsync('ffmpeg', [
          '-v',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=1',
          target,
        ]);
      }
    },
  });

  const prowlarr = await startFakeProwlarr({
    downloadReturnsHtml: options.downloadReturnsHtml ?? false,
    downloadRedirectsToMagnet: options.downloadRedirectsToMagnet ?? false,
    releases: (baseUrl) =>
      options.magnetOnly
        ? [
            fakeRelease(baseUrl, {
              downloadUrl: null,
              magnetUrl: 'magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dn=Homework',
            }),
          ]
        : [
            // A higher-seeded MP3 release, so ranking by quality preference is exercised.
            fakeRelease(baseUrl, {
              title: 'Daft Punk - Homework (1997) [MP3 320]',
              guid: 'guid-mp3',
              seeders: 200,
            }),
            fakeRelease(baseUrl),
          ],
  });

  closers.push(prowlarr.close, qbittorrent.close);

  const prowlarrClient = new ProwlarrClient({
    baseUrl: prowlarr.baseUrl,
    apiKey: 'fake-prowlarr-key',
    logger,
  });
  const qbittorrentClient = new QbittorrentClient({
    baseUrl: qbittorrent.baseUrl,
    username: 'admin',
    password: 'adminadmin',
    logger,
  });
  await qbittorrentClient.login();

  const input: PipelineInput = {
    request: { artist: 'Daft Punk', title: 'Around the World', version: null },
    preferredQuality: 'flac',
    category: 'songarr',
    downloadRoot,
    readyRoot,
    metadataTimeoutSec: 5,
    pollIntervalSec: 0.01 as number,
    stallTimeoutSec: 5,
    ffprobePath: 'ffprobe',
    sourceRecheckDelayMs: 1,
  };

  return {
    prowlarr,
    qbittorrent,
    downloadRoot,
    readyRoot,
    input,
    deps: { prowlarr: prowlarrClient, qbittorrent: qbittorrentClient, logger },
  };
}

/** Pick the first non-disabled choice - i.e. accept the recommendation. */
const acceptRecommended = (choices: readonly Choice<unknown>[]): number =>
  choices.findIndex((choice) => choice.recommended && !choice.disabled);

describe('acquisition pipeline (end to end)', () => {
  test('completes the whole flow and publishes a validated file', async () => {
    const h = await harness();

    const result = await runPipeline(h.input, {
      ...h.deps,
      prompter: createScriptedPrompter({ selections: [acceptRecommended, acceptRecommended] }),
    });

    // The FLAC release should have been recommended over the higher-seeded MP3 one.
    assert.match(result.release.title, /FLAC/);
    assert.equal(result.selectedFile.name, TRACK);
    assert.ok(result.probe, 'a full run must probe the file');
    assert.equal(result.probe.codec, 'flac');

    assert.ok(result.published, 'a full run must publish');
    assert.equal(result.published.readyPath, path.join(h.readyRoot, 'Daft Punk', 'Daft Punk - Around the World.flac'));
    assert.ok((await stat(result.published.readyPath)).size > 0);
  });

  test('adds the torrent stopped, from a .torrent file, and only starts it after priorities', async () => {
    const h = await harness();

    await runPipeline(h.input, {
      ...h.deps,
      prompter: createScriptedPrompter({ selections: [acceptRecommended, acceptRecommended] }),
    });

    assert.ok(h.prowlarr.downloads > 0, 'the .torrent file should have been fetched by Songarr');
    assert.ok(h.qbittorrent.calls.includes('add:file'), 'the torrent should be uploaded as bytes');
    assert.ok(h.qbittorrent.calls.includes('add:stopped'), 'the torrent must be added stopped');
    assert.ok(
      h.qbittorrent.calls.indexOf('createCategory') < h.qbittorrent.calls.indexOf('add'),
      'the Songarr category must be created before the torrent is added',
    );

    // The ordering guarantee: every filePrio call precedes the first start.
    const firstStart = h.qbittorrent.calls.indexOf('start');
    const lastPrio = h.qbittorrent.calls.lastIndexOf('filePrio');
    assert.ok(firstStart > lastPrio, `start (${firstStart}) must come after filePrio (${lastPrio})`);
  });

  test('disables every unwanted file and leaves exactly one enabled', async () => {
    const h = await harness();

    await runPipeline(h.input, {
      ...h.deps,
      prompter: createScriptedPrompter({ selections: [acceptRecommended, acceptRecommended] }),
    });

    const added = h.qbittorrent.added();
    assert.ok(added);
    const enabled = added.files.filter((file) => file.priority !== 0);
    assert.equal(enabled.length, 1);
    assert.equal(enabled[0]!.name, TRACK);
  });

  test('never touches a torrent owned by another application', async () => {
    const h = await harness();

    await runPipeline(h.input, {
      ...h.deps,
      prompter: createScriptedPrompter({ selections: [acceptRecommended, acceptRecommended] }),
    });

    const foreign = h.qbittorrent.torrents().find((t) => t.category === 'tv-sonarr');
    assert.ok(foreign);
    assert.equal(foreign.state, 'downloading', 'the Sonarr torrent must not have been stopped or started');
    assert.equal(foreign.progress, 0.5);
  });

  test('leaves the qBittorrent payload in place so seeding continues', async () => {
    const h = await harness();

    const result = await runPipeline(h.input, {
      ...h.deps,
      prompter: createScriptedPrompter({ selections: [acceptRecommended, acceptRecommended] }),
    });

    const sourcePath = path.join(h.downloadRoot, TRACK);
    assert.ok((await stat(sourcePath)).isFile(), 'the source must survive publication');
    assert.notEqual(result.published?.readyPath, sourcePath);
  });

  test('writes nothing outside the ready root and cleans up .processing', async () => {
    const h = await harness();

    await runPipeline(h.input, {
      ...h.deps,
      prompter: createScriptedPrompter({ selections: [acceptRecommended, acceptRecommended] }),
    });

    assert.deepEqual((await readdir(h.readyRoot)).sort(), ['.processing', 'Daft Punk']);
    assert.deepEqual(await readdir(path.join(h.readyRoot, '.processing')), []);
  });

  test('a magnet-only release is started for metadata, then stopped before file selection', async () => {
    const h = await harness({ magnetOnly: true });

    await runPipeline(h.input, {
      ...h.deps,
      prompter: createScriptedPrompter({ selections: [acceptRecommended, acceptRecommended] }),
    });

    assert.ok(h.qbittorrent.calls.includes('add:url'), 'a magnet-only release is added by URL');

    // start (for metadata) -> stop -> filePrio -> start (for real).
    const starts = h.qbittorrent.calls.reduce<number[]>((acc, call, i) => (call === 'start' ? [...acc, i] : acc), []);
    const stopIndex = h.qbittorrent.calls.indexOf('stop');
    const firstPrio = h.qbittorrent.calls.indexOf('filePrio');

    assert.equal(starts.length, 2, 'the torrent is started once for metadata and once to download');
    assert.ok(starts[0]! < stopIndex, 'the metadata start precedes the stop');
    assert.ok(stopIndex < firstPrio, 'priorities are set only after the torrent is stopped again');
    assert.ok(firstPrio < starts[1]!, 'the real start comes after priorities');
  });

  test('passes a Prowlarr magnet redirect directly to qBittorrent', async () => {
    const h = await harness({ downloadRedirectsToMagnet: true });

    await runPipeline(h.input, {
      ...h.deps,
      prompter: createScriptedPrompter({ selections: [acceptRecommended, acceptRecommended] }),
    });

    assert.ok(h.prowlarr.downloads > 0, 'Songarr follows the selected Prowlarr download endpoint');
    assert.ok(h.qbittorrent.calls.includes('add:url'), 'the redirected magnet is submitted as a URL');
    assert.ok(h.qbittorrent.calls.includes('stop'), 'the magnet is stopped again after metadata arrives');
  });

  test('never uploads a non-bencoded .torrent response as torrent bytes', async () => {
    const h = await harness({ downloadReturnsHtml: true });

    await runPipeline(h.input, {
      ...h.deps,
      prompter: createScriptedPrompter({ selections: [acceptRecommended, acceptRecommended] }),
    });

    // The indexer answered the .torrent request with an HTML page. Songarr must detect that
    // and hand qBittorrent the URL instead of uploading the HTML as a torrent.
    assert.ok(h.prowlarr.downloads > 0, 'the fetch was attempted');
    assert.ok(!h.qbittorrent.calls.includes('add:file'), 'HTML must not be uploaded as torrent bytes');
    assert.ok(h.qbittorrent.calls.includes('add:url'), 'it should fall back to adding by URL');
  });

  test('works against a qBittorrent 4.x WebAPI using pause/resume', async () => {
    const h = await harness({ webApiVersion: '2.9.3' });

    const result = await runPipeline(h.input, {
      ...h.deps,
      prompter: createScriptedPrompter({ selections: [acceptRecommended, acceptRecommended] }),
    });

    assert.ok(result.published);
    assert.ok((await stat(result.published.readyPath)).isFile());
  });

  test('refuses to publish over an existing ready file', async () => {
    const h = await harness();
    const destination = path.join(h.readyRoot, 'Daft Punk', 'Daft Punk - Around the World.flac');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, 'ALREADY HERE');

    await assert.rejects(
      () =>
        runPipeline(h.input, {
          ...h.deps,
          prompter: createScriptedPrompter({ selections: [acceptRecommended, acceptRecommended] }),
        }),
      (error: { code?: string }) => error.code === 'DESTINATION_EXISTS',
    );
  });

  test('rejects a completed file that is not really audio', async () => {
    const h = await harness({ materialiseGarbage: true });

    await assert.rejects(
      () =>
        runPipeline(h.input, {
          ...h.deps,
          prompter: createScriptedPrompter({ selections: [acceptRecommended, acceptRecommended] }),
        }),
      (error: { code?: string }) => error.code === 'FFPROBE_REJECTED' || error.code === 'NO_AUDIO_STREAM',
    );

    // Nothing reached the ready folder.
    const artistDirs = (await readdir(h.readyRoot)).filter((entry) => entry !== '.processing');
    assert.deepEqual(artistDirs, []);
  });

  test('reports a missing source file with actionable guidance', async () => {
    const h = await harness({ skipMaterialise: true });

    await assert.rejects(
      () =>
        runPipeline(h.input, {
          ...h.deps,
          prompter: createScriptedPrompter({ selections: [acceptRecommended, acceptRecommended] }),
        }),
      (error: { code?: string; message?: string }) =>
        error.code === 'SOURCE_MISSING' && /same download path/.test(error.message ?? ''),
    );
  });

  test('fails clearly when the torrent is removed mid-download', async () => {
    const h = await harness({ pollsToComplete: 1000 });

    const prompter = createScriptedPrompter({
      selections: [
        acceptRecommended,
        (choices) => {
          // Remove the torrent right after the file is confirmed.
          queueMicrotask(() => h.qbittorrent.removeAdded());
          return acceptRecommended(choices);
        },
      ],
    });

    await assert.rejects(
      () => runPipeline(h.input, { ...h.deps, prompter }),
      (error: { code?: string }) => error.code === 'TORRENT_MISSING',
    );
  });

  test('times out waiting for metadata that never arrives', async () => {
    const h = await harness({ files: [], magnetOnly: true });
    const input = { ...h.input, metadataTimeoutSec: 0.2 as number };

    await assert.rejects(
      () =>
        runPipeline(input, {
          ...h.deps,
          prompter: createScriptedPrompter({ selections: [acceptRecommended] }),
        }),
      (error: PipelineError) => error.code === 'METADATA_TIMEOUT',
    );
  });

  test('fails when the torrent holds no supported audio', async () => {
    const h = await harness({
      files: [
        { name: `${TORRENT_DIR}/cover.jpg`, size: 200 * 1024, progress: 0, priority: 1 },
        { name: `${TORRENT_DIR}/info.nfo`, size: 2048, progress: 0, priority: 1 },
      ],
    });

    await assert.rejects(
      () =>
        runPipeline(h.input, {
          ...h.deps,
          prompter: createScriptedPrompter({ selections: [acceptRecommended, acceptRecommended] }),
        }),
      (error: PipelineError) => error.code === 'NO_SUPPORTED_AUDIO',
    );
  });

  test('a non-audio file is offered but not selectable', async () => {
    const h = await harness();

    // Deliberately try to pick folder.jpg, which ranks last and must be disabled.
    const prompter = createScriptedPrompter({
      selections: [acceptRecommended, (choices) => choices.length - 1],
    });

    await assert.rejects(() => runPipeline(h.input, { ...h.deps, prompter }), PromptAbortedError);
  });

  test('--skip-publish stops after the download, leaving the ready root untouched', async () => {
    const h = await harness();
    const input = { ...h.input, skipPublish: true, readyRoot: null };

    const result = await runPipeline(input, {
      ...h.deps,
      prompter: createScriptedPrompter({ selections: [acceptRecommended, acceptRecommended] }),
    });

    // Steps 1-8 still ran in full.
    assert.equal(result.selectedFile.name, TRACK);
    assert.ok(h.qbittorrent.calls.includes('add:stopped'));
    assert.ok(h.qbittorrent.calls.indexOf('start') > h.qbittorrent.calls.lastIndexOf('filePrio'));

    const enabled = h.qbittorrent.added()!.files.filter((file) => file.priority !== 0);
    assert.equal(enabled.length, 1);

    // Steps 9 and 10 did not.
    assert.equal(result.probe, null);
    assert.equal(result.published, null);
    assert.deepEqual(await readdir(h.readyRoot), [], 'nothing may be written to the ready root');

    // The reported path is where the download host put the file.
    assert.ok(result.downloadedPath.endsWith(TRACK));
  });

  test('--skip-publish still works when the download root is not visible locally', async () => {
    const h = await harness();
    // A path that exists on the download host but not here - the remote-testing case.
    const input = { ...h.input, skipPublish: true, readyRoot: null };

    await assert.doesNotReject(() =>
      runPipeline(input, {
        ...h.deps,
        prompter: createScriptedPrompter({ selections: [acceptRecommended, acceptRecommended] }),
      }),
    );
  });

  test('refuses to publish when no ready root is configured', async () => {
    const h = await harness();
    const input = { ...h.input, readyRoot: null };

    await assert.rejects(
      () =>
        runPipeline(input, {
          ...h.deps,
          prompter: createScriptedPrompter({ selections: [acceptRecommended, acceptRecommended] }),
        }),
      (error: PipelineError) => error.code === 'READY_ROOT_REQUIRED',
    );
  });

  test('does not add a second torrent when one already carries the request tag', async () => {
    const h = await harness();

    await runPipeline(h.input, {
      ...h.deps,
      prompter: createScriptedPrompter({ selections: [acceptRecommended, acceptRecommended] }),
    });

    const addCount = h.qbittorrent.calls.filter((call) => call === 'add').length;
    assert.equal(addCount, 1);
    assert.equal(h.qbittorrent.torrents().filter((t) => t.category === 'songarr').length, 1);
  });
});
