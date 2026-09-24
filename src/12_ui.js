/* ============================================================
   JIZURA — editor UI
   ============================================================ */
(() => {
'use strict';
if (!document.getElementById('app')) return;          // engine-only pages (tests)
const $ = id => document.getElementById(id);
const LS_KEY = 'jizura.project.v1';
const HUD_CHARS = '0123456789:./-_()【】・No.LYRICRECUNTITLEDXYlinebpminterlude—─／ ';
const ICON = {
  dice: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2" width="12" height="12" rx="2"/><circle cx="5.5" cy="5.5" r="1" fill="currentColor"/><circle cx="10.5" cy="10.5" r="1" fill="currentColor"/><circle cx="10.5" cy="5.5" r="1" fill="currentColor"/><circle cx="5.5" cy="10.5" r="1" fill="currentColor"/></svg>',
  lock: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg>',
};

const S = { project: null, plan: null, activePlanKey: null, audio: null, audioSource: null, renderer: new J.Renderer(), playing: false, t: 0, t0: 0, loop: true, need: true, exporting: null, tap: null, slow: false, lineEls: [], curLine: -2, timelineZoom: 1, timelineStart: 0, timelineBoundaryHover: null, timelineBoundaryDrag: null, layoutPreview: null, layoutMenu: null, lineSortByTime: false };

/* WebAudio player (works inside sandboxed pages where blob media may be blocked) */
const AP = {
  ctx: null, src: null, gain: null, startAt: 0, volume: 1,
  ensure() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (!this.gain) { this.gain = this.ctx.createGain(); this.gain.connect(this.ctx.destination); }
    this.gain.gain.value = this.volume;
  },
  setVolume(v) {
    this.volume = J.clamp(+v || 0, 0, 2);
    if (this.gain && this.ctx) this.gain.gain.setValueAtTime(this.volume, this.ctx.currentTime);
  },
  play(buffer, offset) {
    this.ensure();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.stop();
    const s = this.ctx.createBufferSource(); s.buffer = buffer; s.connect(this.gain);
    const off = Math.max(0, Math.min(offset, buffer.duration - 0.01));
    s.start(0, off); this.src = s; this.startAt = this.ctx.currentTime - off;
  },
  stop() { if (this.src) { try { this.src.stop(); } catch (e) {} try { this.src.disconnect(); } catch (e) {} this.src = null; } },
  time() { return this.ctx ? this.ctx.currentTime - this.startAt : 0; },
};

/* ---------------- project persistence ---------------- */
function mergeProject(p) {
  const d = J.defaultProject();
  const o = Object.assign(d, p || {});
  o.fx = Object.assign(J.defaultProject().fx, (p && p.fx) || {});
  o.timing = Object.assign(J.defaultProject().timing, (p && p.timing) || {});
  const en = J.defaultProject().enabled;
  for (const g of Object.keys(en)) en[g] = Object.assign(en[g], ((p && p.enabled) || {})[g] || {});
  o.enabled = en;
  o.overrides = (p && p.overrides) || {};
  o.previewVolume = J.clamp(Number.isFinite(+(p && p.previewVolume)) ? +(p && p.previewVolume) : 1, 0, 2);
  o.colors = Object.assign({ enabled: false }, (p && p.colors) || {});
  o.fonts = (p && p.fonts) || {};
  o.ui = Object.assign({ lineSortByTime: false }, (p && p.ui) || {});
  o.userFonts = (p && p.userFonts) || [];
  for (const uf of o.userFonts) if (!J.FONTS[uf.key]) J.addUserFont(uf.key, uf.label, uf.family, uf.weight || 400);
  return o;
}
function setBadges(d) {
  return (d && d.extra ? '<span class="set-badge ex" title="最初の公開版のあとに追加">追加</span>' : '') + (d && d.wa ? '<span class="set-badge" title="和風の演出">和</span>' : '');
}
function loadLocal() { try { const s = localStorage.getItem(LS_KEY); if (s) return mergeProject(JSON.parse(s)); } catch (e) {} return mergeProject(null); }
let saveTimer = 0;
function autosave() { clearTimeout(saveTimer); scheduleEditorHistory(); saveTimer = setTimeout(flushSave, 700); }
function flushSave() {
  clearTimeout(saveTimer);
  try { localStorage.setItem(LS_KEY, JSON.stringify(S.project)); } catch (e) {}
  scheduleEditorHistory();
}
window.addEventListener('pagehide', () => { if (S.project) flushSave(); });

/* ---------------- editor-wide undo / redo ----------------
   Ctrl/Cmd+Z belongs to JIZURA as a whole, even while a text/number input is focused. */
const EH = { list: [], i: -1 };
let editorHistTimer = 0, editorHistoryApplying = false;
function editorSnap() {
  if (!S.project) return '';
  const p = JSON.parse(JSON.stringify(S.project));
  delete p.planSnapshot; // large derived data; deterministic project inputs are enough inside one app version
  return JSON.stringify(p);
}
function recordEditorHistory(force = false) {
  clearTimeout(editorHistTimer);
  if (editorHistoryApplying || !S.project) return;
  const s = editorSnap();
  if (!force && EH.i >= 0 && EH.list[EH.i] === s) return;
  EH.list = EH.list.slice(0, EH.i + 1);
  if (EH.list[EH.list.length - 1] !== s) EH.list.push(s);
  EH.i = EH.list.length - 1;
  if (EH.list.length > 80) {
    const n = EH.list.length - 80;
    EH.list.splice(0, n); EH.i -= n;
  }
}
function scheduleEditorHistory() {
  if (editorHistoryApplying || !S.project) return;
  clearTimeout(editorHistTimer);
  editorHistTimer = setTimeout(() => recordEditorHistory(), 420);
}
function resetEditorHistory() {
  clearTimeout(editorHistTimer);
  EH.list = []; EH.i = -1;
  recordEditorHistory(true);
}
function applyEditorHistory(index, label) {
  if (index < 0 || index >= EH.list.length) return false;
  editorHistoryApplying = true;
  try {
    pause();
    S.project = mergeProject(JSON.parse(EH.list[index]));
    fontKey = '';
    syncUI(); replan(); flushSave();
    toast(label);
    return true;
  } finally {
    editorHistoryApplying = false;
  }
}
function editorUndo() {
  clearTimeout(editorHistTimer);
  clearTimeout(replanTimer);
  const cur = editorSnap();
  if (EH.i < 0) resetEditorHistory();
  if (EH.list[EH.i] !== cur) {
    EH.list = EH.list.slice(0, EH.i + 1);
    EH.list.push(cur); EH.i = EH.list.length - 1;
  }
  if (EH.i <= 0) return false;
  EH.i--;
  return applyEditorHistory(EH.i, '元に戻しました');
}
function editorRedo() {
  clearTimeout(editorHistTimer);
  clearTimeout(replanTimer);
  const cur = editorSnap();
  if (EH.i < 0) resetEditorHistory();
  if (EH.list[EH.i] !== cur) {
    // A new edit after Undo starts a new branch; the old Redo chain is discarded.
    EH.list = EH.list.slice(0, EH.i + 1);
    EH.list.push(cur); EH.i = EH.list.length - 1;
    return false;
  }
  if (EH.i >= EH.list.length - 1) return false;
  EH.i++;
  return applyEditorHistory(EH.i, 'やり直しました');
}

/* ---------------- audio persistence ----------------
   Browsers do not expose a reusable full local file path from <input type=file>.
   Store the source audio bytes in IndexedDB for automatic restore, and embed them
   in an explicitly saved .jizura.json so the project remains portable. */
const AUDIO_DB_NAME = 'jizura.assets.v1', AUDIO_STORE = 'audio';
let audioDbJob = null;
function openAudioDb() {
  if (!window.indexedDB) return Promise.resolve(null);
  if (audioDbJob) return audioDbJob;
  audioDbJob = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(AUDIO_DB_NAME, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(AUDIO_STORE)) db.createObjectStore(AUDIO_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('音源ストレージを開けませんでした'));
  }).catch(e => { audioDbJob = null; throw e; });
  return audioDbJob;
}
async function putStoredAudio(meta, file) {
  const db = await openAudioDb(); if (!db) throw new Error('このブラウザでは楽曲の自動保存を利用できません');
  const blob = file instanceof Blob ? file.slice(0, file.size, file.type || meta.type || '') : new Blob([file], { type: meta.type || '' });
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_STORE, 'readwrite');
    tx.objectStore(AUDIO_STORE).put({ id: meta.id, name: meta.name, type: meta.type || '', size: blob.size, lastModified: meta.lastModified || 0, blob });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('楽曲を保存できませんでした'));
    tx.onabort = () => reject(tx.error || new Error('楽曲の保存が中断されました'));
  });
}
async function getStoredAudio(id) {
  if (!id) return null;
  try {
    const db = await openAudioDb(); if (!db) return null;
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(AUDIO_STORE, 'readonly'), req = tx.objectStore(AUDIO_STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) { console.warn('audio restore', e); return null; }
}
async function deleteStoredAudio(id) {
  if (!id) return;
  try {
    const db = await openAudioDb(); if (!db) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(AUDIO_STORE, 'readwrite');
      tx.objectStore(AUDIO_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { console.warn('audio cleanup', e); }
}
function newAudioId() {
  try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
  return 'audio-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}
function audioMeta(file, id) {
  return { id, name: file.name || 'audio', type: file.type || '', size: file.size || 0, lastModified: file.lastModified || 0 };
}
function recordToFile(rec) {
  if (!rec || !rec.blob) return null;
  try { return new File([rec.blob], rec.name || 'audio', { type: rec.type || rec.blob.type || '', lastModified: rec.lastModified || Date.now() }); }
  catch (e) { const b = rec.blob; b.name = rec.name || 'audio'; return b; }
}
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(fr.error || new Error('楽曲データを読み込めませんでした'));
    fr.readAsDataURL(blob);
  });
}
async function embeddedToFile(a) {
  if (!a || !a.dataUrl) return null;
  const res = await fetch(a.dataUrl);
  const blob = await res.blob();
  try { return new File([blob], a.name || 'audio', { type: a.type || blob.type || '', lastModified: a.lastModified || Date.now() }); }
  catch (e) { blob.name = a.name || 'audio'; return blob; }
}
async function attachAudioFile(file, opt = {}) {
  const oldId = S.project.audio && S.project.audio.id;
  const id = opt.id || newAudioId();
  const analyzed = await J.analyzeAudio(file);
  S.audio = analyzed; S.audioSource = file;
  S.project.audio = audioMeta(file, id);
  let stored = true;
  if (opt.persist !== false) {
    try {
      await putStoredAudio(S.project.audio, file);
      if (oldId && oldId !== id) deleteStoredAudio(oldId);
    } catch (e) {
      stored = false;
      console.warn('audio persist', e);
    }
  }
  $('audioName').textContent = `${file.name || analyzed.name}（${J.fmtTime(analyzed.duration)}・約${analyzed.bpm}BPM${stored ? '・保存済み' : '・自動復元は保存できませんでした'}）`;
  if (opt.setSnap !== false) S.project.timing.snap = true;
  AP.setVolume(S.project.previewVolume ?? 1);
  flushSave();
  return true;
}
async function restoreProjectAudio() {
  const meta = S.project && S.project.audio;
  if (!meta || !meta.id) return false;
  const rec = await getStoredAudio(meta.id);
  if (!rec) {
    $('audioName').textContent = `${meta.name || '保存済みの曲'}（楽曲データが見つかりません）`;
    return false;
  }
  try {
    const file = recordToFile(rec);
    await attachAudioFile(file, { id: meta.id, persist: false, setSnap: false });
    return true;
  } catch (e) {
    console.warn('audio restore analyze', e);
    $('audioName').textContent = `${meta.name || '保存済みの曲'}（復元できませんでした）`;
    return false;
  }
}
async function restoreEmbeddedAudio(asset) {
  try {
    const file = await embeddedToFile(asset);
    if (!file) return false;
    const id = (S.project.audio && S.project.audio.id) || newAudioId();
    await attachAudioFile(file, { id, persist: true, setSnap: false });
    return true;
  } catch (e) {
    console.warn('embedded audio restore', e);
    $('audioName').textContent = `${asset && asset.name ? asset.name : '保存済みの曲'}（復元できませんでした）`;
    return false;
  }
}
async function projectPayloadForSave() {
  // Text inputs replan on a short debounce. If Save is clicked inside that window,
  // force the pending plan update before freezing the project.
  if (S.activePlanKey !== planInputKey(S.project)) {
    clearTimeout(replanTimer);
    replan();
  } else {
    storePlanSnapshot();
  }
  const out = JSON.parse(JSON.stringify(S.project));
  let file = S.audioSource;
  if (!file && out.audio && out.audio.id) {
    const rec = await getStoredAudio(out.audio.id);
    file = recordToFile(rec);
  }
  if (file) {
    out._audioAsset = {
      name: file.name || (out.audio && out.audio.name) || 'audio',
      type: file.type || (out.audio && out.audio.type) || '',
      size: file.size || 0,
      lastModified: file.lastModified || (out.audio && out.audio.lastModified) || 0,
      dataUrl: await blobToDataUrl(file),
    };
  }
  return out;
}
async function applyProjectData(raw) {
  pause();
  S.audio = null; S.audioSource = null;
  const p = Object.assign({}, raw || {});
  const embedded = p._audioAsset || null;
  delete p._audioAsset;
  S.project = mergeProject(p);
  if (embedded) await restoreEmbeddedAudio(embedded);
  else await restoreProjectAudio();
  syncUI();
  const frozen = restorePlanSnapshot();
  if (!frozen) replan();
  flushSave();
  return !!S.audio;
}

/* Keep per-line timing / overrides attached to the same lyric when lines are inserted, split, merged or removed.
   Exact matches use an LCS; one-for-one edited gaps keep their state by position. */
function lineIndexMap(oldRaw, newRaw) {
  const A = J.parseLyrics(oldRaw).lines.map(x => x.text);
  const B = J.parseLyrics(newRaw).lines.map(x => x.text);
  const m = A.length, n = B.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const pairs = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const bounds = [[-1, -1], ...pairs, [m, n]];
  const map = {};
  for (const [oi, nj] of pairs) map[nj] = oi;
  for (let k = 0; k < bounds.length - 1; k++) {
    const [oa, na] = bounds[k], [ob, nb] = bounds[k + 1];
    const oc = ob - oa - 1, nc = nb - na - 1;
    if (oc === nc) for (let q = 1; q <= oc; q++) map[na + q] = oa + q;
  }
  return { map, oldCount: m, newCount: n };
}
function remapLineIndexedState(oldRaw, newRaw) {
  if (oldRaw === newRaw) return;
  const { map } = lineIndexMap(oldRaw, newRaw);
  const remap = src => {
    const out = {};
    for (const [nj, oi] of Object.entries(map)) if (src && src[oi] != null) out[nj] = src[oi];
    return out;
  };
  S.project.timing.lineTimes = remap((S.project.timing || {}).lineTimes || {});
  const oldToNew = {};
  for (const [nj, oi] of Object.entries(map)) oldToNew[oi] = +nj;
  const oldBounds = (S.project.timing || {}).cutBoundaries || {}, newBounds = {};
  const remapCutId = id => {
    if (id === 'title') return 'title';
    let m = id.match(/^(-?\d+):(\d+)$/);
    if (m) {
      const ni = oldToNew[m[1]];
      return ni == null ? null : ni + ':' + m[2];
    }
    m = id.match(/^(-?\d+):i$/);
    if (m) {
      const ni = oldToNew[m[1]];
      return ni == null ? null : ni + ':i';
    }
    return null;
  };
  for (const [key, value] of Object.entries(oldBounds)) {
    const parts = key.split('>');
    if (parts.length !== 2) continue;
    const a = remapCutId(parts[0]), b = remapCutId(parts[1]);
    if (a && b) newBounds[a + '>' + b] = value;
  }
  S.project.timing.cutBoundaries = newBounds;
  S.project.overrides = remap(S.project.overrides || {});
}

/* ---------------- frozen plan snapshot ----------------
   Save the fully generated plan, not only its random seed. This makes a saved
   project reopen with the same cuts even if future planner logic changes. */
const PLAN_SNAPSHOT_VERSION = 1;
function planInputKey(project) {
  const src = {
    title: project.title || '', artist: project.artist || '', lyrics: project.lyrics || '',
    style: project.style || 'noir', mood: project.mood ?? null,
    extra: project.extra === true, wa: project.wa !== false, keyBg: project.keyBg || 'off',
    seed: project.seed | 0, aspect: project.aspect || '16:9', fps: project.fps || 24,
    fx: project.fx || {}, enabled: project.enabled || {}, timing: project.timing || {},
    overrides: project.overrides || {}, colors: project.colors || {}, fonts: project.fonts || {},
    userFonts: project.userFonts || [], audioId: project.audio && project.audio.id ? project.audio.id : null,
  };
  const s = JSON.stringify(src);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 'p1-' + (h >>> 0).toString(16).padStart(8, '0') + '-' + s.length;
}
function plainPlan(plan) {
  return JSON.parse(JSON.stringify(plan, (k, v) => (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(v)) ? Array.from(v) : v));
}
function ensureLineCutOrdinals(plan) {
  const counts = {};
  const cuts = [];
  for (const cut of (plan && plan.cuts) || []) {
    if (!(cut.line >= 0) || cut.layout === 'interlude') continue;
    const n = counts[cut.line] || 0;
    if (!(cut.lineCut >= 0)) cut.lineCut = n;
    counts[cut.line] = Math.max(n + 1, cut.lineCut + 1);
    cuts.push(cut);
  }
  // Upgrade snapshots made before draggable boundaries existed. Assign older
  // effect events to the closest cut start so they move with that cut.
  for (const ev of (plan && plan.events) || []) {
    if (Number.isFinite(ev.cutRel) && ev.line != null && ev.lineCut != null) continue;
    let best = null, bd = Infinity;
    for (const cut of cuts) {
      const d = Math.abs(ev.t - cut.start);
      if (d < bd) { bd = d; best = cut; }
    }
    if (best) {
      ev.line = best.line; ev.lineCut = best.lineCut;
      ev.cutRel = best.dur > 1e-6 ? (ev.t - best.start) / best.dur : 0;
    }
  }
}
function storePlanSnapshot() {
  if (!S.project || !S.plan) return;
  const inputKey = planInputKey(S.project);
  S.activePlanKey = inputKey;
  S.project.planSnapshot = {
    version: PLAN_SNAPSHOT_VERSION,
    inputKey,
    savedAt: Date.now(),
    plan: plainPlan(S.plan),
  };
}
function validPlanSnapshot(snap) {
  const p = snap && snap.plan;
  return !!(snap && snap.version === PLAN_SNAPSHOT_VERSION && snap.inputKey === planInputKey(S.project) &&
    p && p.W > 0 && p.H > 0 && Array.isArray(p.lines) && Array.isArray(p.cuts) &&
    p.style && p.fx && Number.isFinite(+p.duration));
}
function finishPlanUi(saveSnapshot) {
  if (S.t > S.plan.duration) S.t = 0;
  renderLines(); sizeViewport(); drawTimeline(); updateTimeUI();
  S.need = true;
  if (saveSnapshot) { storePlanSnapshot(); autosave(); }
  ensureFonts(); drawSwatch(); showNow();
  clearTimeout(warmTimer); warmTimer = setTimeout(warm, 450);
}
function restorePlanSnapshot() {
  const snap = S.project && S.project.planSnapshot;
  if (!validPlanSnapshot(snap)) return false;
  try {
    S.layoutPreview = null;
    S.plan = plainPlan(snap.plan);
    ensureLineCutOrdinals(S.plan);
    S.activePlanKey = snap.inputKey;
    finishPlanUi(false);
    return true;
  } catch (e) {
    console.warn('plan snapshot restore', e);
    return false;
  }
}

/* ---------------- planning ---------------- */
function audioLike() {
  const T = S.project.timing;
  if (S.audio) {
    const a = Object.assign({}, S.audio);
    if (T.bpm > 0) a.beats = J.beatGrid(T.bpm, T.beatOffset || 0, S.audio.duration);
    return a;
  }
  if (T.bpm > 0) return { beats: J.beatGrid(T.bpm, T.beatOffset || 0, 600) };
  return null;
}
function replan() {
  S.layoutPreview = null;
  S.plan = J.plan(S.project, audioLike());
  S.activePlanKey = planInputKey(S.project);
  finishPlanUi(true);
}
/* pre-decompose glyphs used by piece animations while the editor is idle, so playback does not hitch */
let warmTimer = 0, warmJob = 0;
function warm() {
  const job = ++warmJob;
  const cuts = S.plan.cuts.filter(c => c.enter === 'assemble' || ['explode', 'fall', 'drift'].includes(c.exit));
  const src = $('view');
  const cv = document.createElement('canvas'); cv.width = src.width; cv.height = src.height;
  const ctx = cv.getContext('2d');
  let i = 0;
  const idle = window.requestIdleCallback ? (f) => window.requestIdleCallback(f, { timeout: 400 }) : (f) => setTimeout(() => f(null), 40);
  const step = (deadline) => {
    if (job !== warmJob || S.exporting) return;
    do {
      const c = cuts[i++]; if (!c) break;
      const ts = [];
      if (c.enter === 'assemble') ts.push(c.start + Math.min(c.inDur * 0.3, c.dur * 0.2));
      if (c.outDur > 0) ts.push(c.end - c.outDur * 0.5);
      for (const t of ts) { try { S.renderer.frame(ctx, S.plan, t, { scale: cv.width / S.plan.W, fast: true, noHud: true, noGhost: true }); } catch (e) {} }
    } while (i < cuts.length && deadline && deadline.timeRemaining() > 10);
    if (i < cuts.length) idle(step);
  };
  idle(step);
}
let replanTimer = 0;
const replanSoon = (ms = 220) => { clearTimeout(replanTimer); replanTimer = setTimeout(replan, ms); };
let fontKey = '';
let thumbFonts = null;
async function ensureFonts() {
  const txt = S.project.lyrics + (S.project.title || '') + (S.project.artist || '') + HUD_CHARS;
  const keys = J.fontsOfPlan(S.plan);                       // only the faces this plan draws with
  const key = txt + '|' + keys.join(',') + '|' + Object.keys(J.FONTS).length;
  if (key === fontKey) return;
  fontKey = key;
  showMsg('フォントを読み込み中…');
  try { await J.ensureFonts(txt, keys); } catch (e) {}
  showMsg(null); S.need = true; drawStyleGrid(); loadThumbFonts();
}
// style thumbnails need two glyphs of every style's display face — fetched only once the style grid is actually shown
function loadThumbFonts() {
  if (thumbFonts || !$('styleGrid').offsetParent) return;
  thumbFonts = J.ensureFonts('字面', [...new Set(J.STYLE_ORDER.map(k => J.STYLES[k].fonts.display[0]))]).then(() => drawStyleGrid()).catch(() => {});
}
function showMsg(m) { const el = $('viewMsg'); if (!m) { el.hidden = true; return; } el.textContent = m; el.hidden = false; }

/* ---------------- viewport & drawing ---------------- */
function sizeViewport() {
  const vp = $('viewport'), c = $('view');
  const ar = S.plan.W / S.plan.H;
  let cssW = vp.clientWidth || 800, cssH = cssW / ar;
  const maxH = Math.max(220, window.innerHeight * 0.68);
  if (cssH > maxH) { cssH = maxH; cssW = cssH * ar; }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.round(Math.min(S.plan.W, cssW * dpr)), ph = Math.round(pw / ar);
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
  c.style.width = cssW + 'px'; c.style.height = cssH + 'px';
  S.need = true;
}
function draw() {
  const c = $('view'), ctx = c.getContext('2d');
  const pv = S.layoutPreview;
  const plan = pv ? pv.plan : S.plan, t = pv ? pv.t : S.t;
  const t0 = performance.now();
  S.renderer.frame(ctx, plan, t, { scale: c.width / plan.W, fast: S.playing && S.slow });
  const dt = performance.now() - t0;
  S.slow = S.playing ? (dt > 30 ? true : dt < 14 ? false : S.slow) : false;
  if (!pv) { updateTimeUI(); drawTimeline(); updateCutInfo(); }
}
function tick(now) {
  requestAnimationFrame(tick);
  if (S.exporting) return;
  if (S.playing) {
    // rAF timestamps can precede the moment play()/seek() stamped t0 → clamp so t never goes negative
    let t = Math.max(0, S.audio ? AP.time() : (now - S.t0) / 1000);
    if (t >= S.plan.duration - 1e-3) {
      if (S.loop && !S.tap) { seek(0); t = 0; }
      else { pause(); t = S.plan.duration - 1e-3; if (S.tap) stopTap(); }
    }
    S.t = t; S.need = true;
  }
  if (S.need) { S.need = false; draw(); }
}
function updateTimeUI() {
  $('timeNow').textContent = J.fmtTime(S.t);
  $('timeDur').textContent = J.fmtTime(S.plan.duration);
  if (!S.scrubbing) $('scrub').value = String(Math.round(S.t / Math.max(0.001, S.plan.duration) * 10000));
}
function play() {
  if (S.audio) AP.play(S.audio.buffer, S.t);
  else S.t0 = performance.now() - S.t * 1000;
  S.playing = true; $('btnPlay').textContent = '❚❚'; $('btnPlay').setAttribute('aria-label', '一時停止');
}
function pause() {
  S.playing = false; AP.stop();
  $('btnPlay').textContent = '▶'; $('btnPlay').setAttribute('aria-label', '再生'); S.need = true;
}
function seek(t) {
  S.t = J.clamp(t, 0, Math.max(0, S.plan.duration - 1e-3));
  if (S.audio) { if (S.playing) AP.play(S.audio.buffer, S.t); }
  else S.t0 = performance.now() - S.t * 1000;
  S.need = true;
}

/* ---------------- timeline ---------------- */
const layoutHue = k => (J.LAYOUT_ORDER.indexOf(k) * 37 + 30) % 360;
function timelineView() {
  const D = Math.max(0.001, S.plan.duration);
  const zoom = J.clamp(S.timelineZoom || 1, 1, 32);
  const span = D / zoom;
  const maxStart = Math.max(0, D - span);
  const start = J.clamp(S.timelineStart || 0, 0, maxStart);
  S.timelineZoom = zoom;
  S.timelineStart = start;
  return { D, zoom, span, start, end: start + span };
}
function drawTimeline() {
  const c = $('timeline'), dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(10, Math.round(c.clientWidth * dpr)), h = Math.max(10, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const x = c.getContext('2d'), V = timelineView(), X = t => (t - V.start) / V.span * w;
  x.fillStyle = '#131316'; x.fillRect(0, 0, w, h);
  if (S.audio && S.audio.peaks) {
    const pk = S.audio.peaks, n = pk.length, sd = S.audio.duration;
    x.fillStyle = '#2b2b33';
    for (let i = 0; i < w; i += 2) {
      const t = V.start + i / w * V.span;
      if (t > sd) break;
      const v = pk[Math.min(n - 1, Math.max(0, Math.floor(t / sd * n)))];
      const hh = v * h * 0.8;
      x.fillRect(i, h * 0.6 - hh / 2, 1.5, hh);
    }
  }
  const beats = S.plan.beats || [];
  x.fillStyle = '#3a3a44';
  for (const b of beats) {
    if (b < V.start) continue;
    if (b > V.end) break;
    x.fillRect(Math.round(X(b)), h - 6 * dpr, 1, 6 * dpr);
  }
  const top = h * 0.3, bot = h - 8 * dpr;
  for (const cut of S.plan.cuts) {
    if (cut.end <= V.start || cut.start >= V.end) continue;
    const x0 = X(Math.max(cut.start, V.start)), x1 = X(Math.min(cut.end, V.end));
    const hue = layoutHue(cut.layout);
    x.fillStyle = `hsla(${hue},70%,58%,0.28)`; x.fillRect(x0, top, Math.max(1, x1 - x0 - 1), bot - top);
    x.fillStyle = `hsla(${hue},80%,62%,0.95)`; x.fillRect(x0, top, Math.max(1, 2 * dpr), bot - top);
    if (x1 - x0 > 34 * dpr) {
      x.fillStyle = 'rgba(236,231,225,0.85)'; x.font = `${10 * dpr}px ${getComputedStyle(document.body).getPropertyValue('--mono') || 'monospace'}`;
      x.save(); x.beginPath(); x.rect(x0, top, x1 - x0 - 3, bot - top); x.clip();
      x.fillText((J.LAYOUTS[cut.layout] || {}).name || cut.layout, x0 + 5 * dpr, top + 13 * dpr); x.restore();
    }
  }
  x.font = `${10 * dpr}px monospace`;
  for (const ln of S.plan.lines) {
    if (ln.start < V.start || ln.start > V.end) continue;
    const lx = X(ln.start);
    x.fillStyle = '#5d5a63'; x.fillRect(lx, 0, 1, top);
    x.fillStyle = '#8e8a94'; x.fillText(String(ln.index + 1).padStart(2, '0'), lx + 3 * dpr, 12 * dpr);
  }
  const hb = S.timelineBoundaryDrag ? S.timelineBoundaryDrag.boundary : S.timelineBoundaryHover;
  if (hb) {
    const bt = hb.right.start;
    if (bt >= V.start && bt <= V.end) {
      const bx = X(bt);
      x.fillStyle = S.timelineBoundaryDrag ? '#f5a50c' : 'rgba(245,165,12,0.78)';
      x.fillRect(Math.round(bx) - Math.max(1, dpr), top, Math.max(2, 2 * dpr), bot - top);
    }
  }
  if (S.t >= V.start && S.t <= V.end) {
    const px = X(S.t);
    x.fillStyle = '#f5a50c'; x.fillRect(Math.round(px) - dpr, 0, 2 * dpr, h);
  }
  if (V.zoom > 1.001) {
    x.font = `${10 * dpr}px monospace`;
    x.textAlign = 'right';
    x.fillStyle = 'rgba(236,231,225,0.62)';
    x.fillText(`×${V.zoom < 10 ? V.zoom.toFixed(1) : V.zoom.toFixed(0)}`, w - 6 * dpr, 12 * dpr);
    x.textAlign = 'left';
  }
}
function timelineEditableBoundaries() {
  ensureLineCutOrdinals(S.plan);
  const cuts = (S.plan.cuts || []).slice().sort((a, b) => a.start - b.start);
  const out = [];
  for (let i = 1; i < cuts.length; i++) {
    const left = cuts[i - 1], right = cuts[i];
    // A draggable "boundary" exists only when the two timeline items actually touch.
    if (Math.abs(left.end - right.start) > 0.07) continue;
    if (right.end - left.start < 0.14) continue;
    const key = J.cutBoundaryKey && J.cutBoundaryKey(left, right);
    if (key) out.push({ left, right, key });
  }
  return out;
}
function timelineBoundaryAt(ev, radius = 7) {
  const tl = $('timeline'), r = tl.getBoundingClientRect(), V = timelineView();
  // The upper 30% is the line-number/seek area. Boundary dragging is deliberately
  // disabled there so clicking/dragging it always seeks playback.
  const bandTop = r.top + r.height * 0.30;
  const bandBottom = r.bottom - 8;
  if (ev.clientY < bandTop || ev.clientY > bandBottom) return null;
  let best = null, bestPx = radius + 1;
  for (const b of timelineEditableBoundaries()) {
    if (b.right.start < V.start || b.right.start > V.end) continue;
    const px = (b.right.start - V.start) / V.span * r.width;
    const d = Math.abs((ev.clientX - r.left) - px);
    if (d <= radius && d < bestPx) { best = b; bestPx = d; }
  }
  return best;
}
function timelineTimeAt(ev) {
  const r = $('timeline').getBoundingClientRect(), V = timelineView();
  const p = J.clamp((ev.clientX - r.left) / Math.max(1, r.width), 0, 1);
  return V.start + p * V.span;
}
function timelineSeek(ev) {
  seek(timelineTimeAt(ev));
}
function updateBoundaryDrag(ev) {
  const d = S.timelineBoundaryDrag;
  if (!d) return;
  const result = J.setCutBoundaryTime && J.setCutBoundaryTime(S.plan, d.boundary.left, d.boundary.right, timelineTimeAt(ev));
  if (!result) return;
  const t = +result.time.toFixed(4);
  if (!S.project.timing.cutBoundaries) S.project.timing.cutBoundaries = {};
  S.project.timing.cutBoundaries[d.boundary.key] = t;
  if (d.boundary.right.line >= 0 && d.boundary.right.lineCut === 0 &&
      (d.boundary.left.line !== d.boundary.right.line || d.boundary.left.layout === 'title' || d.boundary.left.layout === 'interlude')) {
    if (!S.project.timing.lineTimes) S.project.timing.lineTimes = {};
    S.project.timing.lineTimes[d.boundary.right.line] = t;
  }
  S.t = t;
  updateTimeUI();
  drawTimeline();
  S.need = true;
}
function finishBoundaryDrag() {
  if (!S.timelineBoundaryDrag) return;
  S.timelineBoundaryDrag = null;
  S.timelineBoundaryHover = null;
  $('timeline').style.cursor = 'pointer';
  storePlanSnapshot();
  autosave();
  renderLines();
  updateCutInfo();
  drawTimeline();
  S.need = true;
}
function timelineWheel(ev) {
  ev.preventDefault();
  const delta0 = ev.deltaY || ev.deltaX;
  if (!delta0) return;
  let delta = delta0;
  if (ev.deltaMode === 1) delta *= 16;
  else if (ev.deltaMode === 2) delta *= window.innerHeight;
  const r = $('timeline').getBoundingClientRect(), V = timelineView();
  const p = J.clamp((ev.clientX - r.left) / Math.max(1, r.width), 0, 1);
  const anchor = V.start + p * V.span;
  const zoom = J.clamp(V.zoom * Math.exp(-delta * 0.0015), 1, 32);
  const span = V.D / zoom;
  S.timelineZoom = zoom;
  S.timelineStart = zoom <= 1.0001 ? 0 : J.clamp(anchor - p * span, 0, Math.max(0, V.D - span));
  drawTimeline();
}

/* ---------------- cut info ---------------- */
let lastCutIdx = -2;
function updateCutInfo() {
  const cut = J.cutAt(S.plan, S.t);
  const idx = cut ? cut.index : -1;
  const li = cut ? cut.line : -1;
  if (li !== S.curLine) { S.lineEls.forEach((el, i) => el.classList.toggle('cur', i === li)); S.curLine = li; }
  if (idx === lastCutIdx) return;
  lastCutIdx = idx;
  const el = $('cutInfo');
  if (!cut) { el.innerHTML = '<span class="hint">この位置にカットはありません</span>'; return; }
  const chip = (cls, k, v) => `<span class="chip ${cls}"><b>${k}</b>${v}</span>`;
  const n = (tbl, k) => (tbl[k] ? tbl[k].name : k);
  el.innerHTML = [
    `<span class="chip mono">#${String(cut.index + 1).padStart(2, '0')}</span>`,
    chip('l', 'レイアウト', n(J.LAYOUTS, cut.layout)), chip('e', '登場', n(J.ENTER, cut.enter)), chip('h', '保持', n(J.HOLD, cut.hold)), chip('x', '退場', n(J.EXIT, cut.exit)),
    cut.decor && cut.decor.length ? chip('', '装飾', cut.decor.map(d => n(J.DECOR, d.id)).join('・')) : '',
    cut.treat && cut.treat !== 'none' ? chip('t', '加工', n(J.TREAT, cut.treat)) : '',
    cut.bg && cut.bg !== 'none' ? chip('b', '背景', n(J.BG, cut.bg)) : '',
    cut.cam && cut.cam !== 'push' ? chip('c', 'カメラ', n(J.CAMERA, cut.cam)) : '',
    cut.trans ? chip('c', 'つなぎ', n(J.TRANS, cut.trans)) : '',
  ].join('');
}

/* ---------------- line list ---------------- */
function renderLines() {
  const ol = $('lineList'); ol.innerHTML = ''; S.lineEls = []; S.curLine = -2;
  const ov = S.project.overrides;
  const globalStyleName = (J.STYLES[S.project.style] || J.STYLES.noir).name;
  const styleOpts = '<option value="">全体（' + escapeHtml(globalStyleName) + '）</option>' + J.STYLE_ORDER.map(k => `<option value="${k}">${escapeHtml(J.STYLES[k].name)}</option>`).join('');
  const rows = S.plan.lines.map((ln, i) => ({ ln, i }));
  if (S.lineSortByTime) rows.sort((a, b) => (a.ln.start - b.ln.start) || (a.i - b.i));
  const sortBtn = $('btnSortLines');
  sortBtn.setAttribute('aria-pressed', String(S.lineSortByTime));
  sortBtn.title = S.lineSortByTime ? '歌詞の元の行順に戻す' : 'タイムコードの早い順（昇順）に並べる';
  rows.forEach(({ ln, i }) => {
    const o = ov[i] || {};
    const li = document.createElement('li'); li.className = 'ln';
    const manual = S.project.timing.lineTimes && S.project.timing.lineTimes[i] != null;
    const layoutName = o.layout && J.LAYOUTS[o.layout] ? J.LAYOUTS[o.layout].name : '自動';
    li.innerHTML = `<span class="no">${String(i + 1).padStart(2, '0')}</span>
      <input class="time mono" type="number" step="0.01" min="0" value="${ln.start.toFixed(2)}" title="開始（秒）${manual ? '・手動' : '・自動'}" aria-label="${i + 1}行目の開始秒" style="${manual ? 'border-color:var(--cyan)' : ''}">
      <span class="txt" title="${escapeHtml(ln.text)}">${escapeHtml(ln.text)}</span>
      <div class="meta"><span class="cuts"></span>
      <span class="tools">
        <select class="line-style" aria-label="この行のスタイル">${styleOpts}</select>
        <span class="layout-pick"><button type="button" class="layout-trigger ghost" title="レイアウト指定。候補にマウスを置くと一時プレビュー">${escapeHtml(layoutName)}</button></span>
        <button class="icon ghost dice" title="この行を再抽選">${ICON.dice}</button>
        <button class="icon ghost lock" title="この行の構成をロック" aria-pressed="${o.lock ? 'true' : 'false'}">${ICON.lock}</button>
      </span></div>`;
    const styleSel = li.querySelector('.line-style');
    styleSel.value = o.style || '';
    li.querySelector('.time').addEventListener('change', e => {
      const v = parseFloat(e.target.value);
      if (!S.project.timing.lineTimes) S.project.timing.lineTimes = {};
      if (isFinite(v)) S.project.timing.lineTimes[i] = Math.max(0, v); else delete S.project.timing.lineTimes[i];
      replan();
    });
    li.querySelector('.txt').addEventListener('click', () => seek(ln.start + 0.001));
    styleSel.addEventListener('change', e => { setOv(i, { style: e.target.value || undefined }); fontKey = ''; replan(); });
    li.querySelector('.layout-trigger').addEventListener('click', e => { e.stopPropagation(); openLayoutMenu(e.currentTarget, i, o.layout || ''); });
    li.querySelector('.dice').addEventListener('click', () => { const cur = ov[i] || {}; setOv(i, { seed: (cur.seed | 0) + 1, lock: false }); replan(); seek(ln.start + 0.001); });
    li.querySelector('.lock').addEventListener('click', () => {
      const cur = ov[i] || {};
      if (cur.lock) setOv(i, { lock: false, lockedSeed: undefined });
      else setOv(i, { lock: true, lockedSeed: ln.seed });
      replan();
    });
    const cutsEl = li.querySelector('.cuts');
    S.plan.cuts.filter(c => c.line === i && J.LAYOUTS[c.layout] && !J.LAYOUTS[c.layout].special).forEach(c => {
      const sp = document.createElement('span'); sp.textContent = J.LAYOUTS[c.layout].name; sp.title = `${c.text}｜${J.ENTER[c.enter].name} → ${J.EXIT[c.exit].name}`;
      sp.style.borderColor = `hsla(${layoutHue(c.layout)},70%,58%,0.7)`;
      sp.addEventListener('click', () => seek(c.start + Math.min(c.dur * 0.5, c.inDur + 0.05)));
      cutsEl.appendChild(sp);
    });
    ol.appendChild(li); S.lineEls[i] = li;
  });
  $('linesInfo').textContent = `${S.plan.lines.length}行 / ${S.plan.cuts.length}カット`;
}
function setOv(i, patch) {
  const cur = Object.assign({}, S.project.overrides[i] || {}, patch);
  for (const k of Object.keys(cur)) if (cur[k] === undefined || cur[k] === false || cur[k] === '') delete cur[k];
  if (Object.keys(cur).length) S.project.overrides[i] = cur; else delete S.project.overrides[i];
}

let layoutPreviewTimer = 0;
function clearLayoutPreview() {
  clearTimeout(layoutPreviewTimer);
  if (S.layoutPreview) { S.layoutPreview = null; S.need = true; }
}
function previewLineLayout(i, layoutKey) {
  const p = JSON.parse(JSON.stringify(S.project));
  p.overrides = p.overrides || {};
  const cur = Object.assign({}, p.overrides[i] || {});
  if (layoutKey) cur.layout = layoutKey; else delete cur.layout;
  if (Object.keys(cur).length) p.overrides[i] = cur; else delete p.overrides[i];
  const plan = J.plan(p, audioLike());
  const cut = plan.cuts.find(c => c.line === i && c.layout !== 'interlude');
  const line = plan.lines[i];
  const t = cut ? cut.start + Math.min(cut.dur * 0.55, Math.max(cut.inDur + 0.06, cut.dur * 0.28)) : (line ? line.start + 0.01 : S.t);
  S.layoutPreview = { plan, t };
  S.need = true;
}
function queueLayoutPreview(i, layoutKey) {
  clearTimeout(layoutPreviewTimer);
  layoutPreviewTimer = setTimeout(() => previewLineLayout(i, layoutKey), 35);
}
function closeLayoutMenu() {
  const m = S.layoutMenu;
  if (m) {
    document.removeEventListener('pointerdown', m.outside, true);
    if (m.el && m.el.parentNode) m.el.remove();
    S.layoutMenu = null;
  }
  clearLayoutPreview();
}
function openLayoutMenu(trigger, lineIndex, currentLayout) {
  closeLayoutMenu();
  const menu = document.createElement('div');
  menu.className = 'layout-menu';
  menu.setAttribute('role', 'menu');
  const add = (key, label) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.dataset.k = key;
    if ((currentLayout || '') === key) b.classList.add('selected');
    b.addEventListener('mouseenter', () => {
      menu.querySelectorAll('.previewing').forEach(x => x.classList.remove('previewing'));
      b.classList.add('previewing');
      queueLayoutPreview(lineIndex, key);
    });
    b.addEventListener('click', e => {
      e.stopPropagation();
      setOv(lineIndex, { layout: key || undefined });
      closeLayoutMenu();
      replan();
      const ln = S.plan.lines[lineIndex];
      if (ln) seek(ln.start + 0.001);
    });
    menu.appendChild(b);
  };
  add('', '自動');
  for (const k of J.LAYOUT_ORDER) {
    const d = J.LAYOUTS[k];
    if (d && !d.special) add(k, d.name);
  }
  menu.addEventListener('mouseleave', clearLayoutPreview);
  document.body.appendChild(menu);
  const r = trigger.getBoundingClientRect();
  let left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - menu.offsetWidth - 8));
  let top = r.bottom + 4;
  if (top + menu.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - menu.offsetHeight - 4);
  menu.style.left = left + 'px'; menu.style.top = top + 'px';
  const outside = e => { if (!menu.contains(e.target) && e.target !== trigger) closeLayoutMenu(); };
  document.addEventListener('pointerdown', outside, true);
  S.layoutMenu = { el: menu, outside };
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ---------------- style tab ---------------- */
function drawStyleGrid() {
  const g = $('styleGrid');
  if (!g.children.length) {
    J.STYLE_ORDER.forEach(k => {
      const b = document.createElement('button'); b.className = 'stile'; b.dataset.k = k;
      b.title = J.STYLES[k].desc;
      b.innerHTML = `<canvas width="192" height="108"></canvas><span>${J.STYLES[k].name}</span><span class="badges">${setBadges(J.STYLES[k])}</span>`;
      b.addEventListener('click', () => { remember(); S.project.style = k; S.project.colors.enabled = false; syncUI(); replan(); commit(); });
      g.appendChild(b);
    });
  }
  [...g.children].forEach(b => {
    const k = b.dataset.k, st = J.STYLES[k], sc = st.schemes[0], cv = b.querySelector('canvas'), x = cv.getContext('2d');
    b.setAttribute('aria-pressed', S.project.style === k ? 'true' : 'false');
    const off = !J.randomOk(S.project, 'style', k);
    b.classList.toggle('set-off', off);
    b.title = st.desc + (off ? (st.extra && S.project.extra !== true ? '（追加分がオフのため、おまかせでは選ばれません）' : '（和風の演出がオフのため、おまかせでは選ばれません）') : '');
    x.fillStyle = sc.bg; x.fillRect(0, 0, 192, 108);
    st.schemes.slice(1, 4).forEach((s2, i) => { x.fillStyle = s2.bg; x.fillRect(192 - 14 * (i + 1), 0, 14, 10); });
    const f = st.fonts.display[0];
    x.font = J.fontCSS(f, 46); x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = sc.ghostB; x.fillText('字面', 96 - 3, 54 - 1);
    x.fillStyle = sc.ghostA; x.fillText('字面', 96 + 3, 54 + 2);
    x.fillStyle = sc.fg; x.fillText('字面', 96, 54);
    x.fillStyle = sc.accent; x.fillRect(12, 90, 30, 4);
    x.font = J.fontCSS('mono', 9); x.textAlign = 'left'; x.fillStyle = sc.sub; x.fillText(k.toUpperCase(), 48, 93);
  });
}
function fontSelectOptions(sel) {
  return '<option value="">スタイルの既定</option>' + Object.entries(J.FONTS).map(([k, f]) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${escapeHtml(f.label)}</option>`).join('');
}
function renderFontRoles() {
  const box = $('fontRoles'); box.innerHTML = '';
  [['display', '見出し'], ['serif', '明朝枠'], ['body', '小さな文字']].forEach(([role, label]) => {
    const row = document.createElement('div'); row.className = 'font-row';
    row.innerHTML = `<span class="muted">${label}</span><select aria-label="${label}のフォント">${fontSelectOptions(S.project.fonts[role])}</select>`;
    row.querySelector('select').addEventListener('change', e => { if (e.target.value) S.project.fonts[role] = e.target.value; else delete S.project.fonts[role]; fontKey = ''; replan(); });
    box.appendChild(row);
  });
}
const BASE_KEYS = [['bg', '背景'], ['fg', '文字'], ['sub', '補助']];
const ACCENT_KEYS = [['accent', 'アクセント'], ['ghostA', 'ズレ色A'], ['ghostB', 'ズレ色B']];
function renderColors() {
  const st = J.STYLES[S.project.style] || J.STYLES.noir, sc = st.schemes[0];
  const c = S.project.colors;
  $('colorOn').checked = !!c.enabled;
  $('accentOn').checked = !!c.accentOn;
  const fill = (rowId, keys, flag) => {
    const row = $(rowId); row.innerHTML = '';
    keys.forEach(([k, label]) => {
      const l = document.createElement('label');
      const v = (c[flag] && c[k]) || c[k] || sc[k];
      l.innerHTML = `${label}<input type="color" value="${toColorInput(v)}">`;
      l.querySelector('input').addEventListener('input', e => {
        c[k] = e.target.value.toUpperCase();
        if (!c[flag]) { c[flag] = true; $(flag === 'enabled' ? 'colorOn' : 'accentOn').checked = true; }
        replanSoon(60); drawSwatch();
      });
      row.appendChild(l);
    });
  };
  fill('colorRow', BASE_KEYS, 'enabled');
  fill('colorRowAccent', ACCENT_KEYS, 'accentOn');
  drawSwatch();
}
const toColorInput = v => { const h = String(v || '#000000'); return /^#[0-9a-f]{6}$/i.test(h) ? h.toLowerCase() : J.toHex(...J.hex(h)).toLowerCase(); };
function swatchHTML(cols) { return cols.map(c => `<i style="background:${c}" title="${c}"></i>`).join(''); }
function drawSwatch() {
  const sc = S.plan ? S.plan.style.schemes[0] : null; if (!sc) return;
  $('paletteSwatch').innerHTML = swatchHTML([sc.accent, sc.ghostA, sc.ghostB]);
}
function randomPalette() {
  remember();
  const c = S.project.colors;
  const sc0 = J.STYLES[S.project.style].schemes[0];
  const bg = c.enabled && c.bg ? c.bg : sc0.bg;
  let p, guard = 0;
  do { p = J.randomPalette(bg); } while (guard++ < 6 && p.ghostA === c.ghostA && p.ghostB === c.ghostB);
  Object.assign(c, { accent: p.accent, ghostA: p.ghostA, ghostB: p.ghostB, accentOn: true });
  renderColors(); replan(); commit();
  toast('配色：アクセント・ズレ色A/Bを変更', [p.accent, p.ghostA, p.ghostB]);
}

/* ---------------- history of looks (◀ ▶) ---------------- */
// only the "look" is tracked — lyrics, timing and output settings are never rolled back
const HKEYS = ['style', 'mood', 'seed', 'fx', 'enabled', 'fonts', 'colors', 'overrides'];
const H = { list: [], i: -1 };
const lookSnap = () => JSON.stringify(Object.fromEntries(HKEYS.map(k => [k, S.project[k] ?? null])));
function remember() {            // call before changing the look: makes sure the current look is on the stack
  const s = lookSnap();
  if (H.i >= 0 && H.list[H.i] === s) return;
  H.list = H.list.slice(0, H.i + 1); H.list.push(s); H.i = H.list.length - 1;
}
function commit() {              // call after changing the look
  const s = lookSnap();
  if (H.list[H.i] !== s) { H.list = H.list.slice(0, H.i + 1); H.list.push(s); H.i = H.list.length - 1; }
  if (H.list.length > 80) { H.list.splice(0, H.list.length - 80); H.i = H.list.length - 1; }
  updateHist();
}
function histGo(d) {
  if (S.exporting) return;
  remember();                    // hand edits made since the last step become a stop of their own
  const j = H.i + d; if (j < 0 || j >= H.list.length) return;
  H.i = j;
  Object.assign(S.project, JSON.parse(H.list[j]));
  fontKey = ''; syncUI(); replan(); updateHist();
  toast(`${j + 1} / ${H.list.length} 案目`);
  restartPreview();
}
function updateHist() {
  const canB = H.i > 0, canF = H.i < H.list.length - 1;
  ['btnPrev', 'btnPrev2'].forEach(id => { $(id).disabled = !canB; });
  ['btnNext', 'btnNext2'].forEach(id => { $(id).disabled = !canF; });
  $('histPos').textContent = H.list.length > 1 ? `${H.i + 1} / ${H.list.length}` : '';
}

/* ---------------- おまかせ ---------------- */
function restartPreview() { seek(0); if (!S.playing && S.mode === 'easy') play(); }
function omakase() {
  if (S.exporting || S.tap) return;
  remember();
  const r = J.omakase(S.project);
  Object.assign(S.project, r);
  fontKey = ''; syncUI(); replan(); commit();
  toast(`おまかせ：${J.STYLES[r.style].name} × ${J.MOODS[r.mood].name}`, r.colors.accentOn ? [r.colors.accent, r.colors.ghostA, r.colors.ghostB] : null);
  restartPreview();
}
// change just one aspect of the current look
function rerollPart(part) {
  if (S.exporting || S.tap) return;
  remember();
  const P = S.project;
  let msg = '';
  if (part === 'style') {
    let pool = J.STYLE_ORDER.filter(k => k !== P.style && J.randomOk(P, 'style', k));
    if (!pool.length) pool = J.STYLE_ORDER.filter(k => k !== P.style);
    P.style = pool[Math.floor(Math.random() * pool.length)];
    P.colors.enabled = false;
    msg = `スタイル：${J.STYLES[P.style].name}`;
  } else if (part === 'mood') {
    const r = J.omakase(P);
    Object.assign(P, { mood: r.mood, fx: r.fx, enabled: r.enabled });
    msg = `雰囲気：${J.MOODS[r.mood].name}`;
  } else if (part === 'cut') {
    P.seed = (Math.random() * 1e9) | 0;
    msg = '構成：レイアウトと動きを再抽選';
  }
  fontKey = ''; syncUI(); replan(); commit();
  toast(msg);
  restartPreview();
}
function showNow() {
  const el = $('easyNow'); if (!el || !S.plan || el.closest('[hidden]')) return;
  const P = S.project, sc = S.plan.style.schemes[0];
  const moodName = P.mood && J.MOODS[P.mood] ? J.MOODS[P.mood].name : 'カスタム';
  const fk = S.plan.style.fonts.display[0];
  const fontName = J.FONTS[fk] ? J.FONTS[fk].label : fk;
  const cuts = S.plan.cuts.filter(c => c.line >= 0 && c.layout !== 'interlude');
  const kinds = new Set(cuts.map(c => c.layout)).size;
  const row = (k, v) => `<div class="now-row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  el.innerHTML = row('スタイル', `<b>${escapeHtml(J.STYLES[P.style].name)}</b>`)
    + row('雰囲気', escapeHtml(moodName))
    + row('配色', `<span class="swatches">${swatchHTML([sc.bg, sc.fg, sc.accent, sc.ghostA, sc.ghostB])}</span>${P.colors.accentOn ? '<span class="tagl">ランダム</span>' : ''}`)
    + row('見出し書体', escapeHtml(fontName))
    + row('構成', `${cuts.length} カット・レイアウト ${kinds} 種`)
    + row('演出', `加工 ${cuts.filter(c => c.treat && c.treat !== 'none').length}・背景 ${new Set(cuts.map(c => c.bg).filter(b => b && b !== 'none')).size}種・カメラ ${cuts.filter(c => c.cam && c.cam !== 'push').length}`);
}
let toastTimer = 0;
function toast(m, cols) {
  const el = $('toast'); if (!el) return;
  el.innerHTML = escapeHtml(m) + (cols ? `<span class="swatches">${swatchHTML(cols)}</span>` : '');
  el.hidden = false; el.classList.remove('out'); void el.offsetWidth; el.classList.add('in');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('in'); el.classList.add('out'); toastTimer = setTimeout(() => { el.hidden = true; }, 260); }, 1700);
}

