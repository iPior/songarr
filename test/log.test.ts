import assert from 'node:assert/strict';
import test, { afterEach, describe } from 'node:test';

import { clearSecrets, isLogLevel, redactString, redactValue, registerSecret } from '../src/spike/log.ts';

afterEach(() => clearSecrets());

describe('redactString', () => {
  test('removes registered secrets wherever they appear', () => {
    registerSecret('super-secret-api-key');
    const output = redactString('calling with key super-secret-api-key now');
    assert.ok(!output.includes('super-secret-api-key'));
    assert.match(output, /\[REDACTED\]/);
  });

  test('ignores implausibly short secrets that would redact everything', () => {
    registerSecret('a');
    assert.equal(redactString('a normal sentence'), 'a normal sentence');
  });

  test('redacts magnet links, which identify the payload and carry passkeys', () => {
    const output = redactString('adding magnet:?xt=urn:btih:abc123&dn=Some.Release&tr=http://t/pass/announce');
    assert.ok(!output.includes('btih'));
    assert.match(output, /magnet:\?\[REDACTED\]/);
  });

  test('redacts secret-bearing query parameters', () => {
    for (const key of ['apikey', 'api_key', 'token', 'passkey', 'password']) {
      const output = redactString(`https://indexer.example/rss?${key}=abcdef123456&cat=3000`);
      assert.ok(!output.includes('abcdef123456'), key);
      assert.ok(output.includes('cat=3000'), 'non-secret parameters survive');
    }
  });

  test('redacts an authenticated indexer download URL but keeps the host visible', () => {
    const output = redactString('fetching https://indexer.example/download/abc123secret/file.torrent');
    assert.ok(!output.includes('abc123secret'));
    assert.ok(output.includes('indexer.example'), 'the host stays useful for debugging');
  });

  test('redacts session cookies', () => {
    const output = redactString('Cookie: SID=abcdef123456; other=1');
    assert.ok(!output.includes('abcdef123456'));

    const current = redactString('Cookie: QBT_SID_8701=current-session; other=1');
    assert.ok(!current.includes('current-session'));
  });

  test('leaves ordinary messages untouched', () => {
    const message = 'torrent correlated, 4 files, 40 MiB';
    assert.equal(redactString(message), message);
  });
});

describe('redactValue', () => {
  test('blanks secret-named fields at any depth', () => {
    const redacted = redactValue({
      url: 'http://qbit:8080',
      auth: { username: 'admin', password: 'hunter2', apiKey: 'k-123' },
      nested: [{ token: 't-1' }],
    }) as Record<string, Record<string, string>>;

    assert.equal(redacted['auth']!['username'], 'admin');
    assert.equal(redacted['auth']!['password'], '[REDACTED]');
    assert.equal(redacted['auth']!['apiKey'], '[REDACTED]');
    assert.equal((redacted['nested'] as unknown as Array<Record<string, string>>)[0]!['token'], '[REDACTED]');
  });

  test('scrubs secrets embedded in non-secret-named string fields', () => {
    registerSecret('my-prowlarr-key');
    const redacted = redactValue({ message: 'used my-prowlarr-key' }) as Record<string, string>;
    assert.ok(!redacted['message']!.includes('my-prowlarr-key'));
  });

  test('handles primitives, nulls and arrays without throwing', () => {
    assert.equal(redactValue(42), 42);
    assert.equal(redactValue(null), null);
    assert.deepEqual(redactValue([1, 'two']), [1, 'two']);
  });

  test('truncates rather than recursing forever on a cyclic object', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic['self'] = cyclic;
    assert.doesNotThrow(() => redactValue(cyclic));
  });
});

describe('isLogLevel', () => {
  test('accepts the four supported levels only', () => {
    for (const level of ['debug', 'info', 'warn', 'error']) assert.ok(isLogLevel(level));
    assert.ok(!isLogLevel('trace'));
    assert.ok(!isLogLevel('INFO'));
  });
});
