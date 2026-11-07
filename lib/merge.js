'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

// Binary may lose its exec bit in some deploy environments; fall back to a
// /tmp copy with 0o755.
function ensureExecutable(bin, tag) {
  try {
    fs.accessSync(bin, fs.constants.X_OK);
    return bin;
  } catch (_) {
    const dest = path.join(os.tmpdir(), `dmg-bin-${tag}`);
    fs.copyFileSync(bin, dest);
    fs.chmodSync(dest, 0o755);
    return dest;
  }
}

function probe(file) {
  return new Promise((resolve, reject) => {
    const bin = ensureExecutable(ffprobeStatic.path, 'ffprobe');
    const p = spawn(bin, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffprobe failed: ' + err.slice(-300)));
      try {
        const info = JSON.parse(out);
        const streams = info.streams || [];
        const v = streams.find(
          (s) => s.codec_type === 'video' && !(s.dispositions && s.dispositions.attached_pic)
        );
        if (!v) return reject(new Error('No video stream found'));
        const fpsRaw =
          v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate;
        let fps = 30;
        if (fpsRaw && String(fpsRaw).includes('/')) {
          const [a, b] = String(fpsRaw).split('/').map(Number);
          if (b) fps = a / b;
        } else if (fpsRaw) {
          const f = parseFloat(fpsRaw);
          if (f > 0) fps = f;
        }
        let duration = 0;
        if (info.format && info.format.duration) duration = parseFloat(info.format.duration);
        if (!duration && v.duration) duration = parseFloat(v.duration);
        resolve({
          width: v.width || 0,
          height: v.height || 0,
          fps,
          duration,
          hasAudio: streams.some((s) => s.codec_type === 'audio'),
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function downloadTo(url, dest, maxBytes) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; dmg-video-merger/1.0)' },
  });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
  const cl = parseInt(res.headers.get('content-length') || '0', 10);
  if (maxBytes && cl && cl > maxBytes) {
    throw new Error(`Source too large (${(cl / 1048576).toFixed(1)}MB > limit)`);
  }
  let count = 0;
  const src = Readable.fromWeb(res.body);
  const counter = new Transform({
    transform(chunk, enc, cb) {
      count += chunk.length;
      if (maxBytes && count > maxBytes) {
        cb(new Error(`Source too large (>${Math.round(maxBytes / 1048576)}MB)`));
        src.destroy();
        return;
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(src, counter, fs.createWriteStream(dest));
  } catch (e) {
    try {
      fs.unlinkSync(dest);
    } catch (_) {}
    throw e;
  }
  return count;
}

// inputs: [{ path }] — every input is normalized to the same resolution/fps/codec,
// then concatenated and re-encoded as H.264/AAC (CRF 18, high quality).
async function mergeVideos(
  inputs,
  output,
  { preset = 'medium', maxTotalDurationSec = 600, onProgress = () => {} } = {}
) {
  const probes = [];
  for (const inp of inputs) probes.push(await probe(inp.path));
  const totalDur = probes.reduce((s, p) => s + (p.duration || 0), 0);
  if (maxTotalDurationSec && totalDur > maxTotalDurationSec) {
    throw new Error(`Total duration ${Math.round(totalDur)}s exceeds the ${maxTotalDurationSec}s limit`);
  }

  let W = 0;
  let H = 0;
  for (const p of probes) {
    W = Math.max(W, p.width);
    H = Math.max(H, p.height);
  }
  W = Math.min(W || 1280, 1920);
  H = Math.min(H || 720, 1080);
  if (W % 2) W--;
  if (H % 2) H--;
  const fps = 30;

  const args = ['-y', '-nostdin'];
  const fc = [];
  const segs = [];
  let nextInput = 0;
  inputs.forEach((inp, i) => {
    const vIdx = nextInput++;
    args.push('-i', inp.path);
    let aIdx = null;
    if (!probes[i].hasAudio) {
      aIdx = nextInput++;
      const dur = Math.max(probes[i].duration || 1, 0.04);
      args.push('-f', 'lavfi', '-t', dur.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
    }
    segs.push({ vIdx, aIdx });
  });
  segs.forEach((s, i) => {
    fc.push(
      `[${s.vIdx}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`
    );
    fc.push(
      s.aIdx === null
        ? `[${s.vIdx}:a]aresample=44100,aformat=channel_layouts=stereo[a${i}]`
        : `[${s.aIdx}:a]aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`
    );
  });
  const concatIn = segs.map((_, i) => `[v${i}][a${i}]`).join('');
  fc.push(`${concatIn}concat=n=${segs.length}:v=1:a=1[vout][aout]`);
  args.push(
    '-filter_complex',
    fc.join(';'),
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-preset',
    preset,
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '44100',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    output
  );

  const bin = ensureExecutable(ffmpegStatic, 'ffmpeg');
  return await new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let errTail = '';
    let lastPct = -1;
    const report = (ratio) => {
      const pct = Math.max(0, Math.min(99, Math.round(ratio * 100)));
      if (pct !== lastPct) {
        lastPct = pct;
        try {
          onProgress(pct);
        } catch (_) {}
      }
    };
    p.stdout.on('data', (d) => {
      const s = d.toString();
      const m = /out_time_us=(\d+)/.exec(s) || /out_time_ms=(\d+)/.exec(s);
      if (m && totalDur > 0) report(parseInt(m[1], 10) / 1e6 / totalDur);
    });
    p.stderr.on('data', (d) => {
      errTail = (errTail + d.toString()).slice(-4000);
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve({ width: W, height: H, fps, duration: totalDur });
      else reject(new Error('ffmpeg failed (code ' + code + '): ' + errTail.slice(-500)));
    });
  });
}

module.exports = { probe, downloadTo, mergeVideos, ensureExecutable };