/* ---------------- かんたん / 詳細 ---------------- */
function setMode(m) {
  S.mode = m === 'easy' ? 'easy' : 'pro';
  const easy = S.mode === 'easy';
  $('app').classList.toggle('is-easy', easy);
  $('easyPanel').hidden = !easy;
  $('modeEasy').setAttribute('aria-pressed', String(easy));
  $('modePro').setAttribute('aria-pressed', String(!easy));
  try { localStorage.setItem('jizura.mode', S.mode); } catch (e) {}
  if (easy) { showNow(); syncOut(); codecNote(); }
  sizeViewport(); drawTimeline(); loadThumbFonts();
}

/* ---------------- fx tab ---------------- */
const FX = [['motion', '動きの強さ'], ['glitch', 'グリッチ'], ['chroma', '色ズレ'], ['decor', '装飾の量'], ['density', 'カットの細かさ'], ['texture', '質感'], ['bgSwitch', '背景の切替']];
function renderFx() {
  const box = $('fxSliders'); box.innerHTML = '';
  FX.forEach(([k, label]) => {
    const row = document.createElement('div'); row.className = 'slider';
    const v = S.project.fx[k] ?? 0.5;
    row.innerHTML = `<label for="fx_${k}">${label}</label><input id="fx_${k}" type="range" min="0" max="1" step="0.01" value="${v}"><output>${Math.round(v * 100)}</output>`;
    const inp = row.querySelector('input'), out = row.querySelector('output');
    inp.addEventListener('input', () => { S.project.fx[k] = +inp.value; S.project.mood = null; out.textContent = Math.round(inp.value * 100); replanSoon(120); });
    box.appendChild(row);
  });
  $('fxFlash').checked = !!S.project.fx.flash;
  $('fxKoma').value = String(J.komaOf(S.project.fx));
  $('fxHud').value = S.project.fx.hud || 'auto';
  $('seed').value = S.project.seed;
}

