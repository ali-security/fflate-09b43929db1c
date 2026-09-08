// TODO: test ZIP
import { resolve } from 'path';
import { Worker } from 'worker_threads';
import { suite } from 'uvu';
import * as assert from 'uvu/assert';

// The ZIP64 sentinel: a 32-bit size/offset field set to this value means the
// real value lives in the ZIP64 extra field (tag 0x0001).
const Z64 = 4294967295;

const w2 = (d: Uint8Array, b: number, v: number) => {
  d[b] = v & 255;
  d[b + 1] = (v >>> 8) & 255;
};

const w4 = (d: Uint8Array, b: number, v: number) => {
  w2(d, b, v % 65536);
  w2(d, b + 2, Math.floor(v / 65536) % 65536);
};

const w8 = (d: Uint8Array, b: number, v: number) => {
  w4(d, b, v % 4294967296);
  w4(d, b + 4, Math.floor(v / 4294967296));
};

const enc = (s: string) => {
  const d = new Uint8Array(s.length);
  for (let i = 0; i < s.length; ++i) d[i] = s.charCodeAt(i) & 255;
  return d;
};

const cat = (chunks: Uint8Array[]) => {
  let l = 0;
  for (let i = 0; i < chunks.length; ++i) l += chunks[i].length;
  const out = new Uint8Array(l);
  for (let i = 0, b = 0; i < chunks.length; ++i) {
    out.set(chunks[i], b);
    b += chunks[i].length;
  }
  return out;
};

// builds the central directory extra field for an entry, given the values the
// ZIP64 extra field would have to carry
type ExtraBuilder = (localOffset: number, size: number) => Uint8Array;

interface Entry {
  name: string;
  data: Uint8Array;
  extra: ExtraBuilder;
  comment?: string;
}

// a well-formed ZIP64 extra field: tag 0x0001, then uncompressed size,
// compressed size and local header offset as 64-bit values
const validZip64Extra: ExtraBuilder = (localOffset, size) => {
  const x = new Uint8Array(28);
  w2(x, 0, 1);
  w2(x, 2, 24);
  w8(x, 4, size);
  w8(x, 12, size);
  w8(x, 20, localOffset);
  return x;
};

// no extra field at all - the ZIP64 sizes it promises are nowhere to be found
const noExtra: ExtraBuilder = () => new Uint8Array(0);

// a complete but non-ZIP64 extra field (extended timestamp, tag 0x5455): the
// scan runs off the end of the extra field without ever seeing tag 0x0001
const unrelatedExtra: ExtraBuilder = () => {
  const x = new Uint8Array(9);
  w2(x, 0, 0x5455);
  w2(x, 2, 5);
  return x;
};

// an extra field whose single record claims 65535 bytes of payload but only
// gets 0 - following its length jumps clean out of the extra field
const overlongExtra: ExtraBuilder = () => {
  const x = new Uint8Array(4);
  w2(x, 0, 0x9999);
  w2(x, 2, 65535);
  return x;
};

/**
 * Builds a ZIP archive whose central directory declares every entry with the
 * ZIP64 sentinel, so that reading it goes through the ZIP64 extra field parser.
 */
const buildZip64Archive = (entries: Entry[]) => {
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let off = 0;
  for (let i = 0; i < entries.length; ++i) {
    const e = entries[i], name = enc(e.name);
    offsets.push(off);
    const lh = new Uint8Array(30 + name.length);
    w4(lh, 0, 0x04034b50);
    w2(lh, 4, 45);
    w4(lh, 18, e.data.length);
    w4(lh, 22, e.data.length);
    w2(lh, 26, name.length);
    lh.set(name, 30);
    chunks.push(lh, e.data);
    off += lh.length + e.data.length;
  }
  const cdOffset = off;
  for (let i = 0; i < entries.length; ++i) {
    const e = entries[i], name = enc(e.name), com = enc(e.comment || '');
    const extra = e.extra(offsets[i], e.data.length);
    const ch = new Uint8Array(46 + name.length + extra.length + com.length);
    w4(ch, 0, 0x02014b50);
    w2(ch, 4, 45);
    w2(ch, 6, 45);
    w4(ch, 20, Z64);
    w4(ch, 24, Z64);
    w2(ch, 28, name.length);
    w2(ch, 30, extra.length);
    w2(ch, 32, com.length);
    w4(ch, 42, Z64);
    ch.set(name, 46);
    ch.set(extra, 46 + name.length);
    ch.set(com, 46 + name.length + extra.length);
    chunks.push(ch);
    off += ch.length;
  }
  const cdSize = off - cdOffset, z64Offset = off;
  const tail = new Uint8Array(98);
  // ZIP64 end of central directory record
  w4(tail, 0, 0x06064b50);
  w8(tail, 4, 44);
  w2(tail, 12, 45);
  w2(tail, 14, 45);
  w8(tail, 24, entries.length);
  w8(tail, 32, entries.length);
  w8(tail, 40, cdSize);
  w8(tail, 48, cdOffset);
  // ZIP64 end of central directory locator
  w4(tail, 56, 0x07064b50);
  w8(tail, 64, z64Offset);
  w4(tail, 72, 1);
  // end of central directory record
  w4(tail, 76, 0x06054b50);
  w2(tail, 84, entries.length);
  w2(tail, 86, entries.length);
  w4(tail, 88, cdSize);
  w4(tail, 92, Z64);
  chunks.push(tail);
  return cat(chunks);
};

/**
 * Builds a bare local file header (plus its data) for the streaming API, with
 * the compressed size set to the ZIP64 sentinel.
 */
