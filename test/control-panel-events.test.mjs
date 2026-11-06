import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { LogBuffer, createEventHub } from '../scripts/control-panel-events.mjs';

test('log history preserves newest entries within both count and character limits', () => {
  const logs = new LogBuffer({ maxEntries: 3, maxCharacters: 8 });
  for (const entry of ['aa', 'bb', 'cc', 'dd']) logs.push(entry);
  assert.deepEqual(logs.snapshot(), ['bb', 'cc', 'dd']);
  logs.push('1234567');
  assert.deepEqual(logs.snapshot(), ['1234567']);
  logs.push('0123456789');
  assert.deepEqual(logs.snapshot(), ['23456789']);
  assert.equal(logs.characters, 8);
});

class Client extends EventEmitter {
  writableLength = 0;
  destroyed = false;
  messages = [];
  write(message) { this.messages.push(message); }
  destroy() { this.destroyed = true; this.emit('close'); }
  end() { this.emit('close'); }
}

test('a slow SSE client is disconnected without delaying other clients', () => {
  const hub = createEventHub({ maxBufferedBytes: 100 });
  try {
    const slow = new Client();
    const fast = new Client();
    hub.add(slow, { type: 'history' });
    hub.add(fast, { type: 'history' });
    slow.writableLength = 95;
    hub.send({ type: 'log', message: 'hello' });
    assert.equal(slow.destroyed, true);
    assert.equal(hub.size, 1);
    assert.equal(fast.messages.length, 2);
    fast.destroy();
    assert.equal(hub.size, 0);
  } finally {
    hub.close();
  }
});

test('initial snapshots trim old logs by serialized bytes and preserve their metadata', () => {
  const maxBufferedBytes = 300;
  const hub = createEventHub({ maxBufferedBytes });
  const client = new Client();
  const latest = '\u0000\t\n"\\中😀\ud800'.repeat(100) + 'latest output';
  const history = {
    type: 'history',
    running: true,
    jobs: [{ number: 3, task: 'test' }],
    magicConfig: { config: 'keep this config' },
    logs: ['old output'.repeat(100), latest],
  };
  try {
    hub.add(client, history);
    assert.equal(client.destroyed, false);
    assert.equal(client.messages.length, 1);
    assert.ok(Buffer.byteLength(client.messages[0]) <= maxBufferedBytes);
    const snapshot = JSON.parse(client.messages[0].slice('data: '.length).trim());
    assert.deepEqual({ ...snapshot, logs: [] }, { ...history, logs: [] });
    assert.equal(snapshot.logs.length, 1);
    assert.ok(snapshot.logs[0].endsWith('latest output'));
    assert.ok(snapshot.logs[0].includes('\u0000'));
    assert.ok(latest.endsWith(snapshot.logs[0]));
    assert.ok(snapshot.logs[0].length < latest.length);
    hub.send({ type: 'log', message: 'still connected' });
    assert.equal(client.destroyed, false);
    assert.equal(client.messages.length, 2);
  } finally {
    hub.close();
  }
});

test('history retains recent whole entries and a suffix of the preceding entry', () => {
  const hub = createEventHub({ maxBufferedBytes: 100 });
  const client = new Client();
  try {
    hub.add(client, { type: 'history', logs: ['a'.repeat(100), 'second', 'last'] });
    const snapshot = JSON.parse(client.messages[0].slice('data: '.length).trim());
    assert.equal(client.destroyed, false);
    assert.ok(Buffer.byteLength(client.messages[0]) <= 100);
    assert.deepEqual(snapshot.logs.slice(-2), ['second', 'last']);
    assert.ok(snapshot.logs[0].length > 0 && snapshot.logs[0].length < 100);
  } finally {
    hub.close();
  }
});

test('a history snapshot does not truncate metadata to fit an impossible budget', () => {
  const hub = createEventHub({ maxBufferedBytes: 30 });
  const client = new Client();
  try {
    hub.add(client, { type: 'history', magicConfig: { config: 'preserve configuration' }, logs: [] });
    assert.equal(client.destroyed, true);
    assert.equal(client.messages.length, 0);
  } finally {
    hub.close();
  }
});
