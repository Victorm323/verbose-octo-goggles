// Self-consistency tests for the browser engine: things the Python oracle
// cannot check (1v1 with a pozo, the TT, sampling, the analysis).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const D = require('../../web/engine.js');

function randomState(rules, rnd, stopTiles) {
  const dl = D.deal(rules, rnd);
  const st = new D.State(rules);
  dl.hands.forEach((h, s) => { st.hands[s] = h; });
  if (rules.players === 2) { st.pozo.set(dl.pozo); st.pozoLen = dl.pozo.length; }
  st.turn = st.opener = Math.floor(rnd() * rules.players);
  st.rehash();
  while (!st.isOver() && st.tilesLeft() > stopTiles) {
    const ms = st.moves();
    st.apply(ms[Math.floor(rnd() * ms.length)]);
  }
  return st;
}

test('alpha-beta + TT equals plain minimax (all presets, incl. 1v1 with drawing)', () => {
  const rnd = D.mulberry32(1);
  for (const name of Object.keys(D.PRESETS)) {
    const r = D.makeRules(name);
    for (let i = 0; i < 60; i++) {
      const st = randomState(r, rnd, r.players === 2 ? 6 : 8);
      const want = D.minimax(st);
      assert.strictEqual(D.solve(st, 0).value, want, name);
      assert.strictEqual(D.solve(st, 1).value, -want || 0, name);
    }
  }
});

test('terminalValue agrees with scoreTotals on random finished hands', () => {
  const rnd = D.mulberry32(2);
  for (const name of Object.keys(D.PRESETS)) {
    const r = D.makeRules(name);
    for (let i = 0; i < 300; i++) {
      const st = randomState(r, rnd, 0);
      assert.ok(st.isOver());
      const res = D.scoreState(st);
      const v = D.terminalValue(st);
      assert.strictEqual(v, res.winningTeam === null ? 0 : res.winningTeam === 0 ? res.points : -res.points);
    }
  }
});

test('apply/undo restores the state and its hash exactly', () => {
  const rnd = D.mulberry32(3);
  const r = D.makeRules('mano');
  for (let i = 0; i < 50; i++) {
    const st = randomState(r, rnd, 10);
    const before = JSON.stringify([Array.from(st.hands), st.left, st.right, st.turn, st.passes, st.h1, st.h2, st.pozoPtr]);
    const sp = st.sp;
    D.playout(st, rnd);
    assert.strictEqual(st.sp, sp);
    const after = JSON.stringify([Array.from(st.hands), st.left, st.right, st.turn, st.passes, st.h1, st.h2, st.pozoPtr]);
    assert.strictEqual(after, before);
  }
});

test('sampling is uniform over consistent deals (chi-square on a small position)', () => {
  const r = D.makeRules('patio');
  const t = new D.Table({ rules: r, opener: 0, hero: 0 });
  t.setHand(0, D.parseTiles('6-6 5-5 3-1 0-0 2-6 4-4 5-0'));
  for (const m of [[0, '6-6'], [1, '6-1'], [2, null], [3, '6-3'], [0, '3-1', 'L']]) {
    t.record(m[1] ? { k: 'play', p: m[0], tile: D.parseTile(m[1]), end: m[2] } : { k: 'pass', p: m[0] });
  }
  const b = D.buildBeliefs(t);
  // Empirical marginals from samples vs the exact DP.
  const rnd = D.mulberry32(9);
  const N = 20000;
  const hits = new Float64Array(28 * 4);
  for (let i = 0; i < N; i++) {
    const a = b.sample(rnd);
    b.buckets.forEach((bk, k) => { for (const x of D.tilesOf(a[k])) hits[x * 4 + bk.seat]++; });
  }
  for (const x of b.tiles) {
    for (const bk of b.buckets) {
      const p = b.prob(bk.seat, x), q = hits[x * 4 + bk.seat] / N;
      assert.ok(Math.abs(p - q) < 4 * Math.sqrt(p * (1 - p) / N) + 1e-3, `${D.tileName(x)}@${bk.seat} ${p} vs ${q}`);
    }
  }
  // Seat 2 passed on 6 and 1: it can never hold either number.
  for (const x of b.tiles) if (D.hasSuit(x, 6) || D.hasSuit(x, 1)) assert.strictEqual(b.prob(2, x), 0);
});

