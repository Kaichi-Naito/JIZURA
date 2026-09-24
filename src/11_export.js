/* ============================================================
   JIZURA — export: MP4 (WebCodecs + mp4-muxer), PNG sequence ZIP,
   file saving (artifact download capability or plain browser download)
   ============================================================ */
(() => {
'use strict';

/* ---------- saving ---------- */
J.saveFile = async (filename, data) => {
  const blob = data instanceof Blob ? data : new Blob([data]);
  try {
    if (window.claude && typeof window.claude.use === 'function') {
      const dl = await window.claude.use('downloads');
      if (dl) { await dl.save({ filename, data: blob }); return 'saved'; }
    }
  } catch (e) {
    if (e && e.code === 'declined') return 'declined';
    if (e && e.code && e.code !== 'unavailable' && e.code !== 'not_granted') throw e;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return 'saved';
};

/* ---------- codec negotiation ---------- */
J.pickVideoCodec = async (w, h, fps, bitrate) => {
  if (typeof VideoEncoder === 'undefined') return null;
  const cands = [
    { codec: 'avc1.640033', mux: 'avc', label: 'H.264 High' },
    { codec: 'avc1.4d0033', mux: 'avc', label: 'H.264 Main' },
    { codec: 'avc1.42003e', mux: 'avc', label: 'H.264 Baseline' },
    { codec: 'vp09.00.51.08', mux: 'vp9', label: 'VP9' },
    { codec: 'av01.0.12M.08', mux: 'av1', label: 'AV1' },
  ];
  for (const c of cands) {
    const cfg = { codec: c.codec, width: w, height: h, bitrate, framerate: fps };
    if (c.mux === 'avc') cfg.avc = { format: 'avc' };
    try { const s = await VideoEncoder.isConfigSupported(cfg); if (s.supported) return Object.assign({}, c, { cfg }); } catch (e) {}
  }
  return null;
};
J.pickAudioCodec = async (sr, chn) => {
  if (typeof AudioEncoder === 'undefined') return null;
  for (const c of [{ codec: 'mp4a.40.2', mux: 'aac', sr: 48000 }, { codec: 'opus', mux: 'opus', sr: 48000 }]) {
    try { const s = await AudioEncoder.isConfigSupported({ codec: c.codec, sampleRate: c.sr, numberOfChannels: chn, bitrate: 192000 }); if (s.supported) return c; } catch (e) {}
  }
  return null;
};

async function resample(buffer, sr, duration) {
  const chn = Math.min(2, buffer.numberOfChannels);
  const len = Math.ceil(duration * sr);
  const oc = new OfflineAudioContext(chn, len, sr);
  const src = oc.createBufferSource(); src.buffer = buffer; src.connect(oc.destination); src.start(0);
  return oc.startRendering();
}

/* ---------- MP4 ---------- */
J.exportMP4 = async ({ plan, project, audio, quality = 'high', onProgress, signal }) => {
  const [w, h] = J.outputSize(project);
  const fps = plan.fps;
  const px = w * h * fps;
  const bitrate = Math.round(px * (quality === 'max' ? 0.42 : quality === 'high' ? 0.28 : 0.16));
  const vc = await J.pickVideoCodec(w, h, fps, bitrate);
  if (!vc) throw new Error('このブラウザは動画エンコード（WebCodecs）に対応していません。Chrome か Edge の最新版で開いてください。');
  let ac = null;
  if (audio && audio.buffer && project.includeAudio !== false) ac = await J.pickAudioCodec(48000, Math.min(2, audio.buffer.numberOfChannels));
  const target = new Mp4Muxer.ArrayBufferTarget();
  const muxOpts = { target, video: { codec: vc.mux, width: w, height: h, frameRate: fps }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' };
  if (ac) muxOpts.audio = { codec: ac.mux, numberOfChannels: Math.min(2, audio.buffer.numberOfChannels), sampleRate: ac.sr };
  const muxer = new Mp4Muxer.Muxer(muxOpts);
  let err = null;
  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => { err = e; } });
  venc.configure(Object.assign({}, vc.cfg, { latencyMode: 'quality' }));
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false });
  const R = new J.Renderer();
  const total = Math.max(1, Math.round(plan.duration * fps));
  const scale = w / plan.W;
  const prevRes = J.glyphs.maxRes; J.glyphs.maxRes = h >= 1000 ? 768 : 512;
  try {
  for (let i = 0; i < total; i++) {
    if (signal && signal.aborted) { try { venc.close(); } catch (e) {} throw new Error('キャンセルしました'); }
    if (err) throw err;
    R.frame(ctx, plan, i / fps, { scale });
    const vf = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
    venc.encode(vf, { keyFrame: i % (fps * 2) === 0 });
    vf.close();
    while (venc.encodeQueueSize > 4) await new Promise(r => setTimeout(r, 2));
    if (i % 3 === 0) { onProgress && onProgress(i / total, `フレーム ${i + 1}/${total}`); await new Promise(r => setTimeout(r, 0)); }
  }
  } finally { J.glyphs.maxRes = prevRes; }
  await venc.flush(); venc.close();
  if (ac) {
    onProgress && onProgress(0.99, '音声をエンコード中');
    const rs = await resample(audio.buffer, ac.sr, plan.duration);
    const chn = rs.numberOfChannels;
    const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: e => { err = e; } });
    aenc.configure({ codec: ac.codec, sampleRate: ac.sr, numberOfChannels: chn, bitrate: 192000 });
    const frames = rs.length, block = 4800;
    for (let off = 0; off < frames; off += block) {
      const n = Math.min(block, frames - off);
      const data = new Float32Array(n * chn);
      for (let c = 0; c < chn; c++) data.set(rs.getChannelData(c).subarray(off, off + n), c * n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: ac.sr, numberOfFrames: n, numberOfChannels: chn, timestamp: Math.round(off * 1e6 / ac.sr), data });
      aenc.encode(ad); ad.close();
      if (aenc.encodeQueueSize > 16) await new Promise(r => setTimeout(r, 1));
    }
    await aenc.flush(); aenc.close();
    if (err) throw err;
  }
  muxer.finalize();
  onProgress && onProgress(1, '完了');
  return { blob: new Blob([target.buffer], { type: 'video/mp4' }), codec: vc.label, audio: ac ? ac.mux : null, width: w, height: h };
};


