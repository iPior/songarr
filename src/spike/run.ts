/**
 * Spike CLI entry point.
 *
 *   pnpm spike --artist "Daft Punk" --title "Around the World" --version "Radio Edit"
 *
 * See docs/spike.md for setup and what this does and does not prove.
 */

import { parseArgs } from 'node:util';
import process from 'node:process';

import { ConfigError, loadConfig, verifyPaths, type SpikeConfig } from './config.ts';
import { createLogger, type Logger } from './log.ts';
import { createTerminalPrompter, PromptAbortedError } from './prompt.ts';
import { ProwlarrClient } from './prowlarr.ts';
import { QbittorrentClient } from './qbittorrent.ts';
import { isQualityPreference, type QualityPreference } from './quality.ts';
import { runPipeline, PipelineError, type PipelineHandle } from './pipeline.ts';

const USAGE = `
Songarr acquisition-pipeline spike

Usage:
  pnpm spike --artist <artist> --title <title> [options]

Options:
  --artist <name>      Required. Requested artist.
  --title <name>       Required. Requested track title.
  --version <name>     Optional. e.g. "Radio Edit", "Extended Mix".
  --quality <pref>     flac | mp3_320 | any. Defaults to SONGARR_PREFERRED_QUALITY.
  --skip-publish       Stop once the download finishes: no ffprobe validation and no copy
                       into the ready folder. Use this when qBittorrent runs on another
                       machine whose download directory this one cannot see.
  --check              Test the Prowlarr and qBittorrent connections, then exit.
  --help               Show this message.

Configuration comes from the environment; copy .env.example to .env and fill it in.
`.trim();

interface CliOptions {
  artist: string;
  title: string;
  version: string | null;
  quality: QualityPreference | null;
  check: boolean;
  skipPublish: boolean;
}

function parseCliArgs(argv: readonly string[]): CliOptions | null {
  // `pnpm spike --check` is the native pnpm form, but npm-style invocations may include an
  // explicit separator (`pnpm spike -- --check`). pnpm forwards that separator to this
  // script, so discard only a leading standalone `--` and support both forms.
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];

  const { values } = parseArgs({
    args,
    options: {
      artist: { type: 'string' },
      title: { type: 'string' },
      version: { type: 'string' },
      quality: { type: 'string' },
      check: { type: 'boolean', default: false },
      'skip-publish': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });

  if (values.help) return null;

  if (!values.check && (!values.artist || !values.title)) {
    throw new Error('--artist and --title are required');
  }

  let quality: QualityPreference | null = null;
  if (values.quality) {
    if (!isQualityPreference(values.quality)) {
      throw new Error(`--quality must be one of flac, mp3_320, any - received "${values.quality}"`);
    }
    quality = values.quality;
  }

  return {
    artist: values.artist ?? '',
    title: values.title ?? '',
    version: values.version ?? null,
    quality,
    check: values.check ?? false,
    skipPublish: values['skip-publish'] ?? false,
  };
}

async function checkConnections(
  config: SpikeConfig,
  prowlarr: ProwlarrClient,
  qbittorrent: QbittorrentClient,
  skipPublish: boolean,
): Promise<void> {
  const status = await prowlarr.systemStatus();
  process.stdout.write(
    `Prowlarr    ok  ${config.prowlarr.baseUrl} (${status.appName ?? 'Prowlarr'} ${status.version})\n`,
  );

  await qbittorrent.login();
  const [appVersion, capabilities] = [await qbittorrent.appVersion(), await qbittorrent.getCapabilities()];
  process.stdout.write(
    `qBittorrent ok  ${config.qbittorrent.baseUrl} (${appVersion}, WebAPI ${capabilities.webApiVersion}, ` +
      `lifecycle: ${capabilities.startEndpoint}/${capabilities.stopEndpoint})\n`,
  );

  await verifyPaths(config, { skipLocalChecks: skipPublish });
  if (skipPublish) {
    process.stdout.write(
      `Paths       skipped (--skip-publish); "${config.downloadRoot}" is the download host's ` +
        'path and is not checked here\n',
    );
  } else {
    process.stdout.write(`Paths       ok  downloads=${config.downloadRoot} ready=${config.readyRoot}\n`);
  }
}

/**
 * Render a failure as a coded, actionable line. Stack traces belong in the debug log, not in
 * front of the user (PRD 16) - which matters most for --check, whose whole job is diagnosis.
 */