test('enumeration visits exactly total_deals distinct deals', () => {
  const r = D.makeRules('patio');
  const rnd = D.mulberry32(4);
  let checked = 0;
  for (let g = 0; g < 40 && checked < 8; g++) {
    const dl = D.deal(r, rnd);
    const open = D.firstOpening(r, dl.hands);
    const t = new D.Table({ rules: r, opener: open.seat, hero: 0, forcedOpen: open.tile });
    t.setHand(0, dl.hands[0]);
    const st = new D.State(r);
    dl.hands.forEach((h, s) => { st.hands[s] = h; });
    st.turn = st.opener = open.seat; st.forced = open.tile; st.rehash();
    while (!st.isOver()) {
      const ms = st.moves();
      const m = ms[Math.floor(rnd() * ms.length)];
      t.record(D.toRecord(t, m));
      st.apply(m);
      const b = D.buildBeliefs(t);
      if (b.total > 1 && b.total < 3000) {
        const all = b.enumerate(1e9);
        assert.strictEqual(all.length, b.total);
        assert.strictEqual(new Set(all.map((a) => Array.from(a).join(','))).size, b.total);
        checked++;
        break;
      }
    }
  }
  assert.ok(checked > 0);
});

test('suitProb is exact: matches brute force over enumerated deals', () => {
  const r = D.makeRules('patio');
  const rnd = D.mulberry32(6);
  let checked = 0;
  for (let g = 0; g < 60 && checked < 5; g++) {
    const dl = D.deal(r, rnd);
    const open = D.firstOpening(r, dl.hands);
    const master = new D.Table({ rules: r, opener: open.seat, hero: 0, forcedOpen: open.tile });
    dl.hands.forEach((h, s) => master.setHand(s, h));
    while (!master.isOver()) {
      const ms = master.legalPlays(master.turn);
      master.record(D.toRecord(master, ms[Math.floor(rnd() * ms.length)]));
      const view = master.viewFor(0);
      const b = D.buildBeliefs(view);
      if (b.total > 1 && b.total < 5000 && view.d.voids.some((v) => v)) {
        const all = b.enumerate(1e9);
        assert.strictEqual(all.length, b.total);
        for (const bk of b.buckets) {
          const k = b.bucketOf[bk.seat];
          for (let suit = 0; suit < 7; suit++) {
            const brute = all.filter((a) => a[k] & D.SUIT[suit]).length / all.length;
            assert.ok(Math.abs(b.suitProb(bk.seat, suit) - brute) < 1e-12);
          }
        }
        checked++;
        break;
      }
    }
  }
  assert.ok(checked >= 3);
});

test('1v1 with drawing: draws reset voids, beliefs include the pozo, hands stay consistent', () => {
  const r = D.makeRules('mano');
  const t = new D.Table({ rules: r, opener: 0, hero: 0, names: ['Yo', 'Rival'] });
  t.setHand(0, D.parseTiles('6-6 6-5 5-5 4-4 1-0 2-0 3-0'));
  t.record({ k: 'play', p: 0, tile: D.parseTile('6-6') });
  t.record({ k: 'draw', p: 1 });           // rival had no 6
  t.record({ k: 'draw', p: 1 });
  t.record({ k: 'play', p: 1, tile: D.parseTile('6-2'), end: 'R' });
  const b = D.buildBeliefs(t);
  assert.strictEqual(t.d.counts[1], 8);
  assert.strictEqual(t.d.pozo, 12);
  // The rival kept no 6 after drawing for it; the pozo can hold any unseen tile.
  assert.strictEqual(b.prob(1, D.parseTile('6-1')), 0);
  assert.ok(b.prob(2, D.parseTile('6-1')) > 0);
  const sum = b.tiles.reduce((a, x) => a + b.prob(1, x) + b.prob(2, x), 0);
  assert.ok(Math.abs(sum - b.tiles.length) < 1e-9);
  // Hero cannot pass while the pozo has tiles.
  assert.throws(() => t.record({ k: 'pass', p: 0 }), /draw|legal/);
});

