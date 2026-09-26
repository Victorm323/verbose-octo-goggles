// Conformance: the browser engine must agree with the Python oracle.
//   python3 tests/js/make_fixtures.py > tests/js/fixtures.json
//   node --test tests/js/
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const D = require('../../web/engine.js');
const FX = require(path.join(__dirname, 'fixtures.json'));

const P = D.parseTile;

function stateFrom(rec) {
  const r = D.makeRules(rec.preset);
  const st = new D.State(r);
  rec.dealt.forEach((h, s) => { st.hands[s] = h.map(P).reduce((m, t) => m | (1 << t), 0); });
  st.turn = st.opener = rec.opener;
  st.forced = rec.forced ? P(rec.forced) : -1;
  st.rehash();
  for (const m of rec.moves) st.apply(code(st, m));
  return st;
}
function code(st, m) {
  if (m.k === 'pass') return D.PASS;
  const t = P(m.tile);
  return st.chainLen === 0 ? t * 2 + 1 : D.makeMove(t, m.end);
}
const fmt = (m) => (m < 0 ? 'pass' : D.tileKey(m >> 1) + (m & 1 ? 'R' : 'L'));

test('scoring matches score_totals on every preset', () => {
  for (const c of FX.scoring) {
    const r = D.makeRules(c.preset);
    const got = D.scoreTotals(r, c.pips, c.kind, {
      winner: c.winner, opener: c.opener, blocker: c.blocker, pc: c.pc,
      capicua: c.capicua, chuchazo: c.chuchazo,
    });
    const want = c.result;
    assert.deepStrictEqual(
      [got.kind, got.winner, got.winningTeam, got.points, got.nextOpener],
      [want.kind, want.winner, want.winning_team, want.points, want.next_opener],
      JSON.stringify(c));
  }
  assert.ok(FX.scoring.length >= 1000);
});

test('legal moves match HandState.legal_moves', () => {
  let n = 0;
  for (const rec of FX.positions) {
    const st = stateFrom(rec);
    if (st.isOver()) continue;
    const want = rec.legal.map((m) => code(st, m)).map(fmt);
    assert.deepStrictEqual(st.moves().map(fmt), want);
    n++;
  }
  assert.ok(n > 100);
});

test('exact solve values match dominord.search.solve', () => {
  const diffs = [];
  for (const rec of FX.positions) {
    const st = stateFrom(rec);
    const got = D.solve(st, 0).value;
    if (got !== rec.solve0) diffs.push({ got, want: rec.solve0, moves: rec.moves.length });
  }
  assert.deepStrictEqual(diffs, []);
});

test('finished hands score the same (capicúa, chuchazo, paso corrido, tranque)', () => {
  for (const rec of FX.positions) {
    const st = stateFrom(rec);
    for (const m of rec.final_moves) st.apply(code(st, m));
    assert.ok(st.isOver());
    const res = D.scoreState(st);
    assert.deepStrictEqual([res.kind, res.winner, res.points], [rec.final.kind, rec.final.winner, rec.final.points]);
    const v = D.terminalValue(st);
    const signed = res.winningTeam === null ? 0 : res.winningTeam === 0 ? res.points : -res.points;
    assert.strictEqual(v, signed);
  }
});

test('beliefs: exact deal counts and marginals match build_beliefs', () => {
  for (const c of FX.beliefs) {
    const t = new D.Table({ rules: D.makeRules('patio'), opener: c.opener, hero: 0 });
    t.setHand(0, c.dealt0.map(P));
    for (const m of c.moves) {
      t.record(m.k === 'pass' ? { k: 'pass', p: m.p } : { k: 'play', p: m.p, tile: P(m.tile), end: m.end });
    }
    const b = D.buildBeliefs(t);
    assert.strictEqual(b.total, c.total);
    for (const [tk, bySeat] of Object.entries(c.marginals)) {
      for (let s = 1; s < 4; s++) {
        const want = bySeat[String(s)] || 0;
        assert.ok(Math.abs(b.prob(s, P(tk)) - want) < 1e-9, `${tk} seat ${s}: ${b.prob(s, P(tk))} vs ${want}`);
      }
    }
  }
});