/* ---------------- technique tab ---------------- */
const GROUPS = [['layout', 'レイアウト'], ['enter', '登場'], ['hold', '保持'], ['exit', '退場'], ['decor', '装飾'], ['treat', '文字の加工'], ['bg', '背景'], ['cam', 'カメラ'], ['fx', '画面効果'], ['trans', 'カット間のつなぎ']];
const openGroups = new Set();
function techItems(g) { return J.order(g).filter(k => J.registry(g)[k] && !J.registry(g)[k].special); }
function renderTech() {
  const box = $('techLists'); box.innerHTML = '';
  const q = ($('techFilter').value || '').trim().toLowerCase();
  let total = 0, onAll = 0;
  GROUPS.forEach(([g, label]) => {
    const tbl = J.registry(g), items = techItems(g), en = S.project.enabled[g] || (S.project.enabled[g] = {});
    const shown = q ? items.filter(k => (tbl[k].name + ' ' + k).toLowerCase().includes(q)) : items;
    const onN = items.filter(k => en[k] !== false).length;
    total += items.length; onAll += onN;
    if (q && !shown.length) return;
    const d = document.createElement('details'); d.className = 'tgroup';
    d.open = !!q || openGroups.has(g);
    d.addEventListener('toggle', () => { if (d.open) openGroups.add(g); else openGroups.delete(g); });
    d.innerHTML = `<summary><span class="tg-name">${label}</span><span class="tg-cnt mono">${onN}/${items.length}</span></summary><div class="tg-tools"><button class="ghost small" data-a="on">すべてON</button><button class="ghost small" data-a="off">すべてOFF</button><button class="ghost small" data-a="flip">反転</button></div>`;
    const list = document.createElement('div'); list.className = 'checks';
    shown.forEach(k => {
      const l = document.createElement('label');
      l.title = k + (tbl[k].tags && tbl[k].tags.length ? '（' + tbl[k].tags.map(t => (J.MOODS[t] ? J.MOODS[t].name : t)).join('・') + '）' : '');
      if (!J.randomOk(S.project, g, k)) { l.classList.add('set-off'); l.title += tbl[k].extra && S.project.extra !== true ? '（追加分がオフのため、自動では選ばれません）' : '（和風の演出がオフのため、自動では選ばれません）'; }
      l.innerHTML = `<input type="checkbox" ${en[k] !== false ? 'checked' : ''}> ${escapeHtml(tbl[k].name)}${setBadges(tbl[k])}`;
      l.querySelector('input').addEventListener('change', e => { en[k] = e.target.checked; S.project.mood = null; d.querySelector('.tg-cnt').textContent = `${items.filter(x => en[x] !== false).length}/${items.length}`; replanSoon(60); });
      list.appendChild(l);
    });
    d.querySelectorAll('.tg-tools button').forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.a;
      shown.forEach(k => { en[k] = a === 'on' ? true : a === 'off' ? false : en[k] === false; });
      // keep a fallback so the planner always has something to use
      if (g === 'layout' && !items.some(k => en[k] !== false)) en.center = true;
      if (g === 'enter') en.cut = true; if (g === 'exit') en.cut = true; if (g === 'hold') en.still = true;
      if (g === 'treat') en.none = true; if (g === 'bg') en.none = true; if (g === 'cam') en.push = true;
      S.project.mood = null; openGroups.add(g); renderTech(); replan();
    }));
    d.appendChild(list);
    box.appendChild(d);
  });
  $('techTotal').textContent = `${onAll}/${total}`;
}