function reportFailure(error: unknown, logger: Logger | null): number {
  if (error instanceof PromptAbortedError) {
    process.stderr.write('\nAborted.\n');
    return 130;
  }
  if (error instanceof PipelineError) {
    process.stderr.write(`\n${error.code}: ${error.message}\n  Next: ${error.nextAction}\n`);
    return 1;
  }

  const coded = error as { code?: string; message?: string };
  process.stderr.write(`\n${coded.code ?? 'ERROR'}: ${coded.message ?? String(error)}\n`);
  if (coded.code === 'PROWLARR_UNAUTHORIZED') {
    process.stderr.write('  Next: check PROWLARR_API_KEY against Settings -> General -> API Key.\n');
  } else if (coded.code === 'QBITTORRENT_UNAUTHORIZED') {
    process.stderr.write('  Next: check QBITTORRENT_USERNAME and QBITTORRENT_PASSWORD.\n');
  } else if (coded.code === 'PROWLARR_UNREACHABLE' || coded.code === 'QBITTORRENT_UNREACHABLE') {
    process.stderr.write('  Next: check the URL is reachable from where the spike runs.\n');
  } else if (coded.code === 'CONFIG_INVALID') {
    process.stderr.write('  Next: fix the value in .env - see .env.example for guidance.\n');
  }

  logger?.debug('unhandled failure', { stack: (error as Error).stack });
  return 1;
}

async function main(): Promise<number> {
  let options: CliOptions | null;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 2;
  }

  if (!options) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  let config: SpikeConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`Configuration error: ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  const logger = createLogger(config.logLevel);
  const prowlarr = new ProwlarrClient({
    baseUrl: config.prowlarr.baseUrl,
    apiKey: config.prowlarr.apiKey,
    logger,
  });
  const qbittorrent = new QbittorrentClient({
    baseUrl: config.qbittorrent.baseUrl,
    username: config.qbittorrent.username,
    password: config.qbittorrent.password,
    logger,
  });

  if (options.check) {
    try {
      await checkConnections(config, prowlarr, qbittorrent, options.skipPublish);
      return 0;
    } catch (error) {
      return reportFailure(error, logger);
    }
  }

  try {
    await verifyPaths(config, { skipLocalChecks: options.skipPublish });
    await qbittorrent.login();
  } catch (error) {
    return reportFailure(error, logger);
  }

  const prompter = createTerminalPrompter();
  let handle: PipelineHandle | null = null;

  // Print the correlation identifiers on Ctrl-C so an in-flight torrent is never orphaned
  // without the user knowing what to look for in qBittorrent.
  const onInterrupt = (): void => {
    if (handle?.hash) {
      process.stderr.write(
        `\nInterrupted. A Songarr torrent may still be in qBittorrent:\n` +
          `  category: ${config.category}\n  tag:      ${handle.tag}\n  hash:     ${handle.hash}\n`,
      );
    }
    process.exit(130);
  };
  process.once('SIGINT', onInterrupt);

  try {
    const result = await runPipeline(
      {
        request: { artist: options.artist, title: options.title, version: options.version },
        preferredQuality: options.quality ?? config.preferredQuality,
        category: config.category,
        downloadRoot: config.downloadRoot,
        readyRoot: config.readyRoot,
        metadataTimeoutSec: config.metadataTimeoutSec,
        pollIntervalSec: config.pollIntervalSec,
        stallTimeoutSec: config.stallTimeoutSec,
        ffprobePath: config.ffprobePath,
        skipPublish: options.skipPublish,
      },
      { prowlarr, qbittorrent, prompter, logger },
      (created) => {
        handle = created;
      },
    );

    if (result.published && result.probe) {
      process.stdout.write(
        `\nReady.\n` +
          `  file:     ${result.published.readyPath}\n` +
          `  size:     ${result.published.size} bytes\n` +
          `  codec:    ${result.probe.codec} (${result.probe.formatName})\n` +
          `  duration: ${result.probe.durationSec?.toFixed(1) ?? '?'}s\n` +
          `  torrent:  ${result.hash} (still seeding in qBittorrent)\n`,
      );
    } else {
      process.stdout.write(
        `\nDownloaded (validation and the ready copy were skipped).\n` +
          `  file:     ${result.downloadedPath}\n` +
          `            ^ on the download host, not this machine\n` +
          `  size:     ${result.selectedFile.size} bytes\n` +
          `  torrent:  ${result.hash}\n` +
          `  tag:      ${result.tag}\n` +
          `\nSteps 1-8 succeeded. Verify the file on the download host, then run without\n` +
          `--skip-publish from a machine that can see ${config.downloadRoot} to exercise\n` +
          `ffprobe validation and the ready-folder copy.\n`,
      );
    }
    return 0;
  } catch (error) {
    return reportFailure(error, logger);
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    await prompter.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`Unexpected failure: ${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = 1;
  },
);
