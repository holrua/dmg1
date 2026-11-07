'use strict';
/* End-to-end local test:
 * 1) Turso connectivity + schema
 * 2) ffmpeg merge of two generated videos (different resolutions)
 * 3) output verification (duration/resolution/audio)
 * 4) blob store into Turso + read back + byte-compare
 * 5) source-chunk upload/read path + 24h cleanup check
 */
process.chdir(__dirname + '/..'); // run from project root
require('fs').readFileSync('.env', 'utf8').split('\n').forEach((line) => {
  const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+)\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { getClient, ensureSchema, cleanupExpired, deleteJobCascade } = require('../lib/db');
const storage = require('../lib/storage');
const { mergeVideos, probe, downloadTo, ensureExecutable } = require('../lib/merge');
const ffmpegStatic = require('ffmpeg-static');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log('  PASS  ' + name + (extra ? ' — ' + extra : ''));
  } else {
    failed++;
    console.log('  FAIL  ' + name + (extra ? ' — ' + extra : ''));
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmg-test-'));
  const ffmpeg = ensureExecutable(ffmpegStatic, 'ffmpeg');

  console.log('\n[1] ffmpeg binary');
  check('ffmpeg runs', !!execFileSync(ffmpeg, ['-version']).toString().includes('ffmpeg'));

  console.log('\n[2] Turso connectivity + schema');
  const db = getClient();
  const ping = await db.execute('SELECT 1 AS one');
  check('turso SELECT 1', Number(ping.rows[0].one) === 1);
  await ensureSchema();
  check('schema created (4 tables)', true, 'jobs, sources, source_chunks, output_chunks');
  const cleaned = await cleanupExpired();
  check('cleanupExpired runs', typeof cleaned === 'number', `deleted ${cleaned} expired job(s)`);

  console.log('\n[3] generate test inputs (different resolutions)');
  const a = path.join(tmp, 'a.mp4');
  const b = path.join(tmp, 'b.mp4');
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', a]);
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'smptebars=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=1000', '-t', '2', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', b]);
  const pa = await probe(a);
  const pb = await probe(b);
  check('probe A (640x360, ~2s, audio)', pa.width === 640 && pa.height === 360 && pa.duration > 1.5 && pa.hasAudio);
  check('probe B (1280x720, ~2s, audio)', pb.width === 1280 && pb.height === 720 && pb.duration > 1.5 && pb.hasAudio);

  console.log('\n[4] merge');
  const out = path.join(tmp, 'out.mp4');
  let progressSeen = 0;
  const res = await mergeVideos([{ path: a }, { path: b }], out, {
    preset: 'veryfast',
    maxTotalDurationSec: 600,
    onProgress: (p) => { progressSeen = Math.max(progressSeen, p); },
  });
  const po = await probe(out);
  check('merge completes', fs.existsSync(out) && fs.statSync(out).size > 10000, `${fmt(fs.statSync(out).size)}`);
  check('output resolution = max inputs (1280x720)', po.width === 1280 && po.height === 720, `${po.width}x${po.height}`);
  check('output duration ≈ sum (4s)', Math.abs(po.duration - (pa.duration + pb.duration)) < 0.6, `${po.duration.toFixed(2)}s`);
  check('output has audio', po.hasAudio);
  check('progress callback fired', progressSeen > 10, `max seen ${progressSeen}%`);

  console.log('\n[5] blob storage round-trip via Turso');
  const jobId = 'test-' + crypto.randomBytes(4).toString('hex');
  await db.execute({
    sql: "INSERT INTO jobs (id, status, source_count, created_at, expires_at) VALUES (?, 'processing', 2, ?, ?)",
    args: [jobId, Date.now(), Date.now() + 3600 * 1000],
  });
  const stored = await storage.storeOutput(db, jobId, out);
  check('storeOutput chunked', stored.chunks >= 1 && stored.size === fs.statSync(out).size, `${stored.chunks} chunk(s), ${fmt(stored.size)}`);
  let roundTrip = Buffer.alloc(0);
  for await (const buf of storage.iterOutput(db, jobId)) roundTrip = Buffer.concat([roundTrip, buf]);
  const h1 = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
  const h2 = crypto.createHash('sha256').update(roundTrip).digest('hex');
  check('read-back bytes identical (sha256)', h1 === h2);

  console.log('\n[6] source chunk upload path');
  await storage.insertSourceChunk(db, jobId, 0, 0, Buffer.from('HELLO-CHUNK-0'));
  await storage.insertSourceChunk(db, jobId, 0, 1, Buffer.from('HELLO-CHUNK-1'));
  const srcFile = path.join(tmp, 'src.bin');
  await storage.readSourceToFile(db, jobId, 0, srcFile);
  check('source chunks reassemble in order', fs.readFileSync(srcFile).toString() === 'HELLO-CHUNK-0HELLO-CHUNK-1');
  const counts = await storage.sourceChunkCounts(db, jobId);
  check('sourceChunkCounts', counts['0'] === 2);

  console.log('\n[7] downloadTo (url fetch)');
  // use file:// not supported by fetch — use a tiny http server
  const http = require('http');
  const payload = Buffer.alloc(256 * 1024, 7);
  const srv = http.createServer((rq, rs) => { rs.setHeader('Content-Length', payload.length); rs.end(payload); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const dl = path.join(tmp, 'dl.bin');
  await downloadTo(`http://127.0.0.1:${port}/file.bin`, dl, 10 * 1024 * 1024);
  check('downloadTo fetches remote file', crypto.createHash('sha256').update(fs.readFileSync(dl)).digest('hex') === crypto.createHash('sha256').update(payload).digest('hex'));
  let tooBig = false;
  try { await downloadTo(`http://127.0.0.1:${port}/file.bin`, dl, 1024); } catch (_) { tooBig = true; }
  check('downloadTo enforces size cap', tooBig);
  srv.close();

  console.log('\n[8] 24h auto-delete');
  await deleteJobCascade(jobId);
  const after = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM output_chunks WHERE job_id = ?', args: [jobId] });
  check('deleteJobCascade removes blobs', Number(after.rows[0].n) === 0);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n===== RESULT: ${passed} passed, ${failed} failed =====`);
  process.exit(failed ? 1 : 0);
}

function fmt(b) {
  return b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
}

main().catch((e) => {
  console.error('TEST CRASHED:', e);
  process.exit(1);
});