/* ---------------- output tab ---------------- */
function syncOut() {
  $('outAspect').value = S.project.aspect; $('outRes').value = String(S.project.res); $('outFps').value = String(S.project.fps);
  $('eAspect').value = S.project.aspect; $('eRes').value = String(S.project.res); $('eFps').value = String(S.project.fps);
  $('outQuality').value = S.project.quality || 'high'; $('outAudio').checked = S.project.includeAudio !== false;
  const k = J.keyMode(S.project) || 'off';
  $('outKey').value = k; $('eKey').value = k;
  const kb = $('keyBadge');
  kb.hidden = k === 'off';
  if (k !== 'off') kb.innerHTML = `<i style="background:${J.KEY_BG[k]}"></i>${k === 'green' ? 'グリーンバック' : 'ブラックバック'}`;
}
async function codecNote() {
  const [w, h] = J.outputSize(S.project);
  const vc = await J.pickVideoCodec(w, h, S.project.fps, 12e6);
  $('codecNote').textContent = vc ? `このブラウザでは ${vc.label} で書き出します（${w}×${h} / ${S.project.fps}fps）。書き出し中はタブを開いたままにしてください。` : 'このブラウザは動画エンコード（WebCodecs）に対応していません。Chrome / Edge の最新版で開くか、連番PNGを使ってください。';
  $('btnMP4').disabled = !vc; $('eMP4').disabled = !vc;
  if (!vc) $('eMP4').title = 'このブラウザは MP4 書き出しに対応していません（Chrome / Edge 推奨）';
}
const EXP_BTNS = ['btnMP4', 'btnPNG', 'btnPNGA', 'eMP4'];
function baseName() {
  const k = J.keyMode(S.project);
  return ((S.project.title || 'jizura').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'jizura') + (k ? (k === 'green' ? '_greenback' : '_blackback') : '');
}
async function runExport(kind) {
  if (S.exporting) return;
  pause();
  const ac = new AbortController(); S.exporting = ac;
  const boxes = [...document.querySelectorAll('.exp-box')];
  const setText = m => boxes.forEach(b => { b.querySelector('.exp-text').textContent = m; });
  const txt = { set textContent(m) { setText(m); }, get textContent() { return boxes[0].querySelector('.exp-text').textContent; } };
  boxes.forEach(b => { b.hidden = false; b.querySelector('.exp-bar').style.width = '0%'; });
  setText('準備中…');
  EXP_BTNS.forEach(id => { $(id).disabled = true; });
  const onProgress = (p, m) => { boxes.forEach(b => { b.querySelector('.exp-bar').style.width = (p * 100).toFixed(1) + '%'; }); setText(m); };
  const t0 = performance.now();
  try {
    await J.ensureFonts(S.project.lyrics + (S.project.title || '') + (S.project.artist || '') + HUD_CHARS, J.fontsOfPlan(S.plan));
    if (kind === 'mp4') {
      const r = await J.exportMP4({ plan: S.plan, project: S.project, audio: S.project.includeAudio !== false ? S.audio : null, quality: S.project.quality || 'high', onProgress, signal: ac.signal });
      txt.textContent = `完成 ${(r.blob.size / 1048576).toFixed(1)}MB・${r.codec}${r.audio ? ' + ' + r.audio.toUpperCase() : ''}・${((performance.now() - t0) / 1000).toFixed(0)}秒`;
      const res = await J.saveFile(baseName() + '.mp4', r.blob);
      if (res === 'declined') txt.textContent += '（保存はキャンセルされました）';
    } else {
      const blob = await J.exportPNGZip({ plan: S.plan, project: S.project, transparent: kind === 'pnga', onProgress, signal: ac.signal });
      txt.textContent = `完成 ${(blob.size / 1048576).toFixed(1)}MB`;
      await J.saveFile(baseName() + (kind === 'pnga' ? '_alpha' : '') + '_png.zip', blob);
    }
  } catch (e) {
    txt.textContent = 'エラー: ' + (e && e.message ? e.message : e);
    console.error(e);
  } finally {
    S.exporting = null; S.need = true;
    EXP_BTNS.forEach(id => { $(id).disabled = false; });
    codecNote();
  }
}

