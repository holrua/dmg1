'use strict';
/* Full HTTP smoke test against the local dev server (mimics Vercel):
 * URL-based flow, file-upload flow, status, video streaming + Range, delete, config.
 * Usage: node scripts/smoke-api.js
 */
process.chdir(__dirname + '/..');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const http = require('http');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name + (extra ? ' — ' + extra : '')); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
const API = 'http://127.0.0.1:3100';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(API + '/api/config');
      if (r.ok) return true;
    } catch (_) {}
    await sleep(200);
  }
  return false;
}

async function main() {
  // 1) media server with two real mp4 files (different resolutions)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmg-smoke-'));
  const a = path.join(tmp, 'a.mp4');
  const b = path.join(tmp, 'b.mp4');
  execFileSync(ffmpegStatic, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', a]);
  execFileSync(ffmpegStatic, ['-y', '-f', 'lavfi', '-i', 'smptebars=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=1000', '-t', '2', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', b]);
  const mediaSrv = http.createServer((rq, rs) => {
    const f = rq.url === '/a.mp4' ? a : rq.url === '/b.mp4' ? b : null;
    if (!f) { rs.statusCode = 404; return rs.end(); }
    rs.setHeader('Content-Type', 'video/mp4');
    rs.setHeader('Content-Length', fs.statSync(f).size);
    fs.createReadStream(f).pipe(rs);
  });
  await new Promise((r) => mediaSrv.listen(3101, '127.0.0.1', r));
  const urlA = 'http://127.0.0.1:3101/a.mp4';
  const urlB = 'http://127.0.0.1:3101/b.mp4';

  // 2) start local dev server (child process)
  const dev = spawn(process.execPath, ['scripts/local-dev.js'], {
    env: { ...process.env, PORT: '3100' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  dev.stderr.on('data', (d) => console.error('[dev]', d.toString().trim().slice(0, 300)));
  check('dev server healthy', await waitHealth());

  const cfg = await (await fetch(API + '/api/config')).json();
  check('GET /api/config', cfg.maxSources >= 1 && cfg.uploadChunkBytes === 4 * 1024 * 1024);

  // 3) URL flow
  let r = await fetch(API + '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videos: [urlA, urlB] }),
  });
  const job = await r.json();
  check('POST /api/jobs (urls) → 201', r.status === 201 && !!job.jobId, `jobId=${job.jobId}`);
  check('statusUrl/processUrl present', !!job.statusUrl && !!job.processUrl);

  r = await fetch(job.processUrl, { method: 'POST' });
  const done = await r.json();
  check('POST process → done', r.status === 200 && done.status === 'done', `size=${done.size}, res=${done.resolution}`);
  check('duration ≈ 4s', Math.abs((done.duration || 0) - 4) < 0.7, `${(done.duration || 0).toFixed(2)}s`);
  check('resolution 1280x720', done.resolution === '1280x720');
  check('videoUrl returned', /^https?:\/\/.+\/video$/.test(done.videoUrl || ''));

  r = await fetch(job.statusUrl);
  const st = await r.json();
  check('GET status → done + videoUrl', r.status === 200 && st.status === 'done' && !!st.videoUrl);

  const vres = await fetch(st.videoUrl);
  const vbuf = Buffer.from(await vres.arrayBuffer());
  check('GET video → 200 mp4', vres.status === 200 && /video\/mp4/.test(vres.headers.get('content-type') || ''));
  check('video bytes complete', vbuf.length === done.size, `${vbuf.length} bytes`);
  check('mp4 magic (ftyp)', vbuf.subarray(4, 8).toString() === 'ftyp');
  check('inline disposition', /^inline/.test(vres.headers.get('content-disposition') || ''));

  const rng = await fetch(st.videoUrl, { headers: { Range: 'bytes=0-99' } });
  const rbuf = Buffer.from(await rng.arrayBuffer());
  check('Range request → 206 + 100 bytes', rng.status === 206 && rbuf.length === 100, rng.headers.get('content-range'));

  r = await fetch(st.videoUrl.replace(/\/video$/, '/video') + '?download=1');
  check('download=1 → attachment', /^attachment/.test(r.headers.get('content-disposition') || ''));
  await r.arrayBuffer();

  // 4) file upload flow
  const fileBuf = fs.readFileSync(a);
  r = await fetch(API + '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sources: [{ kind: 'url', url: urlB }, { kind: 'file', name: 'up.mp4', size: fileBuf.length, mime: 'video/mp4' }] }),
  });
  const job2 = await r.json();
  check('POST /api/jobs (mixed) → uploading', r.status === 201 && job2.status === 'uploading' && (job2.uploads || []).length === 1);

  const up = job2.uploads[0];
  r = await fetch(up.uploadUrl, { method: 'POST', body: fileBuf, headers: { 'Content-Type': 'application/octet-stream' } });
  check('POST /api/upload chunk', r.status === 200);

  r = await fetch(job2.processUrl, { method: 'POST' });
  const done2 = await r.json();
  check('mixed job process → done', r.status === 200 && done2.status === 'done', `size=${done2.size}`);
  check('mixed output duration ≈ 4s', Math.abs((done2.duration || 0) - 4) < 0.7);

  // 5) delete
  r = await fetch(job.statusUrl, { method: 'DELETE' });
  check('DELETE job → deleted', r.status === 200);
  r = await fetch(job.statusUrl);
  check('GET deleted job → 404', r.status === 404);

  // 6) validation errors
  r = await fetch(API + '/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"videos":[]}' });
  check('empty videos → 400', r.status === 400);
  r = await fetch(API + '/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not-json' });
  check('bad json → 400', r.status === 400);
  r = await fetch(API + '/api/jobs/nonexistent-id');
  check('unknown job → 404', r.status === 404);
  r = await fetch(API + '/');
  const html = await r.text();
  check('GET / serves the UI', r.status === 200 && html.includes('دمج الفيديوهات'));

  mediaSrv.close();
  dev.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n===== SMOKE RESULT: ${passed} passed, ${failed} failed =====`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('SMOKE CRASHED:', e);
  process.exit(1);
});
