// lib/harness/dsh/log-frames.js — the DSH session log decoder: the zstd frame walk, and the one home of the rule
// that a file is a DSH log exactly when its plaintext's first line is a DSH session header, whatever its encoding.

import { gunzipSync, zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = 0xFD2FB528;
const GZIP_MAGIC = 0x8B1F;

/**
 * The plaintext of every complete frame of a DSH session log, in file order. DSH appends each batch as an
 * independent zstd frame, and `zstdDecompressSync` over the whole buffer stops after the first one, so the frames
 * are located from their frame and block headers alone — the walk of `scanZstdFrames` in DSH's
 * `session-persistence-jsonl` — and decoded one at a time. A final frame that EOF cuts short is a torn append and is
 * left out by that walk, because `zstdDecompressSync` decodes a truncated frame into its available prefix without
 * complaint; an invalid frame or block header throws wherever it appears.
 * @param {Buffer} buffer the log file's bytes
 * @returns {Buffer[]} one plaintext buffer per complete frame
 */
export function walkZstdFrames(buffer) {
  const frames = [];
  for (let start = 0, end; start < buffer.length; start = end) {
    end = completeFrameEnd(buffer, start);
    if (end === null) break;
    frames.push(zstdDecompressSync(buffer.subarray(start, end)));
  }
  return frames;
}

// The exclusive end of the frame starting at `start`, or null when the buffer ends inside it.
function completeFrameEnd(buffer, start) {
  let offset = start;
  if (buffer.length - offset < 4) return null;
  if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
    throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
  }
  offset += 4;
  if (offset === buffer.length) return null;
  const descriptor = buffer.readUInt8(offset);
  offset += 1;
  if ((descriptor & 0x18) !== 0) {
    throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
  }
  const contentSizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 0x20) !== 0;
  const checksum = (descriptor & 0x04) !== 0;
  const dictionaryFlag = descriptor & 0x03;
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
  offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
  if (offset > buffer.length) return null;

  for (;;) {
    if (buffer.length - offset < 3) return null;
    const blockHeader = buffer.readUIntLE(offset, 3);
    offset += 3;
    const blockType = (blockHeader >>> 1) & 0x03;
    if (blockType === 0x03) {
      throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
    }
    // An RLE block stores its one repeated byte, whatever size it expands to.
    offset += blockType === 0x01 ? 1 : blockHeader >>> 3;
    if (offset > buffer.length) return null;
    if ((blockHeader & 1) !== 0) break;
  }

  if (checksum) offset += 4;
  return offset > buffer.length ? null : offset;
}

// The session header the line holds, or null for a line that does not parse or is no `type: 'session'` object.
function sessionHeaderOf(line) {
  let record;
  try { record = JSON.parse(line); } catch { return null; }
  return record !== null && typeof record === 'object' && record.type === 'session' ? record : null;
}

/**
 * A DSH session log as `{ header, events }`: its header line and its events in log order. The plaintext is the
 * concatenated complete frames of a zstd log, the gunzipped body of a gzip file, or the bytes themselves otherwise.
 * Its first line — the bytes before the first LF, or the whole plaintext when it holds none — decides: it is a
 * header when it parses as an object whose `type` is `'session'`, and nothing past it is read to decide. Without a
 * header, a zstd or gzip plaintext throws and unencoded bytes answer null. With one, every non-empty line is
 * `JSON.parse`d and a line that does not parse throws, since DSH writes whole lines and the walk drops a torn final
 * frame.
 * @param {Buffer} buffer the file's bytes
 * @returns {{ header: object, events: object[] }|null}
 */
export function decodeDshLog(buffer) {
  const zstd = buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC;
  const gzip = !zstd && buffer.length >= 2 && buffer.readUInt16LE(0) === GZIP_MAGIC;
  const plaintext = zstd ? Buffer.concat(walkZstdFrames(buffer)) : gzip ? gunzipSync(buffer) : buffer;
  const firstLineEnd = plaintext.indexOf(0x0A);
  const header = sessionHeaderOf(plaintext.subarray(0, firstLineEnd === -1 ? plaintext.length : firstLineEnd)
    .toString('utf8'));
  if (header === null) {
    if (zstd || gzip) throw new Error('not a DSH session log: its first line is not a session header');
    return null;
  }
  const [, ...events] = plaintext.toString('utf8').split('\n').filter(line => line !== '')
    .map(line => JSON.parse(line));
  return { header, events };
}