/* ---------------- tap sync ---------------- */
function startTap() {
  if (!S.plan.lines.length) return;
  S.tap = { i: 0 };
  if (!S.project.timing.lineTimes) S.project.timing.lineTimes = {};
  $('tapPanel').hidden = false; $('btnTap').setAttribute('aria-pressed', 'true');
  seek(0); play(); updateTap();
  $('tapBtn').focus();
}
function tapNow() {
  if (!S.tap) return;
  S.project.timing.lineTimes[S.tap.i] = +S.t.toFixed(3);
  S.tap.i++;
  replan();
  if (S.tap.i >= S.plan.lines.length) stopTap(); else updateTap();
}
function stopTap() { S.tap = null; $('tapPanel').hidden = true; $('btnTap').setAttribute('aria-pressed', 'false'); replan(); }
function updateTap() { const ln = S.plan.lines[S.tap.i]; $('tapLine').textContent = ln ? `${S.tap.i + 1}. ${ln.text}` : '—'; }

/* ---------------- sync all inputs from project ---------------- */
function syncUI() {
  S.lineSortByTime = !!(S.project.ui && S.project.ui.lineSortByTime);
  $('songTitle').value = S.project.title || ''; $('songArtist').value = S.project.artist || '';
  $('lyrics').value = S.project.lyrics;
  $('bpm').value = S.project.timing.bpm > 0 ? S.project.timing.bpm : '';
  $('bpm').placeholder = S.audio ? `自動 ${S.audio.bpm}` : 'なし';
  $('offset').value = S.project.timing.offset ?? 0.4;
  $('lineScale').value = S.project.timing.lineScale ?? 1;
  $('snap').checked = !!S.project.timing.snap;
  const pv = Math.round(J.clamp(S.project.previewVolume ?? 1, 0, 2) * 100);
  $('previewVolume').value = String(pv);
  $('previewVolumeValue').textContent = pv + '%';
  AP.setVolume(pv / 100);
  document.querySelectorAll('.wa-toggle').forEach(el => { el.checked = S.project.wa !== false; });
  document.querySelectorAll('.extra-toggle').forEach(el => { el.checked = S.project.extra === true; });
  renderFontRoles(); renderColors(); renderFx(); renderTech(); syncOut(); drawStyleGrid();
}