/* ---------- alpha MOV (QuickTime PNG video + optional PCM audio) ----------
   Browser WebCodecs does not reliably expose ProRes 4444 encoding. Instead we
   place the exact transparent PNG frames in a QuickTime MOV track. The PNG
   samples are lossless RGBA, so alpha is preserved without chroma keying. */
const movU16 = n => {
  const a = new Uint8Array(2), v = new DataView(a.buffer); v.setUint16(0, n >>> 0, false); return a;
};
const movU32 = n => {
  const a = new Uint8Array(4), v = new DataView(a.buffer); v.setUint32(0, Number(n) >>> 0, false); return a;
};
const movI16 = n => {
  const a = new Uint8Array(2), v = new DataView(a.buffer); v.setInt16(0, n | 0, false); return a;
};
const movU64 = n => {
  let x = BigInt(n);
  const a = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) { a[i] = Number(x & 255n); x >>= 8n; }
  return a;
};
const movFour = s => {
  const a = new Uint8Array(4);
  for (let i = 0; i < 4; i++) a[i] = (s.charCodeAt(i) || 32) & 255;
  return a;
};
const movAscii = s => new TextEncoder().encode(s);
const movBytes = p => p instanceof Uint8Array ? p : p instanceof ArrayBuffer ? new Uint8Array(p) : ArrayBuffer.isView(p) ? new Uint8Array(p.buffer, p.byteOffset, p.byteLength) : movAscii(String(p));
const movJoin = parts => {
  const ps = parts.map(movBytes), n = ps.reduce((a, p) => a + p.byteLength, 0), out = new Uint8Array(n);
  let o = 0; for (const p of ps) { out.set(p, o); o += p.byteLength; } return out;
};
const movBox = (type, ...parts) => {
  const body = movJoin(parts), size = 8 + body.byteLength;
  if (size <= 0xffffffff) return movJoin([movU32(size), movFour(type), body]);
  return movJoin([movU32(1), movFour(type), movU64(BigInt(body.byteLength) + 16n), body]);
};
const movFull = (type, version, flags, ...parts) => {
  const vf = new Uint8Array(4);
  vf[0] = version & 255; vf[1] = (flags >>> 16) & 255; vf[2] = (flags >>> 8) & 255; vf[3] = flags & 255;
  return movBox(type, vf, ...parts);
};
const movZeros = n => new Uint8Array(n);
const movMatrix = () => {
  const a = new Uint8Array(36), v = new DataView(a.buffer);
  v.setInt32(0, 0x00010000, false);
  v.setInt32(16, 0x00010000, false);
  v.setInt32(32, 0x40000000, false);
  return a;
};
const movMvhd = (timescale, duration, nextTrackId) => {
  const a = new Uint8Array(96), v = new DataView(a.buffer);
  v.setUint32(8, timescale >>> 0, false); v.setUint32(12, duration >>> 0, false);
  v.setUint32(16, 0x00010000, false); v.setUint16(20, 0x0100, false);
  a.set(movMatrix(), 32);
  v.setUint32(92, nextTrackId >>> 0, false);
  return movFull('mvhd', 0, 0, a);
};
const movTkhd = (trackId, movieDuration, width, height, audio) => {
  const a = new Uint8Array(80), v = new DataView(a.buffer);
  v.setUint32(8, trackId >>> 0, false); v.setUint32(16, movieDuration >>> 0, false);
  v.setUint16(36, audio ? 0x0100 : 0, false);
  a.set(movMatrix(), 40);
  v.setUint32(72, Math.round(width * 65536) >>> 0, false);
  v.setUint32(76, Math.round(height * 65536) >>> 0, false);
  return movFull('tkhd', 0, 0x000007, a);
};
const movMdhd = (timescale, duration) => {
  const a = new Uint8Array(20), v = new DataView(a.buffer);
  v.setUint32(8, timescale >>> 0, false); v.setUint32(12, duration >>> 0, false);
  v.setUint16(16, 0x55c4, false);
  return movFull('mdhd', 0, 0, a);
};
const movHdlr = (type, name) => movFull('hdlr', 0, 0, movU32(0), movFour(type), movZeros(12), movAscii(name + '\0'));
const movDinf = () => movBox('dinf', movFull('dref', 0, 0, movU32(1), movFull('url ', 0, 1)));
const movStts = (sampleCount, delta) => movFull('stts', 0, 0, movU32(1), movU32(sampleCount), movU32(delta));
const movStsc = samplesPerChunk => movFull('stsc', 0, 0, movU32(1), movU32(1), movU32(samplesPerChunk), movU32(1));
const movStsz = (sampleSize, sizesOrCount) => {
  if (sampleSize) return movFull('stsz', 0, 0, movU32(sampleSize), movU32(sizesOrCount));
  const sizes = sizesOrCount;
  return movFull('stsz', 0, 0, movU32(0), movU32(sizes.length), ...sizes.map(movU32));
};
const movCo64 = offsets => movFull('co64', 0, 0, movU32(offsets.length), ...offsets.map(movU64));
const movVideoSampleEntry = (w, h) => {
  const a = new Uint8Array(78), v = new DataView(a.buffer);
  v.setUint16(6, 1, false);
  v.setUint16(24, w, false); v.setUint16(26, h, false);
  v.setUint32(28, 0x00480000, false); v.setUint32(32, 0x00480000, false);
  v.setUint16(40, 1, false);
  const name = movAscii('PNG');
  a[42] = name.length; a.set(name, 43);
  v.setUint16(74, 32, false); v.setInt16(76, -1, false);
  return movBox('png ', a);
};
const movAudioSampleEntry = (sampleRate, channels) => {
  const a = new Uint8Array(28), v = new DataView(a.buffer);
  v.setUint16(6, 1, false);
  v.setUint16(16, channels, false); v.setUint16(18, 16, false);
  v.setUint16(20, 0, false); v.setUint16(22, 0, false);
  v.setUint32(24, Math.round(sampleRate * 65536) >>> 0, false);
  return movBox('sowt', a);
};
const movStsd = entry => movFull('stsd', 0, 0, movU32(1), entry);
const movVideoTrack = ({ trackId, movieDuration, fps, total, w, h, offsets, sizes }) => {
  const stbl = movBox('stbl',
    movStsd(movVideoSampleEntry(w, h)),
    movStts(total, 1),
    movStsc(1),
    movStsz(0, sizes),
    movCo64(offsets)
  );
  const vmhd = movFull('vmhd', 0, 1, movU16(0), movU16(0), movU16(0), movU16(0));
  const minf = movBox('minf', vmhd, movDinf(), stbl);
  const mdia = movBox('mdia', movMdhd(fps, total), movHdlr('vide', 'VideoHandler'), minf);
  return movBox('trak', movTkhd(trackId, movieDuration, w, h, false), mdia);
};
const movAudioTrack = ({ trackId, movieDuration, sampleRate, channels, frames, offset }) => {
  const bytesPerFrame = channels * 2;
  const stbl = movBox('stbl',
    movStsd(movAudioSampleEntry(sampleRate, channels)),
    movStts(frames, 1),
    movStsc(frames),
    movStsz(bytesPerFrame, frames),
    movCo64([offset])
  );
  const smhd = movFull('smhd', 0, 0, movI16(0), movU16(0));
  const minf = movBox('minf', smhd, movDinf(), stbl);
  const mdia = movBox('mdia', movMdhd(sampleRate, frames), movHdlr('soun', 'SoundHandler'), minf);
  return movBox('trak', movTkhd(trackId, movieDuration, 0, 0, true), mdia);
};
const movPcm16 = async (buffer, duration, sampleRate = 48000) => {
  const rs = await resample(buffer, sampleRate, duration);
  const channels = Math.min(2, rs.numberOfChannels), frames = Math.min(rs.length, Math.ceil(duration * sampleRate));
  const out = new Uint8Array(frames * channels * 2), v = new DataView(out.buffer);
  const data = Array.from({ length: channels }, (_, c) => rs.getChannelData(c));
  let o = 0;
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
    const x = Math.max(-1, Math.min(1, data[c][i] || 0));
    v.setInt16(o, x < 0 ? Math.round(x * 32768) : Math.round(x * 32767), true);
    o += 2;
  }
  return { bytes: out, sampleRate, channels, frames };
};

