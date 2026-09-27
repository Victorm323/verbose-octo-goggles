/*
 * Dominord Mesa — the browser front end.
 *
 * Two modes over one engine (engine.js):
 *   Reconstruct  mirror a real table: enter your tiles, then every play, pass
 *                and draw as it happens; the engine keeps the ends, the turn,
 *                who can hold what, and evaluates every seat.
 *   Play         you against the engine, 1 vs 1 or 2 vs 2 with an engine
 *                partner; the engine players only ever see their own view.
 *
 * Analysis runs in a Web Worker so input never waits on the search.
 */
(function () {
  'use strict';
  const D = window.Dominord;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (x) => (x === undefined || x === null || isNaN(x) ? '–' : Math.round(x * 100) + '%');
  const sgn = (x, d = 1) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(d);
  const TN = D.tileName;

  // ================================================================ storage
  const store = {
    get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  // ================================================================ engine host
  // The same message handler runs in the worker (stringified) or, if workers
  // are unavailable, on the main thread in small time slices.
  function engineHost(D, post) {
    let current = 0;
    const models = {};
    const model = (rules) => {
      const k = JSON.stringify(rules);
      return models[k] || (models[k] = D.matchModel(rules, 1500));
    };
    return function (msg) {
      if (msg.type === 'analyze') {
        const id = (current = msg.id);
        let a;
        try {
          const table = D.Table.fromJSON(msg.table);
          const opts = Object.assign({}, msg.opts);
          if (msg.scores) { opts.scores = msg.scores; opts.matchModel = model(table.rules); }
          a = new D.Analysis(table, opts);
        } catch (err) {
          post({ type: 'error', id, error: String(err && err.message || err) });
          return;
        }
        const t0 = Date.now();
        const loop = () => {
          if (current !== id) return;
          let snap;
          try { snap = a.step(110); } catch (err) { post({ type: 'error', id, error: String(err.message || err) }); return; }
          const final = a.done || Date.now() - t0 >= a.cfg.timeMs;
          post({ type: 'snap', id, snap, final });
          if (!final) setTimeout(loop, 0);
        };
        loop();
      } else if (msg.type === 'choose') {
        try {
          const table = D.Table.fromJSON(msg.table);
          post({ type: 'move', id: msg.id, m: D.chooseMove(table, msg.opts) });
        } catch (err) {
          post({ type: 'error', id: msg.id, error: String(err.message || err) });
        }
      } else if (msg.type === 'cancel') {
        current = 0;
      } else if (msg.type === 'net') {
        try { D.setNet(msg.doc); } catch (err) { post({ type: 'error', id: -1, error: 'network: ' + err.message }); }
      }
    };
  }

  function makeEngine(onMessage) {
    const inline = document.getElementById('engine-src');
    const glue = '\nself.onmessage = (function(){ const h = (' + engineHost.toString()
      + ')(self.Dominord, function (m) { self.postMessage(m); }); return function (e) { h(e.data); }; })();';
    let src = null;
    if (inline && inline.textContent.trim()) src = inline.textContent + glue;
    else src = 'importScripts(' + JSON.stringify(new URL('engine.js', location.href).href + '?v=' + Date.now()) + ');' + glue;
    try {
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = (e) => onMessage(e.data);
      w.onerror = () => {};
      return { post: (m) => w.postMessage(m), kind: 'worker' };
    } catch (e) {
      const h = engineHost(D, (m) => setTimeout(() => onMessage(m), 0));
      return { post: (m) => setTimeout(() => h(m), 0), kind: 'main' };
    }
  }

  // ================================================================ state
  const DEFAULT_NAMES4 = ['You', 'Right', 'Partner', 'Left'];
  const DEFAULT_NAMES2 = ['You', 'Rival'];
  const newMatch = () => ({ scores: [0, 0], results: [], nextOpener: null });

  function defaultSession() {
    return {
      v: 1, mode: 'table', rulesKey: 'patio', rules: D.makeRules('patio'),
      names: DEFAULT_NAMES4.slice(), hero: 0,
      match: newMatch(), phase: 'deal', table: null,
      draft: { tiles: [], opener: null, spectate: false },
      effort: 'live', weighting: true, level: 'normal', coach: true, pozo: [],
      viewPly: null, lastResult: null,
    };
  }
  let S = defaultSession();
  const U = {
    msg: '', msgKind: '', pending: null, snap: null, snapFor: null, busy: false,
    anaId: 0, chooseId: 0, thinking: -1, sheet: null, setup: null, toastT: 0,
  };

  function save() {
    const o = Object.assign({}, S, { table: S.table ? S.table.toJSON() : null });
    store.set('dominord.mesa', o);
  }
  function load() {
    const o = store.get('dominord.mesa');
    if (!o || o.v !== 1) return false;
    try {
      S = Object.assign(defaultSession(), o);
      S.table = o.table ? D.Table.fromJSON(o.table) : null;
      return true;
    } catch (e) { S = defaultSession(); return false; }
  }

  // ================================================================ helpers
  const n = () => S.rules.players;
  const rel = (s) => (s - S.hero + n()) % n();
  const posOf = (s) => (n() === 2 ? (rel(s) === 0 ? 'south' : 'north') : ['south', 'east', 'north', 'west'][rel(s)]);
  const sideOf = (s) => (D.teamOf(s) === D.teamOf(S.hero) ? 'us' : 'them');
  const seatColor = (s) => {
    if (s >= n()) return 'var(--pozo)';
    if (n() === 2) return rel(s) === 0 ? 'var(--us)' : 'var(--them)';
    return ['var(--us)', 'var(--them)', 'var(--us-soft)', 'var(--them-soft)'][rel(s)];
  };
  const nm = (s) => (s >= n() ? 'Pozo' : S.names[s] || 'P' + s);
  const teamName = (t) => {
    if (n() === 2) return nm(t);
    return t === D.teamOf(S.hero) ? 'Us' : 'Them';
  };
  const firstHand = () => S.match.results.length === 0;

  function viewTable() {
    if (!S.table) return null;
    let t = S.mode === 'play' ? S.table.viewFor(S.hero) : S.table;
    if (S.viewPly !== null && S.viewPly < t.moves.length) {
      t = t.clone();
      t.moves = t.moves.slice(0, S.viewPly);
      t._d = null;
    }
    return t;
  }
  function beliefsOf(t) {
    try { return D.buildBeliefs(t); } catch (e) { return null; }
  }
  function say(text, kind) { U.msg = text; U.msgKind = kind || ''; }
  function toast(text) {
    const el = $('#toast');
    el.innerHTML = '<div class="toast" role="status">' + esc(text) + '</div>';
    clearTimeout(U.toastT);
    U.toastT = setTimeout(() => { el.innerHTML = ''; }, 3200);
  }

  // ================================================================ tile graphics
  const PIPS = {
    1: [[0, 0]], 2: [[-1, -1], [1, 1]], 3: [[-1, -1], [0, 0], [1, 1]],
    4: [[-1, -1], [1, -1], [-1, 1], [1, 1]], 5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
    6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
  };
  function pips(v, cx, cy, s, rot) {
    const list = PIPS[v] || [];
    const k = s * 0.27, r = Math.max(1.3, s * 0.09);
    return list.map(([x, y]) => {
      const px = rot ? y : x, py = rot ? x : y;
      return '<circle cx="' + (cx + px * k).toFixed(1) + '" cy="' + (cy + py * k).toFixed(1) + '" r="' + r.toFixed(1) + '" fill="var(--pip)"/>';
    }).join('');
  }
  /** A tile at (x,y); horizontal shows a|b left to right, vertical shows a over b. */
  function tileSVG(x, y, a, b, u, vertical, cls) {
    const w = vertical ? u : 2 * u, h = vertical ? 2 * u : u;
    let s = '<g class="' + (cls || '') + '"><rect x="' + (x + 0.5) + '" y="' + (y + 0.5) + '" width="' + (w - 1) + '" height="' + (h - 1)
      + '" rx="' + (u * 0.14).toFixed(1) + '" fill="var(--tile)" stroke="var(--tile-edge)"/>';
    if (vertical) {
      s += '<line x1="' + (x + u * 0.18) + '" y1="' + (y + u) + '" x2="' + (x + u * 0.82) + '" y2="' + (y + u) + '" stroke="var(--tile-edge)" stroke-width="1"/>';
      s += pips(a, x + u / 2, y + u / 2, u, false) + pips(b, x + u / 2, y + 1.5 * u, u, false);
    } else {
      s += '<line x1="' + (x + u) + '" y1="' + (y + u * 0.18) + '" x2="' + (x + u) + '" y2="' + (y + u * 0.82) + '" stroke="var(--tile-edge)" stroke-width="1"/>';
      s += pips(a, x + u / 2, y + u / 2, u, true) + pips(b, x + 1.5 * u, y + u / 2, u, true);
    }
    return s + '</g>';
  }
  function tileIcon(t, u, vertical) {
    u = u || 12;
    const w = vertical ? u : 2 * u, h = vertical ? 2 * u : u;
    return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" aria-label="' + TN(t) + '">'
      + tileSVG(0, 0, D.HIGH[t], D.LOW[t], u, vertical) + '</svg>';
  }

  /** The chain as a snake: rows alternate direction so the line reads continuously. */
  function chainSVG(chain, width, lastIndex) {
    if (!chain.length) return '';
    width = Math.max(220, Math.floor(width));
    const u = Math.max(13, Math.min(24, Math.floor(width / 17)));
    const gap = 3;
    const items = chain.map(([a, b], i) => ({ a, b, dbl: a === b, w: a === b ? u : 2 * u, i }));
    const rows = [];
    let row = [], rw = 0;
    for (const it of items) {
      if (row.length && rw + it.w > width) { rows.push(row); row = []; rw = 0; }
      row.push(it); rw += it.w + gap;
    }
    if (row.length) rows.push(row);
    const rowH = 2 * u + 12;
    const H = rows.length * rowH;
    let s = '<svg viewBox="0 0 ' + width + ' ' + H + '" width="' + width + '" height="' + H + '" role="img" aria-label="Chain of '
      + chain.length + ' tiles">';
    rows.forEach((r, ri) => {
      const rtl = ri % 2 === 1;
      const y0 = ri * rowH + 6;
      let x = rtl ? width : 0;
      r.forEach((it) => {
        if (rtl) x -= it.w;
        const y = it.dbl ? y0 : y0 + u / 2;
        const cls = it.i === lastIndex ? 'last' : '';
        // Reading right to left, the connecting face sits on the right.
        const [fa, fb] = rtl ? [it.b, it.a] : [it.a, it.b];
        s += tileSVG(x, y, fa, fb, u, it.dbl, cls);
        if (it.i === lastIndex) {
          s += '<rect x="' + (x - 2) + '" y="' + (y - 2) + '" width="' + (it.w + 4) + '" height="' + ((it.dbl ? 2 * u : u) + 4)
            + '" rx="4" fill="none" stroke="var(--focus)" stroke-width="2"/>';
        }
        if (rtl) x -= gap; else x += it.w + gap;
      });
      if (ri < rows.length - 1) {
        const cx = rtl ? 6 : width - 6;
        s += '<path d="M' + cx + ' ' + (y0 + u) + ' v' + (rowH) + '" stroke="var(--mesa-ink)" stroke-opacity=".35" stroke-width="2" stroke-dasharray="3 3" fill="none"/>';
      }
    });
    return s + '</svg>';
  }

  // ================================================================ engine plumbing
  const analyst = makeEngine(onAnalyst);
  const player = makeEngine(onPlayer);
  // The trained network (dominord/train), if the build embedded one or the
  // dev server has web/models/dominord-net.json.
  const NETINFO = { doc: null, meta: null };
  function installNet(doc) {
    try {
      const net = D.setNet(doc);
      NETINFO.doc = doc; NETINFO.meta = net.meta || {};
      analyst.post({ type: 'net', doc }); player.post({ type: 'net', doc });
      render(); requestAnalysis();
    } catch (e) { console.warn('network not loaded:', e.message); }
  }
  (function loadNet() {
    const tag = document.getElementById('net-doc');
    if (tag && tag.textContent.trim()) { setTimeout(() => installNet(JSON.parse(tag.textContent)), 0); return; }
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      fetch('models/dominord-net.json').then((r) => (r.ok ? r.json() : null)).then((d) => d && installNet(d)).catch(() => {});
    }
  })();
  // A network that has passed the training gate (a duplicate-scored win over the
  // previous champion) drives the search by default; an ungated one only shows
  // its read until you switch it on.
  const netGated = () => !!(NETINFO.meta && NETINFO.meta.promoted_on);
  const netOn = () => !!NETINFO.doc && (S.useNet === undefined ? netGated() : S.useNet);
  const readOn = () => !!NETINFO.doc;
  /** The network's instant read from your seat (no search), cached per position. */
  function netReadNow(t) {
    if (!t || !readOn() || !D.NET || t.currentHand(S.hero) === null) return null;
    const key = S.mode + ':' + S.viewPly + ':' + t.moves.length + ':' + JSON.stringify(t.moves[t.moves.length - 1] || null);
    if (U.nrKey !== key) {
      let r = null;
      try { r = D.netRead(D.NET, t, S.hero); } catch (e) { r = null; }
      U.nr = r; U.nrKey = key;
    }
    return U.nr;
  }
  const netOdds = () => S.odds === 'net' && readOn();
  let anaTimer = 0;

  function analysisWanted(t) {
    if (!t || t.isOver()) return false;
    if (S.mode === 'play' && !S.coach && S.phase === 'hand' && S.viewPly === null) return false;
    return true;
  }
  function requestAnalysis() {
    clearTimeout(anaTimer);
    anaTimer = setTimeout(() => {
      const t = viewTable();
      U.snap = null;
      if (!analysisWanted(t)) {
        U.busy = false;
        analyst.post({ type: 'cancel' });
        renderAnalysis(); renderEval();
        return;
      }
      const id = ++U.anaId;
      U.busy = true;
      U.snapFor = t.moves.length + ':' + (S.viewPly === null ? 'live' : 'past');
      analyst.post({
        type: 'analyze', id, table: t.toJSON(),
        opts: { effort: S.effort, weighting: S.weighting, team: D.teamOf(S.hero), allSeats: true, seed: 17 + t.moves.length, useNet: netOn() },
        scores: S.match.scores,
      });
      renderEval();
    }, 40);
  }
  function onAnalyst(msg) {
    if (msg.id !== U.anaId) return;
    if (msg.type === 'error') { U.busy = false; U.snap = { error: msg.error }; renderAnalysis(); renderEval(); return; }
    U.snap = msg.snap;
    U.busy = !msg.final;
    renderAnalysis(); renderEval(); renderEntry(); renderSeats();
  }
  function onPlayer(msg) {
    if (msg.id !== U.chooseId) return;
    U.thinking = -1;
    if (msg.type === 'error') { say('Engine error: ' + msg.error, 'err'); render(); return; }
    applyMaster(msg.m);
  }
  function levelOpts() {
    const net = !!NETINFO.doc;
    const L = {
      easy: { level: 'easy' },
      net: net ? { level: 'net' } : { effort: 'live' },
      normal: { effort: 'live', useNet: net },
      strong: { effort: 'normal', useNet: net },
      max: { effort: 'deep', useNet: net },
    };
    return Object.assign({ weighting: true, seed: 5 + S.table.moves.length, useNet: false }, L[S.level] || L.normal);
  }

  // ================================================================ actions: setup
  function newSession(cfg) {
    const s = defaultSession();
    s.mode = cfg.mode;
    s.rulesKey = cfg.rulesKey;
    s.rules = D.makeRules(cfg.rulesKey, cfg.overrides || {});
    s.names = cfg.names.slice(0, s.rules.players);
    s.level = cfg.level || 'normal';
    s.coach = cfg.coach !== false;
    s.effort = S.effort; s.weighting = S.weighting;
    S = s;
    U.snap = null; U.pending = null; U.chooseId++; U.thinking = -1;
    say('');
    if (S.mode === 'play') startPlayHand();
    save();
    render();
    requestAnalysis();
  }

  function startReconHand() {
    const d = S.draft;
    const tiles = d.spectate ? null : d.tiles.slice();
    if (tiles && tiles.length !== S.rules.tilesPerPlayer) {
      say('Pick your ' + S.rules.tilesPerPlayer + ' tiles first (' + tiles.length + ' so far), or choose "I can’t see my tiles".', 'err');
      return render();
    }
    let opener = d.opener, forced = -1;
    if (firstHand()) {
      const f = S.rules.firstOpener === 'double_six' && S.rules.firstOpenerMustPlay && n() === 4 ? D.DOUBLE_SIX : -1;
      if (f >= 0 && tiles && tiles.includes(f)) opener = S.hero;
      if (f >= 0 && tiles && !tiles.includes(f) && opener === S.hero) {
        say('You don’t hold the 6|6, so someone else opens. Who has it?', 'err');
        return render();
      }
      forced = f;
    } else if (opener === null) {
      opener = S.match.nextOpener !== null ? S.match.nextOpener : 0;
    }
    if (opener === null || opener === undefined) {
      say('Who makes the salida? Pick a seat.', 'err');
      return render();
    }
    const t = new D.Table({ rules: S.rules, opener, hero: S.hero, forcedOpen: forced, names: S.names });
    if (tiles) t.setHand(S.hero, tiles);
    else t.known[S.hero] = null;
    S.table = t;
    S.phase = 'hand';
    S.viewPly = null;
    S.draft = { tiles: [], opener: null, spectate: false };
    say(nm(opener) + ' opens.', 'ok');
    save(); render(); requestAnalysis();
  }

  function startPlayHand() {
    const dl = D.deal(S.rules, Math.random);
    let opener, forced = -1;
    if (firstHand()) {
      const o = D.firstOpening(S.rules, dl.hands);
      opener = o.seat; forced = o.tile;
    } else {
      opener = S.match.nextOpener !== null ? S.match.nextOpener : 0;
    }
    const t = new D.Table({ rules: S.rules, opener, hero: S.hero, forcedOpen: forced, names: S.names });
    dl.hands.forEach((h, s) => t.setHand(s, h));
    S.table = t;
    S.pozo = dl.pozo;
    S.phase = 'hand';
    S.viewPly = null;
    say(nm(opener) + (forced >= 0 ? ' holds the ' + TN(forced) + ' and opens.' : ' opens.'), 'ok');
    save();
    setTimeout(tick, 250);
  }

  // ================================================================ actions: moves
  function tableForEntry() { return S.table; }

  function tryPlay(tile, end) {
    const t = tableForEntry();
    if (!t || S.phase !== 'hand' || S.viewPly !== null) return;
    if (S.mode === 'play' && t.turn !== S.hero) return;
    const p = t.turn;
    let e = end || null;
    if (!e) {
      try { e = t.resolveEnd(tile, null); } catch (err) { say(err.message, 'err'); return render(); }
      if (e === null) { U.pending = { tile }; say('[' + TN(tile) + '] fits both ends. Which one?'); return render(); }
    }
    commit({ k: 'play', p, tile, end: e });
  }
  function doPass() {
    const t = tableForEntry();
    if (!t || S.phase !== 'hand') return;
    commit({ k: 'pass', p: t.turn });
  }
  function doDraw(tile) {
    const t = tableForEntry();
    if (!t || S.phase !== 'hand') return;
    const p = t.turn;
    if (S.mode === 'table' && t.currentHand(p) !== null && !(tile >= 0)) {
      U.pending = { draw: true };
      say('Tap the tile you drew.');
      return render();
    }
    commit({ k: 'draw', p, tile: tile >= 0 ? tile : -1 });
  }

  function coachNote(mv) {
    const snap = U.snap;
    if (!snap || !snap.moves || snap.seat !== S.hero || mv.p !== S.hero || mv.k !== 'play') return;
    if (U.snapFor !== S.table.moves.length + ':live') return;
    const best = snap.moves[0];
    const mine = snap.moves.find((m) => m.tile === mv.tile && (m.end === mv.end || !S.table.d.chain.length || S.table.d.left === S.table.d.right));
    if (!best || !mine || best === mine) return;
    const loss = best.ev - mine.ev;
    if (loss >= 1.5) toast('Engine preferred ' + TN(best.tile) + ' (' + sgn(loss) + ' pts on average)');
  }

  function commit(mv) {
    const t = tableForEntry();
    coachNote(mv);
    try {
      t.record(mv);
    } catch (err) {
      say(err.message, 'err');
      return render();
    }
    U.pending = null;
    const d = t.d;
    const what = mv.k === 'pass' ? 'passes' : mv.k === 'draw' ? 'draws' + (mv.tile >= 0 && (S.mode === 'table' || mv.p === S.hero) ? ' ' + TN(mv.tile) : '') : 'plays ' + TN(mv.tile);
    say(nm(mv.p) + ' ' + what + '.' + (d.pcEvents.length && mv.k === 'pass' && d.passes === n() - 1 && S.rules.pasoCorridoBonus ? ' ¡Paso corrido for ' + nm(d.last) + '!' : ''), 'ok');
    afterMove();
  }

  function afterMove() {
    const t = S.table;
    if (t.isOver()) handOver();
    save();
    render();
    requestAnalysis();
    if (S.mode === 'play') tick();
  }

  function applyMaster(m) {
    const t = S.table;
    if (!t || S.phase !== 'hand') return;
    const rec = D.toRecord(t, m);
    if (rec.k === 'draw') rec.tile = S.pozo.shift();
    try { t.record(rec); } catch (err) { say('Engine move rejected: ' + err.message, 'err'); return render(); }
    const who = nm(rec.p);
    if (rec.k === 'play') say(who + ' plays ' + TN(rec.tile) + '.', 'ok');
    else if (rec.k === 'pass') say(who + ' passes.', 'ok');
    else say(who + (rec.p === S.hero ? ' drew ' + TN(rec.tile) : ' draws from the pozo') + '.', 'ok');
    afterMove();
  }

  /** Play mode: whose move is it, and does anything happen on its own? */
  function tick() {
    if (S.mode !== 'play' || S.phase !== 'hand' || !S.table) return;
    const t = S.table;
    if (t.isOver()) return;
    const p = t.turn;
    if (p === S.hero) {
      const legal = t.legalPlays(p);
      if (legal.length === 1 && legal[0] < 0) {
        const id = ++U.chooseId;
        setTimeout(() => { if (id === U.chooseId) applyMaster(legal[0]); }, legal[0] === D.DRAW ? 550 : 800);
      }
      return;
    }
    const id = ++U.chooseId;
    U.thinking = p;
    renderSeats();
    const snapshot = t.toJSON();
    setTimeout(() => { if (id === U.chooseId) player.post({ type: 'choose', id, table: snapshot, opts: levelOpts() }); }, 320);
  }

  function undo() {
    const t = S.table;
    if (!t || !t.moves.length) return;
    U.chooseId++; U.thinking = -1; U.pending = null;
    if (S.phase !== 'hand') { S.phase = 'hand'; S.lastResult = null; }
    if (S.mode === 'play') {
      // Take back to before your last play (engine replies go with it).
      while (t.moves.length) {
        const mv = t.undo();
        if (mv.k === 'draw') S.pozo.unshift(mv.tile);
        if (mv.p === S.hero && mv.k === 'play') break;
      }
    } else {
      t.undo();
    }
    say('Undone.', 'ok');
    S.viewPly = null;
    save(); render(); requestAnalysis();
    if (S.mode === 'play') tick();
  }

  // ================================================================ hand end
  function handOver() {
    const t = S.table;
    U.chooseId++; U.thinking = -1;
    const bel = beliefsOf(t);
    if (bel && bel.total === 1) {
      const a = bel.sample(() => 0.5);
      const pips = [];
      for (let s = 0; s < n(); s++) {
        const h = t.currentHand(s);
        const b = bel.bucketOf[s];
        pips.push(D.pipsOf(h !== null ? h : b !== undefined ? a[b] : 0));
      }
      finishWithPips(pips);
    } else {
      S.phase = 'scoring';
    }
  }
  function finishWithPips(pips) {
    const t = S.table;
    let res;
    try { res = t.scoreFinished(pips); } catch (err) { say(err.message, 'err'); return render(); }
    if (res.winningTeam !== null) S.match.scores[res.winningTeam] += res.points;
    S.match.results.push({ kind: res.kind, winner: res.winner, winningTeam: res.winningTeam, points: res.points, bonuses: res.bonuses, notes: res.notes, handPips: res.handPips });
    S.match.nextOpener = res.nextOpener;
    S.lastResult = res;
    const champ = S.match.scores.findIndex((x) => x >= S.rules.targetScore);
    S.phase = champ >= 0 ? 'matchover' : 'handover';
    say('');
    save();
  }
  function nextHand() {
    S.lastResult = null;
    S.viewPly = null;
    if (S.phase === 'matchover') { S.match = newMatch(); }
    if (S.mode === 'play') { startPlayHand(); render(); requestAnalysis(); return; }
    S.phase = 'deal';
    S.table = null;
    S.draft = { tiles: [], opener: firstHand() ? null : S.match.nextOpener, spectate: false };
    save(); render(); requestAnalysis();
  }

  // ================================================================ quick entry
  function seatByName(word) {
    const w = word.toLowerCase();
    if (['yo', 'me', 'i', 'you'].includes(w)) return S.hero;
    if (/^p?[0-3]$/.test(w)) return +w.replace('p', '');
    const hits = S.names.map((x, i) => [x.toLowerCase(), i]).filter(([x]) => x.startsWith(w));
    return hits.length === 1 ? hits[0][1] : -1;
  }
  function runCommand(text) {
    const toks = text.trim().split(/\s+/).filter(Boolean);
    if (!toks.length) return;
    const w0 = toks[0].toLowerCase();
    if (['undo', 'u', 'deshacer', 'z'].includes(w0)) return undo();
    if (['mano', 'hand'].includes(w0) && S.phase === 'deal') {
      try { S.draft.tiles = D.parseTiles(toks.slice(1).join(' ')); say('Hand set.', 'ok'); } catch (e) { say(e.message, 'err'); }
      return render();
    }
    if (S.phase !== 'hand') { say('No hand in progress.', 'err'); return render(); }
    const t = tableForEntry();
    let i = 0;
    let seat = t.turn;
    const maybeSeat = seatByName(toks[0]);
    if (maybeSeat >= 0 && !/^[0-6][-|:/]?[0-6]$/.test(toks[0])) { seat = maybeSeat; i = 1; }
    let verb = (toks[i] || '').toLowerCase();
    if (['paso', 'pass', 'p'].includes(w0) && i === 0) {
      if (toks[1]) { const s = seatByName(toks[1]); if (s >= 0) seat = s; }
      if (seat !== t.turn) { say('It is ' + nm(t.turn) + '’s turn.', 'err'); return render(); }
      return doPass();
    }
    if (['paso', 'pass', 'p'].includes(verb)) { if (seat !== t.turn) { say('It is ' + nm(t.turn) + '’s turn.', 'err'); return render(); } return doPass(); }
    if (['robo', 'roba', 'draw', 'r'].includes(verb)) {
      let tile = -1;
      if (toks[i + 1]) { try { tile = D.parseTile(toks[i + 1]); } catch (e) { say(e.message, 'err'); return render(); } }
      return doDraw(tile);
    }
    if (seat !== t.turn) { say('It is ' + nm(t.turn) + '’s turn, not ' + nm(seat) + '’s.', 'err'); return render(); }
    let tile;
    try { tile = D.parseTile(toks[i]); } catch (e) { say(e.message + '. Try "6-4", "paso" or "undo".', 'err'); return render(); }
    const e = (toks[i + 1] || '').toLowerCase();
    const end = ['l', 'left', 'izq', 'i'].includes(e) ? 'L' : ['r', 'right', 'der', 'd'].includes(e) ? 'R' : null;
    tryPlay(tile, end);
  }

  // ================================================================ render: header
  function renderHeader() {
    const r = S.rules;
    const us = D.teamOf(S.hero), them = 1 - us;
    $('#topbar').innerHTML =
      '<div class="brand"><h1>Dominord</h1><span class="sub">' + esc(r.label) + '</span></div>'
      + '<div class="modes" role="group" aria-label="Mode">'
      + '<button data-act="mode" data-v="table" aria-pressed="' + (S.mode === 'table') + '">Reconstruct</button>'
      + '<button data-act="mode" data-v="play" aria-pressed="' + (S.mode === 'play') + '">Play</button></div>'
      + '<div class="score" aria-label="Match score">'
      + '<span class="team us">' + esc(teamName(us)) + ' <b>' + S.match.scores[us] + '</b></span>'
      + '<span class="team them"><b>' + S.match.scores[them] + '</b> ' + esc(teamName(them)) + '</span>'
      + '<span class="target">to ' + r.targetScore + '</span></div>'
      + '<div class="tools"><button class="btn" data-act="newmatch">New match</button><button class="btn" data-act="files">Save / load</button></div>';
  }

  // ================================================================ render: eval bar
  function netMark() {
    const r = netReadNow(viewTable());
    if (!r) return '';
    const v = 50 + 50 * Math.tanh(r.ev / 35);
    const narrow = window.matchMedia('(max-width: 640px)').matches;
    return '<div class="netmark" title="Network: ' + sgn(r.ev) + ' pts" style="' + (narrow ? 'left:' + v.toFixed(1) + '%' : 'bottom:' + v.toFixed(1) + '%') + '"></div>';
  }
  function renderEval() {
    const el = $('#evalbar');
    const s = U.snap;
    const narrow = window.matchMedia('(max-width: 640px)').matches;
    el.classList.toggle('busy', U.busy);
    if (!s || s.ev === undefined) {
      el.innerHTML = '<div class="fill" style="' + (narrow ? 'width:50%' : 'height:50%') + '"></div><div class="mid"></div>' + netMark();
      el.setAttribute('aria-valuetext', 'no evaluation');
      return;
    }
    const f = (x) => 50 + 50 * Math.tanh(x / 35);
    const v = f(s.ev), lo = f(s.lo), hi = f(s.hi);
    const fill = narrow ? 'width:' + v.toFixed(1) + '%' : 'height:' + v.toFixed(1) + '%';
    const band = narrow ? 'left:auto;right:' + (100 - hi).toFixed(1) + '%;width:' + (hi - lo).toFixed(1) + '%' : 'top:' + (100 - hi).toFixed(1) + '%;height:' + (hi - lo).toFixed(1) + '%';
    el.innerHTML = '<div class="fill" style="' + fill + '"></div><div class="band" style="' + band + '"></div><div class="mid"></div>'
      + '<div class="val top">' + (s.ev < 0 ? sgn(s.ev, 0) : '') + '</div><div class="val bot">' + (s.ev >= 0 ? sgn(s.ev, 0) : '') + '</div>'
      + netMark();
    el.setAttribute('aria-valuetext', 'expected ' + sgn(s.ev) + ' points for us');
  }

  // ================================================================ render: seats and chain
  function renderSeats() {
    const t = viewTable();
    const grid = $('#mesa');
    grid.classList.toggle('two', n() === 2);
    const master = S.table;
    const bel = t ? beliefsOf(t) : null;
    const d = t ? t.d : null;
    let html = '';
    const revealAll = S.mode === 'play' && S.phase !== 'hand' && master;
    for (let s = 0; s < n(); s++) {
      const pos = posOf(s);
      const side = sideOf(s);
      const isTurn = t && !t.isOver() && S.phase === 'hand' && d.turn === s;
      const count = d ? d.counts[s] : S.rules.tilesPerPlayer;
      const hand = t ? t.currentHand(s) : null;
      const exp = bel ? bel.expectedPips(s) : null;
      const voids = d ? D.tilesOf(d.voids[s] & 0x7f) : [];
      let last = '';
      if (d) {
        for (let i = t.moves.length - 1; i >= 0; i--) {
          const mv = t.moves[i];
          if (mv.p !== s) continue;
          last = mv.k === 'pass' ? 'passed' : mv.k === 'draw' ? 'drew' : 'played ' + TN(mv.tile);
          break;
        }
      }
      html += '<div class="seat ' + pos + ' ' + side + (isTurn ? ' turn' : '') + '">'
        + '<div class="who"><span class="dot"></span><span class="nm">' + esc(nm(s)) + '</span>'
        + (isTurn ? '<span class="turntag">' + (U.thinking === s ? 'thinking' : 'to play') + '</span>' : '') + '</div>'
        + '<div class="backs" aria-label="' + count + ' tiles">' + '<i></i>'.repeat(Math.max(0, count)) + '</div>'
        + '<div class="stats"><span><b>' + count + '</b> tiles</span>'
        + (exp !== null ? '<span>' + (hand !== null ? '' : '≈') + '<b>' + exp.toFixed(hand !== null ? 0 : 1) + '</b> pts</span>' : '') + '</div>';
      const sty = U.snap && U.snap.styles && U.snap.styles[s];
      if (sty && t && t.moves.some((m) => m.p === s && m.k === 'play')) {
        let top = null;
        for (const k in sty) if (!top || sty[k] > sty[top]) top = k;
        html += '<div class="style" title="How this player has been choosing, judged from every play so far">'
          + 'plays <b>' + esc(D.STYLE_LABEL[top]) + '</b> ' + pct(sty[top]) + '</div>';
      }
      if (voids.length) {
        html += '<div class="voids">' + voids.map((v) => '<span class="chip void ' + (side === 'us' ? 'us' : '') + '" title="' + esc(nm(s)) + ' cannot hold a ' + v + '">no ' + v + '</span>').join('') + '</div>';
      }
      if (revealAll) {
        const h = master.currentHand(s);
        if (h) html += '<div class="revealed">' + D.tilesOf(h).map((x) => tileIcon(x, 9)).join('') + '</div>';
      }
      html += '<div class="lastact">' + esc(last) + '</div></div>';
    }
    if (n() === 2 && d) {
      html += '<div class="seat pozo"><div class="who"><span class="dot"></span><span class="nm">Pozo</span></div>'
        + '<div class="stats"><span><b>' + d.pozo + '</b> tiles ' + (S.rules.draw ? 'to draw' : 'asleep') + '</span></div></div>';
    }
    // centre: the chain
    let center = '<div class="center">';
    if (d && d.chain.length) {
      center += '<div class="ends"><span>Left end<b>' + d.left + '</b></span><span>' + d.chain.length + ' on the table</span><span>Right end<b>' + d.right + '</b></span></div>';
    }
    center += '<div class="chainbox" id="chainbox">';
    if (!d || !d.chain.length) {
      center += '<div class="empty">' + (S.phase === 'deal' ? 'Enter your hand below to start the hand.' : t ? esc(nm(d.turn)) + ' makes the salida.' : '') + '</div>';
    }
    center += '</div></div>';
    grid.innerHTML = html + center;
    if (d && d.chain.length) {
      const box = $('#chainbox');
      let lastIdx = -1;
      const lm = [...t.moves].reverse().find((m) => m.k === 'play');
      if (lm) {
        // where did the last tile land?
        lastIdx = lm.end === 'L' && d.chain.length > 1 ? 0 : d.chain.length - 1;
        if (t.moves.filter((m) => m.k === 'play').length === 1) lastIdx = 0;
      }
      box.innerHTML = chainSVG(d.chain, box.clientWidth - 4, lastIdx);
    }
  }

  // ================================================================ render: entry
  function probCell(bel, t, tile) {
    // Stacked bar: who holds this tile, seat by seat (plus the pozo in 1v1).
    const nr = netOdds() ? netReadNow(t) : null;
    if (nr && nr.belief) {
      const prob = (s, x) => nr.belief[x * (n() + 1) + s];
      bel = Object.assign({}, bel, { prob: (s, x) => (bel.prob(s, x) === 1 ? 1 : prob(s, x)) });
    }
    const order = [];
    for (let k = 1; k < n(); k++) order.push((S.hero + k) % n());
    if (bel.bucketOf[n()] !== undefined) order.push(n());
    let bar = '', top = -1, topP = 0;
    for (const s of order) {
      const p = bel.prob(s, tile);
      if (p > 0.001) bar += '<span style="width:' + (p * 100).toFixed(1) + '%;background:' + seatColor(s) + '"></span>';
      if (p > topP) { topP = p; top = s; }
    }
    return { bar, top, topP };
  }

  function gridHTML(t, bel, mode) {
    // mode: 'deal' (pick your 7) | 'play' (record a tile) | 'view'
    const d = t ? t.d : null;
    const mine = t ? t.currentHand(S.hero) : null;
    const turn = d ? d.turn : -1;
    const turnHand = t && S.phase === 'hand' ? t.currentHand(turn) : null;
    const snap = U.snap;
    const bestTile = snap && snap.moves && snap.moves.length && snap.seat === S.hero && snap.moves[0].tile >= 0 ? snap.moves[0].tile : -1;
    let legalSet = null;
    if (mode === 'play' && turnHand !== null) {
      legalSet = new Set(t.legalPlays(turn).filter((m) => m >= 0).map((m) => m >> 1));
    }
    const drawPick = U.pending && U.pending.draw;
    let html = '<div class="grid28" role="grid" aria-label="The 28 tiles">';
    for (let hi = 6; hi >= 0; hi--) {
      for (let lo = 0; lo <= 6; lo++) {
        if (lo > hi) { html += '<div class="cell-empty"></div>'; continue; }
        const tile = D.tileId(lo, hi);
        const cls = ['cell'];
        let inner = '<span class="face"><span>' + hi + '</span><s></s><span>' + lo + '</span></span>';
        let can = false;
        let title = TN(tile);
        if (mode === 'deal') {
          const sel = S.draft.tiles.includes(tile);
          if (sel) cls.push('sel');
          can = true;
          inner += '<span class="pct">' + (sel ? 'mine' : '&nbsp;') + '</span>';
        } else if (d && (d.played >> tile) & 1) {
          cls.push('played');
          inner += '<span class="pct">played</span>';
          title += ': on the table';
        } else if (mine !== null && (mine >> tile) & 1) {
          cls.push('mine');
          inner += '<span class="pct">yours</span>';
          title += ': in your hand';
          if (mode === 'play' && legalSet && turn === S.hero) can = legalSet.has(tile);
          if (tile === bestTile && S.phase === 'hand' && turn === S.hero) cls.push('best');
        } else if (bel) {
          const pc = probCell(bel, t, tile);
          inner += '<span class="pbar">' + pc.bar + '</span><span class="pct">' + (pc.top >= 0 ? Math.round(pc.topP * 100) + '%' : '') + '</span>';
          if (pc.topP > 0.999) inner += '<span class="sure" style="background:' + seatColor(pc.top) + '">' + esc(nm(pc.top).slice(0, 1)) + '</span>';
          title += ': ' + [...Array(n() + 1).keys()].filter((s) => bel.prob(s, tile) > 0.0005).map((s) => nm(s) + ' ' + pct(bel.prob(s, tile))).join(', ');
          if (mode === 'play') {
            if (drawPick) can = true;
            else if (turnHand === null) {
              // An unknown seat: any unseen tile that fits the ends and is not ruled out for them.
              const fits = !d.chain.length || D.hasSuit(tile, d.left) || D.hasSuit(tile, d.right);
              const possible = bel.prob(turn, tile) > 0 || (S.rules.draw && d.drawStreak === turn);
              can = fits && possible && (!d.chain.length ? (t.forcedOpen < 0 || tile === t.forcedOpen) : true);
            }
          }
        }
        if (mode === 'play' && !can && !cls.includes('played') && !cls.includes('mine')) cls.push('off');
        if (can) cls.push('can');
        html += '<button class="' + cls.join(' ') + '" data-act="tile" data-t="' + tile + '"' + (can ? '' : ' disabled') + ' title="' + esc(title) + '">' + inner + '</button>';
      }
    }
    return html + '</div>';
  }

  function legendHTML(bel) {
    if (!bel) return '';
    const order = [];
    for (let k = 1; k < n(); k++) order.push((S.hero + k) % n());
    if (bel.bucketOf[n()] !== undefined) order.push(n());
    const src = readOn() && D.NET && D.NET.hasBelief
      ? '<span class="modes small" role="group" aria-label="Odds source"><button data-act="odds" data-v="exact" aria-pressed="' + !netOdds() + '">Exact</button>'
        + '<button data-act="odds" data-v="net" aria-pressed="' + netOdds() + '">Network</button></span>' : '';
    return '<div class="legend"><span class="label">Who holds it</span>' + src + order.map((s) => '<span><i style="background:' + seatColor(s) + '"></i>' + esc(nm(s)) + '</span>').join('')
      + (netOdds() ? '<span>· network read, masked by what is certain</span></div>'
        : '<span>· exact over ' + bel.total.toLocaleString() + ' possible deal' + (bel.total === 1 ? '' : 's') + '</span></div>');
  }

  function renderEntry() {
    const el = $('#entry');
    const t = viewTable();
    let html = '';
    if (S.viewPly !== null) {
      html += '<div class="viewing"><span>Viewing the position after move ' + S.viewPly + '</span><button class="btn small" data-act="live">Back to live</button></div>';
    }
    if (S.phase === 'deal' && S.mode === 'table') {
      const k = S.draft.tiles.length;
      const first = firstHand();
      html += '<div class="prompt"><span class="say">Your hand: tap your ' + S.rules.tilesPerPlayer + ' tiles <span class="num">(' + k + '/' + S.rules.tilesPerPlayer + ')</span></span>'
        + '<div class="actions"><button class="btn" data-act="spectate">I can’t see my tiles</button>'
        + '<button class="btn primary" data-act="starthand"' + (k === S.rules.tilesPerPlayer ? '' : ' disabled') + '>Start hand</button></div></div>';
      const holdsSix = S.draft.tiles.includes(D.DOUBLE_SIX);
      const forced = first && S.rules.firstOpener === 'double_six' && n() === 4;
      html += '<div class="msg ' + U.msgKind + '">' + esc(U.msg) + '</div>';
      if (!(forced && holdsSix)) {
        const q = forced ? 'Who has the 6|6?' : first ? 'Who makes the salida?' : 'Salida (last hand’s winner by default):';
        const cur = S.draft.opener !== null ? S.draft.opener : (!first ? S.match.nextOpener : null);
        html += '<div class="prompt" style="margin-bottom:8px"><span class="label">' + q + '</span><div class="seg" style="flex:1">'
          + [...Array(n()).keys()].filter((s) => !(forced && s === S.hero)).map((s) => '<button data-act="opener" data-s="' + s + '" aria-pressed="' + (cur === s) + '"><b>' + esc(nm(s)) + '</b></button>').join('') + '</div></div>';
      } else {
        html += '<div class="hint" style="margin-bottom:8px">You hold the 6|6, so the salida is yours.</div>';
      }
      html += gridHTML(null, null, 'deal');
      el.innerHTML = html;
      return;
    }
    if (!S.table) {
      el.innerHTML = '<div class="prompt"><span class="say">No hand in progress.</span><div class="actions"><button class="btn primary" data-act="newmatch">New match</button></div></div>';
      return;
    }
    const d = t.d;
    const bel = beliefsOf(t);
    if (S.phase === 'hand' && S.viewPly === null) {
      const p = d.turn;
      const known = t.currentHand(p) !== null;
      const side = sideOf(p);
      let prompt;
      if (S.mode === 'play' && p !== S.hero) prompt = '<span class="nm ' + side + '">' + esc(nm(p)) + '</span> is thinking…';
      else if (S.mode === 'play') prompt = 'Your move' + (d.chain.length ? ' — ends <span class="num">' + d.left + '</span> and <span class="num">' + d.right + '</span>' : ' — make the salida');
      else prompt = 'What does <span class="nm ' + side + '">' + esc(nm(p)) + '</span> do?' + (known ? '' : ' Tap the tile they lay.');
      const canPass = d.chain.length && !(S.rules.draw && d.pozo > 0);
      const canDraw = S.rules.draw && d.chain.length && d.pozo > 0;
      html += '<div class="prompt"><span class="say">' + prompt + '</span><div class="actions">';
      if (S.mode === 'table') {
        if (canPass) html += '<button class="btn" data-act="pass">Paso</button>';
        if (canDraw) html += '<button class="btn" data-act="draw">' + (known ? 'Drew…' : 'Drew one') + '</button>';
      }
      html += '<button class="btn" data-act="undo"' + (t.moves.length ? '' : ' disabled') + '>' + (S.mode === 'play' ? 'Take back' : 'Undo') + '</button></div></div>';
      if (U.pending && U.pending.tile !== undefined) {
        html += '<div class="endpick"><span>Lay ' + tileIcon(U.pending.tile, 11) + ' on</span>'
          + '<button class="btn us" data-act="end" data-e="L">Left end (' + d.left + ')</button>'
          + '<button class="btn us" data-act="end" data-e="R">Right end (' + d.right + ')</button>'
          + '<button class="btn small" data-act="cancelpend">Cancel</button></div>';
      }
      html += '<div class="msg ' + U.msgKind + '">' + esc(U.msg) + '</div>';
      if (S.mode === 'play') {
        html += myHandHTML(t);
        if (S.coach) html += legendHTML(bel) + gridHTML(t, bel, 'view');
      } else {
        html += legendHTML(bel) + gridHTML(t, bel, 'play');
      }
    } else if (S.phase === 'hand') {
      html += legendHTML(bel) + gridHTML(t, bel, 'view');
    } else if (S.phase === 'scoring') {
      html += scoringHTML(t, bel);
    } else if (S.phase === 'handover' || S.phase === 'matchover') {
      html += resultHTML();
      html += legendHTML(bel) + gridHTML(t, bel, 'view');
    }
    el.innerHTML = html;
  }

  function myHandHTML(t) {
    const h = t.currentHand(S.hero);
    if (h === null) return '';
    const myTurn = t.turn === S.hero;
    const legal = myTurn ? new Set(t.legalPlays(S.hero).filter((m) => m >= 0).map((m) => m >> 1)) : new Set();
    const snap = U.snap;
    const evs = {};
    if (snap && snap.moves && snap.seat === S.hero && S.coach) {
      for (const m of snap.moves) if (m.tile >= 0 && (evs[m.tile] === undefined || m.ev > evs[m.tile])) evs[m.tile] = m.ev;
    }
    const best = snap && snap.moves && snap.moves.length && snap.seat === S.hero && S.coach ? snap.moves[0].tile : -1;
    return '<div class="myhand" aria-label="Your hand">' + D.tilesOf(h).map((x) => {
      const can = legal.has(x);
      return '<div><button data-act="tile" data-t="' + x + '"' + (can ? '' : ' disabled') + (x === best && myTurn ? ' class="best"' : '') + ' title="' + TN(x) + '">'
        + tileIcon(x, 22, true) + '</button>' + (evs[x] !== undefined && myTurn ? '<span class="ev">' + sgn(evs[x]) + '</span>' : '<span class="ev">&nbsp;</span>') + '</div>';
    }).join('') + '</div>';
  }

  function scoringHTML(t, bel) {
    const d = t.d;
    const w = t.dominoPlayer();
    let html = '<div class="result"><div class="big">' + (w >= 0 ? esc(nm(w)) + ' is out — ¡dominó!' : '¡Tranque! The table is blocked.') + '</div>'
      + '<div>Enter the points each player shows (the pips left in hand). Blank seats use the engine’s estimate.</div>'
      + '<div class="pipinputs">';
    for (let s = 0; s < n(); s++) {
      const h = t.currentHand(s);
      const fixed = h !== null ? D.pipsOf(h) : d.counts[s] === 0 ? 0 : null;
      const est = bel ? bel.expectedPips(s) : 0;
      html += '<label class="field"><span class="label">' + esc(nm(s)) + ' (' + d.counts[s] + ' tiles)</span>'
        + '<input id="pips' + s + '" inputmode="numeric" ' + (fixed !== null ? 'value="' + fixed + '" disabled' : 'placeholder="≈ ' + est.toFixed(0) + '"') + '></label>';
    }
    html += '</div><div class="actions"><button class="btn" data-act="undo">Undo last move</button><button class="btn primary" data-act="score">Score the hand</button></div></div>'
      + '<div class="msg ' + U.msgKind + '">' + esc(U.msg) + '</div>';
    return html;
  }

  function resultHTML() {
    const r = S.lastResult;
    if (!r) return '';
    const us = D.teamOf(S.hero);
    const cls = r.winningTeam === null ? '' : r.winningTeam === us ? 'us' : 'them';
    const head = r.kind === 'void' ? 'Tied tranque — nobody scores'
      : (r.kind === 'domino' ? '¡Dominó! ' : '¡Tranque! ') + esc(nm(r.winner)) + ' takes ' + r.points + ' for ' + esc(teamName(r.winningTeam));
    const bon = r.bonuses.length ? r.bonuses.map((b) => b[0].replace('_', ' ') + ' +' + b[1]).join(', ') : '';
    const champ = S.match.scores.findIndex((x) => x >= S.rules.targetScore);
    let html = '<div class="result ' + cls + '"><div class="big">' + head + '</div>'
      + '<div>Pips left: ' + r.handPips.map((p, s) => esc(nm(s)) + ' <span class="num">' + p + '</span>').join(' · ')
      + (bon ? ' · Bonuses: ' + esc(bon) : '') + (r.notes && r.notes.length ? ' · ' + esc(r.notes.join(' ')) : '') + '</div>';
    if (champ >= 0) {
      const pollona = S.match.scores[1 - champ] === 0;
      html += '<div class="big">' + esc(teamName(champ)) + ' win the match ' + S.match.scores[champ] + '–' + S.match.scores[1 - champ] + (pollona ? ' — ¡pollona!' : '') + '</div>';
    }
    html += '<div class="actions"><button class="btn" data-act="undo">Undo last move</button><button class="btn primary" data-act="nexthand">' + (champ >= 0 ? 'New match' : 'Next hand') + '</button></div></div>';
    return html;
  }

  // ================================================================ render: analysis
  function moveLabel(m) {
    if (m.pass) return 'Paso';
    if (m.draw) return 'Draw';
    return '<span class="mv">' + tileIcon(m.tile, 10) + '<span>' + TN(m.tile) + '</span>' + (m.end && U.snapChain ? '<span class="arrow">' + (m.end === 'L' ? '← left' : 'right →') + '</span>' : '') + '</span>';
  }
  function ciBar(m, scale) {
    const f = (x) => Math.max(0, Math.min(100, 50 + (x / scale) * 50));
    return '<span class="ci"><i style="left:' + f(m.lo).toFixed(1) + '%;width:' + Math.max(1, f(m.hi) - f(m.lo)).toFixed(1) + '%"></i><b style="left:' + f(m.ev).toFixed(1) + '%"></b></span>';
  }
  function movesTable(list, known) {
    if (!list || !list.length) return '<div class="hint">No options.</div>';
    const scale = Math.max(20, ...list.map((m) => Math.max(Math.abs(m.lo), Math.abs(m.hi))));
    let html = '<table class="moves"><thead><tr><th>' + (known ? 'Move' : 'Likely play') + '</th>' + (known ? '' : '<th>odds</th>')
      + '<th>points</th><th>win</th><th>tranque</th></tr></thead><tbody>';
    list.forEach((m, i) => {
      html += '<tr class="' + (i === 0 ? 'top' : '') + '"><td>' + moveLabel(m) + '</td>' + (known ? '' : '<td>' + pct(m.choice) + '</td>')
        + '<td>' + sgn(m.ev) + ciBar(m, scale) + '</td><td>' + pct(m.win) + '</td><td>' + pct(m.tranque) + '</td></tr>';
    });
    return html + '</tbody></table>';
  }

  function renderAnalysis() {
    const el = $('#analysis');
    const t = viewTable();
    const s = U.snap;
    let html = '<header><h2>Engine</h2><div class="opts">'
      + '<label>Depth <select id="effort" data-act="effort">'
      + ['live', 'normal', 'deep'].map((e) => '<option value="' + e + '"' + (S.effort === e ? ' selected' : '') + '>' + { live: 'Quick', normal: 'Normal', deep: 'Deep' }[e] + '</option>').join('')
      + '</select></label>'
      + '<label title="Weight each imagined deal by how plausible the players’ choices were under it"><input type="checkbox" id="weighting" data-act="weighting"' + (S.weighting ? ' checked' : '') + '> Read their choices</label>'
      + (NETINFO.doc ? '<label title="Use the self-play network in the search"><input type="checkbox" id="usenet" data-act="usenet"' + (netOn() ? ' checked' : '') + '> Network</label>' : '')
      + (S.mode === 'play' ? '<label><input type="checkbox" id="coach" data-act="coach"' + (S.coach ? ' checked' : '') + '> Coach</label>' : '')
      + '</div></header>';
    if (!t) {
      el.innerHTML = html + '<div class="hint">Start a hand to see the evaluation, the odds and the best plays for every seat.</div>';
      return;
    }
    if (S.mode === 'play' && !S.coach && S.phase === 'hand' && S.viewPly === null) {
      el.innerHTML = html + '<div class="hint">Coach is off: no hints while you play. Turn it on to see the bar, the odds and the engine’s choice.</div>';
      return;
    }
    if (t.isOver()) {
      el.innerHTML = html + '<div class="hint">The hand is over. Scroll back through the history to review any position.</div>' + suitOddsHTML(t);
      return;
    }
    U.snapChain = t.d.chain.length > 0;
    const nrHTML = netReadHTML(t);
    if (!s) {
      el.innerHTML = html + nrHTML + '<div class="hint">Search thinking…</div>' + suitOddsHTML(t);
      return;
    }
    if (s.error) {
      el.innerHTML = html + '<div class="msg err">' + esc(s.error) + '</div>';
      return;
    }
    U.snapChain = t.d.chain.length > 0;
    const us = D.teamOf(S.hero);
    const evCls = s.ev >= 0 ? 'us' : 'them';
    html += '<div class="kpis">'
      + '<div class="kpi ' + evCls + '"><div class="label">This hand, for us</div><div class="v">' + sgn(s.ev) + ' <small>pts ±' + ((s.hi - s.lo) / 2).toFixed(1) + '</small></div></div>'
      + '<div class="kpi"><div class="label">We take the hand</div><div class="v">' + pct(s.win) + '</div></div>'
      + (s.matchWin !== undefined ? '<div class="kpi"><div class="label">We win the match</div><div class="v">' + pct(s.matchWin) + ' <small>was ' + pct(s.matchWinBefore) + '</small></div></div>' : '')
      + '<div class="kpi"><div class="label">Chance of tranque</div><div class="v">' + pct(s.tranqueChance) + ' <small>ours ' + (s.tranqueChance > 0.005 ? pct(s.tranqueWin) : '–') + '</small></div></div>'
      + '</div>';
    const notes = [];
    if (s.winIfNow >= 0.7) notes.push(['good', 'If the table blocked right now, we would take the count (' + pct(s.winIfNow) + '). A tranque suits us.']);
    else if (s.winIfNow <= 0.3 && s.tranqueChance >= 0.2) notes.push(['bad', 'Careful: if it blocks, the count goes to them (' + pct(1 - s.winIfNow) + '). Get rid of weight.']);
    if (s.opportunity) {
      const m = s.opportunity.move;
      notes.push([s.opportunity.ours ? 'good' : 'bad', (s.opportunity.ours ? 'Tranque chance: ' : esc(nm(s.seat)) + ' can block it their way with ') + TN(m.tile) + ' (' + pct(m.tranqueWin) + ' they block and win it).']);
    }
    html += notes.map(([k, x]) => '<div class="note ' + k + '">' + x + '</div>').join('');

    const seat = s.seat;
    const known = t.currentHand(seat) !== null;
    html += '<h3 class="label" style="margin-top:12px">' + (known ? 'Best play for ' : 'What ') + esc(nm(seat)) + (known ? '' : ' will likely play') + '</h3>';
    html += movesTable((s.moves || []).slice(0, 7), known);
    if (s.margin && known && s.moves.length > 1) {
      const z = s.margin.z;
      html += '<div class="hint">' + (z > 2.5 ? 'Clear choice' : z > 1.2 ? 'Probably best' : 'Close call') + ': ' + TN(s.moves[0].tile >= 0 ? s.moves[0].tile : 0) + ' leads the next option by ' + s.margin.mean.toFixed(1) + ' pts (z ' + Math.min(99, z).toFixed(1) + ').</div>';
    }
    if (s.seatMoves) {
      html += '<details><summary>Everyone else’s best options</summary>';
      for (let k = 1; k < n(); k++) {
        const o = (seat + k) % n();
        const list = s.seatMoves[o];
        if (!list) continue;
        html += '<div class="label" style="margin-top:8px">' + esc(nm(o)) + ' if it were their turn</div>' + movesTable(list.slice(0, 3), t.currentHand(o) !== null);
      }
      html += '</details>';
    }
    html += nrHTML;
    html += suitOddsHTML(t);
    html += '<div class="engineinfo">' + (s.exhaustive ? 'Exact over all ' + s.total.toLocaleString() + ' possible deals'
      : s.deals + ' of ' + s.total.toLocaleString() + ' possible deals') + ' · perfect play solved from '
      + ({ live: 22, normal: 24, deep: 28 }[S.effort]) + ' tiles · ' + (s.elapsed / 1000).toFixed(1) + ' s'
      + (S.weighting && s.ess && s.deals ? ' · effective deals ' + Math.round(s.ess) : '')
      + (s.net ? ' · network' + (NETINFO.meta && NETINFO.meta.hands ? ' (' + (NETINFO.meta.hands / 1e6).toFixed(1) + 'M self-play hands)' : '') : '')
      + (U.busy ? ' · thinking…' : '') + '</div>';
    el.innerHTML = html;
  }

  function netReadHTML(t) {
    const r = netReadNow(t);
    if (!r) return '';
    const m = NETINFO.meta || {};
    let html = '<div class="netread"><h3 class="label">Network read · instant, from your seat</h3>'
      + '<div class="hint">' + (m.hands ? (m.hands / 1e6).toFixed(1) + 'M self-play hands · ' : '')
      + (netGated() ? 'passed the strength gate' : 'not yet through the strength gate — treat as a preview') + '</div><div class="kpis">'
      + '<div class="kpi ' + (r.ev >= 0 ? 'us' : 'them') + '"><div class="label">Points, for us</div><div class="v">' + sgn(r.ev) + ' <small>adv ' + sgn(r.advantage * 100, 0) + '%</small></div></div>'
      + (r.win !== null ? '<div class="kpi"><div class="label">We take the hand</div><div class="v">' + pct(r.win) + '</div></div>'
        + '<div class="kpi"><div class="label">Tranque</div><div class="v">' + pct(r.tranque) + '</div></div>' : '')
      + '</div>';
    if (r.moves && r.moves.length > 1) {
      html += '<table class="moves"><thead><tr><th>Network’s choice</th><th>chance best</th><th>value</th></tr></thead><tbody>'
        + r.moves.slice(0, 7).map((m, i) => '<tr class="' + (i === 0 ? 'top' : '') + '"><td>' + moveLabel(m) + '</td><td>'
          + '<span class="pb"><i style="width:' + (m.p * 100).toFixed(1) + '%"></i></span>' + pct(m.p) + '</td><td>' + sgn(m.q) + '</td></tr>').join('')
        + '</tbody></table>';
    }
    return html + '</div>';
  }

  function suitOddsHTML(t) {
    const bel = beliefsOf(t);
    if (!bel) return '';
    const seats = [];
    for (let k = 1; k < n(); k++) seats.push((S.hero + k) % n());
    let html = '<details open><summary>Who can answer each number</summary><table class="suits"><thead><tr><th></th>'
      + [0, 1, 2, 3, 4, 5, 6].map((v) => '<th>' + v + '</th>').join('') + '</tr></thead><tbody>';
    for (const s of seats) {
      const col = seatColor(s);
      html += '<tr><td class="nm" style="color:' + col + '">' + esc(nm(s)) + '</td>';
      for (let v = 0; v < 7; v++) {
        const p = bel.suitProb(s, v);
        const alpha = Math.round(p * 70);
        html += '<td><span style="background:color-mix(in srgb, ' + col + ' ' + alpha + '%, transparent)">' + (p > 0.999 ? 'yes' : p < 0.001 ? '–' : Math.round(p * 100)) + '</span></td>';
      }
      html += '</tr>';
    }
    return html + '</tbody></table><div class="hint">Chance each player holds at least one tile of that number. “–” means they passed on it or it is gone.</div></details>';
  }

  // ================================================================ render: history
  function renderHistory() {
    const el = $('#history');
    const t = S.mode === 'play' ? (S.table ? S.table.viewFor(S.hero) : null) : S.table;
    if (!t || !t.moves.length) {
      el.innerHTML = '<div class="hint">Moves appear here. Tap one to review the table at that point.</div>';
      $('#histhint').textContent = '';
      return;
    }
    const cur = S.viewPly === null ? t.moves.length : S.viewPly;
    el.innerHTML = '<div class="history">' + t.moves.map((mv, i) => {
      const label = (i + 1) + '. ' + nm(mv.p).slice(0, 8) + ' ' + (mv.k === 'pass' ? 'paso' : mv.k === 'draw' ? 'robó' : TN(mv.tile));
      return '<button class="' + sideOf(mv.p) + (i + 1 === cur ? ' cur' : '') + '" data-act="ply" data-i="' + (i + 1) + '">' + esc(label) + '</button>';
    }).join('') + '</div>';
    $('#histhint').textContent = S.viewPly === null ? '' : 'reviewing';
  }

  // ================================================================ sheets
  function openSetup() {
    U.setup = U.setup || {
      mode: S.mode, rulesKey: S.rulesKey, names: S.names.slice(), level: S.level, coach: S.coach,
      overrides: {},
    };
    U.sheet = 'setup';
    renderSheet();
  }
  function renderSheet() {
    const el = $('#sheet');
    if (!U.sheet) { el.innerHTML = ''; return; }
    if (U.sheet === 'files') {
      const json = JSON.stringify(Object.assign({}, S, { table: S.table ? S.table.toJSON() : null }), null, 1);
      el.innerHTML = '<div class="sheet" data-act="closesheet"><div class="card" role="dialog" aria-label="Save or load">'
        + '<h2>Save / load</h2><div class="hint">Your match saves itself in this browser. To move it elsewhere, copy the text below; to restore one, paste it in and press Load.</div>'
        + '<label class="field"><span class="label">Match file</span><textarea id="filetext" rows="10" spellcheck="false">' + esc(json) + '</textarea></label>'
        + '<div class="msg" id="filemsg"></div>'
        + '<div class="foot"><button class="btn" data-act="copyfile">Copy</button><button class="btn" data-act="loadfile">Load</button><button class="btn primary" data-act="closesheet">Done</button></div></div></div>';
      return;
    }
    const c = U.setup;
    const two = D.PRESETS[c.rulesKey].players === 2;
    const formats = [
      ['patio', '2 vs 2 · Patio', 'To 200, every tile counts, capicúa and paso corrido pay 25'],
      ['patio100', '2 vs 2 · Patio to 100', 'Shorter match, same counting'],
      ['formal', '2 vs 2 · Formal', 'Only the losers’ tiles count, no bonuses, pair totals decide a tranque'],
      ['mano', '1 vs 1 · Drawing', 'Draw from the pozo when you cannot play; to 100'],
      ['mano_dormidas', '1 vs 1 · No drawing', '14 tiles sleep; pass when you cannot play'],
    ];
    const r = D.makeRules(c.rulesKey, c.overrides);
    const seatLabels = two ? ['You', 'Rival'] : ['You', 'On your right', 'Partner', 'On your left'];
    let html = '<div class="sheet" data-act="closesheet"><div class="card" role="dialog" aria-label="New match">'
      + '<h2>New match</h2>'
      + '<div class="field"><span class="label">What are you doing?</span><div class="seg">'
      + '<button data-act="su-mode" data-v="table" aria-pressed="' + (c.mode === 'table') + '"><b>Reconstruct a live table</b><span>Enter your tiles and every play as it happens</span></button>'
      + '<button data-act="su-mode" data-v="play" aria-pressed="' + (c.mode === 'play') + '"><b>Play the engine</b><span>' + (two ? 'Heads-up against the engine' : 'You and an engine partner against two engines') + '</span></button>'
      + '</div></div>'
      + '<div class="field"><span class="label">Game</span><div class="seg">'
      + formats.map(([k, a, b]) => '<button data-act="su-rules" data-v="' + k + '" aria-pressed="' + (c.rulesKey === k) + '"><b>' + a + '</b><span>' + b + '</span></button>').join('')
      + '</div></div>';
    if (c.mode === 'table') {
      html += '<div class="field"><span class="label">Names, in playing order (play passes to the right)</span><div class="row2">'
        + seatLabels.map((lab, i) => '<label class="field"><span class="hint">' + lab + '</span><input id="su-name' + i + '" value="' + esc(c.names[i] || (two ? DEFAULT_NAMES2 : DEFAULT_NAMES4)[i]) + '"></label>').join('')
        + '</div></div>';
    } else {
      html += '<div class="row2"><label class="field"><span class="label">Engine strength</span><select id="su-level">'
        + [['easy', 'Easy — plays its heaviest tile'], ...(NETINFO.doc ? [['net', 'Network — instant, no search']] : []),
          ['normal', 'Club — quick search' + (NETINFO.doc ? ' + network' : '')], ['strong', 'Strong — deeper search'], ['max', 'Maximum — exact from the salida']]
          .map(([k, lab]) => '<option value="' + k + '"' + (c.level === k ? ' selected' : '') + '>' + lab + '</option>').join('')
        + '</select></label><label class="field"><span class="label">Coach</span><select id="su-coach"><option value="1"' + (c.coach ? ' selected' : '') + '>On — show the bar, odds and hints</option><option value="0"' + (!c.coach ? ' selected' : '') + '>Off — just play</option></select></label></div>';
    }
    html += '<details><summary>House rules</summary><div class="row2" style="margin-top:8px">'
      + numField('targetScore', 'Play to', r.targetScore)
      + selField('handPoints', 'A dominó counts', r.handPoints, [['all_remaining', 'Every tile left'], ['opponents_only', 'Only the losers’ tiles']])
      + selField('tranqueWinner', 'A tranque goes to', r.tranqueWinner, [['lowest_individual', 'The lightest hand'], ['lowest_team_total', 'The lighter pair']])
      + selField('tranqueTie', 'A tied tranque goes to', r.tranqueTie, [['opener', 'The salida'], ['blocker', 'Whoever blocked'], ['no_score', 'Nobody']])
      + selField('tranquePoints', 'A tranque counts', r.tranquePoints, [['all_remaining', 'Every tile left'], ['opponents_only', 'Only the losers’ tiles']])
      + selField('nextOpener', 'Next salida', r.nextOpener, [['hand_winner', 'The hand’s winner'], ['winner_team_rotates', 'Winner’s partner'], ['rotate_seat', 'Next seat']])
      + numField('capicuaBonus', 'Capicúa bonus', r.capicuaBonus)
      + numField('chuchazoBonus', 'Chuchazo bonus', r.chuchazoBonus)
      + (two ? '' : numField('pasoCorridoBonus', 'Paso corrido bonus', r.pasoCorridoBonus))
      + '</div></details>'
      + '<div class="foot"><button class="btn" data-act="closesheet">Cancel</button><button class="btn primary" data-act="su-start">Start</button></div>'
      + '</div></div>';
    el.innerHTML = html;
  }
  function numField(k, lab, v) {
    return '<label class="field"><span class="hint">' + lab + '</span><input id="ru-' + k + '" data-rule="' + k + '" inputmode="numeric" value="' + v + '"></label>';
  }
  function selField(k, lab, v, opts) {
    return '<label class="field"><span class="hint">' + lab + '</span><select id="ru-' + k + '" data-rule="' + k + '">'
      + opts.map(([o, l]) => '<option value="' + o + '"' + (o === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label>';
  }
  function readSetupForm() {
    const c = U.setup;
    const two = D.PRESETS[c.rulesKey].players === 2;
    for (let i = 0; i < (two ? 2 : 4); i++) {
      const inp = document.getElementById('su-name' + i);
      if (inp) c.names[i] = inp.value.trim() || (two ? DEFAULT_NAMES2 : DEFAULT_NAMES4)[i];
    }
    const lv = document.getElementById('su-level'); if (lv) c.level = lv.value;
    const co = document.getElementById('su-coach'); if (co) c.coach = co.value === '1';
    document.querySelectorAll('[data-rule]').forEach((el) => {
      const k = el.dataset.rule;
      const base = D.PRESETS[c.rulesKey][k];
      let v = el.value;
      if (typeof base === 'number') { v = parseInt(v, 10); if (isNaN(v) || v < 0) v = base; }
      if (v !== base) c.overrides[k] = v; else delete c.overrides[k];
    });
  }

  // ================================================================ render all
  function render() {
    renderHeader();
    renderSeats();
    renderEntry();
    renderEval();
    renderAnalysis();
    renderHistory();
    renderSheet();
    $('#cmdform').hidden = !(S.mode === 'table' && (S.phase === 'hand' || S.phase === 'deal'));
    $('#cmdhint').hidden = $('#cmdform').hidden;
  }

  // ================================================================ events
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'closesheet' && el.classList.contains('sheet') && ev.target !== el) return;
    switch (act) {
      case 'mode':
        if (el.dataset.v !== S.mode) { U.setup = null; openSetup(); U.setup.mode = el.dataset.v; renderSheet(); }
        break;
      case 'newmatch': U.setup = null; openSetup(); break;
      case 'files': U.sheet = 'files'; renderSheet(); break;
      case 'closesheet': U.sheet = null; renderSheet(); break;
      case 'su-mode': readSetupForm(); U.setup.mode = el.dataset.v; renderSheet(); break;
      case 'su-rules': {
        readSetupForm();
        const wasTwo = D.PRESETS[U.setup.rulesKey].players === 2;
        U.setup.rulesKey = el.dataset.v; U.setup.overrides = {};
        const two = D.PRESETS[U.setup.rulesKey].players === 2;
        if (two !== wasTwo) U.setup.names = (two ? DEFAULT_NAMES2 : DEFAULT_NAMES4).slice();
        renderSheet();
        break;
      }
      case 'su-start': readSetupForm(); U.sheet = null; renderSheet(); newSession(U.setup); U.setup = null; break;
      case 'copyfile': {
        const ta = $('#filetext');
        const done = () => { $('#filemsg').textContent = 'Copied.'; };
        try { navigator.clipboard.writeText(ta.value).then(done, () => { ta.select(); $('#filemsg').textContent = 'Selected — copy it with your keyboard.'; }); }
        catch (e) { ta.select(); }
        break;
      }
      case 'loadfile': {
        try {
          const o = JSON.parse($('#filetext').value);
          if (o.v !== 1) throw new Error('not a Dominord match file');
          S = Object.assign(defaultSession(), o);
          S.table = o.table ? D.Table.fromJSON(o.table) : null;
          U.sheet = null; U.snap = null; U.chooseId++;
          save(); render(); requestAnalysis();
          if (S.mode === 'play') tick();
        } catch (e) { $('#filemsg').textContent = 'Could not load: ' + e.message; }
        break;
      }
      case 'tile': {
        const tile = +el.dataset.t;
        if (S.phase === 'deal') {
          const i = S.draft.tiles.indexOf(tile);
          if (i >= 0) S.draft.tiles.splice(i, 1);
          else if (S.draft.tiles.length < S.rules.tilesPerPlayer) S.draft.tiles.push(tile);
          say('');
          renderEntry();
        } else if (U.pending && U.pending.draw) {
          U.pending = null;
          doDraw(tile);
        } else {
          tryPlay(tile);
        }
        break;
      }
      case 'end': { const p = U.pending; U.pending = null; if (p) tryPlay(p.tile, el.dataset.e); break; }
      case 'cancelpend': U.pending = null; say(''); renderEntry(); break;
      case 'pass': doPass(); break;
      case 'draw': doDraw(-1); break;
      case 'undo': undo(); break;
      case 'opener': S.draft.opener = +el.dataset.s; say(''); renderEntry(); break;
      case 'starthand': startReconHand(); break;
      case 'spectate': S.draft.spectate = true; S.draft.tiles = []; startReconHand(); break;
      case 'score': {
        const t = S.table;
        const pips = [];
        const bel = beliefsOf(t);
        for (let s = 0; s < n(); s++) {
          const v = document.getElementById('pips' + s).value.trim();
          pips.push(v === '' ? Math.round(bel ? bel.expectedPips(s) : 0) : parseInt(v, 10));
        }
        if (pips.some((x) => isNaN(x) || x < 0)) { say('Points must be whole numbers.', 'err'); return renderEntry(); }
        finishWithPips(pips); render();
        break;
      }
      case 'nexthand': nextHand(); break;
      case 'ply': S.viewPly = +el.dataset.i; const len = (S.mode === 'play' ? S.table.viewFor(S.hero) : S.table).moves.length; if (S.viewPly >= len) S.viewPly = null; render(); requestAnalysis(); break;
      case 'odds': S.odds = el.dataset.v; save(); renderEntry(); break;
      case 'live': S.viewPly = null; render(); requestAnalysis(); break;
      default: break;
    }
  });
  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.id === 'effort') { S.effort = el.value; save(); requestAnalysis(); }
    if (el.id === 'weighting') { S.weighting = el.checked; save(); requestAnalysis(); }
    if (el.id === 'usenet') { S.useNet = el.checked; save(); render(); requestAnalysis(); }
    if (el.id === 'coach') { S.coach = el.checked; save(); render(); requestAnalysis(); }
  });
  $('#cmdform').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const inp = $('#cmd');
    const v = inp.value;
    inp.value = '';
    runCommand(v);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && U.sheet) { U.sheet = null; renderSheet(); }
  });
  let rsz = 0;
  window.addEventListener('resize', () => { clearTimeout(rsz); rsz = setTimeout(() => { renderSeats(); renderEval(); }, 120); });

  // ================================================================ boot
  function demo() {
    // A realistic first screen: a patio hand a few plays in.
    S = defaultSession();
    S.names = ['You', 'Juan', 'Socio', 'Pedro'];
    const t = new D.Table({ rules: S.rules, opener: 1, hero: 0, forcedOpen: D.DOUBLE_SIX, names: S.names });
    t.setHand(0, D.parseTiles('6-4 5-5 3-1 0-0 2-6 4-4 5-0'));
    t.record({ k: 'play', p: 1, tile: D.DOUBLE_SIX });
    t.record({ k: 'pass', p: 2 });
    t.record({ k: 'play', p: 3, tile: D.parseTile('6-3') });
    S.table = t;
    S.phase = 'hand';
    say('Example hand — Socio passed on the 6, so the engine has struck every 6 from his hand. Start your own with New match.', 'ok');
  }
  if (!load()) demo();
  render();
  requestAnalysis();
  if (S.mode === 'play' && S.phase === 'hand') tick();
})();
