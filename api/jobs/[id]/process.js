'use strict';
const fs = require('fs');
const path = require('path');
const { getClient, ensureSchema, limits, cleanupExpired } = require('../../../lib/db');
const storage = require('../../../lib/storage');
const { mergeVideos, downloadTo } = require('../../../lib/merge');
const { json, setCors, baseUrl, errMessage } = require('../../../lib/util');

// POST /api/jobs/<id>/process
// Synchronous: downloads/pulls all sources, merges them with ffmpeg, stores the
// result in Turso (auto-deleted after 24h) and returns the final video URL.
// If the job is already processing (fresh attempt), returns 202.
const STALE_MS = 10 * 60 * 1000;

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed. Use POST.' });
  const id = String(req.query.id || '');
  let dir = null;
  try {
    await ensureSchema();
    cleanupExpired().catch(() => {});
    const db = getClient();
    const r = await db.execute({ sql: 'SELECT * FROM jobs WHERE id = ?', args: [id] });
    if (!r.rows.length) return json(res, 404, { error: 'Job not found' });
    const job = r.rows[0];
    const base = baseUrl(req);

    if (job.status === 'done') {
      return json(res, 200, {
        jobId: id,
        status: 'done',
        videoUrl: `${base}/api/jobs/${id}/video`,
        downloadUrl: `${base}/api/jobs/${id}/video?download=1`,
        size: job.output_size,
        duration: job.output_duration,
        expiresAt: new Date(job.expires_at).toISOString(),
      });
    }
    if (job.status === 'processing' && Date.now() - (job.updated_at || 0) < STALE_MS) {
      return json(res, 202, { jobId: id, status: 'processing', statusUrl: `${base}/api/jobs/${id}` });
    }

    const srcs = (await db.execute({ sql: 'SELECT * FROM sources WHERE job_id = ? ORDER BY seq', args: [id] })).rows;
    if (!srcs.length) return json(res, 400, { error: 'Job has no sources' });
    const counts = await storage.sourceChunkCounts(db, id);
    for (const s of srcs) {
      if (String(s.kind) === 'file' && !counts[String(s.seq)]) {
        return json(res, 400, { error: `Source #${s.seq} (${s.filename}) has no uploaded data` });
      }
    }

    await db.execute({
      sql: "UPDATE jobs SET status = 'processing', progress = 1, error = NULL, updated_at = ? WHERE id = ?",
      args: [Date.now(), id],
    });

    dir = storage.tmpDirFor(id);
    const n = srcs.length;
    const inputs = [];
    for (let i = 0; i < n; i++) {
      const s = srcs[i];
      const dest = path.join(dir, `in_${i}.bin`);
      if (String(s.kind) === 'url') {
        await downloadTo(s.url, dest, limits.sourceMaxBytes);
      } else {
        await storage.readSourceToFile(db, id, s.seq, dest);
      }
      inputs.push({ path: dest });
      await db.execute({
        sql: 'UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ?',
        args: [Math.round(((i + 1) / n) * 40), Date.now(), id],
      });
    }

    let lastPct = 40;
    const result = await mergeVideos(inputs, path.join(dir, 'out.mp4'), {
      preset: limits.ffmpegPreset,
      maxTotalDurationSec: limits.maxTotalDurationSec,
      onProgress: (p) => {
        const pct = 40 + Math.round((p / 100) * 50);
        if (pct > lastPct) {
          lastPct = pct;
          db.execute({
            sql: 'UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ?',
            args: [pct, Date.now(), id],
          }).catch(() => {});
        }
      },
    });

    const size = fs.statSync(path.join(dir, 'out.mp4')).size;
    if (size > limits.outputMaxBytes) {
      throw new Error(
        `Merged file is ${(size / 1048576).toFixed(1)}MB which exceeds the ${Math.round(limits.outputMaxBytes / 1048576)}MB limit`
      );
    }
    await db.execute({
      sql: 'UPDATE jobs SET progress = 92, updated_at = ? WHERE id = ?',
      args: [Date.now(), id],
    });
    await storage.storeOutput(db, id, path.join(dir, 'out.mp4'));
    await db.execute({
      sql: "UPDATE jobs SET status = 'done', progress = 100, output_name = ?, output_mime = 'video/mp4', output_size = ?, output_duration = ?, updated_at = ? WHERE id = ?",
      args: [`merged-${id}.mp4`, size, result.duration, Date.now(), id],
    });
    // Sources are no longer needed once the merge succeeded.
    await db.execute({ sql: 'DELETE FROM source_chunks WHERE job_id = ?', args: [id] });

    return json(res, 200, {
      jobId: id,
      status: 'done',
      videoUrl: `${base}/api/jobs/${id}/video`,
      downloadUrl: `${base}/api/jobs/${id}/video?download=1`,
      size,
      duration: result.duration,
      resolution: `${result.width}x${result.height}`,
      expiresAt: new Date(job.expires_at).toISOString(),
    });
  } catch (e) {
    try {
      await getClient().execute({
        sql: "UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
        args: [errMessage(e), Date.now(), id],
      });
    } catch (_) {}
    return json(res, 500, { error: errMessage(e) });
  } finally {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {}
    }
  }
};