const buildZip64LocalHeader = (name: string, data: Uint8Array, extra: Uint8Array) => {
  const fn = enc(name);
  const lh = new Uint8Array(30 + fn.length + extra.length);
  w4(lh, 0, 0x04034b50);
  w2(lh, 4, 45);
  w4(lh, 18, Z64);
  w4(lh, 22, Z64);
  w2(lh, 26, fn.length);
  w2(lh, 28, extra.length);
  lh.set(fn, 30);
  lh.set(extra, 30 + fn.length);
  return cat([lh, data]);
};

// a valid local ZIP64 extra field: tag 0x0001, uncompressed then compressed size
const localZip64Extra = (size: number) => {
  const x = new Uint8Array(20);
  w2(x, 0, 1);
  w2(x, 2, 16);
  w8(x, 4, size);
  w8(x, 12, size);
  return x;
};

const fflate = resolve(__dirname, '..');

interface RunResult {
  ok: boolean;
  code?: number;
  message?: string;
  files?: Record<string, string>;
  names?: string[];
}

// The ZIP64 extra field parser used to be able to spin forever, so every case
// runs in a worker with a hard timeout: a regression shows up as a failed
// assertion instead of a hung test process.
const runInWorker = (mode: 'sync' | 'async' | 'stream', data: Uint8Array, ms = 5000) => {
  const src = `
    const { unzipSync, unzip, Unzip } = require(${JSON.stringify(fflate)});
    const { parentPort, workerData } = require('worker_threads');
    const data = new Uint8Array(workerData.data);
    try {
      if (workerData.mode === 'sync') {
        const files = unzipSync(data);
        const out = {};
        for (const k in files) out[k] = Buffer.from(files[k]).toString('latin1');
        parentPort.postMessage({ ok: true, files: out });
      } else if (workerData.mode === 'async') {
        unzip(data, function() {});
        parentPort.postMessage({ ok: true });
      } else {
        const uz = new Unzip();
        const names = [];
        uz.onfile = function(f) { names.push(f.name + ':' + f.size); };
        uz.push(data, true);
        parentPort.postMessage({ ok: true, names: names });
      }
    } catch (err) {
      parentPort.postMessage({ ok: false, code: err.code, message: err.message });
    }
  `;
  return new Promise<RunResult>((res, rej) => {
    const worker = new Worker(src, { eval: true, workerData: { mode, data } });
    let timedOut = false;
    const tm = setTimeout(() => {
      timedOut = true;
      worker.terminate();
    }, ms);
    worker
      .once('message', (msg: RunResult) => {
        clearTimeout(tm);
        worker.terminate();
        res(msg);
      })
      .once('error', err => {
        clearTimeout(tm);
        rej(err);
      })
      .once('exit', () => {
        clearTimeout(tm);
        if (timedOut) rej(new Error('Timed out: the ZIP64 extra field parser did not terminate'));
      });
  });
};

const assertInvalidZip = (result: RunResult) => {
  assert.is(result.ok, false, 'expected the crafted archive to be rejected, got ' + JSON.stringify(result));
  assert.is(result.code, 13);
  assert.is(result.message, 'invalid zip data');
};

const zip64 = suite('zip64 extra field');

// The central directory promises ZIP64 sizes but ships no extra field at all,
// so the parser used to scan past the entry forever (CVE-2026-45820).
zip64('unzipSync rejects a ZIP64 sentinel with no extra field', async () => {
  const data = buildZip64Archive([{ name: 'a.txt', data: enc('hello'), extra: noExtra }]);
  assertInvalidZip(await runInWorker('sync', data));
});

zip64('unzipSync rejects a ZIP64 sentinel with an unrelated extra field', async () => {
  const data = buildZip64Archive([{ name: 'a.txt', data: enc('hello'), extra: unrelatedExtra }]);
  assertInvalidZip(await runInWorker('sync', data));
});

zip64('unzipSync rejects an extra field record longer than the extra field', async () => {
  const data = buildZip64Archive([{ name: 'a.txt', data: enc('hello'), extra: overlongExtra }]);
  assertInvalidZip(await runInWorker('sync', data));
});

zip64('unzip rejects a ZIP64 sentinel with no extra field', async () => {
  const data = buildZip64Archive([{ name: 'a.txt', data: enc('hello'), extra: noExtra }]);
  assertInvalidZip(await runInWorker('async', data));
});

// The streaming API reads the same extra field out of the local file header.
zip64('Unzip rejects a ZIP64 sentinel with no extra field', async () => {
  const data = buildZip64LocalHeader('a.txt', enc('hello'), new Uint8Array(0));
  assertInvalidZip(await runInWorker('stream', data));
});

zip64('Unzip rejects an extra field record longer than the extra field', async () => {
  const data = buildZip64LocalHeader('a.txt', enc('hello'), overlongExtra(0, 0));
  assertInvalidZip(await runInWorker('stream', data));
});

// Well-formed ZIP64 archives must still decompress: the entries below use the
// sentinel everywhere, so all sizes and offsets come out of the extra field,
// and the trailing comment on the first entry exercises the walk to the next
// central directory record.
zip64('unzipSync reads a well-formed ZIP64 archive', async () => {
  const data = buildZip64Archive([
    { name: 'a.txt', data: enc('hello'), extra: validZip64Extra, comment: 'first' },
    { name: 'b.txt', data: enc('world!'), extra: validZip64Extra }
  ]);
  const result = await runInWorker('sync', data);
  assert.is(result.ok, true, JSON.stringify(result));
  assert.equal(result.files, { 'a.txt': 'hello', 'b.txt': 'world!' });
});

zip64('Unzip reads a well-formed ZIP64 local header', async () => {
  const data = buildZip64LocalHeader('a.txt', enc('hello'), localZip64Extra(5));
  const result = await runInWorker('stream', data);
  assert.is(result.ok, true, JSON.stringify(result));
  assert.equal(result.names, ['a.txt:5']);
});

zip64.run();