J.exportMOVAlpha = async ({ plan, project, audio, onProgress, signal }) => {
  const [w, h] = J.outputSize(project);
  const fps = plan.fps, total = Math.max(1, Math.round(plan.duration * fps));
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: true });
  const bgOpacity = J.clamp(Number.isFinite(+project.alphaBgOpacity) ? +project.alphaBgOpacity : 0, 0, 1);
  // Alpha MOV is independent of the green/black key preview mode.
  const alphaPlan = plan.keyBg ? Object.assign({}, plan, { keyBg: 'off' }) : plan;
  const bgCanvas = bgOpacity > 0 ? document.createElement('canvas') : null;
  const fgCanvas = bgOpacity > 0 ? document.createElement('canvas') : null;
  let bgCtx = null, fgCtx = null;
  if (bgCanvas) {
    bgCanvas.width = fgCanvas.width = w; bgCanvas.height = fgCanvas.height = h;
    bgCtx = bgCanvas.getContext('2d', { alpha: true });
    fgCtx = fgCanvas.getContext('2d', { alpha: true });
  }
  const R = new J.Renderer(), scale = w / plan.W;
  const frames = [], sizes = [];
  const prevRes = J.glyphs.maxRes; J.glyphs.maxRes = h >= 1000 ? 768 : 512;
  try {
    for (let i = 0; i < total; i++) {
      if (signal && signal.aborted) throw new Error('キャンセルしました');
      const t = i / fps;
      if (bgOpacity > 0) {
        R.frame(bgCtx, alphaPlan, t, { scale, backgroundOnly: true });
        R.frame(fgCtx, alphaPlan, t, { scale, transparent: true });
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, w, h);
        ctx.globalAlpha = bgOpacity; ctx.drawImage(bgCanvas, 0, 0);
        ctx.globalAlpha = 1; ctx.drawImage(fgCanvas, 0, 0);
      } else {
        R.frame(ctx, alphaPlan, t, { scale, transparent: true });
      }
      const blob = await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('PNGフレームを作成できませんでした')), 'image/png'));
      frames.push(blob); sizes.push(blob.size);
      if (i % 2 === 0 || i === total - 1) {
        onProgress && onProgress((i + 1) / total * 0.88, '透過フレーム ' + (i + 1) + '/' + total);
        await new Promise(r => setTimeout(r, 0));
      }
    }
  } finally { J.glyphs.maxRes = prevRes; }

  let pcm = null;
  if (audio && audio.buffer && project.includeAudio !== false) {
    if (signal && signal.aborted) throw new Error('キャンセルしました');
    onProgress && onProgress(0.9, '音声を準備中');
    pcm = await movPcm16(audio.buffer, plan.duration, 48000);
  }

  onProgress && onProgress(0.96, 'MOVを組み立て中');
  const ftyp = movBox('ftyp', movFour('qt  '), movU32(0x00000200), movFour('qt  '));
  const videoBytes = sizes.reduce((a, n) => a + BigInt(n), 0n);
  const audioBytes = pcm ? BigInt(pcm.bytes.byteLength) : 0n;
  const payloadBytes = videoBytes + audioBytes;
  const mdatTotal8 = payloadBytes + 8n;
  const mdatHeader = mdatTotal8 <= 0xffffffffn
    ? movJoin([movU32(Number(mdatTotal8)), movFour('mdat')])
    : movJoin([movU32(1), movFour('mdat'), movU64(payloadBytes + 16n)]);

  let off = BigInt(ftyp.byteLength + mdatHeader.byteLength);
  const videoOffsets = [];
  for (const n of sizes) { videoOffsets.push(off); off += BigInt(n); }
  const audioOffset = off;

  const movieTimescale = 60000;
  const videoMovieDuration = Math.round(total / fps * movieTimescale);
  const audioMovieDuration = pcm ? Math.round(pcm.frames / pcm.sampleRate * movieTimescale) : 0;
  const movieDuration = Math.max(videoMovieDuration, audioMovieDuration);
  const tracks = [movVideoTrack({
    trackId: 1, movieDuration: videoMovieDuration,
    fps, total, w, h, offsets: videoOffsets, sizes
  })];
  if (pcm) tracks.push(movAudioTrack({
    trackId: 2, movieDuration: audioMovieDuration,
    sampleRate: pcm.sampleRate, channels: pcm.channels, frames: pcm.frames, offset: audioOffset
  }));
  const moov = movBox('moov', movMvhd(movieTimescale, movieDuration, pcm ? 3 : 2), ...tracks);
  const parts = [ftyp, mdatHeader, ...frames];
  if (pcm) parts.push(pcm.bytes);
  parts.push(moov);

  onProgress && onProgress(1, '完了');
  return {
    blob: new Blob(parts, { type: 'video/quicktime' }),
    codec: 'PNG + Alpha', audio: pcm ? 'PCM' : null, width: w, height: h, backgroundOpacity: bgOpacity
  };
};

