'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// Output blobs are split into 2MB rows to stay well under Turso HTTP limits.
const OUT_CHUNK_BYTES = 2 * 1024 * 1024;

function toBuffer(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer) return Buffer.from(v);
  return Buffer.from(v);
}

function writeChunk(ws, buf) {
  return new Promise((resolve, reject) => {
    if (ws.write(buf)) resolve();
    else ws.once('drain', resolve);
  });
}

async function insertSourceChunk(db, jobId, seq, chunkSeq, data) {
  await db.execute({
    sql: 'INSERT OR REPLACE INTO source_chunks (job_id, seq, chunk_seq, data) VALUES (?, ?, ?, ?)',
    args: [jobId, seq, chunkSeq, data],
  });
}

async function readSourceToFile(db, jobId, seq, dest) {
  const ws = fs.createWriteStream(dest);
  const failure = new Promise((_, reject) => ws.once('error', reject));
  try {
    let last = -1;
    for (;;) {
      const r = await db.execute({
        sql: 'SELECT chunk_seq, data FROM source_chunks WHERE job_id = ? AND seq = ? AND chunk_seq > ? ORDER BY chunk_seq LIMIT 8',
        args: [jobId, seq, last],
      });
      if (!r.rows.length) break;
      for (const row of r.rows) {
        last = row.chunk_seq;
        await Promise.race([writeChunk(ws, toBuffer(row.data)), failure]);
      }
    }
  } finally {
    await new Promise((resolve) => ws.end(() => resolve()));
  }
  if (ws.errored) throw ws.errored;
}

async function sourceChunkCounts(db, jobId) {
  const r = await db.execute({
    sql: 'SELECT seq, COUNT(*) AS n FROM source_chunks WHERE job_id = ? GROUP BY seq',
    args: [jobId],
  });
  const map = {};
  for (const row of r.rows) map[String(row.seq)] = Number(row.n);
  return map;
}

async function storeOutput(db, jobId, filePath) {
  const size = fs.statSync(filePath).size;
  const data = await fs.promises.readFile(filePath);
  let chunkSeq = 0;
  const stmts = [];
  for (let off = 0; off < data.length; off += OUT_CHUNK_BYTES) {
    stmts.push({
      sql: 'INSERT INTO output_chunks (job_id, chunk_seq, data) VALUES (?, ?, ?)',
      args: [jobId, chunkSeq++, data.subarray(off, Math.min(off + OUT_CHUNK_BYTES, data.length))],
    });
  }
  for (let i = 0; i < stmts.length; i += 10) {
    await db.batch(stmts.slice(i, i + 10), 'write');
  }
  return { size, chunks: chunkSeq };
}

// Streams the stored output back, paginating through blob chunks.
async function* iterOutput(db, jobId) {
  let last = -1;
  for (;;) {
    const r = await db.execute({
      sql: 'SELECT chunk_seq, data FROM output_chunks WHERE job_id = ? AND chunk_seq > ? ORDER BY chunk_seq LIMIT 8',
      args: [jobId, last],
    });
    if (!r.rows.length) return;
    for (const row of r.rows) {
      last = row.chunk_seq;
      yield toBuffer(row.data);
    }
  }
}

function tmpDirFor(jobId) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dmg-${jobId}-`));
}

module.exports = {
  OUT_CHUNK_BYTES,
  toBuffer,
  insertSourceChunk,
  readSourceToFile,
  sourceChunkCounts,
  storeOutput,
  iterOutput,
  tmpDirFor,
};
