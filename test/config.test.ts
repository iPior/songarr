import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';

import { ConfigError, loadConfig, verifyPaths } from '../src/spike/config.ts';
import { clearSecrets, redactString } from '../src/spike/log.ts';

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PROWLARR_URL: 'http://prowlarr:9696',
    PROWLARR_API_KEY: 'prowlarr-key-abcdef',
    QBITTORRENT_URL: 'http://qbittorrent:8080',
    QBITTORRENT_USERNAME: 'admin',
    QBITTORRENT_PASSWORD: 'qbit-password-123',
    SONGARR_DOWNLOAD_ROOT: '/downloads',
    SONGARR_READY_ROOT: '/ready',
    ...overrides,
  };
}

describe('loadConfig', () => {
  test('loads a complete configuration and applies defaults', () => {
    const config = loadConfig(env());
    clearSecrets();

    assert.equal(config.category, 'songarr');
    assert.equal(config.preferredQuality, 'any');
    assert.equal(config.metadataTimeoutSec, 120);
    assert.equal(config.pollIntervalSec, 5);
    assert.equal(config.ffprobePath, 'ffprobe');
    assert.equal(config.logLevel, 'info');
  });

  test('names the missing variable when a required one is absent', () => {
    for (const key of [
      'PROWLARR_URL',
      'PROWLARR_API_KEY',
      'QBITTORRENT_URL',
      'QBITTORRENT_USERNAME',
      'QBITTORRENT_PASSWORD',
      'SONGARR_DOWNLOAD_ROOT',
    ]) {
      assert.throws(
        () => loadConfig(env({ [key]: undefined })),
        (error: ConfigError) => error instanceof ConfigError && error.message.includes(key),
        key,
      );
      clearSecrets();
    }
  });

  test('leaves the ready root null when unset, for --skip-publish', () => {
    // It is optional at load time and enforced by verifyPaths, so a run that never publishes
    // does not have to invent a path it will not use.
    const config = loadConfig(env({ SONGARR_READY_ROOT: undefined }));
    clearSecrets();
    assert.equal(config.readyRoot, null);
  });

  test('treats a whitespace-only value as missing', () => {
    assert.throws(() => loadConfig(env({ PROWLARR_API_KEY: '   ' })), ConfigError);
    clearSecrets();
  });

  test('strips a trailing slash from base URLs', () => {
    const config = loadConfig(env({ PROWLARR_URL: 'http://prowlarr:9696/' }));
    clearSecrets();
    assert.equal(config.prowlarr.baseUrl, 'http://prowlarr:9696');
  });

  test('rejects a non-absolute or non-http URL', () => {
    assert.throws(() => loadConfig(env({ PROWLARR_URL: 'prowlarr:9696' })), ConfigError);
    clearSecrets();
    assert.throws(() => loadConfig(env({ QBITTORRENT_URL: 'ftp://host/' })), ConfigError);
    clearSecrets();
  });

  test('requires absolute paths for both roots', () => {
    assert.throws(() => loadConfig(env({ SONGARR_DOWNLOAD_ROOT: 'downloads' })), ConfigError);
    clearSecrets();
    assert.throws(() => loadConfig(env({ SONGARR_READY_ROOT: './ready' })), ConfigError);
    clearSecrets();
  });

  test('validates the quality preference and log level', () => {
    assert.throws(() => loadConfig(env({ SONGARR_PREFERRED_QUALITY: 'lossless' })), ConfigError);
    clearSecrets();
    assert.throws(() => loadConfig(env({ SONGARR_LOG_LEVEL: 'trace' })), ConfigError);
    clearSecrets();
  });

  test('allows the ffprobe executable to be configured', () => {
    const config = loadConfig(env({ FFPROBE_PATH: '/opt/ffmpeg/bin/ffprobe' }));
    clearSecrets();
    assert.equal(config.ffprobePath, '/opt/ffmpeg/bin/ffprobe');
  });

  test('rejects a non-positive or non-integer timeout', () => {
    for (const value of ['0', '-5', 'abc', '1.5']) {
      assert.throws(() => loadConfig(env({ SONGARR_METADATA_TIMEOUT_SEC: value })), ConfigError, value);
      clearSecrets();
    }
  });

  test('registers both secrets so they are redacted from logs', () => {
    clearSecrets();
    loadConfig(env());

    assert.ok(!redactString('key is prowlarr-key-abcdef').includes('prowlarr-key-abcdef'));
    assert.ok(!redactString('pw is qbit-password-123').includes('qbit-password-123'));
    clearSecrets();
  });
});

