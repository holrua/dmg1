'use strict';
const { getClient, ensureSchema, deleteJobCascade } = require('../../../lib/db');
const { json, setCors, baseUrl, errMessage } = require('../../../lib/util');

// GET /api/jobs/<id>    → job status
// DELETE /api/jobs/<id> → delete job + all stored data
function jobResponse(job, base) {
  const out = {
    jobId: String(job.id),
    status: String(job.status),
    progress: job.progress || 0,
    createdAt: new Date(job.created_at).toISOString(),
    expiresAt: new Date(job.expires_at).toISOString(),
  };
  if (out.status === 'done') {
    out.videoUrl = `${base}/api/jobs/${out.jobId}/video`;
    out.downloadUrl = `${base}/api/jobs/${out.jobId}/video?download=1`;
    out.size = job.output_size;
    out.duration = job.output_duration;
    out.name = job.output_name;
  }
  if (out.status === 'failed' && job.error) out.error = job.error;
  return out;
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  const id = req.query.id;
  if (!id) return json(res, 400, { error: 'Missing id' });
  try {
    await ensureSchema();
    const db = getClient();
    if (req.method === 'DELETE') {
      await deleteJobCascade(String(id));
      return json(res, 200, { deleted: true, jobId: String(id) });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'Use GET or DELETE' });
    }
    const r = await db.execute({ sql: 'SELECT * FROM jobs WHERE id = ?', args: [String(id)] });
    if (!r.rows.length) return json(res, 404, { error: 'Job not found' });
    return json(res, 200, jobResponse(r.rows[0], baseUrl(req)));
  } catch (e) {
    return json(res, 500, { error: errMessage(e) });
  }
};