/* ---------------- wiring ---------------- */
function bind() {
  $('lyrics').addEventListener('input', e => {
    const next = e.target.value, prev = S.project.lyrics;
    remapLineIndexedState(prev, next);
    S.project.lyrics = next;
    replanSoon(260);
  });
  $('songTitle').addEventListener('input', e => { S.project.title = e.target.value; replanSoon(300); });
  $('songArtist').addEventListener('input', e => { S.project.artist = e.target.value; replanSoon(300); });
  $('btnSyntax').addEventListener('click', e => { const s = $('syntax'); s.hidden = !s.hidden; e.target.setAttribute('aria-expanded', String(!s.hidden)); });
  $('bpm').addEventListener('change', e => { S.project.timing.bpm = Math.max(0, parseFloat(e.target.value) || 0); replan(); });
  $('offset').addEventListener('change', e => { S.project.timing.offset = Math.max(0, parseFloat(e.target.value) || 0); replan(); });
  $('lineScale').addEventListener('change', e => { S.project.timing.lineScale = J.clamp(parseFloat(e.target.value) || 1, 0.3, 4); replan(); });
  $('snap').addEventListener('change', e => { S.project.timing.snap = e.target.checked; replan(); });
  $('btnResetTimes').addEventListener('click', () => { S.project.timing.lineTimes = {}; replan(); });
  $('btnSortLines').addEventListener('click', () => {
    S.lineSortByTime = !S.lineSortByTime;
    S.project.ui = Object.assign({}, S.project.ui || {}, { lineSortByTime: S.lineSortByTime });
    renderLines(); updateCutInfo(); autosave();
  });
  $('audioFile').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; if (f) loadAudioFile(f); });
  $('previewVolume').addEventListener('input', e => {
    const pct = J.clamp(+e.target.value || 0, 0, 200);
    S.project.previewVolume = pct / 100;
    $('previewVolumeValue').textContent = Math.round(pct) + '%';
    AP.setVolume(S.project.previewVolume);
    autosave();
  });
  $('btnTap').addEventListener('click', () => (S.tap ? stopTap() : startTap()));
  $('tapBtn').addEventListener('click', tapNow);
  $('tapStop').addEventListener('click', () => { pause(); stopTap(); });
  $('btnPlay').addEventListener('click', () => (S.playing ? pause() : play()));
  $('btnLoop').addEventListener('click', e => { S.loop = !S.loop; e.target.setAttribute('aria-pressed', String(S.loop)); });
  $('btnShuffle').addEventListener('click', () => { remember(); S.project.seed = (Math.random() * 1e9) | 0; $('seed').value = S.project.seed; replan(); commit(); });
  const sc = $('scrub');
  sc.addEventListener('input', () => { S.scrubbing = true; seek(sc.value / 10000 * S.plan.duration); });
  sc.addEventListener('change', () => { S.scrubbing = false; });
  const tl = $('timeline');
  let drag = false;
  tl.addEventListener('pointerdown', e => {
    const b = timelineBoundaryAt(e, 9);
    if (b) {
      e.preventDefault();
      if (S.playing) pause();
      drag = false;
      S.timelineBoundaryHover = b;
      S.timelineBoundaryDrag = { boundary: b, pointerId: e.pointerId };
      tl.style.cursor = 'col-resize';
      tl.setPointerCapture(e.pointerId);
      updateBoundaryDrag(e);
      return;
    }
    drag = true;
    S.timelineBoundaryHover = null;
    tl.style.cursor = 'pointer';
    tl.setPointerCapture(e.pointerId);
    timelineSeek(e);
  });
  tl.addEventListener('pointermove', e => {
    if (S.timelineBoundaryDrag) { updateBoundaryDrag(e); return; }
    if (drag) { timelineSeek(e); return; }
    const b = timelineBoundaryAt(e, 8);
    const old = S.timelineBoundaryHover && S.timelineBoundaryHover.key;
    const next = b && b.key;
    S.timelineBoundaryHover = b;
    tl.style.cursor = b ? 'col-resize' : 'pointer';
    if (old !== next) drawTimeline();
  });
  tl.addEventListener('pointerup', e => {
    if (S.timelineBoundaryDrag) {
      try { if (tl.hasPointerCapture(e.pointerId)) tl.releasePointerCapture(e.pointerId); } catch (err) {}
      finishBoundaryDrag();
      return;
    }
    drag = false;
  });
  tl.addEventListener('pointercancel', () => { drag = false; finishBoundaryDrag(); });
  tl.addEventListener('pointerleave', () => {
    if (!drag && !S.timelineBoundaryDrag && S.timelineBoundaryHover) {
      S.timelineBoundaryHover = null; tl.style.cursor = 'pointer'; drawTimeline();
    }
  });
  tl.addEventListener('wheel', timelineWheel, { passive: false });
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    document.querySelectorAll('.tabpane').forEach(p => { p.hidden = p.dataset.pane !== b.dataset.tab; });
    if (b.dataset.tab === 'out') codecNote();
    loadThumbFonts();
  }));
  $('fxFlash').addEventListener('change', e => { S.project.fx.flash = e.target.checked; replan(); });
  $('techFilter').addEventListener('input', () => renderTech());
  const setSwitch = (cls, key, on, msgOn, msgOff) => document.querySelectorAll('.' + cls).forEach(el => el.addEventListener('change', e => {
    remember();
    S.project[key] = e.target.checked;
    document.querySelectorAll('.' + cls).forEach(x => { x.checked = e.target.checked; });
    renderTech(); drawStyleGrid(); replan(); commit(); flushSave();
    toast(e.target.checked ? msgOn : msgOff);
  }));
  setSwitch('extra-toggle', 'extra', true, '追加分の演出：使う', '追加分の演出：使わない（最初の公開版の演出だけ）');
  setSwitch('wa-toggle', 'wa', true, '和風の演出：使う', '和風の演出：使わない（おまかせ・シャッフルで選ばれません）');
  $('fxKoma').addEventListener('change', e => { const k = +e.target.value; S.project.fx.koma = k; S.project.fx.onTwos = k > 0; S.project.mood = null; replan(); });
  $('fxHud').addEventListener('change', e => { S.project.fx.hud = e.target.value; replan(); });
  $('seed').addEventListener('change', e => { S.project.seed = parseInt(e.target.value, 10) || 0; replan(); });
  $('btnSeed').addEventListener('click', () => { S.project.seed = (Math.random() * 1e9) | 0; $('seed').value = S.project.seed; replan(); });
  const colorToggle = (flag, keys) => e => {
    remember();
    const c = S.project.colors; c[flag] = e.target.checked;
    if (c[flag]) { const sc0 = J.STYLES[S.project.style].schemes[0]; keys.forEach(([k]) => { if (!c[k]) c[k] = sc0[k]; }); }
    renderColors(); replan(); commit();
  };
  $('colorOn').addEventListener('change', colorToggle('enabled', BASE_KEYS));
  $('accentOn').addEventListener('change', colorToggle('accentOn', ACCENT_KEYS));
  $('btnRandPalette').addEventListener('click', randomPalette);
  $('btnAddFont').addEventListener('click', () => {
    const name = $('localFont').value.trim(); if (!name) return;
    const key = 'local_' + name.replace(/\s+/g, '_');
    const weight = /bold|太|black|heavy|w[6-9]|[6-9]00/i.test(name) ? 700 : 400;
    J.addUserFont(key, name + '（PC）', name, weight);
    S.project.userFonts = (S.project.userFonts || []).filter(u => u.key !== key).concat([{ key, label: name + '（PC）', family: name, weight }]);
    S.project.fonts.display = key; $('localFont').value = '';
    fontKey = ''; renderFontRoles(); replan();
  });
  $('fontFile').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    try { const key = await J.loadFontFile(f); S.project.fonts.display = key; fontKey = ''; renderFontRoles(); replan(); }
    catch (err) { showMsg('フォントを読み込めませんでした'); setTimeout(() => showMsg(null), 2500); }
  });
  ['outAspect', 'eAspect'].forEach(id => $(id).addEventListener('change', e => { S.project.aspect = e.target.value; syncOut(); replan(); codecNote(); }));
  ['outRes', 'eRes'].forEach(id => $(id).addEventListener('change', e => { S.project.res = +e.target.value; syncOut(); autosave(); codecNote(); }));
  ['outFps', 'eFps'].forEach(id => $(id).addEventListener('change', e => { S.project.fps = +e.target.value; syncOut(); replan(); codecNote(); }));
  $('outQuality').addEventListener('change', e => { S.project.quality = e.target.value; autosave(); });
  ['outKey', 'eKey'].forEach(id => $(id).addEventListener('change', e => {
    S.project.keyBg = e.target.value; syncOut(); replan(); flushSave();
    const k = J.keyMode(S.project);
    toast(k ? `背景：${k === 'green' ? 'グリーンバック' : 'ブラックバック'}（白い文字と演出だけ）` : '背景：通常（スタイルの配色）');
  }));
  $('outAudio').addEventListener('change', e => { S.project.includeAudio = e.target.checked; autosave(); });
  $('btnMP4').addEventListener('click', () => runExport('mp4'));
  $('btnPNG').addEventListener('click', () => runExport('png'));
  $('btnPNGA').addEventListener('click', () => runExport('pnga'));
  document.querySelectorAll('.exp-cancel').forEach(b => b.addEventListener('click', () => { if (S.exporting) S.exporting.abort(); }));
  $('eMP4').addEventListener('click', () => runExport('mp4'));
  // かんたんモード
  $('modeEasy').addEventListener('click', () => setMode('easy'));
  $('modePro').addEventListener('click', () => setMode('pro'));
  $('btnOmakase').addEventListener('click', omakase);
  $('btnOmakaseBig').addEventListener('click', omakase);
  ['btnPrev', 'btnPrev2'].forEach(id => $(id).addEventListener('click', () => histGo(-1)));
  ['btnNext', 'btnNext2'].forEach(id => $(id).addEventListener('click', () => histGo(1)));
  $('eStyle').addEventListener('click', () => rerollPart('style'));
  $('eMood').addEventListener('click', () => rerollPart('mood'));
  $('eCut').addEventListener('click', () => rerollPart('cut'));
  $('ePalette').addEventListener('click', () => { randomPalette(); restartPreview(); });
  // 利用について（出力物の権利・ライセンス）
  const dlg = $('termsDlg');
  const openTerms = () => { if (dlg.showModal) { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', ''); };
  document.querySelectorAll('.terms-open').forEach(b => b.addEventListener('click', openTerms));
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close ? dlg.close() : dlg.removeAttribute('open'); });   // click on the backdrop
  $('btnSave').addEventListener('click', async () => {
    const b = $('btnSave'), old = b.textContent;
    b.disabled = true; b.textContent = '保存準備中…';
    try {
      const payload = await projectPayloadForSave();
      await J.saveFile(baseName() + '.jizura.json', JSON.stringify(payload, null, 1));
    } catch (err) {
      console.error(err);
      showMsg('プロジェクトを保存できませんでした: ' + (err && err.message ? err.message : err));
      setTimeout(() => showMsg(null), 3500);
    } finally {
      b.disabled = false; b.textContent = old;
    }
  });
  $('btnAE').addEventListener('click', () => J.saveFile(baseName() + '_ae.json', JSON.stringify(J.planForAE(S.plan, S.project), null, 1)));
  $('fileProject').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    try {
      $('audioName').textContent = 'プロジェクトを読み込み中…';
      await applyProjectData(JSON.parse(await f.text()));
      resetEditorHistory();
    }
    catch (err) { showMsg('プロジェクトを読み込めませんでした: ' + (err && err.message ? err.message : err)); setTimeout(() => showMsg(null), 3500); }
    e.target.value = '';
  });
  document.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && e.code === 'KeyZ') {
      e.preventDefault();
      e.shiftKey ? editorRedo() : editorUndo();
      return;
    }
    if (mod && !e.altKey && e.code === 'KeyY') {
      e.preventDefault();
      editorRedo();
      return;
    }
    const tag = (e.target && e.target.tagName) || '';
    const typing = /INPUT|TEXTAREA|SELECT/.test(tag) && e.target.type !== 'range' && e.target.type !== 'checkbox';
    if (S.tap && (e.code === 'Space' || e.code === 'Enter') && !typing) { e.preventDefault(); tapNow(); return; }
    if (S.tap && e.code === 'Escape') { pause(); stopTap(); return; }
    if (typing || $('termsDlg').open) return;
    if (e.code === 'Space') { e.preventDefault(); S.playing ? pause() : play(); }
    else if (e.code === 'ArrowRight') seek(S.t + (e.shiftKey ? 1 : 1 / S.plan.fps));
    else if (e.code === 'ArrowLeft') seek(S.t - (e.shiftKey ? 1 : 1 / S.plan.fps));
    else if (e.code === 'KeyR' && !e.metaKey && !e.ctrlKey && !e.altKey && !S.exporting) { e.preventDefault(); omakase(); }
  });
  $('lineList').addEventListener('scroll', () => { if (S.layoutMenu) closeLayoutMenu(); }, { passive: true });
  window.addEventListener('resize', () => { closeLayoutMenu(); sizeViewport(); drawTimeline(); });
  if (window.ResizeObserver) new ResizeObserver(() => { sizeViewport(); drawTimeline(); }).observe($('viewport'));
}