describe('verifyPaths', () => {
  async function roots(): Promise<{ downloadRoot: string; readyRoot: string }> {
    const base = await mkdtemp(path.join(tmpdir(), 'songarr-config-'));
    const downloadRoot = path.join(base, 'downloads');
    const readyRoot = path.join(base, 'ready');
    await mkdir(downloadRoot);
    await mkdir(readyRoot);
    return { downloadRoot, readyRoot };
  }

  test('accepts existing, accessible directories', async () => {
    const { downloadRoot, readyRoot } = await roots();
    const config = loadConfig(env({ SONGARR_DOWNLOAD_ROOT: downloadRoot, SONGARR_READY_ROOT: readyRoot }));
    clearSecrets();
    await assert.doesNotReject(() => verifyPaths(config));
  });

  test('reports a missing root by name', async () => {
    const { readyRoot } = await roots();
    const config = loadConfig(env({ SONGARR_DOWNLOAD_ROOT: '/definitely/not/here', SONGARR_READY_ROOT: readyRoot }));
    clearSecrets();
    await assert.rejects(
      () => verifyPaths(config),
      (error: ConfigError) => error.message.includes('SONGARR_DOWNLOAD_ROOT'),
    );
  });

  test('rejects a ready root that is not writable', async (t) => {
    if (process.getuid?.() === 0) return t.skip('running as root, permission checks do not apply');

    const { downloadRoot, readyRoot } = await roots();
    await chmod(readyRoot, 0o500);
    const config = loadConfig(env({ SONGARR_DOWNLOAD_ROOT: downloadRoot, SONGARR_READY_ROOT: readyRoot }));
    clearSecrets();

    await assert.rejects(
      () => verifyPaths(config),
      (error: ConfigError) => error.message.includes('SONGARR_READY_ROOT'),
    );
    await chmod(readyRoot, 0o700);
  });

  test('demands a ready root unless the local checks are skipped', async () => {
    const { downloadRoot } = await roots();
    const config = loadConfig(env({ SONGARR_DOWNLOAD_ROOT: downloadRoot, SONGARR_READY_ROOT: undefined }));
    clearSecrets();

    await assert.rejects(
      () => verifyPaths(config),
      (error: ConfigError) => /SONGARR_READY_ROOT is required/.test(error.message),
    );
    await assert.doesNotReject(() => verifyPaths(config, { skipLocalChecks: true }));
  });

  test('skipLocalChecks accepts a download root that does not exist on this machine', async () => {
    // The remote-stack case: the path is the download host's, not ours.
    const config = loadConfig(env({ SONGARR_DOWNLOAD_ROOT: '/downloads', SONGARR_READY_ROOT: undefined }));
    clearSecrets();
    await assert.doesNotReject(() => verifyPaths(config, { skipLocalChecks: true }));
  });

  test('rejects a root that is a file rather than a directory', async () => {
    const { downloadRoot, readyRoot } = await roots();
    const { writeFile } = await import('node:fs/promises');
    const asFile = path.join(readyRoot, 'not-a-dir');
    await writeFile(asFile, '');

    const config = loadConfig(env({ SONGARR_DOWNLOAD_ROOT: downloadRoot, SONGARR_READY_ROOT: asFile }));
    clearSecrets();
    await assert.rejects(
      () => verifyPaths(config),
      (error: ConfigError) => /not a directory/.test(error.message),
    );
  });
});
