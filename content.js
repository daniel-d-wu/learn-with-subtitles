// Lomb Input: content script (YouTube).
//
// - Works out each video's SPOKEN language (from YouTube's speech-recognition
//   track, which follows the audio) and tags everything with it. Any language.
// - Receives that language's subtitle file (captured by page_hook.js) and turns
//   it into cues. Translated tracks are never stored.
// - Draws its own subtitles over the video (spoken-language line + optional
//   translation line) and a transcript panel next to the video.
// - Logs exposure: which ranges of the video actually played (paused time,
//   seeks and ads excluded). Audio-only counts.
// - A global on/off switch (popup) stops everything: no overlay, no logging.
//
// Storage (chrome.storage.local), one key per record so tabs never overwrite each other:
//   x:<YYYY-MM-DD>:<exp_id>        exposure record (one viewing of one video)
//   t:youtube:<vid>:<lang>:<kind>  track record (full cue list, stored once per video)
//   settings                       on/off and display toggles

(() => {
  if (window.__lombContent) return;
  window.__lombContent = true;

  const EXT_VER = chrome.runtime.getManifest().version;
  const SCHEMA = 3;
  const TAG = '__lomb';
  const SAVE_EVERY_MS = 5000;
  const TICK_MS = 150;
  const MAX_ENABLE_TRIES = 12;

  // ---------- small helpers ----------
  const localDate = (d = new Date()) => d.toLocaleDateString('en-CA'); // YYYY-MM-DD
  const r3 = x => Math.round(x * 1000) / 1000;
  const base = c => String(c || '').split('-')[0].toLowerCase();
  const langName = code => {
    try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch (e) { return code; }
  };
  const fmtTime = s => {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0');
  };
  const sendPage = msg => window.postMessage(Object.assign({ __lombReq: true }, msg), '*');
  const currentVid = () => {
    if (location.pathname !== '/watch') return null;
    return new URLSearchParams(location.search).get('v');
  };
  const getPlayer = () => document.getElementById('movie_player');
  const getVideo = () => {
    const p = getPlayer();
    return (p && p.querySelector('video')) || document.querySelector('video.html5-main-video');
  };

  // ---------- settings ----------
  const settings = {
    enabled: true, overlay: true, sidebar: true, second: true, secondLang: 'en', autopause: false,
    hoverDict: true,      // hover a word in the overlay: pause + definition
    panelFloat: null,     // null = docked in YouTube's right column; {x, y, w, h} = floating
  };
  chrome.storage.local.get('settings').then(r => {
    Object.assign(settings, r.settings || {});
    applySettings();
  });
  const saveSettings = () => chrome.storage.local.set({ settings: { ...settings } });

  // React live to the popup's on/off switch (and other setting changes).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const wasOn = settings.enabled;
    Object.assign(settings, changes.settings.newValue || {});
    if (wasOn && !settings.enabled) startVideo(null);       // save, then switch everything off
    if (!wasOn && settings.enabled) S.vid = undefined;      // next tick starts fresh
    if (showsUi() && !S.track) S.enableTries = 0;           // UI turned back on: load the track
    applySettings();
  });

  // ---------- state ----------
  const S = {
    vid: null,
    exp: null,            // current exposure record
    cur: null,            // open watched range [start, end] (element of exp.ranges)
    lastVt: null, lastWall: null,
    audio: null,          // spoken language (base code, e.g. 'de'); null = unknown
    langStatus: '',       // '', 'ok', 'unknown_lang', 'no_tracks'
    chosen: null,         // { lang, kind } the player was asked to load
    pending: {},          // subtitle files that arrived before the language was known
    track: null,          // { lang, kind, name }
    cues: [],             // [{s, e, t}]
    second: [],           // translation cues, display only (never stored)
    seen: new Set(),      // indices of cues overlapped by a watched range
    curIdx: -1,
    apArm: -1, apDone: -1,
    enableTries: 0, nextEnable: 0,
    lastSave: 0,
    fetchId: 0,
    active: false,        // overlay + panel shown
    tab: 'transcript',    // sidebar tab: 'transcript' | 'saved'
    sel: null,            // sidebar selection: { text, words, cueIdx, title }
    selEl: null, selRes: null, selSeq: 0, selPaused: false,
    expr: null,           // per cue: expressions found [{ from, to, title }]
  };

  // ---------- parsing subtitle files ----------
  function parseJson3(obj, isAsr) {
    const cues = [];
    for (const ev of obj.events || []) {
      if (!ev.segs) continue;
      const t = ev.segs.map(x => x.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      const s = (ev.tStartMs || 0) / 1000;
      cues.push({ s, e: s + (ev.dDurationMs || 0) / 1000, t });
    }
    return finish(cues, isAsr);
  }

  function parseXml(text, isAsr) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const cues = [];
    for (const p of doc.querySelectorAll('p')) {              // srv3: <p t="ms" d="ms">
      const t = (p.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      const s = Number(p.getAttribute('t') || 0) / 1000;
      cues.push({ s, e: s + Number(p.getAttribute('d') || 0) / 1000, t });
    }
    if (!cues.length) {
      for (const n of doc.querySelectorAll('text')) {         // format 1: <text start dur>
        const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t) continue;
        const s = Number(n.getAttribute('start') || 0);
        cues.push({ s, e: s + Number(n.getAttribute('dur') || 0), t });
      }
    }
    return finish(cues, isAsr);
  }

  function parseVtt(text, isAsr) {
    const toS = x => {
      const p = x.trim().split(':').map(Number);
      return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
    };
    const cues = [];
    for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
      const lines = block.split('\n');
      const i = lines.findIndex(l => l.includes('-->'));
      if (i < 0) continue;
      const [a, b] = lines[i].split('-->');
      const t = lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (t) cues.push({ s: toS(a), e: toS(b.trim().split(/\s/)[0]), t });
    }
    return finish(cues, isAsr);
  }

  function finish(cues, isAsr) {
    cues.sort((a, b) => a.s - b.s);
    const out = [];
    for (const c of cues) {
      const prev = out[out.length - 1];
      if (prev && prev.t === c.t && Math.abs(prev.s - c.s) < 0.05) continue;
      out.push(c);
    }
    // Speech-recognition lines stay on screen while the next scrolls in;
    // end each one when the next starts so only one line shows at a time.
    if (isAsr) for (let i = 0; i < out.length - 1; i++) {
      if (out[i + 1].s > out[i].s) out[i].e = Math.min(out[i].e, out[i + 1].s);
    }
    for (const c of out) if (c.e <= c.s) c.e = c.s + 2;
    return out;
  }

  function parseAny(body, isAsr) {
    const b = (body || '').trimStart();
    try {
      if (b.startsWith('{')) return parseJson3(JSON.parse(b), isAsr);
      if (b.startsWith('<')) return parseXml(b, isAsr);
      if (b.startsWith('WEBVTT')) return parseVtt(b, isAsr);
    } catch (e) {}
    return [];
  }

  // ---------- messages from the page ----------
  window.addEventListener('message', e => {
    if (e.source !== window || !e.data || !e.data[TAG]) return;
    if (!settings.enabled) return;
    const d = e.data;
    if (d.type === 'timedtext' || d.type === 'fetched') onTimedText(d.url, d.body);
    if (d.type === 'tracks' && d.vid === S.vid) onTracks(d);
  });

  function onTracks(d) {
    if (d.status === 'ok') {
      S.langStatus = 'ok';
      S.audio = d.spoken;
      S.chosen = d.chosen;
      if (S.exp) { S.exp.audio_lang = d.spoken; S.exp.audio_lang_source = 'asr'; }
      // Files that arrived before the language was known.
      const waiting = S.pending; S.pending = {};
      for (const k of Object.keys(waiting)) onTimedText(waiting[k].url, waiting[k].body);
    } else if (d.status === 'unknown_lang' || d.status === 'no_tracks') {
      // No speech-recognition track (yet). The player often hasn't loaded its caption
      // list when the page opens, so keep asking until MAX_ENABLE_TRIES; only then is
      // the language treated as unknown (watch time still logged, audio_lang = null).
      if (S.langStatus !== 'ok') S.langStatus = d.status;
      S.lastTracks = d.tracks || [];
    }
    renderPanelHeader();
  }

  function onTimedText(url, body) {
    let u;
    try { u = new URL(url); } catch (e) { return; }
    const q = u.searchParams;
    const vid = q.get('v');
    const lang = q.get('lang') || '';
    const tlang = q.get('tlang');
    const kind = q.get('kind') === 'asr' ? 'asr' : 'manual';
    if (!vid || vid !== S.vid || !body) return;

    if (!S.audio) {                         // language not known yet: keep for later
      if (!tlang) S.pending[lang + '|' + kind] = { url, body };
      return;
    }
    // Translation of the spoken-language track: second line only, never stored.
    if (tlang) {
      if (tlang === settings.secondLang && base(lang) === S.audio) {
        const cues = parseAny(body, kind === 'asr');
        if (cues.length) S.second = cues;
      }
      return;
    }
    if (base(lang) !== S.audio) return;     // other-language subtitles = translations

    const cues = parseAny(body, kind === 'asr');
    if (!cues.length) {
      if (q.get('fmt') !== 'json3') {       // unknown format: ask for json3
        q.set('fmt', 'json3');
        sendPage({ type: 'fetch', id: ++S.fetchId, url: u.href });
      }
      return;
    }
    if (S.track && S.track.kind === 'manual' && kind === 'asr') return;   // keep creator-uploaded
    if (S.track && S.track.kind === kind && S.track.lang === lang && S.cues.length === cues.length) return;

    S.track = { lang, kind, name: q.get('name') || '' };
    S.trackUrl = u.href;
    S.cues = cues;
    S.seen = new Set();
    S.curIdx = -1;
    if (S.exp) {
      S.exp.text_source = 'live_track';
      S.exp.track_lang = lang;
      S.exp.track_kind = kind;
      for (const r of S.exp.ranges) markRange(r[0], r[1]);
    }
    saveTrack(vid, S.track, cues);
    setActive(true);
    renderPanelList();
    markExpressions();
    requestSecond(u);
  }

  function requestSecond(u) {
    if (!settings.second || S.second.length || !S.audio || base(settings.secondLang) === S.audio) return;
    const t = new URL(u.href);
    t.searchParams.set('tlang', settings.secondLang);
    t.searchParams.set('fmt', 'json3');
    sendPage({ type: 'fetch', id: ++S.fetchId, url: t.href });
  }

  function saveTrack(vid, track, cues) {
    const key = `t:youtube:${vid}:${track.lang}:${track.kind}`;
    chrome.storage.local.set({
      [key]: {
        schema: SCHEMA, rec: 'track', content_id: 'youtube:' + vid, site: 'youtube', vid,
        audio_lang: S.audio, lang: track.lang, kind: track.kind, name: track.name,
        source: 'player_capture', fetched_at: new Date().toISOString(), n_cues: cues.length,
        cues: cues.map(c => [r3(c.s), r3(c.e), c.t]),
      },
    });
  }

  // ---------- exposure ----------
  function newExposure(vid) {
    return {
      schema: SCHEMA, rec: 'exposure', exp_id: crypto.randomUUID(),
      capture: 'live', device: 'desktop_chrome', site: 'youtube', vid,
      content_id: 'youtube:' + vid, title: '', channel: '', url: location.href,
      watched_on: localDate(), t_start: new Date().toISOString(), t_end: null,
      play_s: 0, muted_s: 0, minutes: 0, ranges: [], dur: null,
      audio_lang: null, audio_lang_source: null,
      text_source: 'none', track_lang: null, track_kind: null, ext_ver: EXT_VER,
    };
  }

  function mergeRanges(ranges) {
    const rs = ranges.map(r => [r[0], r[1]]).filter(r => r[1] >= r[0]).sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const r of rs) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
      else out.push(r);
    }
    return out.map(r => [r3(r[0]), r3(r[1])]);
  }

  function readMeta() {
    const e = S.exp;
    if (!e) return;
    const h1 = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string');
    const title = (h1 && h1.textContent.trim()) ||
      document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '').trim();
    if (title && e.play_s > 3) e.title = title;
    const ch = document.querySelector('ytd-watch-metadata #channel-name a, #owner #channel-name a, ytd-channel-name a');
    if (ch && e.play_s > 3) e.channel = ch.textContent.trim();
    const v = getVideo();
    if (v && isFinite(v.duration) && v.duration > 0 && !getPlayer()?.classList.contains('ad-showing')) e.dur = r3(v.duration);
  }

  function saveExposure(force) {
    const e = S.exp;
    if (!e || e.play_s < 1) return;            // ignore page loads that never played
    if (!force && Date.now() - S.lastSave < SAVE_EVERY_MS) return;
    S.lastSave = Date.now();
    readMeta();
    e.t_end = new Date().toISOString();
    e.minutes = r3(e.play_s / 60);
    const rec = Object.assign({}, e, { ranges: mergeRanges(e.ranges), play_s: r3(e.play_s), muted_s: r3(e.muted_s) });
    chrome.storage.local.set({ [`x:${e.watched_on}:${e.exp_id}`]: rec }).catch(() => {});
  }

  function startVideo(vid) {
    saveExposure(true);
    S.vid = vid;
    S.exp = vid ? newExposure(vid) : null;
    S.cur = null; S.lastVt = null; S.lastWall = null;
    S.audio = null; S.langStatus = ''; S.lastTracks = []; S.chosen = null; S.pending = {};
    S.track = null; S.trackUrl = null; S.cues = []; S.second = []; S.seen = new Set();
    S.sel = null; S.selEl = null; S.selRes = null; S.selSeq++; S.selPaused = false; S.expr = null; S.exprList = null; S.slang = null;
    S.curIdx = -1; S.apArm = -1; S.apDone = -1; S.enableTries = 0; S.nextEnable = 0;
    setActive(false);
  }

  // Extend the watched range while the video plays normally; start a new one after a jump.
  function trackPlayback(v) {
    const p = getPlayer();
    const ad = p && p.classList.contains('ad-showing');
    if (!S.exp || !v || v.paused || v.seeking || v.ended || ad || v.readyState < 2) {
      S.cur = null; S.lastVt = null;
      return;
    }
    const t = v.currentTime, now = performance.now();
    if (S.lastVt != null) {
      const dv = t - S.lastVt, dw = (now - S.lastWall) / 1000;
      if (dv >= 0 && dv <= dw * (v.playbackRate || 1) * 1.5 + 0.5) {
        if (!S.cur) { S.cur = [S.lastVt, t]; S.exp.ranges.push(S.cur); }
        const from = S.cur[1];
        S.cur[1] = t;
        S.exp.play_s += dw;
        if (v.muted || v.volume === 0) S.exp.muted_s += dw;
        markRange(from, t);
      } else {
        S.cur = null;                           // jump (seek / skip): close the range
      }
    }
    S.lastVt = t; S.lastWall = now;
  }

  // A cue counts as seen if any part of it falls inside a watched range.
  function markRange(a, b) {
    const cues = S.cues;
    if (!cues.length) return;
    let lo = 0, hi = cues.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cues[m].s < a - 30) lo = m + 1; else hi = m; }
    let changed = false;
    for (let i = lo; i < cues.length && cues[i].s <= b; i++) {
      if (cues[i].e >= a && !S.seen.has(i)) { S.seen.add(i); changed = true; markRow(i); }
    }
    if (changed) renderPanelHeader();
  }

  // ---------- cue lookup ----------
  function cueAt(list, t) {
    let lo = 0, hi = list.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (list[m].s <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans >= 0 && t < list[ans].e ? ans : -1;
  }
  function lastStartedAt(t) {
    let lo = 0, hi = S.cues.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (S.cues[m].s <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  }

  // ---------- UI on / off ----------
  let overlay, ovMain, ovSecond, panel, panelHead, panelList, panelSel, panelSaved, panelRows = [];

  function setActive(v) {
    S.active = v;
    document.documentElement.classList.toggle('lomb-active', v);
    if (!v) {
      closeHover();
      if (overlay) overlay.remove();
      overlay = null;
      removePanel();
    }
  }

  // ---------- UI: overlay ----------
  // The spoken-language line is split into word spans so each word can be hovered.
  const WORD_RE = /[\p{L}\p{M}][\p{L}\p{M}'’\-]*/gu;
  let ovText = null;

  function ensureOverlay() {
    const p = getPlayer();
    if (!p) return;
    if (overlay && overlay.isConnected && overlay.parentElement === p) return;
    overlay = document.createElement('div');
    overlay.className = 'lomb-ov';
    ovMain = document.createElement('div'); ovMain.className = 'lomb-ov-main';
    ovSecond = document.createElement('div'); ovSecond.className = 'lomb-ov-second';
    overlay.append(ovMain, ovSecond);
    p.appendChild(overlay);
    ovText = null;
    hookHover(overlay);
  }

  // exprs: expressions found in this line ([{ from, to, title }] word indexes), highlighted too.
  function renderMain(text, exprs, key) {
    ovText = key;
    ovMain.textContent = '';
    let last = 0, wi = 0, host = ovMain, ex = null;
    for (const m of text.matchAll(WORD_RE)) {
      const startEx = (exprs || []).find(x => x.from === wi);
      if (m.index > last) (startEx ? ovMain : host).append(text.slice(last, m.index));
      if (startEx) {
        ex = startEx;
        host = document.createElement('span');
        host.className = 'lomb-ex-ov';
        host.dataset.title = ex.title;
        ovMain.append(host);
      }
      const w = document.createElement('span');
      w.className = 'lomb-w';
      w.textContent = m[0];
      host.append(w);
      last = m.index + m[0].length;
      if (ex && wi === ex.to) { host = ovMain; ex = null; }
      wi++;
    }
    if (last < text.length) ovMain.append(text.slice(last));
  }

  function setOverlay(main, second, cueIdx) {
    if (!overlay) return;
    if (hover.open) return;                   // keep the line steady while a definition is open
    const exprs = cueIdx >= 0 && S.expr ? S.expr[cueIdx] : null;
    const key = main + '|' + (exprs ? exprs.length : 0);
    if (ovText !== key) renderMain(main, exprs, key);
    const sec = settings.second ? second : '';
    if (ovSecond.textContent !== sec) ovSecond.textContent = sec;
    overlay.classList.toggle('lomb-empty', !main && !sec);
  }

  // ---------- hover dictionary ----------
  // Hover a word: the video pauses and an English definition appears (English Wiktionary).
  // Leaving the subtitles closes it and resumes playback if the hover paused it.
  const hover = { open: false, timer: 0, span: null, pausedByUs: false, tip: null, seq: 0 };
  const dictCache = new Map();

  function hookHover(ov) {
    ov.addEventListener('mouseover', e => {
      const w = e.target.closest('.lomb-ex-ov') || e.target.closest('.lomb-w');
      if (!w || !settings.hoverDict || w === hover.span) return;
      clearTimeout(hover.timer);
      hover.timer = setTimeout(() => openWord(w), 120);
    });
    ov.addEventListener('mouseout', e => {
      if (e.target.closest('.lomb-w') || e.target.closest('.lomb-ex-ov')) clearTimeout(hover.timer);
      if (!ov.contains(e.relatedTarget)) closeHover();
    });
  }

  function openWord(span) {
    if (!overlay || !span.isConnected) return;
    const v = getVideo();
    if (v && !v.paused) { v.pause(); hover.pausedByUs = true; }
    if (hover.span) hover.span.classList.remove('on');
    hover.span = span;
    hover.open = true;
    span.classList.add('on');
    if (!hover.tip) {
      hover.tip = document.createElement('div');
      hover.tip.className = 'lomb-tip';
      hover.tip.addEventListener('click', e => {
        const b = e.target.closest('[data-save]');
        if (b && hover.save) { saveItem(hover.save); markSaved(b); }
      });
      overlay.appendChild(hover.tip);
    }
    const isExpr = span.classList.contains('lomb-ex-ov');
    const shown = span.textContent.replace(/^[-'’]+|[-'’]+$/g, '');
    const word = isExpr ? span.dataset.title : shown;
    const seq = ++hover.seq;
    hover.tip.innerHTML = `<div class="lomb-tip-word">${esc(word)}</div><div class="lomb-tip-muted">Looking up…</div>`;
    placeTip(span);
    (isExpr ? lookupExpr(word) : lookup(word, S.audio)).then(res => {
      if (seq !== hover.seq || !hover.tip) return;
      hover.tip.innerHTML = (isExpr && word.toLowerCase() !== shown.toLowerCase()
        ? `<div class="lomb-tip-form">Expression: “${esc(shown)}”</div>` : '') + renderDefinition(word, res, true);
      placeTip(span);
      const v = getVideo();
      const ci = v ? cueAt(S.cues, v.currentTime) : -1;
      hover.save = { text: shown, words: tokenizeRaw(shown), res, cueIdx: ci >= 0 ? ci : null, source: 'overlay' };
      logLookup(word, res, ci >= 0 ? ci : null, 'overlay');
    });
  }

  function placeTip(span) {
    if (!hover.tip || !overlay) return;
    const o = overlay.getBoundingClientRect(), r = span.getBoundingClientRect();
    const tw = hover.tip.offsetWidth;
    let left = r.left - o.left + r.width / 2 - tw / 2;
    left = Math.max(-o.left + 8, Math.min(left, window.innerWidth - o.left - tw - 8));
    hover.tip.style.left = left + 'px';
    hover.tip.style.bottom = (o.bottom - r.top + 8) + 'px';
  }

  function closeHover() {
    clearTimeout(hover.timer);
    if (!hover.open) return;
    hover.open = false;
    hover.seq++;
    if (hover.span) hover.span.classList.remove('on');
    hover.span = null;
    if (hover.tip) { hover.tip.remove(); hover.tip = null; }
    if (hover.pausedByUs) {
      hover.pausedByUs = false;
      const v = getVideo();
      if (v && v.paused) v.play().catch(() => {});
    }
  }

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const wikt = (kind, term) => new Promise(res => {
    try { chrome.runtime.sendMessage({ type: 'wikt', kind, term }, r => res(r || { status: 0, body: '' })); }
    catch (e) { res({ status: 0, body: '' }); }
  });
  const htmlText = h => {
    const d = new DOMParser().parseFromString(`<div>${h || ''}</div>`, 'text/html');
    return (d.body.textContent || '').replace(/\s+/g, ' ').trim();
  };
  const FORM_OF = /\b(inflection|form|plural|singular|participle|preterite|past tense|present tense|imperative|comparative|superlative|genitive|dative|accusative|nominative|diminutive|feminine|masculine|neuter|alternative spelling|alternative form|obsolete spelling|contraction) of\b/i;

  // Look a word up in the given language. Tries the word as written, lowercase and
  // capitalized (German nouns). Inflected forms also fetch their dictionary form.
  async function lookup(word, lang) {
    const key = lang + '|' + word;
    if (dictCache.has(key)) return dictCache.get(key);
    const tries = [...new Set([word, word.toLowerCase(), word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()])];
    let res = { found: false, term: word, groups: [], lemma: null, lemmaGroups: [] };
    for (const t of tries) {
      const groups = await definitions(t, lang);
      if (groups.length) { res = { found: true, term: t, groups, lemma: null, lemmaGroups: [] }; break; }
    }
    // "kommt" = "third-person singular present of kommen": also show "kommen".
    if (res.found) {
      const defs = res.groups.flatMap(g => g.defs);
      const formOf = defs.length && defs.every(d => FORM_OF.test(d.text) && d.link);
      if (formOf) {
        const lemma = defs[0].link;
        if (lemma && lemma !== res.term) {
          res.lemma = lemma;
          res.lemmaGroups = (await definitions(lemma, lang)).filter(g => g.defs.some(d => !FORM_OF.test(d.text)));
        }
      }
    }
    dictCache.set(key, res);
    return res;
  }

  // -> [{ pos, defs: [{ text, link }] }]
  async function definitions(term, lang) {
    const r = await wikt('def', term);
    if (r.status === 200) {
      try {
        const j = JSON.parse(r.body);
        const groups = (j[lang] || []).map(g => ({
          pos: g.partOfSpeech || '',
          defs: (g.definitions || []).filter(d => d.definition).map(d => ({ text: htmlText(d.definition), link: firstLink(d.definition) })),
        })).filter(g => g.defs.length);
        if (groups.length || r.status === 200) return groups;
      } catch (e) {}
    }
    if (r.status === 404) return [];
    // Fallback: read the language's section from the full page HTML.
    const h = await wikt('html', term);
    if (h.status !== 200) return [];
    return parsePageHtml(h.body, langName(lang));
  }

  function firstLink(html) {
    const d = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
    const a = d.querySelector('a[title]');
    return a ? a.getAttribute('title').replace(/#.*$/, '') : null;
  }

  function parsePageHtml(html, languageName) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const h2 = [...doc.querySelectorAll('h2')].find(h => (h.id || h.textContent).trim().replace(/_/g, ' ') === languageName);
    if (!h2) return [];
    const section = h2.closest('section') || h2.parentElement;
    const groups = [];
    let pos = '';
    const walker = doc.createTreeWalker(section, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.currentNode; n; n = walker.nextNode()) {
      if (/^H[3-5]$/.test(n.tagName)) pos = n.textContent.trim();
      if (n.tagName === 'OL' && !n.parentElement.closest('ol')) {
        const defs = [...n.children].filter(li => li.tagName === 'LI').map(li => {
          const clone = li.cloneNode(true);
          clone.querySelectorAll('ul, ol, dl, .HQToggle, .nyms').forEach(x => x.remove());
          const a = clone.querySelector('a[title]');
          return { text: clone.textContent.replace(/\s+/g, ' ').trim(), link: a ? a.getAttribute('title').replace(/#.*$/, '') : null };
        }).filter(d => d.text);
        if (defs.length) groups.push({ pos, defs });
      }
    }
    return groups;
  }

  function renderDefinition(word, res, withSave) {
    const list = groups => groups.slice(0, 2).map(g =>
      `<div class="lomb-tip-pos">${esc(g.pos)}</div><ol>` +
      g.defs.slice(0, 3).map(d => `<li>${esc(d.text)}</li>`).join('') + `</ol>`).join('');
    const saveBtn = withSave ? `<button class="lomb-save" data-save>☆ Save</button>` : '';
    if (!res.found) {
      return `<div class="lomb-tip-word">${esc(word)}</div><div class="lomb-tip-muted">No entry found in Wiktionary.</div>` + saveBtn;
    }
    let out = `<div class="lomb-tip-word">${esc(res.term)}</div>`;
    if (res.lemma && res.lemmaGroups.length) {
      out += `<div class="lomb-tip-form">${esc(res.groups[0].defs[0].text)}</div>` +
             `<div class="lomb-tip-word lomb-tip-lemma">${esc(res.lemma)}</div>` + list(res.lemmaGroups);
    } else {
      out += list(res.groups);
    }
    const page = encodeURIComponent(res.lemma && res.lemmaGroups.length ? res.lemma : res.term);
    out += `<div class="lomb-tip-foot">${saveBtn}<a class="lomb-tip-src" href="https://en.wiktionary.org/wiki/${page}#${encodeURIComponent(langName(S.audio).replace(/ /g, '_'))}" target="_blank" rel="noopener">Wiktionary</a></div>`;
    return out;
  }

  // Each lookup is logged: looked-up words are a signal of unknown words.
  function logLookup(word, res, cueIdx, source) {
    if (!S.exp) return;
    const v = getVideo();
    const vt = v ? r3(v.currentTime) : null;
    const i = cueIdx != null ? cueIdx : -1;
    const id = crypto.randomUUID();
    chrome.storage.local.set({
      [`l:${localDate()}:${id}`]: {
        schema: SCHEMA, rec: 'lookup', lookup_id: id, t: new Date().toISOString(), watched_on: localDate(),
        exp_id: S.exp.exp_id, content_id: S.exp.content_id, site: 'youtube', vid: S.vid,
        audio_lang: S.audio, word, entry: res.found ? res.term : null, lemma: res.lemma || null,
        found: !!res.found, phrase: !!res.phrase, source: source || 'overlay',
        vt, cue_idx: i >= 0 ? i : null, cue_text: i >= 0 && S.cues[i] ? S.cues[i].t : null,
      },
    }).catch(() => {});
  }

  // ---------- expressions (idioms) ----------
  // Wiktionary's idiom list for the video's language (e.g. "Category:German idioms") is
  // downloaded once a month and matched against each subtitle line. Matching uses the
  // fixed part of each idiom: placeholders (jemandem, etwas, sich…) are ignored, the
  // final verb only has to appear in some form (gehen -> geht), e.g.
  // "jemandem auf den Keks gehen" matches "Das geht mir auf den Keks."
  const PLACEHOLDER = /^(jemand|jemandem|jemanden|jemandes|jmdm?|jmdn|jmds|etwas|etw|sich|someone|something|one's|oneself|someone's)$/i;
  const IDIOM_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
  const idiomIndex = new Map();   // lang -> Map(firstCoreToken -> [idiom])
  const idiomLoading = new Map(); // lang -> Promise

  const clean = w => w.replace(/^[-'’]+|[-'’]+$/g, '');
  const tokenize = text => [...text.matchAll(WORD_RE)].map(m => m[0].toLowerCase().replace(/^[-'’]+|[-'’]+$/g, ''));

  // German strong / irregular verbs: stems that appear in their conjugated forms
  // (present, past, participle), so "verstanden" matches "verstehen" and "gab" matches "geben".
  const DE_STRONG = {
    gehen: ['geh', 'ging', 'gang'], stehen: ['steh', 'stand', 'stünd', 'ständ'], kommen: ['komm', 'kam', 'käm'],
    geben: ['geb', 'gib', 'gab', 'gäb'], nehmen: ['nehm', 'nimm', 'nahm', 'nomm', 'nähm'], sehen: ['seh', 'sieh', 'sah', 'säh'],
    haben: ['hab', 'hat', 'hätt'], sein: ['bin', 'bist', 'ist', 'sind', 'seid', 'war', 'wär', 'gewesen', 'sei'],
    werden: ['werd', 'wird', 'wirst', 'wurd', 'würd', 'geworden'], tun: ['tu', 'tat', 'tät'], lassen: ['lass', 'läss', 'ließ', 'lies'],
    fallen: ['fall', 'fäll', 'fiel'], halten: ['halt', 'hält', 'hielt'], ziehen: ['zieh', 'zog', 'zög'], bringen: ['bring', 'bracht', 'brächt'],
    denken: ['denk', 'dacht', 'dächt'], wissen: ['wiss', 'weiß', 'weis', 'wusst', 'wüsst'], werfen: ['werf', 'wirf', 'warf', 'worf', 'würf'],
    treffen: ['treff', 'triff', 'traf', 'träf', 'troff'], schlagen: ['schlag', 'schläg', 'schlug', 'schlüg'], tragen: ['trag', 'träg', 'trug', 'trüg'],
    liegen: ['lieg', 'lag', 'läg'], sitzen: ['sitz', 'saß', 'säß', 'sess'], finden: ['find', 'fand', 'fänd', 'fund'], binden: ['bind', 'band', 'bund'],
    springen: ['spring', 'sprang', 'sprung'], trinken: ['trink', 'trank', 'trunk'], sprechen: ['sprech', 'sprich', 'sprach', 'sproch'],
    brechen: ['brech', 'brich', 'brach', 'broch'], laufen: ['lauf', 'läuf', 'lief'], schießen: ['schieß', 'schoss', 'schöss'],
    fliegen: ['flieg', 'flog', 'flög'], reißen: ['reiß', 'riss'], beißen: ['beiß', 'biss'], greifen: ['greif', 'griff'],
    schneiden: ['schneid', 'schnitt'], steigen: ['steig', 'stieg'], bleiben: ['bleib', 'blieb'], schreiben: ['schreib', 'schrieb'],
    treiben: ['treib', 'trieb'], scheinen: ['schein', 'schien'], weisen: ['weis', 'wies'], fahren: ['fahr', 'fähr', 'fuhr', 'führ'],
    essen: ['ess', 'iss', 'aß', 'äß', 'gegessen'], fressen: ['fress', 'friss', 'fraß'], vergessen: ['vergess', 'vergiss', 'vergaß'],
    sterben: ['sterb', 'stirb', 'starb', 'storb'], helfen: ['helf', 'hilf', 'half', 'holf'], werben: ['werb', 'wirb', 'warb', 'worb'],
    stechen: ['stech', 'stich', 'stach', 'stoch'], schwimmen: ['schwimm', 'schwamm', 'schwomm'], singen: ['sing', 'sang', 'sung'],
    sinken: ['sink', 'sank', 'sunk'], stinken: ['stink', 'stank', 'stunk'], ringen: ['ring', 'rang', 'rung'], gewinnen: ['gewinn', 'gewann', 'gewonn'],
    beginnen: ['beginn', 'begann', 'begonn'], schließen: ['schließ', 'schloss', 'schlöss'], gießen: ['gieß', 'goss'], fließen: ['fließ', 'floss'],
    rufen: ['ruf', 'rief'], schlafen: ['schlaf', 'schläf', 'schlief'], braten: ['brat', 'brät', 'briet'], raten: ['rat', 'rät', 'riet'],
    stoßen: ['stoß', 'stöß', 'stieß'], hängen: ['häng', 'hing', 'hang'], heben: ['heb', 'hob', 'höb'], lügen: ['lüg', 'log', 'lög'],
    bitten: ['bitt', 'bat', 'bät', 'beten'], gelten: ['gelt', 'gilt', 'galt', 'golt'], laden: ['lad', 'läd', 'lud'],
    mögen: ['mag', 'mög', 'mocht', 'möcht'], können: ['kann', 'könn', 'konnt'], müssen: ['muss', 'müss', 'musst'], wollen: ['will', 'woll', 'wollt'],
    dürfen: ['darf', 'dürf', 'durft'], sollen: ['soll', 'sollt'], kennen: ['kenn', 'kannt'], nennen: ['nenn', 'nannt'], rennen: ['renn', 'rannt'],
    brennen: ['brenn', 'brannt'], senden: ['send', 'sandt'], wenden: ['wend', 'wandt'], schieben: ['schieb', 'schob', 'schöb'],
    frieren: ['frier', 'fror'], verlieren: ['verlier', 'verlor'], wiegen: ['wieg', 'wog'], biegen: ['bieg', 'bog'], lesen: ['les', 'lies', 'las', 'läs'],
    messen: ['mess', 'miss', 'maß'], streiten: ['streit', 'stritt'], leiden: ['leid', 'litt'], reiten: ['reit', 'ritt'], gleiten: ['gleit', 'glitt'],
  };
  const DE_PREFIXES = ['zurück', 'zusammen', 'weiter', 'heraus', 'herein', 'hinaus', 'vorbei', 'nieder', 'entgegen',
    'durch', 'unter', 'wider', 'über', 'fest', 'fort', 'hin', 'her', 'los', 'mit', 'nach', 'vor', 'weg', 'auf', 'aus', 'bei', 'ein',
    'ver', 'zer', 'ent', 'emp', 'miss', 'ab', 'an', 'be', 'er', 'ge', 'zu', 'um'];

  // Stems whose presence (anywhere in a word) counts as the idiom's verb being used.
  function verbStems(verb, lang) {
    const own = verb.replace(/(en|n)$/, '');
    const stems = new Set(own.length >= 3 ? [own] : []);
    if (lang === 'de') {
      let root = DE_STRONG[verb] ? verb : null;
      if (!root) for (const p of DE_PREFIXES) {
        const r = verb.slice(p.length);
        if (verb.startsWith(p) && r.length >= 3 && DE_STRONG[r]) { root = r; break; }
      }
      if (root) DE_STRONG[root].forEach(x => x.length >= 3 && stems.add(x));
      else {                                                   // regular verb with a prefix: its root stem
        for (const p of DE_PREFIXES) {
          const r = verb.slice(p.length).replace(/(en|n)$/, '');
          if (verb.startsWith(p) && r.length >= 3) { stems.add(r); break; }
        }
      }
    }
    return [...stems];
  }

  function compileIdiom(title, lang) {
    const toks = title.split(/\s+/).map(t => t.replace(/[.,;:!?„“"()]/g, '')).filter(Boolean);
    if (toks.length < 2) return null;
    let verb = null;
    const last = toks[toks.length - 1];
    // A final lower-case infinitive (≥4 letters) is the verb, matched in any conjugated form.
    if (/^[a-zäöüß]{2,}(en|ern|eln|n)$/.test(last)) verb = last.toLowerCase();
    const rest = verb ? toks.slice(0, -1) : toks;
    // longest run of fixed (non-placeholder) tokens
    let best = [], cur = [], bestEnd = -1;
    rest.forEach((t, i) => {
      if (PLACEHOLDER.test(t)) { cur = []; return; }
      cur.push(t.toLowerCase());
      if (cur.length > best.length) { best = cur.slice(); bestEnd = i; }
    });
    if (!best.length) return null;
    if (best.length === 1) {
      // One fixed word + a verb ("bei jemandem sein", "was wenn") matched almost any line.
      // Allow it only for a long word plus a real infinitive ("Gas geben"); otherwise the
      // verb must sit right after the word and is matched literally ("zu haben").
      const noun = /^[A-ZÄÖÜ]/.test(rest[bestEnd]);           // "Gas geben", "Schwein haben"
      const strong = verb && (best[0].length >= 4 || (noun && best[0].length >= 3)) &&
        ((verb.length >= 5 && /(en|ern|eln)$/.test(verb)) || (lang === 'de' && DE_STRONG[verb]));
      if (!strong) {
        if (!verb || bestEnd !== rest.length - 1) return null;
        return { title, core: [best[0], verb], stems: [], needVerb: false };
      }
    }
    const stems = verb ? verbStems(verb, lang) : [];
    return { title, core: best, stems, needVerb: best.length < 3 && stems.length > 0 };
  }

  // Wiktionary lists merged into one expression list per language (deduplicated):
  // "<Language> multiword terms" (≈3,500 for German), plus its "idioms" and "phrases" sub-lists.
  // Wiktionary lists for the video's language, merged (an entry can be in several):
  //   multiword terms (≈3,500 German), idioms, phrases  -> expressions (orange underline)
  //   colloquialisms (≈4,200), slang (≈540), vulgarities -> multi-word ones are expressions too;
  //                                                         single words get a dotted underline
  const EXPR_CATEGORIES = L => [
    { cat: `${L} multiword terms`, tag: 'phrase' }, { cat: `${L} idioms`, tag: 'idiom' },
    { cat: `${L} phrases`, tag: 'phrase' }, { cat: `${L} colloquialisms`, tag: 'colloquial' },
    { cat: `${L} slang`, tag: 'slang' }, { cat: `${L} vulgarities`, tag: 'vulgar' },
  ];
  const EXPR_CACHE_VER = 4;          // 4: German list ships with the extension (lists/de.json)
  const BUNDLED_LISTS = new Set(['de']);
  const EXPR_RETRY_MS = 10 * 60 * 1000;       // after a failed download, try again in 10 minutes
  const SLANG_TAGS = new Set(['colloquial', 'slang', 'vulgar']);
  const COMMON_WORDS = new Set(('der die das den dem des und ist ich du er sie es wir ihr nicht ein eine so was wie aber auch ' +
    'dann noch mal ja nein da hier mit auf in zu von für hat habe war sind man doch nur schon gut mehr jetzt immer kann muss ' +
    'will wenn weil also oder als bei nach um aus the and you').split(' '));

  async function fetchCategory(cat) {
    const titles = [];
    let cont = '';
    for (let page = 0; page < 30; page++) {           // up to 15,000 entries per list
      let r = await wikt('cat', cat + '|' + cont);
      if (r.status !== 200) { await new Promise(res => setTimeout(res, 1500)); r = await wikt('cat', cat + '|' + cont); }
      if (r.status !== 200) return { titles, ok: false, status: r.status };
      let j; try { j = JSON.parse(r.body); } catch (e) { return { titles, ok: false, status: 'bad json' }; }
      for (const m of (j.query && j.query.categorymembers) || []) titles.push(m.title);
      cont = j.continue && j.continue.cmcontinue;
      if (!cont) break;
    }
    return { titles, ok: true };
  }

  async function loadIdioms(lang) {
    if (!lang) return null;
    const have = idiomIndex.get(lang);
    if (have && !(have.error && Date.now() - have.failedAt > EXPR_RETRY_MS)) return have;
    if (idiomLoading.has(lang)) return idiomLoading.get(lang);
    const p = (async () => {
      const key = 'idx:' + lang;
      let cached = null, bundled = false;
      if (BUNDLED_LISTS.has(lang)) {               // shipped with the extension: no download, never partial
        const r = await new Promise(res => chrome.runtime.sendMessage({ type: 'bundled', lang }, x => res(x || {})));
        try { if (r.status === 200) cached = JSON.parse(r.body); } catch (e) { cached = null; }
        if (cached && cached.entries) {
          cached.v = EXPR_CACHE_VER; cached.failed = []; bundled = true;
          chrome.storage.local.remove(key).catch(() => {});   // drop any old downloaded copy
        } else cached = null;
      }
      if (!cached) cached = (await chrome.storage.local.get(key))[key];
      const stale = !bundled && (!cached || cached.v !== EXPR_CACHE_VER || Date.now() - Date.parse(cached.fetched_at) > IDIOM_MAX_AGE_MS ||
        (cached.failed && cached.failed.length && Date.now() - Date.parse(cached.fetched_at) > EXPR_RETRY_MS));
      let error = null;
      if (stale) {
        const entries = {};                         // title -> [tags]
        const lists = {}, failed = [];
        for (const { cat, tag } of EXPR_CATEGORIES(langName(lang))) {
          const r = await fetchCategory(cat);
          lists[cat] = r.titles.length;
          if (!r.ok) failed.push(`${cat} (${r.status})`);
          for (const t of r.titles) (entries[t] = entries[t] || []).includes(tag) || entries[t].push(tag);
        }
        if (Object.keys(entries).length) {
          cached = { v: EXPR_CACHE_VER, fetched_at: new Date().toISOString(), lang, lists, failed, entries };
          chrome.storage.local.set({ [key]: cached }).catch(() => {});
        } else {
          error = 'download failed: ' + failed.join(', ');
          if (!cached || cached.v !== EXPR_CACHE_VER) cached = null;   // keep an older good list if there is one
        }
      }
      const index = new Map();
      const slang = new Map();                      // single colloquial / slang word -> tags
      let n = 0;
      for (const [t, tags] of Object.entries((cached && cached.entries) || {})) {
        if (!/\s/.test(t)) {
          // Single words: only slang / vulgar ones. "Colloquial" single words are mostly everyday words
          // with one informal sense (und, so, er, komm), which underlined half of every line.
          const lw = t.toLowerCase();
          if (tags.some(x => x === 'slang' || x === 'vulgar') && lw.length >= 3 && !COMMON_WORDS.has(lw))
            slang.set(lw, tags.filter(x => SLANG_TAGS.has(x)));
          continue;
        }
        const c = compileIdiom(t, lang);
        if (!c) continue;
        c.tags = tags;
        n++;
        const k = c.core[0];
        if (!index.has(k)) index.set(k, []);
        index.get(k).push(c);
      }
      index.total = cached ? Object.keys(cached.entries).length : 0;
      index.usable = n;
      index.slang = slang;
      index.lists = cached ? cached.lists : null;
      index.failed = cached ? cached.failed : null;
      index.error = error || (!cached ? 'no list' : null);
      index.failedAt = index.error ? Date.now() : 0;
      idiomIndex.set(lang, index);
      idiomLoading.delete(lang);
      return index;
    })();
    idiomLoading.set(lang, p);
    return p;
  }

  // -> [{ from, to, title, len }] word-index ranges (inclusive) over a token list.
  // verbToks: words around the match (this line and its neighbours) where the verb may appear.
  const VERB_SPAN = 5;                         // max words between the verb and the fixed words
  function matchTokens(toks, index, verbToks) {
    const out = [];
    const vt = verbToks || toks;
    toks.forEach((tok, i) => {
      for (const c of index.get(tok) || []) {
        if (i + c.core.length > toks.length) continue;
        if (!c.core.every((t, k) => toks[i + k] === t)) continue;
        if (c.needVerb && !vt.some(t => c.stems.some(st => t.includes(st)))) continue;
        let from = i, to = i + c.core.length - 1;
        // Highlight the verb too when it's in the same line, close to the fixed words:
        // "ich [verstehe nur Bahnhof]", "er hat [Gas gegeben]". The span covers the words between.
        if (c.stems.length) {
          let best = -1;
          for (let j = Math.max(0, from - VERB_SPAN); j <= Math.min(toks.length - 1, to + VERB_SPAN); j++) {
            if (j >= from && j <= to) continue;
            if (!c.stems.some(st => toks[j].includes(st))) continue;
            if (best < 0 || Math.abs(j - i) < Math.abs(best - i)) best = j;
          }
          if (best >= 0) { from = Math.min(from, best); to = Math.max(to, best); }
        }
        out.push({ from, to, title: c.title, len: c.core.length + (to - from + 1 - c.core.length > 0 ? 1 : 0) });
      }
    });
    return out;
  }

  function keepLongest(list) {
    list.sort((a, b) => b.len - a.len || a.from - b.from);
    const taken = [];
    return list.filter(m => {
      if (taken.some(t => m.from <= t.to && m.to >= t.from)) return false;
      taken.push(m); return true;
    }).sort((a, b) => a.from - b.from);
  }

  // Per cue: expressions inside the line, plus ones that run on into the next line
  // (auto-generated subtitles often split sentences across lines).
  function findAllExpressions(cues, index) {
    const toks = cues.map(c => tokenize(c.t));
    const per = cues.map(() => []);
    if (!index || !index.size) return per;
    // Lines i and i+1 belong to one sentence if they're close in time and line i doesn't end
    // a sentence (auto-generated subtitles have no punctuation, so they always continue).
    const joined = i => i >= 0 && i < cues.length - 1 && cues[i + 1].s - cues[i].e <= 1.5 && !/[.!?…]["“”'»]?\s*$/.test(cues[i].t);
    const near = i => {                                // this line plus the rest of its sentence
      let v = toks[i];
      if (joined(i - 1)) v = toks[i - 1].concat(v);
      if (joined(i)) v = v.concat(toks[i + 1]);
      return v;
    };
    toks.forEach((t, i) => { per[i].push(...matchTokens(t, index, near(i))); });
    for (let i = 0; i < cues.length - 1; i++) {
      const a = toks[i], b = toks[i + 1];
      if (!a.length || !b.length || !joined(i)) continue;
      const window = (joined(i - 1) ? toks[i - 1] : []).concat(a, b, joined(i + 1) ? toks[i + 2] : []);
      for (const m of matchTokens(a.concat(b), index, window)) {
        if (m.from < a.length && m.to >= a.length) {           // crosses the line break
          per[i].push({ from: m.from, to: a.length - 1, title: m.title, len: m.len });
          per[i + 1].push({ from: 0, to: m.to - a.length, title: m.title, len: m.len });
        }
      }
    }
    return per.map(keepLongest);
  }

  async function markExpressions() {
    const lang = S.audio;
    const index = await loadIdioms(lang);
    if (lang !== S.audio || !index) return;
    S.exprList = { total: index.total, usable: index.usable, slang: index.slang.size, error: index.error, failed: index.failed };
    S.slang = index.slang;
    S.expr = findAllExpressions(S.cues, index);
    renderPanelList();
  }

  // ---------- saved words / phrases ----------
  // s:<saved_id> -> one saved word or phrase, with its definition and where it came from.
  function saveItem(o) {
    const id = crypto.randomUUID();
    const res = o.res || {};
    const shown = res.lemma && res.lemmaGroups && res.lemmaGroups.length ? res.lemmaGroups : res.groups || [];
    const gloss = shown.length ? shown[0].defs.slice(0, 2).map(d => d.text).join('; ') : null;
    const ci = o.cueIdx;
    chrome.storage.local.set({
      [`s:${id}`]: {
        schema: SCHEMA, rec: 'saved', saved_id: id, t: new Date().toISOString(), saved_on: localDate(),
        text: o.text, words: o.words, lang: S.audio,
        entry: res.found ? (res.lemma && res.lemmaGroups && res.lemmaGroups.length ? res.lemma : res.term) : null,
        gloss, phrase: o.words.length > 1, source: o.source,
        content_id: S.exp ? S.exp.content_id : 'youtube:' + S.vid, vid: S.vid,
        title: (S.exp && S.exp.title) || document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, ''),
        exp_id: S.exp ? S.exp.exp_id : null,
        vt: ci != null && S.cues[ci] ? r3(S.cues[ci].s) : null,
        cue_idx: ci, cue_text: ci != null && S.cues[ci] ? S.cues[ci].t : null,
      },
    }).catch(() => {});
  }
  function markSaved(btn) { btn.textContent = '★ Saved'; btn.disabled = true; btn.classList.add('done'); }

  // ---------- UI: transcript panel (docked or floating, draggable) ----------
  const showsUi = () => settings.overlay || settings.sidebar;
  let drag = null, resizeObs = null, resizeTimer = 0;

  function dockHost() {
    return document.querySelector('#secondary-inner') || document.querySelector('#secondary');
  }

  function ensurePanel() {
    const floating = !!settings.panelFloat;
    const host = floating ? document.body : dockHost();
    if (!host) return;
    if (!panel) buildPanel();
    if (panel.parentElement !== host) {
      if (floating) document.body.appendChild(panel); else host.prepend(panel);
    }
    placePanel();
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.className = 'lomb-panel';
    panelHead = document.createElement('div');
    panelHead.className = 'lomb-head';
    panelList = document.createElement('div');
    panelList.className = 'lomb-list';
    panelSel = document.createElement('div');
    panelSel.className = 'lomb-selbox';
    panelSaved = document.createElement('div');
    panelSaved.className = 'lomb-savedlist';
    const body = document.createElement('div');
    body.className = 'lomb-body';         // fixed-height area shared by Transcript and Saved
    body.append(panelSel, panelList, panelSaved);
    panel.append(panelHead, body);

    // Click an underlined expression or a word = definition + Save; click the time = jump there.
    panelList.addEventListener('click', e => {
      const w = e.target.closest('.lomb-ex') || e.target.closest('.lomb-sw');
      if (w) { selectItem(w); return; }
      const row = e.target.closest('.lomb-row');
      if (row) seekToCue(Number(row.dataset.i));
    });
    // Hover an expression or a word in the sidebar = definition, without pausing.
    panelList.addEventListener('mouseover', e => {
      const w = e.target.closest('.lomb-ex') || e.target.closest('.lomb-sw');
      if (!w || !settings.hoverDict || w === side.span) return;
      clearTimeout(side.timer);
      side.timer = setTimeout(() => openSideTip(w), 350);
    });
    panelList.addEventListener('mouseout', e => {
      if ((e.target.closest('.lomb-sw') || e.target.closest('.lomb-ex')) && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.lomb-tip-side'))) {
        clearTimeout(side.timer);
        closeSideTip();
      }
    });
    panelSel.addEventListener('click', e => {
      const b = e.target.closest('[data-sel]');
      if (!b) return;
      if (b.dataset.sel === 'clear') clearSel(true);
      if (b.dataset.sel === 'save' && S.sel) {
        saveItem({ text: S.sel.text, words: S.sel.words, res: S.selRes, cueIdx: S.sel.cueIdx, source: 'sidebar' });
        markSaved(b);
      }
    });
    panelSaved.addEventListener('click', e => {
      const item = e.target.closest('[data-id]');
      if (!item) return;
      if (e.target.closest('[data-del]')) { chrome.storage.local.remove('s:' + item.dataset.id); return; }
      if (e.target.closest('[data-jump]')) {
        const it = savedItems.find(x => x.saved_id === item.dataset.id);
        if (!it) return;
        if (it.vid === S.vid && it.vt != null) { const v = getVideo(); if (v) { v.currentTime = it.vt; v.play().catch(() => {}); } }
        else window.open(`https://www.youtube.com/watch?v=${encodeURIComponent(it.vid)}${it.vt != null ? '&t=' + Math.floor(it.vt) + 's' : ''}`, '_blank');
      }
    });
    refreshSaved();
    panelHead.addEventListener('click', e => {
      const tab = e.target.closest('[data-tab]');
      if (tab) { S.tab = tab.dataset.tab; applyTab(); renderPanelHeader(); return; }
      const act = e.target.closest('[data-act]');
      if (act) {
        if (act.dataset.act === 'dock') { settings.panelFloat = null; saveSettings(); ensurePanel(); renderPanelHeader(); }
        if (act.dataset.act === 'hide') { settings.sidebar = false; saveSettings(); applySettings(); }
        if (act.dataset.act === 'retryexpr') {
          const ix = idiomIndex.get(S.audio);
          if (ix) ix.failedAt = 0;
          S.exprList = null; renderPanelHeader(); markExpressions();
        }
        return;
      }
      const b = e.target.closest('[data-toggle]');
      if (!b) return;
      settings[b.dataset.toggle] = !settings[b.dataset.toggle];
      saveSettings(); applySettings();
      if (b.dataset.toggle === 'second' && settings.second && S.trackUrl) requestSecond(new URL(S.trackUrl));
    });

    // Drag by the title bar. Dragging a docked panel pulls it out into a floating one.
    panelHead.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !e.target.closest('.lomb-bar') || e.target.closest('button')) return;
      const r = panel.getBoundingClientRect();
      drag = { id: e.pointerId, px: e.clientX, py: e.clientY, x: r.left, y: r.top, w: r.width, h: r.height, moved: false };
      panelHead.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    panelHead.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.px, dy = e.clientY - drag.py;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      if (!drag.moved) {
        drag.moved = true;
        if (!settings.panelFloat) {
          settings.panelFloat = { x: drag.x, y: drag.y, w: Math.min(drag.w, 320), h: Math.min(drag.h, window.innerHeight * 0.7) };
          ensurePanel();
          renderPanelHeader();
        }
      }
      settings.panelFloat = Object.assign({}, settings.panelFloat, { x: drag.x + dx, y: drag.y + dy });
      placePanel();
    });
    const endDrag = e => {
      if (!drag || e.pointerId !== drag.id) return;
      const moved = drag.moved;
      drag = null;
      if (moved) saveSettings();
    };
    panelHead.addEventListener('pointerup', endDrag);
    panelHead.addEventListener('pointercancel', endDrag);

    // Remember the size when a floating panel is resized from its corner.
    resizeObs = new ResizeObserver(() => {
      if (!settings.panelFloat || drag || !panel) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!settings.panelFloat || !panel) return;
        const w = Math.round(panel.offsetWidth), h = Math.round(panel.offsetHeight);
        if (w !== settings.panelFloat.w || h !== settings.panelFloat.h) {
          settings.panelFloat = Object.assign({}, settings.panelFloat, { w, h });
          saveSettings();
        }
      }, 400);
    });
    resizeObs.observe(panel);
    renderPanelList();
  }

  // Apply docked / floating position. Floating panels are kept on screen.
  function placePanel() {
    if (!panel) return;
    const f = settings.panelFloat;
    panel.classList.toggle('lomb-floating', !!f);
    if (!f) {
      panel.style.left = panel.style.top = panel.style.width = panel.style.height = '';
      return;
    }
    const w = Math.max(240, Math.min(f.w || 320, window.innerWidth - 16));
    const h = Math.max(200, Math.min(f.h || 480, window.innerHeight - 16));
    const x = Math.max(0, Math.min(f.x, window.innerWidth - Math.min(w, 120)));
    const y = Math.max(0, Math.min(f.y, window.innerHeight - 48));
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
    panel.style.width = w + 'px';
    panel.style.height = h + 'px';
  }
  window.addEventListener('resize', () => placePanel());

  function removePanel() {
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    if (panel) panel.remove();
    closeSideTip();
    panel = panelHead = panelList = panelSel = panelSaved = null;
    panelRows = [];
    drag = null;
  }

  function renderPanelHeader() {
    if (!panelHead) return;
    const n = S.cues.length, seen = S.seen.size;
    const pct = n ? Math.round((100 * seen) / n) : 0;
    const ranges = S.exp ? mergeRanges(S.exp.ranges) : [];
    const watched = ranges.reduce((a, r) => a + (r[1] - r[0]), 0);
    const nExpr = S.expr ? S.expr.reduce((a, x) => a + x.length, 0) : 0;
    const trackLabel = S.track ? langName(S.audio) + (S.track.kind === 'asr' ? ' · auto' : '') : 'Loading…';
    const secondLabel = (settings.secondLang || 'en').toUpperCase();
    const btn = (key, label, tip) =>
      `<button class="lomb-btn${settings[key] ? ' on' : ''}" data-toggle="${key}" title="${tip}">${label}</button>`;
    panelHead.innerHTML =
      `<div class="lomb-bar" title="Drag to move">` +
        `<span class="lomb-grip">⠿</span><span class="lomb-title">Lomb</span>` +
        `<span class="lomb-sub">${trackLabel}</span>` +
        (settings.panelFloat ? `<button class="lomb-icon" data-act="dock" title="Put back next to the video">Dock</button>` : '') +
        `<button class="lomb-icon" data-act="hide" title="Hide sidebar (turn back on in the popup)">✕</button>` +
      `</div>` +
      `<div class="lomb-row2">` +
        `<span class="lomb-stats" title="${esc(exprStatus())}">` +
          (n ? `${seen}/${n} · ${pct}%` : '') + ` · ${fmtTime(watched)}` + (S.exprList && !S.exprList.error ? ` · ${nExpr} expr.` : '') + `</span>` +
        `<span class="lomb-btns">${btn('overlay', 'Subs', 'Subtitle overlay on the video')}` +
          (base(settings.secondLang) !== S.audio ? btn('second', secondLabel, 'Translation line') : '') +
          `${btn('autopause', '⏸', 'Auto-pause after each line (Q). Keys: A previous · S repeat · D next')}</span>` +
      `</div>` +
      (S.exprList && S.exprList.error
        ? `<div class="lomb-warn">⚠ Expression list unavailable <button class="lomb-icon" data-act="retryexpr">Retry</button></div>` : '') +
      `<div class="lomb-tabs"><button data-tab="transcript" class="${S.tab === 'saved' ? '' : 'on'}">Transcript</button>` +
      `<button data-tab="saved" class="${S.tab === 'saved' ? 'on' : ''}">Saved (${savedItems.length})</button></div>`;
  }

  function exprStatus() {
    const x = S.exprList;
    if (!x) return 'Expression list: loading…';
    if (x.error) return 'Expression list: ' + x.error;
    return `Lines seen · time watched · expressions found\nExpression list: ${x.total} entries (${x.usable} multi-word, ${x.slang} slang/colloquial words)` +
      (x.failed && x.failed.length ? `\nNot downloaded: ${x.failed.join(', ')}` : '');
  }

  function applyTab() {
    if (!panel) return;
    const saved = S.tab === 'saved';
    panelList.style.display = saved ? 'none' : '';
    panelSel.style.display = saved || !S.sel ? 'none' : '';
    panelSaved.style.display = saved ? '' : 'none';
  }

  // ---------- sidebar: click a word or an underlined expression ----------
  // Shows its definition in a box above the transcript, with Save.
  async function selectItem(el) {
    const row = el.closest('.lomb-row');
    const i = Number(row.dataset.i);
    const isExpr = el.classList.contains('lomb-ex');
    const text = isExpr ? el.textContent.replace(/[.,;:!?]+$/, '') : clean(el.textContent);
    if (S.selEl) S.selEl.classList.remove('sel');
    S.selEl = el; el.classList.add('sel');
    const v = getVideo();
    if (v && !v.paused) { v.pause(); S.selPaused = true; }
    closeSideTip();
    S.sel = { text, words: tokenizeRaw(text), cueIdx: i, title: isExpr ? el.dataset.title : null };
    renderSelBox(null);
    const seq = ++S.selSeq;
    const res = isExpr ? await lookupExpr(el.dataset.title) : await lookup(text, S.audio);
    if (seq !== S.selSeq) return;
    S.selRes = res;
    renderSelBox(res);
    logLookup(text, res, i, 'sidebar');
  }
  const tokenizeRaw = text => [...text.matchAll(WORD_RE)].map(m => clean(m[0]));

  async function lookupExpr(title) {
    const key = S.audio + '|expr|' + title;
    if (dictCache.has(key)) return dictCache.get(key);
    const groups = await definitions(title, S.audio);
    const res = { found: !!groups.length, phrase: true, term: title, groups, lemma: null, lemmaGroups: [] };
    dictCache.set(key, res);
    return res;
  }

  function renderSelBox(res) {
    if (!panelSel) return;
    if (!S.sel) { panelSel.style.display = 'none'; panelSel.innerHTML = ''; return; }
    const shown = S.sel.title || S.sel.text;
    const body = res ? renderDefinition(shown, res, false)
      : `<div class="lomb-tip-word">${esc(shown)}</div><div class="lomb-tip-muted">Looking up…</div>`;
    const note = S.sel.title && S.sel.title.toLowerCase() !== S.sel.text.toLowerCase()
      ? `<div class="lomb-tip-form">Expression in this line: “${esc(S.sel.text)}”</div>` : '';
    panelSel.innerHTML = note + body +
      `<div class="lomb-sel-btns"><button class="lomb-save" data-sel="save"${res ? '' : ' disabled'}>☆ Save</button>` +
      `<button class="lomb-icon" data-sel="clear">Close</button></div>`;
    applyTab();
  }

  function clearSel(resume) {
    if (S.selEl) S.selEl.classList.remove('sel');
    S.selEl = null; S.sel = null; S.selRes = null; S.selSeq++;
    renderSelBox(null);
    if (resume && S.selPaused) {
      S.selPaused = false;
      const v = getVideo();
      if (v && v.paused) v.play().catch(() => {});
    }
  }

  // ---------- sidebar: hover definition (no pause) ----------
  const side = { timer: 0, span: null, tip: null, seq: 0 };
  function openSideTip(span) {
    if (!span.isConnected) return;
    side.span = span;
    if (!side.tip) {
      side.tip = document.createElement('div');
      side.tip.className = 'lomb-tip lomb-tip-side';
      side.tip.addEventListener('mouseleave', closeSideTip);
      document.body.appendChild(side.tip);
    }
    const isExpr = span.classList.contains('lomb-ex');
    const word = isExpr ? span.dataset.title : clean(span.textContent);
    const seq = ++side.seq;
    side.tip.innerHTML = `<div class="lomb-tip-word">${esc(word)}</div><div class="lomb-tip-muted">Looking up…</div>`;
    placeSideTip(span);
    (isExpr ? lookupExpr(word) : lookup(word, S.audio)).then(res => {
      if (seq !== side.seq || !side.tip) return;
      side.tip.innerHTML = renderDefinition(word, res, false);
      placeSideTip(span);
    });
  }
  function placeSideTip(span) {
    if (!side.tip) return;
    const r = span.getBoundingClientRect();
    const tw = side.tip.offsetWidth, th = side.tip.offsetHeight;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    let top = r.top - th - 8;
    if (top < 8) top = r.bottom + 8;
    side.tip.style.left = left + 'px';
    side.tip.style.top = top + 'px';
  }
  function closeSideTip() {
    clearTimeout(side.timer);
    side.seq++;
    side.span = null;
    if (side.tip) { side.tip.remove(); side.tip = null; }
  }

  // ---------- sidebar: saved list ----------
  let savedItems = [];
  async function refreshSaved() {
    const all = await chrome.storage.local.get(null);
    savedItems = Object.entries(all).filter(([k]) => k.startsWith('s:')).map(([, v]) => v)
      .sort((a, b) => String(b.t).localeCompare(String(a.t)));
    renderSaved();
    renderPanelHeader();
  }
  function renderSaved() {
    if (!panelSaved) return;
    if (!savedItems.length) {
      panelSaved.innerHTML = `<div class="lomb-saved-empty">Nothing saved yet. Click words in the transcript (several for a phrase), or hover a word in the subtitles, then press ☆ Save.</div>`;
      return;
    }
    panelSaved.innerHTML = savedItems.map(it =>
      `<div class="lomb-saved-item" data-id="${esc(it.saved_id)}">` +
        `<div class="lomb-saved-top"><span class="lomb-saved-text">${esc(it.text)}</span>` +
          (it.entry && it.entry.toLowerCase() !== it.text.toLowerCase() ? `<span class="lomb-saved-entry">→ ${esc(it.entry)}</span>` : '') +
          `<span class="lomb-saved-lang">${esc(langName(it.lang))}</span>` +
          `<button class="lomb-icon" data-del title="Remove">✕</button></div>` +
        (it.gloss ? `<div class="lomb-saved-gloss">${esc(it.gloss)}</div>` : '') +
        (it.cue_text ? `<div class="lomb-saved-cue">“${esc(it.cue_text)}”</div>` : '') +
        `<div class="lomb-saved-src" data-jump title="Play this moment">▶ ${esc(it.title || it.vid)}${it.vt != null ? ' · ' + fmtTime(it.vt) : ''}</div>` +
      `</div>`).join('');
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some(k => k.startsWith('s:'))) refreshSaved();
  });

  function renderPanelList() {
    renderPanelHeader();
    if (!panelList) return;
    panelList.textContent = '';
    panelRows = [];
    S.curIdx = -1;
    const frag = document.createDocumentFragment();
    S.cues.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'lomb-row' + (S.seen.has(i) ? ' seen' : '');
      row.dataset.i = i;
      const tm = document.createElement('span'); tm.className = 'lomb-t'; tm.textContent = fmtTime(c.s);
      const tx = document.createElement('span'); tx.className = 'lomb-x';
      const exprs = (S.expr && S.expr[i]) || [];
      let last = 0, wi = 0, host = tx, ex = null;
      for (const m of c.t.matchAll(WORD_RE)) {
        const startEx = exprs.find(x => x.from === wi);
        if (startEx) {
          if (m.index > last) host.append(c.t.slice(last, m.index));
          ex = startEx;
          host = document.createElement('span');
          host.className = 'lomb-ex';
          host.dataset.title = ex.title;
          host.title = ex.title;
          tx.append(host);
        } else if (m.index > last) host.append(c.t.slice(last, m.index));
        const w = document.createElement('span');
        w.className = 'lomb-sw';
        const sl = !ex && S.slang && S.slang.get(clean(m[0]).toLowerCase());
        if (sl) { w.classList.add('lomb-slang'); w.title = sl.join(' / '); }
        w.dataset.wi = wi;
        w.textContent = m[0];
        host.append(w);
        last = m.index + m[0].length;
        if (ex && wi === ex.to) { host = tx; ex = null; }
        wi++;
      }
      if (last < c.t.length) tx.append(c.t.slice(last));
      row.append(tm, tx);
      frag.appendChild(row);
      panelRows.push(row);
    });
    panelList.appendChild(frag);
    applyTab();
  }

  function markRow(i) { const r = panelRows[i]; if (r) r.classList.add('seen'); }

  function highlight(i) {
    if (i === S.curIdx) return;
    const old = panelRows[S.curIdx];
    if (old) old.classList.remove('cur');
    S.curIdx = i;
    const row = panelRows[i];
    if (row && panelList) {
      row.classList.add('cur');
      if (!panelList.matches(':hover')) {
        const top = row.offsetTop - panelList.clientHeight / 3;
        panelList.scrollTo({ top, behavior: 'smooth' });
      }
    }
  }

  function applySettings() {
    document.documentElement.classList.toggle('lomb-hide-ov', !settings.overlay);
    if (!settings.sidebar) removePanel();
    else if (panel) placePanel();
    renderPanelHeader();
  }

  // ---------- controls ----------
  function seekToCue(i) {
    const v = getVideo();
    if (!v || i < 0 || i >= S.cues.length) return;
    v.currentTime = S.cues[i].s + 0.01;
    S.apArm = -1; S.apDone = -1;
    v.play().catch(() => {});
  }

  document.addEventListener('keydown', e => {
    if (!settings.enabled || !S.active || !showsUi() || currentVid() == null || !S.cues.length) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const el = e.target;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    const v = getVideo();
    if (!v) return;
    const k = e.key.toLowerCase();
    const at = lastStartedAt(v.currentTime + 0.05);
    if (k === 'a') seekToCue(at > 0 && v.currentTime - S.cues[at].s < 1 ? at - 1 : Math.max(at, 0));
    else if (k === 'd') seekToCue(at + 1);
    else if (k === 's') seekToCue(Math.max(at, 0));
    else if (k === 'q') { settings.autopause = !settings.autopause; saveSettings(); applySettings(); }
    else return;
    e.preventDefault(); e.stopPropagation();
  }, true);

  // ---------- main loop ----------
  function tick() {
    if (!settings.enabled) return;
    const vid = currentVid();
    if (vid !== S.vid) startVideo(vid);
    if (!vid) return;

    if (S.active && settings.overlay) ensureOverlay();
    if (S.active && settings.sidebar) ensurePanel();

    // Ask the player for the spoken-language track until it arrives.
    if ((!S.track || !S.audio) && S.enableTries < MAX_ENABLE_TRIES && Date.now() >= S.nextEnable) {
      S.enableTries++;
      S.nextEnable = Date.now() + 1500;
      // select = switch the player's captions to the spoken language. With overlay and
      // sidebar both off (logging only), leave the player alone and just copy what it loads.
      sendPage({ type: 'enable', vid, select: showsUi() });
    }

    const v = getVideo();
    trackPlayback(v);
    if (hover.open && v && !v.paused) closeHover();   // user resumed playback (e.g. space bar)

    if (v && S.active && S.cues.length) {
      const t = v.currentTime;
      const i = cueAt(S.cues, t);
      const j = S.second.length ? cueAt(S.second, t) : -1;
      setOverlay(i >= 0 ? S.cues[i].t : '', j >= 0 ? S.second[j].t : '', i);
      const hi = i >= 0 ? i : lastStartedAt(t);
      if (hi >= 0) highlight(hi);
      if (settings.autopause && !v.paused) {
        if (S.apArm >= 0 && t >= S.cues[S.apArm].e - 0.08 && t < S.cues[S.apArm].e + 1.5) {
          v.pause(); S.apDone = S.apArm; S.apArm = -1;
        } else if (S.apArm >= 0 && (t < S.cues[S.apArm].s - 0.5 || t > S.cues[S.apArm].e + 1.5)) {
          S.apArm = -1;
        }
        if (i >= 0 && S.apArm < 0 && i !== S.apDone) S.apArm = i;
      }
    }
    saveExposure(false);
  }

  setInterval(tick, TICK_MS);
  document.addEventListener('visibilitychange', () => { if (document.hidden && settings.enabled) saveExposure(true); });
  window.addEventListener('pagehide', () => { if (settings.enabled) saveExposure(true); });
})();
