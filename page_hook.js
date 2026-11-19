// Lomb Input: page hook. Runs inside YouTube's own page (MAIN world).
//
// 1. Watches the requests YouTube's player makes for subtitle files
//    (/api/timedtext) and hands a copy of each response to content.js.
//    The player's own request carries YouTube's valid token, so the file is real.
// 2. On request from content.js, works out the video's spoken language and switches
//    the player's captions to that language's track, which makes the player
//    download it (captured by 1).
// 3. On request from content.js, re-fetches a captured subtitle URL with small
//    changes (json3 format, translation for the second line).

(() => {
  if (window.__lombHooked) return;
  window.__lombHooked = true;

  const TAG = '__lomb';
  const origFetch = window.fetch;
  const isTimedText = u => typeof u === 'string' && u.includes('/api/timedtext');
  const abs = u => { try { return new URL(u, location.href).href; } catch (e) { return String(u); } };
  const post = msg => window.postMessage(Object.assign({ [TAG]: true }, msg), '*');

  // --- 1a. fetch ---
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      if (isTimedText(url)) {
        p.then(res => res.clone().text())
          .then(body => post({ type: 'timedtext', url: abs(url), body }))
          .catch(() => {});
      }
    } catch (e) { /* never break the page */ }
    return p;
  };

  // --- 1b. XMLHttpRequest ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__lombUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    try {
      const url = String(this.__lombUrl || '');
      if (isTimedText(url)) {
        this.addEventListener('load', () => {
          try {
            let body = '';
            if (this.responseType === '' || this.responseType === 'text') body = this.responseText;
            else if (this.responseType === 'arraybuffer') body = new TextDecoder().decode(this.response);
            else if (this.responseType === 'json') body = JSON.stringify(this.response);
            else if (typeof this.response === 'string') body = this.response;
            post({ type: 'timedtext', url: abs(url), body });
          } catch (e) {}
        });
      }
    } catch (e) {}
    return origSend.apply(this, arguments);
  };

  // --- 2. player helpers ---
  const player = () => document.getElementById('movie_player');

  function captionTracks(p) {
    try {
      const r = p.getPlayerResponse && p.getPlayerResponse();
      return (r && r.captions && r.captions.playerCaptionsTracklistRenderer &&
              r.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
    } catch (e) { return []; }
  }

  const base = c => String(c || '').split('-')[0].toLowerCase();

  // Spoken language = language of YouTube's speech-recognition (asr) track,
  // which always follows the audio. Track to show and store: creator-uploaded
  // track in that language first, else the asr track. Never a translation.
  function enableSpoken(vid, select) {
    const p = player();
    if (!p) return post({ type: 'tracks', vid, status: 'no_player' });
    let playing = '';
    try { playing = (p.getVideoData && p.getVideoData().video_id) || ''; } catch (e) {}
    if (playing && playing !== vid) return post({ type: 'tracks', vid, status: 'stale_player' });

    const tracks = captionTracks(p);
    const asr = tracks.filter(x => x.kind === 'asr');
    if (!asr.length) {
      return post({ type: 'tracks', vid, status: tracks.length ? 'unknown_lang' : 'no_tracks', spoken: null,
        tracks: tracks.map(x => ({ lang: x.languageCode, kind: 'manual' })) });
    }
    const spoken = base(asr[0].languageCode);
    const same = tracks.filter(x => base(x.languageCode) === spoken);
    const t = same.find(x => x.kind !== 'asr') || same.find(x => x.kind === 'asr');
    post({
      type: 'tracks', vid, status: 'ok', spoken,
      chosen: { lang: t.languageCode, kind: t.kind === 'asr' ? 'asr' : 'manual' },
    });
    if (select === false) return;          // logging only: don't change the player's captions
    try { if (p.loadModule) p.loadModule('captions'); } catch (e) {}
    try {
      let target = { languageCode: t.languageCode };
      if (t.kind) target.kind = t.kind;
      const list = (p.getOption && p.getOption('captions', 'tracklist')) || [];
      const match = list.find(x => x.languageCode === t.languageCode && (x.kind || '') === (t.kind || ''));
      if (match) target = match;
      p.setOption('captions', 'track', target);
    } catch (e) {}
  }

  // --- messages from content.js ---
  window.addEventListener('message', async e => {
    if (e.source !== window || !e.data || !e.data.__lombReq) return;
    const d = e.data;
    if (d.type === 'enable') enableSpoken(d.vid, d.select);
    if (d.type === 'fetch') {
      let body = '', status = 0;
      try {
        const r = await origFetch(d.url, { credentials: 'include' });
        status = r.status;
        body = await r.text();
      } catch (err) {}
      post({ type: 'fetched', id: d.id, url: d.url, body, status });
    }
  });
})();