/* ---------- PNG sequence as ZIP (store, no compression) ---------- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (u8) => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
class ZipWriter {
  constructor() { this.parts = []; this.central = []; this.offset = 0; }
  add(name, u8) {
    const nb = new TextEncoder().encode(name), crc = crc32(u8);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true); lh.setUint32(18, u8.length, true); lh.setUint32(22, u8.length, true);
    lh.setUint16(26, nb.length, true); lh.setUint16(28, 0, true);
    this.parts.push(lh.buffer, nb, u8);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, u8.length, true); ch.setUint32(24, u8.length, true);
    ch.setUint16(28, nb.length, true); ch.setUint32(42, this.offset, true);
    this.central.push(ch.buffer, nb);
    this.offset += 30 + nb.length + u8.length;
  }
  finish() {
    const cdSize = this.central.reduce((s, p) => s + (p.byteLength ?? p.length), 0);
    const n = this.central.length / 2;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, n, true); end.setUint16(10, n, true); end.setUint32(12, cdSize, true); end.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.central, end.buffer], { type: 'application/zip' });
  }
}
J.exportPNGZip = async ({ plan, project, transparent, onProgress, signal, every = 1 }) => {
  const [w, h] = J.outputSize(project);
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const R = new J.Renderer();
  const fps = plan.fps, total = Math.max(1, Math.round(plan.duration * fps));
  const zip = new ZipWriter();
  const scale = w / plan.W;
  for (let i = 0; i < total; i += every) {
    if (signal && signal.aborted) throw new Error('キャンセルしました');
    R.frame(ctx, plan, i / fps, { scale, transparent });
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    zip.add(`jizura_${String(i).padStart(5, '0')}.png`, new Uint8Array(await blob.arrayBuffer()));
    onProgress && onProgress(i / total, `PNG ${i + 1}/${total}`);
  }
  onProgress && onProgress(1, '完了');
  return zip.finish();
};

/* ---------- plan JSON for the After Effects panel ---------- */
/* The After Effects panel implements the original expression set. Newer pack entries are exported as their
   closest original counterpart (the browser key is kept in web* fields so nothing is lost). */