/* song file -> beat analysis (file input, or a host such as the After Effects panel) */
async function loadAudioFile(f) {
  $('audioName').textContent = '解析・保存中…';
  try {
    pause();
    await attachAudioFile(f, { persist: true, setSnap: true });
    syncUI(); replan();
    return true;
  } catch (err) {
    $('audioName').textContent = '読み込めませんでした: ' + err.message;
    S.audio = null; S.audioSource = null;
    return false;
  }
}

/* ---------------- boot ---------------- */
async function boot() {
  S.project = loadLocal();
  bind();
  syncUI();
  // Prefer the saved finished plan. Older projects without a snapshot are
  // generated once with the current planner, then immediately upgraded.
  const frozen = restorePlanSnapshot();
  if (!frozen) replan();
  if (S.project.audio && S.project.audio.id) {
    $('audioName').textContent = `${S.project.audio.name || '保存済みの曲'}（復元中…）`;
    await restoreProjectAudio();
    syncUI();
    if (frozen) {
      // Audio restore only affects playback/timeline waveform; keep the saved visual plan.
      drawTimeline(); updateTimeUI(); S.need = true;
    } else {
      // Old projects had no saved plan, so regenerate once with the restored audio,
      // then freeze that result for future opens.
      replan();
    }
  }
  let mode = 'easy'; try { mode = localStorage.getItem('jizura.mode') || 'easy'; } catch (e) {}
  setMode(mode); commit();
  resetEditorHistory();
  // open on a representative frame (end of the first cut's entrance)
  const c0 = S.plan.cuts.find(c => c.line >= 0);
  if (c0) seek(c0.start + Math.min(c0.dur * 0.6, c0.inDur + 0.25));
  requestAnimationFrame(tick);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { boot(); }); else boot();
J.ui = S;
// hooks for hosts that embed the app (the After Effects CEP panel)
J.uiApi = { toast, replan, syncUI, pause, seek, flushSave, loadAudioFile, restartPreview, restoreProjectAudio, projectPayloadForSave, applyProjectData, storePlanSnapshot, restorePlanSnapshot, planInputKey, editorUndo, editorRedo, resetEditorHistory };
})();
