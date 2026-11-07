'use strict';
const { createClient } = require('@libsql/client');

// jobs.status: queued (URLs only, ready to process) | uploading (has file sources)
//            | processing | done | failed
const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  source_count INTEGER NOT NULL DEFAULT 0,
  output_name TEXT,
  output_mime TEXT,
  output_size INTEGER,
  output_duration REAL,
  error TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS sources (
  job_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  url TEXT,
  filename TEXT,
  mime TEXT,
  size INTEGER,
  PRIMARY KEY (job_id, seq)
);
CREATE TABLE IF NOT EXISTS source_chunks (
  job_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  chunk_seq INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (job_id, seq, chunk_seq)
);
CREATE TABLE IF NOT EXISTS output_chunks (
  job_id TEXT NOT NULL,
  chunk_seq INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (job_id, chunk_seq)
);
`;

let _client = null;
let _schema = null;

function getClient() {
  if (_client) return _client;
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error('TURSO_DATABASE_URL is not configured');
  _client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  return _client;
}

function ensureSchema() {
  if (!_schema) {
    _schema = getClient().executeMultiple(SCHEMA).catch((e) => {
      _schema = null;
      throw e;
    });
  }
  return _schema;
}

function num(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

const limits = {
  maxSources: num(process.env.MAX_SOURCES, 10),
  sourceMaxBytes: num(process.env.SOURCE_MAX_MB, 200) * 1024 * 1024,
  outputMaxBytes: num(process.env.OUTPUT_MAX_MB, 150) * 1024 * 1024,
  maxTotalDurationSec: num(process.env.MAX_TOTAL_DURATION_SEC, 600),
  ffmpegPreset: process.env.FFMPEG_PRESET || 'medium',
};

// Deletes jobs older than their 24h expiry, along with all their blobs.
async function cleanupExpired() {
  const db = getClient();
  const now = Date.now();
  const res = await db.execute({ sql: 'SELECT id FROM jobs WHERE expires_at < ?', args: [now] });
  const ids = res.rows.map((r) => String(r.id));
  if (!ids.length) return 0;
  const stmts = [];
  for (const id of ids) {
    stmts.push({ sql: 'DELETE FROM source_chunks WHERE job_id = ?', args: [id] });
    stmts.push({ sql: 'DELETE FROM output_chunks WHERE job_id = ?', args: [id] });
    stmts.push({ sql: 'DELETE FROM sources WHERE job_id = ?', args: [id] });
    stmts.push({ sql: 'DELETE FROM jobs WHERE id = ?', args: [id] });
  }
  await db.batch(stmts, 'write');
  return ids.length;
}

async function deleteJobCascade(id) {
  const db = getClient();
  await db.batch(
    [
      { sql: 'DELETE FROM source_chunks WHERE job_id = ?', args: [id] },
      { sql: 'DELETE FROM output_chunks WHERE job_id = ?', args: [id] },
      { sql: 'DELETE FROM sources WHERE job_id = ?', args: [id] },
      { sql: 'DELETE FROM jobs WHERE id = ?', args: [id] },
    ],
    'write'
  );
}

module.exports = { getClient, ensureSchema, limits, cleanupExpired, deleteJobCascade };
