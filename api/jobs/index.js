'use strict';
const { getClient, ensureSchema, limits, cleanupExpired } = require('../../lib/db');
const { json, setCors, newId, baseUrl, readRawBody, errMessage } = require('../../lib/util');

// POST /api/jobs
// { "videos": ["https://...", "..."] }
// or  { "sources": [{ "kind": "url", "url": "https://..." }, { "kind": "file", "name": "a.mp4", "size": 123, "mime": "video/mp4" }] }
module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed. Use POST.' });
  try {
    await ensureSchema();
    await cleanupExpired();
    const raw = await readRawBody(req, 1024 * 1024);
    let body;
    try {
      body = JSON.parse(raw.toString('utf8') || '{}');
    } catch (_) {
      return json(res, 400, { error: 'Invalid JSON body' });
    }

    let sources = [];
    if (Array.isArray(body.sources)) {
      for (const s of body.sources) {
        if (s && s.kind === 'url' && typeof s.url === 'string') {
          sources.push({ kind: 'url', url: s.url.trim(), filename: s.filename || null, size: null, mime: null });
        } else if (s && s.kind === 'file') {
          sources.push({
            kind: 'file',
            url: null,
            filename: s.name || s.filename || 'video.mp4',
            size: Number(s.size) || null,
            mime: s.mime || s.mimeType || 'video/mp4',
          });
        }
      }
    } else if (Array.isArray(body.videos)) {
      for (const u of body.videos) {
        if (typeof u === 'string') sources.push({ kind: 'url', url: u.trim(), filename: null, size: null, mime: null });
      }
    }
    sources = sources.filter((s) => s.kind === 'file' || /^https?:\/\/.+/i.test(s.url || ''));
    if (!sources.length) {
      return json(res, 400, { error: 'Provide "videos": [urls] or "sources": [{kind:"url"|"file", ...}]' });
    }
    if (sources.length > limits.maxSources) {
      return json(res, 400, { error: `Too many videos. Max is ${limits.maxSources}.` });
    }
    for (const s of sources) {
      if (s.url && s.url.length > 2048) return json(res, 400, { error: 'URL too long (max 2048 chars)' });
    }

    const id = newId();
    const now = Date.now();
    const expires = now + 24 * 60 * 60 * 1000; // auto-delete after 24h
    const hasFiles = sources.some((s) => s.kind === 'file');
    const db = getClient();
    await db.execute({
      sql: 'INSERT INTO jobs (id, status, progress, source_count, created_at, expires_at, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?)',
      args: [id, hasFiles ? 'uploading' : 'queued', sources.length, now, expires, now],
    });
    await db.batch(
      sources.map((s, seq) => ({
        sql: 'INSERT INTO sources (job_id, seq, kind, url, filename, mime, size) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [id, seq, s.kind, s.url, s.filename, s.mime, s.size],
      })),
      'write'
    );

    const base = baseUrl(req);
    const out = {
      jobId: id,
      status: hasFiles ? 'uploading' : 'queued',
      statusUrl: `${base}/api/jobs/${id}`,
      processUrl: `${base}/api/jobs/${id}/process`,
      expiresAt: new Date(expires).toISOString(),
    };
    if (hasFiles) {
      out.uploadChunkBytes = 4 * 1024 * 1024; // Vercel request-body limit is 4.5MB
      out.uploads = sources
        .map((s, seq) =>
          s.kind === 'file' ? { seq, uploadUrl: `${base}/api/upload?job=${id}&seq=${seq}` } : null
        )
        .filter(Boolean);
    }
    return json(res, 201, out);
  } catch (e) {
    return json(res, 500, { error: errMessage(e) });
  }
};