J.AE_MAP = {
  layout: { lowerThird: 'center', corners: 'mixed', staircase: 'mixed', zigzag: 'wave', arcTop: 'ring', spiral: 'ring', gridCells: 'labels', dropCap: 'mixed', justified: 'tile', frameBox: 'center', bubble: 'pill', subtitleBar: 'center', ticker: 'marquee', splitScreen: 'diag', mirror: 'stack', sideways: 'vcols', edgeFrame: 'marquee', perspective: 'stack', hanko: 'vcols', genkou: 'vcols', panels: 'diag', filmstrip: 'labels', quote: 'center', ruler: 'gloss', searchBar: 'type', chat: 'labels', notification: 'pill', ticket: 'pill',
    rain: 'tile', hanging: 'scatter', orbit: 'ring', tunnel: 'tile', wordCloud: 'scatter', bounceLine: 'mixed', elastic: 'condensed', crossBands: 'diag', stickerBomb: 'labels', neon: 'center', keycaps: 'labels', bubbles: 'scatter', slotMachine: 'labels', flipBoard: 'labels', credits: 'type', zoomRepeat: 'stack', splitHalves: 'stack', columnsBig: 'vcols', circleWords: 'ring', dotMatrix: 'type', depthStack: 'stack', typeSpecimen: 'stack', kanjiFocus: 'huge', halfVertical: 'vcols', curtain: 'center', equalizer: 'mixed', tape: 'diag' },
  enter: { riseMask: 'drop', dropMask: 'drop', slideL: 'wipe', slideR: 'wipe', slideWhole: 'stretch', flipX: 'spin', flipY: 'spin', domino: 'spin', fold: 'pop', unroll: 'wipe', strokeDraw: 'assemble', outlineFill: 'blur', splitJoin: 'slice', vSlice: 'slice', shutter: 'wipe', iris: 'zoom', diagWipe: 'wipe', blinds: 'slice', checker: 'flicker', randomOrder: 'flicker', bounceBig: 'drop', squashDrop: 'drop', rubber: 'stretch', glitchIn: 'scramble', echoIn: 'zoom', whip: 'stretch', skewIn: 'stretch', trackIn: 'blur', trackOut: 'blur', blurStagger: 'blur', fadeStagger: 'blur', waveIn: 'pop', spiralIn: 'spin', zoomOut: 'zoom', resolve: 'scramble', magnet: 'assemble', inkBleed: 'blur', neonOn: 'flicker', cursorSweep: 'type', stamp: 'zoom' },
  exit: { sinkMask: 'fall', riseOut: 'drift', slideOutL: 'stretch', slideOutR: 'stretch', flipOutX: 'shrink', flipOutY: 'fall', foldOut: 'shrink', squash: 'shrink', trackOutWide: 'blur', collapse: 'shrink', zoomThrough: 'blur', zoomFar: 'shrink', spinOut: 'scatter', twist: 'shrink', waveOut: 'scatter', blurOutStagger: 'blur', undraw: 'blur', outlineOut: 'blur', irisClose: 'shrink', diagWipeOut: 'wipe', blindsClose: 'slice', checkerOut: 'glitch', splitApart: 'slice', vSliceDrop: 'fall', melt: 'fall', dissolve: 'drift', backspace: 'wipe', scrambleOut: 'glitch', glitchDissolve: 'glitch', echoOut: 'blur', whipOut: 'stretch', gravity: 'fall', popOut: 'scatter', burn: 'drift', sweepCover: 'wipe', shatterLite: 'explode' },
  hold: { float: 'drift', sway: 'wave', pulse: 'breathe', shimmer: 'still', colorRun: 'still', rotateSlow: 'drift', trackBreathe: 'breathe', skewWobble: 'wave', beatHop: 'wave', hWave: 'wave', heartbeat: 'breathe', orbitSmall: 'jitter', jelly: 'breathe', scanBand: 'glitchtick', noiseDrift: 'drift', tilt: 'drift', zoomSlow: 'drift', stretchPulse: 'breathe', glitchJump: 'glitchtick', echoTrail: 'drift' },
  decor: { crosshair: 'brackets', cropMarks: 'brackets', reticle: 'rings', radar: 'rings', progressRing: 'rings', timecodeBar: 'barcode', rulerEdge: 'grid', dimension: 'leaders', indexNum: 'counter', dateStamp: 'barcode', qrBlock: 'barcode', glitchRects: 'bars', concentricSquares: 'shapes', triangleSpin: 'shapes', lineBurst: 'sparks', plusGrid: 'grid', guides: 'grid', waveLine: 'waveform', spiralLine: 'rings', halftonePatch: 'shapes', checkerStrip: 'stripes', beatRing: 'rings', orbitDots: 'dots', constellation: 'sparks', confetti: 'shapes', petals: 'shapes', rainStreaks: 'slash', snow: 'dots', lightLeak: 'blobs', bokeh: 'blobs', speedCorner: 'slash', risingParticles: 'sparks', twinkle: 'sparks', brushStroke: 'bars', tapePieces: 'bars', scribbleCircle: 'rings', scribbleUnder: 'slash', crossOut: 'slash', highlightMark: 'bars', heartsStars: 'shapes', watermarkKanji: 'counter', verticalStrip: 'leaders', romajiLine: 'leaders', bracketsJP: 'brackets', seal: 'shapes' },
  fx: { rgbSplit: 'chroma', smear: 'slice', vhsRoll: 'slice', trackingNoise: 'slice', waveWarp: 'slice', pixelDrift: 'slice', tileShift: 'block', gridRepeat: 'block', mirrorFlash: 'block', strobe: 'invert', blackFrame: 'invert', whiteFrame: 'flash', filmBurn: 'flash', lightSweep: 'flash', panelWipe: 'flash', zoomPunch: 'zoom', whipBlur: 'zoom', posterize: 'mosaic', hueShift: 'chroma', irisTrans: 'zoom', doors: 'slice', blindsTrans: 'slice', splitSlide: 'slice', crtOff: 'flash' },
};
// The plan goes to the After Effects panel as-is (version 2): the panel builds every key it implements and
// picks the closest counterpart itself (from the exported metadata / J.AE_MAP) for anything it lacks.
J.planForAE = (plan, project) => {
  const clean = JSON.parse(JSON.stringify(plan, (k, v) => (k === 'energy' || k === 'buffer' || k === 'peaks' ? undefined : v)));
  clean.version = 2;
  clean.width = J.outputSize(project)[0]; clean.height = J.outputSize(project)[1];
  clean.extra = project.extra === true; clean.wa = project.wa !== false;
  clean.fonts = {};
  for (const [role, keys] of Object.entries(plan.style.fonts)) clean.fonts[role] = keys.map(k => J.FONTS[k] ? J.FONTS[k].label : k);
  clean.fontTable = Object.fromEntries(Object.entries(J.FONTS).map(([k, f]) => [k, { label: f.label, family: f.family.replace(/"/g, ''), weight: f.weight, kind: f.kind }]));
  return clean;
};
})();