test('bad entries are rejected with a message naming the problem', () => {
  const r = D.makeRules('patio');
  const t = new D.Table({ rules: r, opener: 1, hero: 0, forcedOpen: D.DOUBLE_SIX });
  t.setHand(0, D.parseTiles('6-4 5-5 3-1 0-0 2-6 4-4 5-0'));
  assert.throws(() => t.record({ k: 'play', p: 1, tile: D.parseTile('5-5') }), /salida must be|belongs/);
  t.record({ k: 'play', p: 1, tile: D.DOUBLE_SIX });
  t.record({ k: 'pass', p: 2 });
  assert.throws(() => t.record({ k: 'play', p: 3, tile: D.parseTile('6-4') }), /belongs to/);
  t.record({ k: 'play', p: 3, tile: D.parseTile('6-3') });
  t.record({ k: 'play', p: 0, tile: D.parseTile('6-4'), end: 'L' });
  t.record({ k: 'play', p: 1, tile: D.parseTile('3-3') });
  // Seat 2 passed on the 6: it cannot turn up with a 6 later.
  assert.throws(() => t.record({ k: 'play', p: 2, tile: D.parseTile('6-1'), end: 'R' }), /passed on/);
});

test('analysis: the hero on play gets ranked moves with intervals; seats agree on the deal set', () => {
  const r = D.makeRules('patio');
  const t = new D.Table({ rules: r, opener: 0, hero: 0, forcedOpen: D.DOUBLE_SIX });
  t.setHand(0, D.parseTiles('6-6 5-5 3-1 0-0 2-6 4-4 5-0'));
  t.record({ k: 'play', p: 0, tile: D.DOUBLE_SIX });
  t.record({ k: 'play', p: 1, tile: D.parseTile('6-1') });
  t.record({ k: 'pass', p: 2 });
  t.record({ k: 'play', p: 3, tile: D.parseTile('6-3') });
  const snap = D.analyze(t, { effort: 'live', full: true, cfg: { timeMs: 1500 } });
  assert.strictEqual(snap.seat, 0);
  assert.ok(snap.moves.length >= 1);
  for (const m of snap.moves) assert.ok(m.lo <= m.ev && m.ev <= m.hi);
  assert.ok(snap.lo <= snap.ev && snap.ev <= snap.hi);
  assert.ok(snap.win >= 0 && snap.win <= 1);
  assert.ok(snap.seatMoves && snap.seatMoves[1] && snap.seatMoves[3]);
});

test('late positions are analysed over every consistent deal, exactly', () => {
  const r = D.makeRules('patio');
  const rnd = D.mulberry32(5);
  for (let g = 0; g < 20; g++) {
    const dl = D.deal(r, rnd);
    const open = D.firstOpening(r, dl.hands);
    const master = new D.Table({ rules: r, opener: open.seat, hero: 0, forcedOpen: open.tile });
    dl.hands.forEach((h, s) => master.setHand(s, h));
    while (!master.isOver() && D.buildBeliefs(master.viewFor(0)).total > 200) {
      master.record(D.toRecord(master, D.chooseMove(master, { level: 'easy' })));
    }
    if (master.isOver()) continue;
    const snap = D.analyze(master.viewFor(0), { effort: 'normal', full: true });
    assert.ok(snap.exhaustive);
    assert.strictEqual(snap.deals, snap.total);
    return;
  }
  assert.fail('no late position reached');
});

