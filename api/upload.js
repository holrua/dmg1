'use strict';
const { getClient, ensureSchema } = require('../lib/db');
const { insertSourceChunk } = require('../lib/storage');
const { json, setCors, readRawBody, errMessage } = require('../lib/util');

// POST /api/upload?job=<id>&seq=<n>[&chunk=<k>]
// Raw binary body (application/octet-stream), max ~4MB per request.
module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed. Use POST.' });
  try {
    await ensureSchema();
    const u = new URL(req.url, 'http://x');
    const jobId = u.searchParams.get('job');
    const seq = parseInt(u.searchParams.get('seq'), 10);
    const chunkSeq = parseInt(u.searchParams.get('chunk') || '0', 10);
    if (!jobId || !Number.isInteger(seq) || seq < 0 || !Number.isInteger(chunkSeq) || chunkSeq < 0) {
      return json(res, 400, { error: 'Missing/invalid job, seq or chunk query params' });
    }

    const db = getClient();
    const job = await db.execute({ sql: 'SELECT id, status FROM jobs WHERE id = ?', args: [jobId] });
    if (!job.rows.length) return json(res, 404, { error: 'Job not found' });
    const status = String(job.rows[0].status);
    if (!['uploading', 'queued'].includes(status)) {
      return json(res, 409, { error: `Job status is "${status}"; uploads are closed` });
    }
    const src = await db.execute({
      sql: 'SELECT seq, kind FROM sources WHERE job_id = ? AND seq = ?',
      args: [jobId, seq],
    });
    if (!src.rows.length) return json(res, 404, { error: 'Source not found' });
    if (String(src.rows[0].kind) !== 'file') {
      return json(res, 400, { error: 'This source is a URL, nothing to upload' });
    }

    const data = await readRawBody(req, 4.4 * 1024 * 1024);
    if (!data.length) return json(res, 400, { error: 'Empty body' });
    await insertSourceChunk(db, jobId, seq, chunkSeq, data);
    return json(res, 200, { ok: true, chunk: chunkSeq, bytes: data.length });
  } catch (e) {
    const code = /too large/i.test(String(e && e.message)) ? 413 : 500;
    return json(res, code, { error: errMessage(e) });
  }
};
