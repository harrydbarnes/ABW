import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

assert.equal(process.env.CI, 'true', 'Run this test on a disposable CI runner');
const [executable] = process.argv.slice(2);
assert.ok(executable);
const root = mkdtempSync(join(process.env.RUNNER_TEMP, 'abw-po-smoke-'));
const folder = join(root, 'ABW', 'po-check');
mkdirSync(folder, { recursive: true });
const origin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/';
writeFileSync(join(folder, 'native-host.json'), JSON.stringify({ allowed_origins: [origin] }));
const id = randomUUID();
const booking = { media: 'D', client: 'T01', product: '3', po: '61507' };
writeFileSync(join(folder, id + '.job'), JSON.stringify(booking));

function send(request, callingOrigin = origin) {
  const message = Buffer.from(JSON.stringify(request));
  const size = Buffer.alloc(4);
  size.writeUInt32LE(message.length);
  return spawnSync(executable, [callingOrigin], {
    env: { ...process.env, LOCALAPPDATA: root },
    input: Buffer.concat([size, message]),
    timeout: 10000,
    windowsHide: true,
  });
}

function reply(request) {
  const process = send(request);
  assert.ifError(process.error);
  assert.equal(process.status, 0, process.stderr?.toString());
  assert.ok(process.stdout.length >= 4);
  assert.equal(process.stdout.readUInt32LE(), process.stdout.length - 4);
  return JSON.parse(process.stdout.subarray(4).toString());
}

assert.equal(send({ action: 'poll' }, 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/').status, 1);
assert.deepEqual(reply({ action: 'poll' }), { jobs: [{ id, booking }] });
assert.deepEqual(reply({ action: 'complete', id, status: 'checked' }), { ok: true });
assert.equal(JSON.parse(readFileSync(join(folder, id + '.result'), 'utf8')), 'checked');
assert.deepEqual(reply({ action: 'poll' }), { jobs: [] });
console.log('ABW native messaging host accepted a paired request, returned a booking, and persisted a verdict.');
