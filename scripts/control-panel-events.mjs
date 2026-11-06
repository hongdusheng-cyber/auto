export class LogBuffer {
  constructor({ maxEntries = 2000, maxCharacters = 512 * 1024 } = {}) {
    this.maxEntries = maxEntries;
    this.maxCharacters = maxCharacters;
    this.entries = new Array(maxEntries);
    this.start = 0;
    this.length = 0;
    this.characters = 0;
  }

  push(value) {
    const text = String(value).slice(-this.maxCharacters);
    while (this.length && (this.length === this.maxEntries || this.characters + text.length > this.maxCharacters)) {
      this.characters -= this.entries[this.start].length;
      this.entries[this.start] = undefined;
      this.start = (this.start + 1) % this.maxEntries;
      this.length -= 1;
    }
    this.entries[(this.start + this.length) % this.maxEntries] = text;
    this.length += 1;
    this.characters += text.length;
  }

  snapshot() {
    return Array.from({ length: this.length }, (_, index) => this.entries[(this.start + index) % this.maxEntries]);
  }
}

// Find a suffix that fits its JSON byte budget without repeatedly serializing
// progressively shorter copies of a potentially large log entry.
function logSuffixWithinBytes(value, maxBytes) {
  if (maxBytes < 2) return null;
  let start = value.length;
  let bytes = 2; // JSON string quotes.
  while (start > 0) {
    const code = value.charCodeAt(start - 1);
    const previous = start > 1 ? value.charCodeAt(start - 2) : 0;
    let width = 1;
    let characterBytes;
    if (code >= 0xdc00 && code <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) {
      width = 2;
      characterBytes = 4;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      characterBytes = 6; // JSON escapes lone UTF-16 surrogates.
    } else if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      characterBytes = 2;
    } else if (code < 0x20) {
      characterBytes = 6;
    } else {
      characterBytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
    }
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    start -= width;
  }
  return value.slice(start);
}

export function createEventHub({ maxBufferedBytes = 2 * 1024 * 1024, heartbeatMs = 25000 } = {}) {
  const clients = new Set();

  function historyPayload(history) {
    const payload = `data: ${JSON.stringify(history)}\n\n`;
    if (Buffer.byteLength(payload) <= maxBufferedBytes || !Array.isArray(history.logs)) return payload;

    const withoutLogs = { ...history, logs: [] };
    let remaining = maxBufferedBytes - Buffer.byteLength(`data: ${JSON.stringify(withoutLogs)}\n\n`);
    if (remaining < 0) return payload; // Metadata must remain intact.
    const newestLogs = [];
    for (let index = history.logs.length - 1; index >= 0; index -= 1) {
      const entry = history.logs[index];
      const separatorBytes = newestLogs.length ? 1 : 0;
      const entryBytes = Buffer.byteLength(JSON.stringify(entry) ?? 'null');
      if (entryBytes + separatorBytes > remaining) {
        if (typeof entry === 'string') {
          const suffix = logSuffixWithinBytes(entry, remaining - separatorBytes);
          if (suffix) newestLogs.push(suffix);
        }
        break;
      }
      newestLogs.push(entry);
      remaining -= entryBytes + separatorBytes;
    }
    return `data: ${JSON.stringify({ ...history, logs: newestLogs.reverse() })}\n\n`;
  }

  function write(client, payload) {
    if (client.destroyed || client.writableEnded) {
      clients.delete(client);
      return;
    }
    if (client.writableLength + Buffer.byteLength(payload) > maxBufferedBytes) {
      // EventSource reconnects and receives a bounded history snapshot.
      clients.delete(client);
      client.destroy();
      return;
    }
    try {
      client.write(payload);
    } catch {
      clients.delete(client);
      client.destroy();
    }
  }

  const heartbeat = setInterval(() => {
    for (const client of clients) write(client, ': heartbeat\n\n');
  }, heartbeatMs);
  heartbeat.unref();

  return {
    add(client, history) {
      clients.add(client);
      const remove = () => clients.delete(client);
      client.once('close', remove);
      client.once('error', remove);
      write(client, historyPayload(history));
    },
    send(data) {
      const payload = `data: ${JSON.stringify(data)}\n\n`;
      for (const client of clients) write(client, payload);
    },
    close() {
      clearInterval(heartbeat);
      for (const client of clients) client.end();
      clients.clear();
    },
    get size() { return clients.size; },
  };
}
