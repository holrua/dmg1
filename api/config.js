'use strict';
const { limits } = require('../lib/db');
const { json, setCors } = require('../lib/util');

// GET /api/config — public limits so clients (and the UI) can size uploads.
module.exports = async (req, res) => {
  setCors(req, res);
  return json(res, 200, {
    maxSources: limits.maxSources,
    sourceMaxMb: Math.round(limits.sourceMaxBytes / 1048576),
    outputMaxMb: Math.round(limits.outputMaxBytes / 1048576),
    maxTotalDurationSec: limits.maxTotalDurationSec,
    ffmpegPreset: limits.ffmpegPreset,
    uploadChunkBytes: 4 * 1024 * 1024,
  });
};
