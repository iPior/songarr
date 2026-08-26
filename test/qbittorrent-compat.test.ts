import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  compareVersions,
  extractSessionCookie,
  FilePriority,
  isErrorState,
  isFileComplete,
  isMetadataState,
  resolveCapabilities,
} from '../src/spike/qbittorrent.ts';

describe('extractSessionCookie', () => {
  test('accepts the legacy fixed SID cookie', () => {
    const headers = new Headers({ 'Set-Cookie': 'SID=legacy-session; HttpOnly; path=/' });
    assert.equal(extractSessionCookie(headers), 'SID=legacy-session');
  });

  test('accepts the qBittorrent 5.2 port-scoped session cookie', () => {
    const headers = new Headers({ 'Set-Cookie': 'QBT_SID_8701=current-session; HttpOnly; path=/' });
    assert.equal(extractSessionCookie(headers), 'QBT_SID_8701=current-session');
  });

  test('does not retain an unrelated reverse-proxy cookie', () => {
    const headers = new Headers({ 'Set-Cookie': 'proxy_session=unrelated; Secure; path=/' });
    assert.equal(extractSessionCookie(headers), null);
  });
});

describe('compareVersions', () => {
  test('orders dotted numeric versions', () => {
    assert.ok(compareVersions('2.11.0', '2.9.0') > 0);
    assert.ok(compareVersions('2.8.2', '2.8.10') < 0);
    assert.equal(compareVersions('2.11', '2.11.0'), 0);
  });

  test('treats missing components as zero', () => {
    assert.equal(compareVersions('2', '2.0.0'), 0);
    assert.ok(compareVersions('2.1', '2') > 0);
  });

  test('does not throw on unexpected input', () => {
    assert.equal(compareVersions('', ''), 0);
    assert.ok(compareVersions('abc', '1.0') < 0);
  });
});

describe('resolveCapabilities', () => {
  test('qBittorrent 5.x (WebAPI 2.11+) uses start/stop and the stopped parameter', () => {
    const caps = resolveCapabilities('2.11.2');
    assert.equal(caps.startEndpoint, 'start');
    assert.equal(caps.stopEndpoint, 'stop');
    assert.equal(caps.addStoppedParam, 'stopped');
    assert.ok(caps.filesHaveIndex);
  });

  test('qBittorrent 4.6 (WebAPI 2.9.x) uses resume/pause and the paused parameter', () => {
    const caps = resolveCapabilities('2.9.3');
    assert.equal(caps.startEndpoint, 'resume');
    assert.equal(caps.stopEndpoint, 'pause');
    assert.equal(caps.addStoppedParam, 'paused');
    assert.ok(caps.filesHaveIndex);
  });

  test('2.11.0 exactly is already the modern lifecycle', () => {
    assert.equal(resolveCapabilities('2.11.0').startEndpoint, 'start');
    assert.equal(resolveCapabilities('2.10.9').startEndpoint, 'resume');
  });

  test('files[].index only exists from WebAPI 2.8.2', () => {
    assert.ok(resolveCapabilities('2.8.2').filesHaveIndex);
    assert.ok(!resolveCapabilities('2.8.1').filesHaveIndex);
    assert.ok(!resolveCapabilities('2.7.0').filesHaveIndex);
  });

  test('carries the version through for logging', () => {
    assert.equal(resolveCapabilities('2.9.3').webApiVersion, '2.9.3');
  });
});

describe('state predicates', () => {
  test('recognises terminal error states', () => {
    assert.ok(isErrorState('error'));
    assert.ok(isErrorState('missingFiles'));
    assert.ok(!isErrorState('downloading'));
    assert.ok(!isErrorState('stalledDL'));
    assert.ok(!isErrorState('pausedDL'));
  });

  test('recognises metadata-fetching states', () => {
    assert.ok(isMetadataState('metaDL'));
    assert.ok(isMetadataState('forcedMetaDL'));
    assert.ok(!isMetadataState('downloading'));
  });
});

describe('isFileComplete', () => {
  const base = { index: 0, name: 'track.flac', size: 1000, priority: FilePriority.Normal };

  test('is true only at full progress', () => {
    assert.ok(isFileComplete({ ...base, progress: 1 }));
    assert.ok(!isFileComplete({ ...base, progress: 0.999 }));
    assert.ok(!isFileComplete({ ...base, progress: 0 }));
  });

  test('tolerates a progress value above 1 from piece overlap', () => {
    // Pieces straddle file boundaries, so extra bytes land against the selected file.
    assert.ok(isFileComplete({ ...base, progress: 1.0001 }));
  });
});

describe('FilePriority', () => {
  test('do-not-download is zero, which is what disables a file', () => {
    assert.equal(FilePriority.DoNotDownload, 0);
    assert.equal(FilePriority.Normal, 1);
  });
});
