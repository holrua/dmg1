'use strict';
const { ensureSchema, cleanupExpired } = require('../lib/db');
const { json, setCors, errMessage } = require('../lib/util');

// GET /api/cron — daily Vercel Cron: deletes jobs past their 24h expiry.
// Cleanup also runs lazily on create/process requests, so videos are always
// removed even if the cron never fires.
module.exports = async (req, res) => {
  setCors(req, res);
  try {
    await ensureSchema();
    const deleted = await cleanupExpired();
    return json(res, 200, { ok: true, deletedJobs: deleted, ranAt: new Date().toISOString() });
  } catch (e) {
    return json(res, 500, { error: errMessage(e) });
  }
};