test('style model: a seat that always drops its heaviest tile is read as heavy-first', () => {
  const r = D.makeRules('patio');
  const rnd = D.mulberry32(8);
  let hits = 0, tries = 0;
  for (let g = 0; g < 12; g++) {
    const dl = D.deal(r, rnd);
    const open = D.firstOpening(r, dl.hands);
    const master = new D.Table({ rules: r, opener: open.seat, hero: 0, forcedOpen: open.tile });
    dl.hands.forEach((h, s) => master.setHand(s, h));
    // Seats 1 and 3 play heaviest-first; 0 and 2 play at random.
    while (!master.isOver() && master.d.chain.length < 14) {
      const seat = master.turn;
      const legal = master.legalPlays(seat);
      const m = seat % 2 ? D.chooseMove(master, { level: 'easy' }) : legal[Math.floor(rnd() * legal.length)];
      master.record(D.toRecord(master, m));
    }
    if (master.isOver()) continue;
    const a = new D.Analysis(master.viewFor(0), { effort: 'live', weighting: true, useNet: false });
    if (!a.posterior) continue;
    for (const s of [1, 3]) {
      const p = a.posterior[s];
      tries++;
      if (a.styles[p.indexOf(Math.max(...p))] === 'heavy') hits++;
    }
  }
  assert.ok(tries >= 10);
  assert.ok(hits / tries >= 0.7, `heavy identified ${hits}/${tries}`);
});

test('analysis runs with a network: rollouts to the exact horizon, styles reported', () => {
  // A random network (all weights tiny) is enough to exercise the plumbing.
  const mk = (rows, cols) => {
    const a = new Float32Array(rows * cols);
    const rnd = D.mulberry32(rows * 31 + cols);
    for (let i = 0; i < a.length; i++) a[i] = (rnd() - 0.5) * 0.1;
    return { shape: cols ? [rows, cols] : [rows], data: Buffer.from(a.buffer).toString('base64') };
  };
  const h = 16, qh = 8;
  const doc = {
    format: 'dominord-net/1', stateDim: D.STATE_DIM, actionDim: D.ACTION_DIM, valueScale: 50, hidden: h, qhidden: qh,
    layers: {
      'trunk.0.weight': mk(h, D.STATE_DIM), 'trunk.0.bias': mk(h, 1), 'trunk.2.weight': mk(h, h), 'trunk.2.bias': mk(h, 1),
      'q.0.weight': mk(qh, h + D.ACTION_DIM), 'q.0.bias': mk(qh, 1), 'q.2.weight': mk(1, qh), 'q.2.bias': mk(1, 1),
      'v.0.weight': mk(64, h), 'v.0.bias': mk(64, 1), 'v.2.weight': mk(1, 64), 'v.2.bias': mk(1, 1),
    },
  };
  const net = new D.Net(doc);
  const r = D.makeRules('patio');
  const t = new D.Table({ rules: r, opener: 0, hero: 0, forcedOpen: D.DOUBLE_SIX });
  t.setHand(0, D.parseTiles('6-6 5-5 3-1 0-0 2-6 4-4 5-0'));
  t.record({ k: 'play', p: 0, tile: D.DOUBLE_SIX });
  t.record({ k: 'play', p: 1, tile: D.parseTile('6-1') });
  t.record({ k: 'play', p: 2, tile: D.parseTile('6-3') });
  t.record({ k: 'play', p: 3, tile: D.parseTile('1-1') });
  const snap = D.analyze(t, { effort: 'live', full: true, net, cfg: { timeMs: 800 } });
  assert.ok(snap.net);
  assert.ok(snap.moves.length >= 1 && snap.styles && snap.styles[1]);
  assert.ok(Math.abs(Object.values(snap.styles[1]).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  // The network alone picks a legal move.
  const m = D.chooseMove(t, { level: 'net', net });
  assert.ok(t.legalPlays(0).includes(m));
});
