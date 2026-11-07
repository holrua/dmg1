'use strict';
const { Readable } = require('stream');
const { getClient, ensureSchema } = require('../../../lib/db');
const storage = require('../../../lib/storage');
const { setCors, parseRange, errMessage } = require('../../../lib/util');

// GET  /api/jobs/<id>/video            → stream the merged video (supports Range)
// GET  /api/jobs/<id>/video?download=1 → force download
module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Use GET' }));
  }
  const id = String(req.query.id || '');
  try {
    await ensureSchema();
    const db = getClient();
    const r = await db.execute({ sql: 'SELECT * FROM jobs WHERE id = ?', args: [id] });
    if (!r.rows.length) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'Job not found' }));
    }
    const job = r.rows[0];
    if (String(job.status) !== 'done') {
      res.statusCode = 409;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: `Video not ready (status: ${job.status})` }));
    }

    const total = job.output_size || 0;
    const fname = job.output_name || `merged-${id}.mp4`;
    const download = new URL(req.url, 'http://x').searchParams.get('download') === '1';
    res.setHeader('Content-Type', job.output_mime || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader(
      'Content-Disposition',
      `${download ? 'attachment' : 'inline'}; filename="${fname}"; filename*=UTF-8''${encodeURIComponent(fname)}`
    );

    const range = parseRange(req.headers.range, total);
    const start = range ? range.start : 0;
    const end = range ? range.end : total - 1;
    if (req.method === 'HEAD') {
      res.setHeader('Content-Length', total);
      return res.end();
    }
    if (range) {
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    } else {
      res.statusCode = 200;
    }
    res.setHeader('Content-Length', Math.max(0, end - start + 1));

    const gen = async function* () {
      let pos = 0;
      for await (const buf of storage.iterOutput(db, id)) {
        const chunkEnd = pos + buf.length - 1;
        if (chunkEnd < start) {
          pos = chunkEnd + 1;
          continue;
        }
        if (pos > end) break;
        const from = Math.max(start, pos) - pos;
        const to = Math.min(end, chunkEnd) - pos;
        yield buf.subarray(from, to + 1);
        pos = chunkEnd + 1;
      }
    };
    const stream = Readable.from(gen());
    stream.on('error', () => {
      try {
        res.destroy();
      } catch (_) {}
    });
    stream.pipe(res);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: errMessage(e) }));
  }
};
