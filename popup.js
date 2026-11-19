// Lomb Input popup: on/off switch, totals by language, JSONL export.

const localDate = (d = new Date()) => d.toLocaleDateString('en-CA');
const fmtMin = m => (m < 10 ? Math.round(m * 10) / 10 : Math.round(m));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const langName = code => {
  if (!code) return 'Unknown language';
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch (e) { return code; }
};

// ---------- on / off ----------
const power = document.getElementById('power');
let settings = {};
async function loadSettings() {
  settings = (await chrome.storage.local.get('settings')).settings || {};
  if (settings.enabled === undefined) settings.enabled = true;
  showPower();
  showOpts();
}
const optOverlay = document.getElementById('optOverlay');
const optSidebar = document.getElementById('optSidebar');
const optSecond = document.getElementById('optSecond');
const optHover = document.getElementById('optHover');
function showOpts() {
  optOverlay.checked = settings.overlay !== false;
  optSidebar.checked = settings.sidebar !== false;
  optSecond.checked = settings.second !== false;
  optHover.checked = settings.hoverDict !== false;
  document.body.classList.toggle('logonly', !optOverlay.checked && !optSidebar.checked);
}
async function setOpt(key, val) {
  const cur = (await chrome.storage.local.get('settings')).settings || {};
  settings = Object.assign(cur, { [key]: val });
  if (settings.enabled === undefined) settings.enabled = true;
  await chrome.storage.local.set({ settings });
  showOpts();
}
optOverlay.onchange = () => setOpt('overlay', optOverlay.checked);
optSidebar.onchange = () => setOpt('sidebar', optSidebar.checked);
optSecond.onchange = () => setOpt('second', optSecond.checked);
optHover.onchange = () => setOpt('hoverDict', optHover.checked);

function showPower() {
  power.classList.toggle('on', settings.enabled);
  power.setAttribute('aria-checked', String(settings.enabled));
  document.getElementById('powerLabel').textContent = settings.enabled ? 'On' : 'Off';
  document.body.classList.toggle('off', !settings.enabled);
}
async function togglePower() {
  settings = Object.assign((await chrome.storage.local.get('settings')).settings || {}, { enabled: !settings.enabled });
  await chrome.storage.local.set({ settings });
  showPower();
}
power.onclick = togglePower;
power.onkeydown = e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); togglePower(); } };

// ---------- data ----------
async function load() {
  const all = await chrome.storage.local.get(null);
  const exps = [], tracks = {}, lookups = [], saved = [];
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith('x:')) exps.push(v);
    else if (k.startsWith('l:')) lookups.push(v);
    else if (k.startsWith('s:')) saved.push(v);
    else if (k.startsWith('t:')) (tracks[v.content_id] = tracks[v.content_id] || []).push(v);
  }
  return { exps, tracks, lookups, saved };
}

// Lines seen in one exposure: cues of its track that overlap a watched range.
function linesSeen(exp, tracks) {
  const list = (tracks[exp.content_id] || []).find(t => t.lang === exp.track_lang && t.kind === exp.track_kind);
  if (!list) return 0;
  let n = 0;
  for (const [s, e] of list.cues) if (exp.ranges.some(([a, b]) => s <= b && e >= a)) n++;
  return n;
}

async function render() {
  const { exps, tracks } = await load();
  const today = localDate();
  const byDay = {}, byLangToday = {};
  for (const x of exps) {
    const lines = linesSeen(x, tracks);
    const d = (byDay[x.watched_on] = byDay[x.watched_on] || { min: 0, lines: 0, vids: new Set() });
    d.min += x.minutes || 0; d.lines += lines; d.vids.add(x.vid);
    if (x.watched_on === today) {
      const k = x.audio_lang || '';
      const l = (byLangToday[k] = byLangToday[k] || { min: 0, lines: 0 });
      l.min += x.minutes || 0; l.lines += lines;
    }
  }
  const t = byDay[today] || { min: 0, lines: 0, vids: new Set() };
  document.getElementById('min').textContent = fmtMin(t.min);
  document.getElementById('lines').textContent = t.lines;
  document.getElementById('vids').textContent = t.vids.size;

  const langs = Object.entries(byLangToday).sort((a, b) => b[1].min - a[1].min);
  document.getElementById('langs').innerHTML = langs.length
    ? langs.map(([k, v]) => `<tr><td>${esc(langName(k))}</td><td class="n">${fmtMin(v.min)} min</td><td class="n">${v.lines} lines</td></tr>`).join('')
    : '<tr><td class="muted">Nothing yet today.</td></tr>';

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = localDate(d), v = byDay[k];
    days.push(`<tr><td>${k}</td><td class="n">${v ? fmtMin(v.min) : 0} min</td><td class="n">${v ? v.lines : 0} lines</td></tr>`);
  }
  document.getElementById('days').innerHTML = days.join('');

  const recent = exps.sort((a, b) => String(b.t_end).localeCompare(String(a.t_end))).slice(0, 6);
  document.getElementById('recent').innerHTML = recent.length
    ? recent.map(x => `<tr><td><div class="vt">${esc(x.title || x.vid)}<span class="tag">${esc(langName(x.audio_lang))}</span></div></td>` +
        `<td class="n">${fmtMin(x.minutes)} min${x.text_source === 'live_track' ? '' : '<br><span class="muted">no subtitles</span>'}</td></tr>`).join('')
    : '<tr><td class="muted">Watch a YouTube video to start.</td></tr>';
}

document.getElementById('export').onclick = async () => {
  const { exps, tracks, lookups, saved } = await load();
  if (!exps.length && !saved.length) { document.getElementById('note').textContent = 'Nothing to export yet.'; return; }
  const ids = new Set(exps.map(x => x.content_id));
  const trackRecs = Object.entries(tracks).filter(([id]) => ids.has(id)).flatMap(([, v]) => v);
  const lines = [...exps, ...trackRecs, ...lookups, ...saved].map(r => JSON.stringify(r)).join('\n') + '\n';
  const dates = [...exps.map(x => x.watched_on), ...saved.map(x => x.saved_on)].sort();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines], { type: 'application/x-ndjson' }));
  a.download = `lomb_input_${dates[0]}_${dates[dates.length - 1]}.jsonl`;
  a.click();
  document.getElementById('note').textContent = `Exported ${exps.length} viewings, ${trackRecs.length} subtitle tracks, ${lookups.length} lookups and ${saved.length} saved words/phrases.`;
};

document.getElementById('clear').onclick = async () => {
  if (!confirm('Delete all logged viewings and word lookups? Subtitle tracks and saved words/phrases are kept.')) return;
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter(k => k.startsWith('x:') || k.startsWith('l:')));
  render();
};

loadSettings();
render();
