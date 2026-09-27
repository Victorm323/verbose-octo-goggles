/*
 * dominord engine — browser core.
 *
 * A dependency-free port of the Python engine (dominord/) built on the
 * representation ROADMAP.md Phase 1 prescribes: a hand is a 28-bit mask, the
 * search state is (hands, ends, turn, pass streak), and move generation is
 * `hand & (SUIT[left] | SUIT[right])`.  Runs unchanged in a page, a Web Worker
 * and Node (tests/js/), attaching itself as `Dominord` on the global object.
 *
 * Layers, top to bottom:
 *   tiles / rules / scoring ...... what the table agrees on (docs/RULES.md)
 *   State ........................ perfect-information hand, apply/undo, no allocation
 *   solve / playout .............. exact alpha-beta + Zobrist TT, greedy rollouts
 *   Table ........................ what an observer knows (the reconstruction layer)
 *   Beliefs ...................... exact marginals by DP, uniform sampling, enumeration
 *   Analysis ..................... PIMC over consistent deals, anytime, with CIs
 *   matchModel ................... P(win the partida) from the score
 */
(function (root) {
  'use strict';

  // ==================================================================== tiles
  const LOW = new Int8Array(28);
  const HIGH = new Int8Array(28);
  const PIPS = new Int8Array(28);
  const ID = new Int8Array(49);
  const SUIT = new Int32Array(7);
  (function () {
    let k = 0;
    for (let a = 0; a <= 6; a++) {
      for (let b = a; b <= 6; b++) {
        LOW[k] = a; HIGH[k] = b; PIPS[k] = a + b;
        ID[a * 7 + b] = k; ID[b * 7 + a] = k;
        SUIT[a] |= 1 << k; SUIT[b] |= 1 << k;
        k++;
      }
    }
  })();
  const FULL = (1 << 28) - 1;
  const CHUCHA = 0;        // [0|0]
  const DOUBLE_SIX = 27;   // [6|6]

  const tileId = (a, b) => ID[a * 7 + b];
  const isDouble = (t) => LOW[t] === HIGH[t];
  const otherFace = (t, s) => (LOW[t] === s ? HIGH[t] : LOW[t]);
  const hasSuit = (t, s) => LOW[t] === s || HIGH[t] === s;

  function popcount(x) {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  function tilesOf(mask) {
    const out = [];
    while (mask) {
      const b = mask & -mask;
      out.push(31 - Math.clz32(b));
      mask ^= b;
    }
    return out;
  }
  function pipsOf(mask) {
    let s = 0;
    while (mask) {
      const b = mask & -mask;
      s += PIPS[31 - Math.clz32(b)];
      mask ^= b;
    }
    return s;
  }
  function suitsMask(voids) {
    let m = 0;
    for (let s = 0; s < 7; s++) if (voids & (1 << s)) m |= SUIT[s];
    return m;
  }
  /** Display name, heavy face first: ``6|4``. */
  const tileName = (t) => HIGH[t] + '|' + LOW[t];
  /** Python's ``str(Tile)`` — low face first — used by the conformance fixtures. */
  const tileKey = (t) => LOW[t] + '|' + HIGH[t];

  function parseTile(text) {
    const raw = String(text).trim().toLowerCase().replace(/[\[\]]/g, '');
    let m = raw.match(/^([0-6])\s*[-|:/.x]\s*([0-6])$/);
    if (!m) m = raw.match(/^([0-6])([0-6])$/);
    if (!m) throw new Error('cannot read tile "' + text + '"');
    return tileId(+m[1], +m[2]);
  }
  function parseTiles(text) {
    return String(text).split(/[\s,;]+/).filter(Boolean).map(parseTile);
  }

  // ==================================================================== rng
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rnd) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const x = arr[i]; arr[i] = arr[j]; arr[j] = x;
    }
    return arr;
  }

  // ==================================================================== rules
  // Every point tables argue about is a field (CLAUDE.md invariant 1).  Names
  // mirror dominord/rules.py; `draw` and `players: 2` add the mano-a-mano game.
  const RULE_DEFAULTS = {
    label: 'Patio (to 200)',
    players: 4,
    tilesPerPlayer: 7,
    targetScore: 200,
    firstOpener: 'double_six',        // double_six | highest_double | highest_tile
    firstOpenerMustPlay: true,
    nextOpener: 'hand_winner',        // hand_winner | winner_team_rotates | rotate_seat
    mustPlayIfAble: true,
    handPoints: 'all_remaining',      // all_remaining | opponents_only
    tranqueWinner: 'lowest_individual', // lowest_individual | lowest_team_total
    tranqueTie: 'opener',             // opener | blocker | no_score
    tranquePoints: 'all_remaining',
    capicuaBonus: 25,
    chuchazoBonus: 25,
    pasoCorridoBonus: 25,
    pollonaDoublesGame: false,
    draw: false,                      // 1v1: draw from the pozo when you cannot play
  };
  const PRESETS = {
    patio: Object.assign({}, RULE_DEFAULTS),
    patio100: Object.assign({}, RULE_DEFAULTS, { label: 'Patio (to 100)', targetScore: 100 }),
    formal: Object.assign({}, RULE_DEFAULTS, {
      label: 'Formal / club',
      handPoints: 'opponents_only',
      tranquePoints: 'opponents_only',
      tranqueWinner: 'lowest_team_total',
      tranqueTie: 'no_score',
      capicuaBonus: 0, chuchazoBonus: 0, pasoCorridoBonus: 0,
    }),
    // Heads-up.  With 14 tiles off the table the [6|6] may be asleep, so the
    // salida goes to the highest double (heaviest tile if nobody has one).
    mano: Object.assign({}, RULE_DEFAULTS, {
      label: '1 vs 1, drawing (a robar)',
      players: 2, draw: true, targetScore: 100,
      firstOpener: 'highest_double',
      handPoints: 'opponents_only', tranquePoints: 'opponents_only',
      capicuaBonus: 0, chuchazoBonus: 0, pasoCorridoBonus: 0,
    }),
    mano_dormidas: Object.assign({}, RULE_DEFAULTS, {
      label: '1 vs 1, no drawing (14 asleep)',
      players: 2, draw: false, targetScore: 100,
      firstOpener: 'highest_double',
      handPoints: 'opponents_only', tranquePoints: 'opponents_only',
      capicuaBonus: 0, chuchazoBonus: 0, pasoCorridoBonus: 0,
    }),
  };
  function makeRules(base, changes) {
    const src = typeof base === 'string' ? PRESETS[base] : base;
    if (!src) throw new Error('unknown rule preset ' + base);
    return Object.assign({}, RULE_DEFAULTS, src, changes || {});
  }
  const teamOf = (seat) => seat % 2;
  const partnerOf = (r, seat) => (seat + 2) % r.players;
  const nextSeat = (r, seat) => (seat + 1) % r.players;
  const pozoSize = (r) => 28 - r.players * r.tilesPerPlayer;

  /** Seat that opens the first hand of a match, and the tile it must lay. */
  function firstOpening(r, hands) {
    const holder = (t) => hands.findIndex((h) => (h >> t) & 1);
    if (r.firstOpener === 'double_six') {
      const s = holder(DOUBLE_SIX);
      if (s >= 0) return { seat: s, tile: r.firstOpenerMustPlay ? DOUBLE_SIX : -1 };
    }
    if (r.firstOpener === 'double_six' || r.firstOpener === 'highest_double') {
      for (let p = 6; p >= 0; p--) {
        const s = holder(tileId(p, p));
        if (s >= 0) return { seat: s, tile: r.firstOpenerMustPlay ? tileId(p, p) : -1 };
      }
    }
    // Heaviest tile: (pips, is_double, high) as in dominord.state.opening_seat.
    let best = -1, bestSeat = 0;
    const rank = (t) => PIPS[t] * 100 + (isDouble(t) ? 10 : 0) + HIGH[t];
    hands.forEach((h, s) => {
      for (const t of tilesOf(h)) if (best < 0 || rank(t) > rank(best)) { best = t; bestSeat = s; }
    });
    return { seat: bestSeat, tile: r.firstOpenerMustPlay ? best : -1 };
  }

  // ==================================================================== scoring
  function nextOpenerAfter(r, winner, opener) {
    if (r.nextOpener === 'hand_winner') return winner;
    if (r.nextOpener === 'winner_team_rotates') return partnerOf(r, winner);
    return nextSeat(r, opener);
  }

  /** Port of scoring.tranque_winner: [seat | null, notes]. */
  function tranqueWinner(r, pips, opener, blocker) {
    const n = r.players;
    let tied = [];
    if (r.tranqueWinner === 'lowest_individual') {
      const best = Math.min.apply(null, pips);
      for (let s = 0; s < n; s++) if (pips[s] === best) tied.push(s);
    } else {
      const totals = [0, 0];
      for (let s = 0; s < n; s++) totals[teamOf(s)] += pips[s];
      const best = Math.min(totals[0], totals[1]);
      for (let t = 0; t < 2; t++) {
        if (totals[t] !== best) continue;
        let pick = -1;
        for (let s = 0; s < n; s++) if (teamOf(s) === t && (pick < 0 || pips[s] < pips[pick])) pick = s;
        tied.push(pick);
      }
    }
    if (tied.length === 1) return [tied[0], []];
    if (tied.every((s) => teamOf(s) === teamOf(tied[0]))) return [Math.min.apply(null, tied), []];
    if (r.tranqueTie === 'no_score') return [null, ['Tied tranque: the hand is void']];
    const byOpener = r.tranqueTie === 'opener';
    const preferred = byOpener ? opener : blocker;
    const label = byOpener ? 'the salida' : 'whoever blocked';
    if (preferred === null || preferred === undefined || preferred < 0) {
      return [null, ['Tie with no tiebreak: the hand is void']];
    }
    if (tied.includes(preferred)) return [preferred, ['Tie goes to ' + label]];
    const partner = partnerOf(r, preferred);
    if (tied.includes(partner)) return [partner, ['Tie goes to the pair of ' + label]];
    return [null, ['Tie with no tiebreak: the hand is void']];
  }

  /**
   * Port of scoring.score_totals.  `pc` = paso-corrido bonuses banked per team
   * (a count, each worth rules.pasoCorridoBonus).
   */
  function scoreTotals(r, pips, kind, o) {
    o = o || {};
    const n = r.players;
    const opener = o.opener || 0;
    const blocker = o.blocker === undefined ? null : o.blocker;
    const pc = o.pc || [0, 0];
    const teamPips = [0, 0];
    for (let s = 0; s < n; s++) teamPips[teamOf(s)] += pips[s];
    let winner, notes = [], mode;
    if (kind === 'domino') {
      winner = o.winner;
      if (winner === undefined || winner === null) throw new Error('a dominó needs the seat that closed');
      if (pips[winner] !== 0) throw new Error('the seat that closed the hand cannot hold tiles');
      mode = r.handPoints;
    } else if (kind === 'tranque') {
      [winner, notes] = tranqueWinner(r, pips, opener, blocker);
      mode = r.tranquePoints;
    } else {
      throw new Error('unknown hand ending ' + kind);
    }
    if (winner === null) {
      return {
        kind: 'void', winner: null, winningTeam: null, points: 0, basePoints: 0,
        bonuses: [], handPips: pips.slice(), teamPips,
        nextOpener: blocker !== null && blocker >= 0 ? blocker : opener, notes,
      };
    }
    const team = teamOf(winner);
    let base = 0;
    for (let s = 0; s < n; s++) if (mode === 'all_remaining' || teamOf(s) !== team) base += pips[s];
    const bonuses = [];
    for (let i = 0; i < (pc[team] || 0); i++) bonuses.push(['paso_corrido', r.pasoCorridoBonus]);
    if (kind === 'domino') {
      if (r.capicuaBonus && o.capicua) { bonuses.push(['capicua', r.capicuaBonus]); notes.push('¡Capicúa!'); }
      if (r.chuchazoBonus && o.chuchazo) { bonuses.push(['chuchazo', r.chuchazoBonus]); notes.push('¡Chuchazo!'); }
    }
    return {
      kind, winner, winningTeam: team,
      points: base + bonuses.reduce((a, b) => a + b[1], 0),
      basePoints: base, bonuses, handPips: pips.slice(), teamPips,
      nextOpener: nextOpenerAfter(r, winner, opener), notes,
    };
  }

  // ==================================================================== State
  // Perfect-information hand for the search.  Moves are small ints:
  //   tile * 2 + end (0 = left, 1 = right) | PASS | DRAW.
  const PASS = -1;
  const DRAW = -2;
  const moveTile = (m) => m >> 1;
  const moveEnd = (m) => (m & 1 ? 'R' : 'L');
  const makeMove = (tile, end) => tile * 2 + (end === 'L' ? 0 : 1);

  // Zobrist keys (two 32-bit halves), fixed seed so keys are stable.
  const Z = (function () {
    const rnd = mulberry32(0xd0d0cafe);
    const r32 = () => (rnd() * 4294967296) | 0;
    const mk = (len) => {
      const a = new Int32Array(len), b = new Int32Array(len);
      for (let i = 0; i < len; i++) { a[i] = r32(); b[i] = r32(); }
      return [a, b];
    };
    return {
      own: mk(28 * 4),     // tile held by seat
      left: mk(8), right: mk(8), turn: mk(4), passes: mk(8), last: mk(5),
      pc0: mk(16), pc1: mk(16), forced: mk(29),
      pozo: mk(28 * 16),   // tile at depth j of the remaining pozo
    };
  })();

  class State {
    constructor(rules) {
      this.r = rules;
      this.n = rules.players;
      this.hands = new Int32Array(4);
      this.left = -1; this.right = -1;
      this.turn = 0; this.passes = 0; this.last = -1;
      this.pc0 = 0; this.pc1 = 0;
      this.opener = 0;
      this.forced = -1;            // tile the salida must be (chain empty only)
      this.chainLen = 0;
      this.capicua = 0;            // set by the play that empties a hand
      this.pozo = new Int8Array(28); this.pozoLen = 0; this.pozoPtr = 0;
      this.ph1 = new Int32Array(29); this.ph2 = new Int32Array(29);
      this.h1 = 0; this.h2 = 0;
      // Public history the network reads: tiles each seat has played and the
      // numbers each is known to lack (same rules as Table: a pass adds the
      // ends, a draw resets to them).
      this.playedBy = new Int32Array(4); this.voids = new Int32Array(4);
      this.sp = 0; this.stk = new Int32Array(9 * 512);
    }
    /** Recompute hashes after hands/pozo were written directly. */
    rehash() {
      let h1 = 0, h2 = 0;
      for (let s = 0; s < this.n; s++) {
        for (const t of tilesOf(this.hands[s])) { h1 ^= Z.own[0][t * 4 + s]; h2 ^= Z.own[1][t * 4 + s]; }
      }
      this.h1 = h1; this.h2 = h2;
      for (let p = 0; p <= this.pozoLen; p++) {
        let a = 0, b = 0;
        for (let j = p; j < this.pozoLen; j++) {
          const i = this.pozo[j] * 16 + (j - p);
          a ^= Z.pozo[0][i]; b ^= Z.pozo[1][i];
        }
        this.ph1[p] = a; this.ph2[p] = b;
      }
    }
    clone() {
      const s = new State(this.r);
      s.hands.set(this.hands);
      s.left = this.left; s.right = this.right; s.turn = this.turn; s.passes = this.passes;
      s.last = this.last; s.pc0 = this.pc0; s.pc1 = this.pc1; s.opener = this.opener;
      s.forced = this.forced; s.chainLen = this.chainLen; s.capicua = this.capicua;
      s.pozo.set(this.pozo); s.pozoLen = this.pozoLen; s.pozoPtr = this.pozoPtr;
      s.playedBy.set(this.playedBy); s.voids.set(this.voids);
      s.rehash();
      return s;
    }
    tilesLeft() {
      let c = 0;
      for (let s = 0; s < this.n; s++) c += popcount(this.hands[s]);
      return c;
    }
    isOver() {
      return (this.last >= 0 && this.hands[this.last] === 0) || this.passes >= this.n;
    }
    /** Legal moves for `seat` written into buf[off..]; returns the count. */
    gen(seat, buf, off) {
      const h = this.hands[seat];
      let c = off;
      if (this.chainLen === 0) {
        if (this.forced >= 0) {
          if ((h >> this.forced) & 1) buf[c++] = this.forced * 2 + 1;
        } else {
          let m = h;
          while (m) { const b = m & -m; buf[c++] = (31 - Math.clz32(b)) * 2 + 1; m ^= b; }
        }
      } else {
        const L = this.left, R = this.right;
        const sl = SUIT[L], sr = SUIT[R];
        let m = h & (sl | sr);
        while (m) {
          const b = m & -m;
          const t = 31 - Math.clz32(b);
          const lok = (sl & b) !== 0, rok = (sr & b) !== 0;
          if (lok) buf[c++] = t * 2;
          if (rok && !(lok && L === R)) buf[c++] = t * 2 + 1;
          m ^= b;
        }
      }
      if (c === off) buf[c++] = (this.r.draw && this.pozoPtr < this.pozoLen) ? DRAW : PASS;
      return c - off;
    }
    moves(seat) {
      const buf = new Int16Array(40);
      const k = this.gen(seat === undefined ? this.turn : seat, buf, 0);
      return Array.from(buf.subarray(0, k));
    }
    apply(m) {
      const k = this.stk, p = this.sp;
      this.sp = p + 9;
      k[p] = m; k[p + 1] = this.left; k[p + 2] = this.right; k[p + 3] = this.turn;
      k[p + 4] = this.passes; k[p + 5] = this.last; k[p + 6] = -1; k[p + 7] = this.capicua;
      k[p + 8] = this.voids[this.turn];
      const seat = this.turn;
      if (m === PASS) {
        if (this.chainLen) this.voids[seat] |= (1 << this.left) | (1 << this.right);
        this.passes++;
        if (this.r.pasoCorridoBonus && this.passes === this.n - 1 && this.last >= 0) {
          if (this.last % 2 === 0) { this.pc0++; k[p + 6] = 0; } else { this.pc1++; k[p + 6] = 1; }
        }
        this.turn = seat + 1 === this.n ? 0 : seat + 1;
      } else if (m === DRAW) {
        const t = this.pozo[this.pozoPtr++];
        this.hands[seat] |= 1 << t;
        this.voids[seat] = this.chainLen ? (1 << this.left) | (1 << this.right) : 0;
        this.h1 ^= Z.own[0][t * 4 + seat]; this.h2 ^= Z.own[1][t * 4 + seat];
      } else {
        const t = m >> 1;
        const bit = 1 << t;
        if (this.chainLen === 0) {
          this.left = LOW[t]; this.right = HIGH[t];
        } else {
          if (this.hands[seat] === bit) {
            const L = this.left, R = this.right;
            this.capicua = (L !== R && t === ID[L * 7 + R]) ? 1 : 0;
          }
          if (m & 1) this.right = LOW[t] === this.right ? HIGH[t] : LOW[t];
          else this.left = LOW[t] === this.left ? HIGH[t] : LOW[t];
        }
        this.hands[seat] &= ~bit;
        this.playedBy[seat] |= bit;
        this.h1 ^= Z.own[0][t * 4 + seat]; this.h2 ^= Z.own[1][t * 4 + seat];
        this.chainLen++;
        this.passes = 0;
        this.last = seat;
        this.turn = seat + 1 === this.n ? 0 : seat + 1;
      }
    }
    undo() {
      const k = this.stk;
      const p = (this.sp -= 9);
      const m = k[p];
      const seat = k[p + 3];
      if (m === PASS) {
        if (k[p + 6] === 0) this.pc0--; else if (k[p + 6] === 1) this.pc1--;
      } else if (m === DRAW) {
        const t = this.pozo[--this.pozoPtr];
        this.hands[seat] &= ~(1 << t);
        this.h1 ^= Z.own[0][t * 4 + seat]; this.h2 ^= Z.own[1][t * 4 + seat];
      } else {
        const t = m >> 1;
        this.hands[seat] |= 1 << t;
        this.playedBy[seat] &= ~(1 << t);
        this.h1 ^= Z.own[0][t * 4 + seat]; this.h2 ^= Z.own[1][t * 4 + seat];
        this.chainLen--;
      }
      this.left = k[p + 1]; this.right = k[p + 2]; this.turn = seat;
      this.passes = k[p + 4]; this.last = k[p + 5]; this.capicua = k[p + 7];
      this.voids[seat] = k[p + 8];
    }
    undoTo(sp) { while (this.sp > sp) this.undo(); }
    lastMove() { return this.sp ? this.stk[this.sp - 9] : PASS; }
    handPips() {
      const out = [];
      for (let s = 0; s < this.n; s++) out.push(pipsOf(this.hands[s]));
      return out;
    }
  }

  // --------------------------------------------------------------- terminal
  // Fast scoring for the search, value in points signed for TEAM 0.  The kind
  // and winning team of the last scored terminal are left in RES_KIND/RES_TEAM
  // (0 domino, 1 tranque, 2 void; team -1 when void).  Checked against
  // scoreTotals in tests/js/engine.test.js.
  let RES_KIND = 0, RES_TEAM = -1;
  const _pips = [0, 0, 0, 0];

  function tranqueValue(st) {
    const r = st.r, n = st.n;
    for (let s = 0; s < n; s++) _pips[s] = pipsOf(st.hands[s]);
    const pips = _pips.slice(0, n);
    const [w] = tranqueWinner(r, pips, st.opener, st.last);
    RES_KIND = 1;
    if (w === null) { RES_KIND = 2; RES_TEAM = -1; return 0; }
    const team = w % 2;
    let pts = 0;
    for (let s = 0; s < n; s++) if (r.tranquePoints === 'all_remaining' || s % 2 !== team) pts += pips[s];
    pts += (team === 0 ? st.pc0 : st.pc1) * r.pasoCorridoBonus;
    RES_TEAM = team;
    return team === 0 ? pts : -pts;
  }

  function terminalValue(st) {
    const r = st.r, n = st.n, w = st.last;
    if (w >= 0 && st.hands[w] === 0) {
      const team = w % 2;
      let pts = 0;
      for (let s = 0; s < n; s++) {
        if (r.handPoints === 'all_remaining' || s % 2 !== team) pts += pipsOf(st.hands[s]);
      }
      pts += (team === 0 ? st.pc0 : st.pc1) * r.pasoCorridoBonus;
      if (st.capicua && r.capicuaBonus) pts += r.capicuaBonus;
      if (r.chuchazoBonus && st.sp && (st.lastMove() >> 1) === CHUCHA && st.lastMove() >= 0) pts += r.chuchazoBonus;
      RES_KIND = 0; RES_TEAM = team;
      return team === 0 ? pts : -pts;
    }
    return tranqueValue(st);
  }

  /** Full HandResult-style object for a finished State (for the UI / tests). */
  function scoreState(st) {
    const pips = st.handPips();
    const pc = [st.pc0, st.pc1];
    const w = st.last;
    if (w >= 0 && st.hands[w] === 0) {
      const lm = st.lastMove();
      return scoreTotals(st.r, pips, 'domino', {
        winner: w, opener: st.opener, blocker: st.last, pc,
        capicua: !!st.capicua, chuchazo: lm >= 0 && (lm >> 1) === CHUCHA,
      });
    }
    return scoreTotals(st.r, pips, 'tranque', { opener: st.opener, blocker: st.last, pc });
  }

  // --------------------------------------------------------------- heuristics
  /** dominord.search.static_eval — weight, tempo and control of the ends. */
  function staticEval(st, team) {
    let pipDiff = 0, tileDiff = 0, control = 0;
    const started = st.chainLen > 0;
    const endMask = started ? (SUIT[st.left] | SUIT[st.right]) : 0;
    for (let s = 0; s < st.n; s++) {
      const h = st.hands[s];
      const sign = s % 2 === team ? -1 : 1;
      pipDiff += sign * pipsOf(h);
      tileDiff += sign * popcount(h);
      if (started) control -= sign * popcount(h & endMask);
    }
    return 0.45 * pipDiff + 3.0 * tileDiff + 1.5 * control;
  }

  const _gbuf = new Int16Array(40);
  /** The rollout policy: best one-ply move for the side to move. */
  function greedyMove(st, rnd) {
    const seat = st.turn, team = seat % 2;
    const k = st.gen(seat, _gbuf, 0);
    if (k === 1) return _gbuf[0];
    let best = -Infinity, pick = _gbuf[0], ties = 0;
    const cand = Array.from(_gbuf.subarray(0, k));
    for (const m of cand) {
      st.apply(m);
      let v;
      if (st.isOver()) { v = terminalValue(st); if (team === 1) v = -v; }
      else v = staticEval(st, team);
      st.undo();
      if (v > best + 1e-9) { best = v; pick = m; ties = 1; }
      else if (v > best - 1e-9) {
        ties++;
        if (rnd && rnd() * ties < 1) pick = m;
      }
    }
    return pick;
  }

  /** Play out with the greedy policy; value for team 0.  State is restored. */
  function playout(st, rnd) {
    const sp = st.sp;
    while (!st.isOver()) st.apply(greedyMove(st, rnd));
    const v = terminalValue(st);
    st.undoTo(sp);
    return v;
  }

  // ==================================================================== solver
  // Exact alpha-beta in team-0 frame with an open-addressed Zobrist TT that
  // survives across determinizations (keys cover every field the value depends
  // on, so sharing it is sound — see ROADMAP Phase 1, WP7).
  const TT_BITS = 20, TT_SIZE = 1 << TT_BITS, TT_MASK = TT_SIZE - 1;
  const EXACT = 0, LOWER = 1, UPPER = 2;
  let TT = null;
  function ensureTT() {
    if (!TT) {
      TT = {
        k1: new Int32Array(TT_SIZE), k2: new Int32Array(TT_SIZE),
        val: new Int16Array(TT_SIZE), flag: new Int8Array(TT_SIZE),
        move: new Int16Array(TT_SIZE), res: new Int8Array(TT_SIZE),
        used: new Uint8Array(TT_SIZE), rules: null,
      };
    }
    return TT;
  }
  function clearTT() { if (TT) { TT.used.fill(0); } }

  const ABORT = { abort: true };
  const SEARCH = { nodes: 0, limit: Infinity };
  const MOVEBUF = new Int16Array(40 * 160);

  function nodeKey(st) {
    let a = st.h1, b = st.h2;
    a ^= Z.left[0][st.left + 1] ^ Z.right[0][st.right + 1] ^ Z.turn[0][st.turn] ^ Z.passes[0][st.passes]
      ^ Z.last[0][st.last + 1] ^ Z.pc0[0][st.pc0 & 15] ^ Z.pc1[0][st.pc1 & 15] ^ st.ph1[st.pozoPtr];
    b ^= Z.left[1][st.left + 1] ^ Z.right[1][st.right + 1] ^ Z.turn[1][st.turn] ^ Z.passes[1][st.passes]
      ^ Z.last[1][st.last + 1] ^ Z.pc0[1][st.pc0 & 15] ^ Z.pc1[1][st.pc1 & 15] ^ st.ph2[st.pozoPtr];
    if (st.chainLen === 0) { a ^= Z.forced[0][st.forced + 1]; b ^= Z.forced[1][st.forced + 1]; }
    _k2 = b;
    return a;
  }
  let _k2 = 0;

  function ab(st, alpha, beta, depth) {
    if (++SEARCH.nodes > SEARCH.limit) throw ABORT;
    if (st.isOver()) return terminalValue(st);
    const tt = TT;
    const k1 = nodeKey(st), k2 = _k2;
    const idx = (k1 ^ (k2 >>> 12)) & TT_MASK;
    let ttMove = -9;
    if (tt.used[idx] && tt.k1[idx] === k1 && tt.k2[idx] === k2) {
      const v = tt.val[idx], f = tt.flag[idx];
      if (f === EXACT || (f === LOWER && v >= beta) || (f === UPPER && v <= alpha)) {
        const rc = tt.res[idx];
        RES_KIND = rc >> 2; RES_TEAM = (rc & 3) - 1;
        return v;
      }
      ttMove = tt.move[idx];
    }
    const off = depth * 40;
    const k = st.gen(st.turn, MOVEBUF, off);
    // Order: TT move, then heavy tiles first (they cut more branches early).
    for (let i = off + 1; i < off + k; i++) {
      const m = MOVEBUF[i];
      const key = m === ttMove ? 1000 : (m >= 0 ? PIPS[m >> 1] : -1);
      let j = i - 1;
      while (j >= off) {
        const o = MOVEBUF[j];
        const ok = o === ttMove ? 1000 : (o >= 0 ? PIPS[o >> 1] : -1);
        if (ok >= key) break;
        MOVEBUF[j + 1] = o; j--;
      }
      MOVEBUF[j + 1] = m;
    }
    const maximizing = (st.turn & 1) === 0;
    const a0 = alpha, b0 = beta;
    let best = maximizing ? -Infinity : Infinity, bestRes = 0, bestMove = MOVEBUF[off];
    for (let i = 0; i < k; i++) {
      const m = MOVEBUF[off + i];
      st.apply(m);
      const v = ab(st, alpha, beta, depth + 1);
      st.undo();
      if (maximizing) {
        if (v > best) { best = v; bestMove = m; bestRes = (RES_KIND << 2) | (RES_TEAM + 1); }
        if (v > alpha) alpha = v;
      } else {
        if (v < best) { best = v; bestMove = m; bestRes = (RES_KIND << 2) | (RES_TEAM + 1); }
        if (v < beta) beta = v;
      }
      if (alpha >= beta) break;
    }
    tt.used[idx] = 1; tt.k1[idx] = k1; tt.k2[idx] = k2;
    tt.val[idx] = best; tt.move[idx] = bestMove; tt.res[idx] = bestRes;
    tt.flag[idx] = best <= a0 ? UPPER : best >= b0 ? LOWER : EXACT;
    RES_KIND = bestRes >> 2; RES_TEAM = (bestRes & 3) - 1;
    return best;
  }

  function bindRules(r) {
    const tt = ensureTT();
    if (tt.rules !== r) { clearTT(); tt.rules = r; }
  }

  /**
   * Exact value of a State for `team` (signed hand points), or null when the
   * node budget runs out.  Also returns the terminal of the principal line.
   */
  function solve(st, team, nodeLimit) {
    bindRules(st.r);
    const sp = st.sp;
    SEARCH.limit = nodeLimit ? SEARCH.nodes + nodeLimit : Infinity;
    try {
      const v = ab(st, -Infinity, Infinity, 0);
      return { value: team === 0 || v === 0 ? v : -v, kind: RES_KIND, winTeam: RES_TEAM };
    } catch (e) {
      if (e !== ABORT) throw e;
      st.undoTo(sp);
      return null;
    } finally {
      SEARCH.limit = Infinity;
    }
  }

  /** Plain minimax with no pruning or TT — the oracle for the solver's tests. */
  function minimax(st) {
    if (st.isOver()) return terminalValue(st);
    const ms = st.moves();
    const max = (st.turn & 1) === 0;
    let best = max ? -Infinity : Infinity;
    for (const m of ms) {
      st.apply(m);
      const v = minimax(st);
      st.undo();
      best = max ? Math.max(best, v) : Math.min(best, v);
    }
    return best;
  }

  /**
   * Value of a determinized position for team 0 plus how it ends.  Exact when
   * small enough (and within the node budget), otherwise a greedy playout.
   */
  function resolve(st, cfg, rnd, pol) {
    if (st.isOver()) {
      const v = terminalValue(st);
      return { value: v, kind: RES_KIND, winTeam: RES_TEAM, exact: true };
    }
    if (st.tilesLeft() <= cfg.exactTiles) {
      const r = solve(st, 0, cfg.nodeCap);
      if (r) return { value: r.value, kind: r.kind, winTeam: r.winTeam, exact: true };
    }
    if (pol) {
      // Each seat plays its modelled style (the network for strong players)
      // only until the position is small enough to solve, then it is exact.
      const sp = st.sp;
      while (!st.isOver() && st.tilesLeft() > cfg.exactTiles) st.apply(styleMove(pol.styles[st.turn], st, rnd, pol.net));
      let out;
      if (st.isOver()) {
        const v = terminalValue(st);
        out = { value: v, kind: RES_KIND, winTeam: RES_TEAM, exact: false };
      } else {
        const r = solve(st, 0, cfg.nodeCap);
        out = r ? { value: r.value, kind: r.kind, winTeam: r.winTeam, exact: false }
          : { value: playout(st, rnd), kind: RES_KIND, winTeam: RES_TEAM, exact: false };
      }
      st.undoTo(sp);
      return out;
    }
    const v = playout(st, rnd);
    return { value: v, kind: RES_KIND, winTeam: RES_TEAM, exact: false };
  }

  // ==================================================================== Table
  // What an observer at the table knows (dominord/table.py).  Moves:
  //   {k:'play', p, tile, end:'L'|'R'} | {k:'pass', p} | {k:'draw', p, tile (-1 unknown)}
  class Table {
    constructor(o) {
      o = o || {};
      this.rules = o.rules || makeRules('patio');
      const n = this.rules.players;
      this.opener = o.opener || 0;
      this.hero = o.hero === undefined ? 0 : o.hero;     // null => pure observer
      this.forcedOpen = o.forcedOpen === undefined ? -1 : o.forcedOpen;
      this.names = o.names || Array.from({ length: n }, (_, i) => 'P' + i);
      this.known = Array(n).fill(null);                  // dealt masks we can see
      this.moves = [];
      this._d = null;
    }
    setHand(seat, tiles) {
      const mask = Array.isArray(tiles) ? tiles.reduce((m, t) => m | (1 << t), 0) : tiles;
      if (popcount(mask) !== this.rules.tilesPerPlayer) {
        throw new Error('a dealt hand holds ' + this.rules.tilesPerPlayer + ' tiles, got ' + popcount(mask));
      }
      this.known.forEach((h, s) => {
        if (s !== seat && h !== null && (h & mask)) {
          throw new Error(tilesOf(h & mask).map(tileName).join(' ') + ' already dealt to ' + this.names[s]);
        }
      });
      this.known[seat] = mask;
      this._d = null;
    }
    clone() {
      const t = new Table({ rules: this.rules, opener: this.opener, hero: this.hero,
        forcedOpen: this.forcedOpen, names: this.names.slice() });
      t.known = this.known.slice();
      t.moves = this.moves.map((m) => Object.assign({}, m));
      return t;
    }
    /** A copy of this table as seen from `seat` only (for engine players). */
    viewFor(seat) {
      const t = this.clone();
      t.hero = seat;
      t.known = t.known.map((h, s) => (s === seat ? h : null));
      t.moves = t.moves.map((m) => (m.k === 'draw' && m.p !== seat ? { k: 'draw', p: m.p, tile: -1 } : m));
      return t;
    }
    get d() { return this._d || (this._d = this._derive()); }
    _derive() {
      const r = this.rules, n = r.players;
      const d = {
        chain: [], left: -1, right: -1, turn: this.opener,
        counts: Array(n).fill(r.tilesPerPlayer), voids: Array(n).fill(0),
        played: 0, playedBy: Array(n).fill(0), drawn: Array(n).fill(0), draws: Array(n).fill(0),
        pozo: r.players === 2 ? pozoSize(r) : 0,
        passes: 0, last: -1, pc: [0, 0], pcEvents: [],
        endsBeforeLast: null, lastTile: -1, drawStreak: -1,
      };
      for (const mv of this.moves) {
        if (mv.k === 'pass') {
          if (d.chain.length) d.voids[mv.p] |= (1 << d.left) | (1 << d.right);
          d.passes++;
          if (r.pasoCorridoBonus && d.passes === n - 1 && d.last >= 0) {
            d.pc[teamOf(d.last)]++;
            d.pcEvents.push(d.last);
          }
          d.turn = nextSeat(r, mv.p);
          d.drawStreak = -1;
        } else if (mv.k === 'draw') {
          d.counts[mv.p]++; d.pozo--; d.draws[mv.p]++;
          if (mv.tile >= 0) d.drawn[mv.p] |= 1 << mv.tile;
          // Drawing means "nothing for either end": the kept hand is void in
          // both, but whatever was drawn may carry older void numbers again.
          d.voids[mv.p] = d.chain.length ? (1 << d.left) | (1 << d.right) : 0;
          d.drawStreak = mv.p;
        } else {
          const t = mv.tile;
          d.endsBeforeLast = [d.left, d.right];
          if (!d.chain.length) {
            d.chain.push([LOW[t], HIGH[t]]);
            d.left = LOW[t]; d.right = HIGH[t];
          } else if (mv.end === 'L') {
            const o = otherFace(t, d.left);
            d.chain.unshift([o, d.left]); d.left = o;
          } else {
            const o = otherFace(t, d.right);
            d.chain.push([d.right, o]); d.right = o;
          }
          d.counts[mv.p]--;
          d.played |= 1 << t; d.playedBy[mv.p] |= 1 << t;
          d.passes = 0; d.last = mv.p; d.lastTile = t;
          d.turn = nextSeat(r, mv.p);
          d.drawStreak = -1;
        }
      }
      return d;
    }
    get turn() { return this.d.turn; }
    currentHand(seat) {
      if (this.known[seat] === null || this.known[seat] === undefined) return null;
      return (this.known[seat] | this.d.drawn[seat]) & ~this.d.played;
    }
    unseen() {
      let seen = this.d.played;
      for (let s = 0; s < this.rules.players; s++) {
        const h = this.currentHand(s);
        if (h !== null) seen |= h;
      }
      return FULL & ~seen;
    }
    unknownSeats() {
      const out = [];
      for (let s = 0; s < this.rules.players; s++) if (this.currentHand(s) === null) out.push(s);
      return out;
    }
    dominoPlayer() {
      const c = this.d.counts;
      for (let s = 0; s < c.length; s++) if (c[s] === 0) return s;
      return -1;
    }
    isBlocked() { return this.d.passes >= this.rules.players; }
    isOver() { return this.dominoPlayer() >= 0 || this.isBlocked(); }

    /** Pick the end when the notation leaves it implicit; null = ambiguous. */
    resolveEnd(tile, end) {
      const d = this.d;
      if (!d.chain.length) return 'R';
      const lok = hasSuit(tile, d.left), rok = hasSuit(tile, d.right);
      if (end) return end;
      if (lok && rok) return d.left === d.right ? 'R' : null;
      if (lok) return 'L';
      if (rok) return 'R';
      throw new Error('[' + tileName(tile) + '] fits neither end (' + d.left + ', ' + d.right + ')');
    }
    /** Legal plays for a seat whose hand is known. */
    legalPlays(seat) {
      const st = new State(this.rules);
      const h = this.currentHand(seat);
      if (h === null) throw new Error(this.names[seat] + "'s hand is unknown");
      st.hands[seat] = h;
      st.left = this.d.left; st.right = this.d.right; st.chainLen = this.d.chain.length;
      st.forced = this.d.chain.length ? -1 : this.forcedOpen;
      st.pozoLen = this.d.pozo; st.pozoPtr = 0;
      return st.moves(seat);
    }
    validate(mv) {
      const d = this.d, r = this.rules, nm = (s) => this.names[s];
      if (this.isOver()) throw new Error('the hand is already over');
      if (mv.p !== d.turn) throw new Error("it is " + nm(d.turn) + "'s turn, not " + nm(mv.p) + "'s");
      const hand = this.currentHand(mv.p);
      const endsMask = d.chain.length ? (SUIT[d.left] | SUIT[d.right]) : FULL;
      if (mv.k === 'pass') {
        if (!d.chain.length) throw new Error('nobody passes on the salida');
        if (hand !== null && (hand & endsMask) && r.mustPlayIfAble) {
          throw new Error(nm(mv.p) + ' holds a legal tile: ' + tilesOf(hand & endsMask).map((t) => '[' + tileName(t) + ']').join(' '));
        }
        if (r.draw && d.pozo > 0) throw new Error(nm(mv.p) + ' must draw from the pozo, not pass');
        return;
      }
      if (mv.k === 'draw') {
        if (!r.draw) throw new Error('these rules have no drawing');
        if (d.pozo <= 0) throw new Error('the pozo is empty: pass instead');
        if (!d.chain.length) throw new Error('nobody draws before the salida');
        if (hand !== null && (hand & endsMask)) throw new Error(nm(mv.p) + ' can play, so cannot draw');
        if (hand !== null && !(mv.tile >= 0)) throw new Error('say which tile ' + nm(mv.p) + ' drew');
        if (mv.tile >= 0) {
          if (!((this.unseen() >> mv.tile) & 1)) throw new Error('[' + tileName(mv.tile) + '] is not in the pozo');
        }
        return;
      }
      const t = mv.tile;
      if (!(t >= 0 && t < 28)) throw new Error('bad tile');
      if ((d.played >> t) & 1) throw new Error('[' + tileName(t) + '] is already on the table');
      if (d.counts[mv.p] === 0) throw new Error(nm(mv.p) + ' has no tiles left');
      if (hand !== null && !((hand >> t) & 1)) throw new Error(nm(mv.p) + ' does not hold [' + tileName(t) + ']');
      for (let s = 0; s < r.players; s++) {
        const h = this.currentHand(s);
        if (s !== mv.p && h !== null && ((h >> t) & 1)) throw new Error('[' + tileName(t) + '] belongs to ' + nm(s));
      }
      if (hand === null && (d.voids[mv.p] & ((1 << LOW[t]) | (1 << HIGH[t]))) && d.drawStreak !== mv.p) {
        const v = tilesOf(d.voids[mv.p] & 0x7f);
        throw new Error(nm(mv.p) + ' already passed on ' + v.join(' and ') + ', so cannot hold [' + tileName(t) + '] — check the history');
      }
      if (!d.chain.length) {
        if (this.forcedOpen >= 0 && t !== this.forcedOpen) throw new Error('the salida must be [' + tileName(this.forcedOpen) + ']');
        return;
      }
      if (mv.end === 'L' && !hasSuit(t, d.left)) throw new Error('[' + tileName(t) + '] does not fit the left end ' + d.left);
      if (mv.end === 'R' && !hasSuit(t, d.right)) throw new Error('[' + tileName(t) + '] does not fit the right end ' + d.right);
      if (mv.end !== 'L' && mv.end !== 'R') throw new Error('which end?');
    }
    /**
     * Record a move.  Rejects anything that breaks the rules *or* leaves no
     * consistent deal (WP6: name the move that made the position impossible).
     */
    record(mv) {
      mv = Object.assign({}, mv);
      if (mv.k === 'play') {
        const end = this.resolveEnd(mv.tile, mv.end);
        if (end === null) throw new Error('[' + tileName(mv.tile) + '] fits both ends — say left or right');
        mv.end = end;
      }
      if (mv.k === 'draw' && mv.tile === undefined) mv.tile = -1;
      this.validate(mv);
      this.moves.push(mv);
      this._d = null;
      try {
        buildBeliefs(this);
      } catch (e) {
        this.moves.pop();
        this._d = null;
        throw new Error('that move leaves no possible deal: ' + e.message);
      }
      return mv;
    }
    undo() {
      const mv = this.moves.pop();
      this._d = null;
      return mv;
    }
    /** Full State for a deal: `assign[b]` = tiles of bucket b of `bel`. */
    toState(bel, assign, rnd) {
      const r = this.rules, d = this.d, st = new State(r);
      for (let s = 0; s < r.players; s++) {
        const h = this.currentHand(s);
        st.hands[s] = h === null ? 0 : h;
      }
      bel.buckets.forEach((b, i) => {
        if (b.seat < r.players) st.hands[b.seat] = assign[i];
        else {
          const pz = shuffle(tilesOf(assign[i]), rnd || Math.random);
          st.pozo.set(pz); st.pozoLen = pz.length; st.pozoPtr = 0;
        }
      });
      st.left = d.left; st.right = d.right; st.turn = d.turn; st.passes = d.passes; st.last = d.last;
      st.pc0 = d.pc[0]; st.pc1 = d.pc[1]; st.opener = this.opener; st.chainLen = d.chain.length;
      for (let s = 0; s < r.players; s++) { st.playedBy[s] = d.playedBy[s]; st.voids[s] = d.voids[s]; }
      st.forced = d.chain.length ? -1 : this.forcedOpen;
      if (this.isOver() && d.last >= 0 && d.counts[d.last] === 0 && d.endsBeforeLast) {
        const [L, R] = d.endsBeforeLast;
        st.capicua = (d.chain.length > 1 && L !== R && d.lastTile === tileId(L, R)) ? 1 : 0;
      }
      st.rehash();
      return st;
    }
    /** Score a finished hand from pip totals (or revealed tiles turned into pips). */
    scoreFinished(pips) {
      const d = this.d, r = this.rules;
      const w = this.dominoPlayer();
      if (w >= 0) {
        if (pips[w] !== 0) throw new Error(this.names[w] + ' closed the hand and cannot hold tiles');
        const [L, R] = d.endsBeforeLast || [-1, -1];
        const capicua = d.chain.length > 1 && L !== R && d.lastTile === tileId(L, R);
        return scoreTotals(r, pips, 'domino', {
          winner: w, opener: this.opener, blocker: d.last, pc: d.pc, capicua, chuchazo: d.lastTile === CHUCHA,
        });
      }
      if (!this.isBlocked()) throw new Error('the hand is not over');
      return scoreTotals(r, pips, 'tranque', { opener: this.opener, blocker: d.last, pc: d.pc });
    }
    toJSON() {
      return {
        rules: this.rules, opener: this.opener, hero: this.hero, forcedOpen: this.forcedOpen,
        names: this.names, known: this.known.map((h) => (h === null ? null : tilesOf(h).map(tileKey))),
        moves: this.moves.map((m) => Object.assign({}, m, m.tile !== undefined && m.tile >= 0 ? { tile: tileKey(m.tile) } : {})),
      };
    }
    static fromJSON(o) {
      const t = new Table({ rules: o.rules, opener: o.opener, hero: o.hero, forcedOpen: o.forcedOpen, names: o.names });
      o.known.forEach((h, s) => { if (h) t.known[s] = h.map(parseTile).reduce((m, x) => m | (1 << x), 0); });
      for (const m of o.moves) {
        const mv = Object.assign({}, m);
        if (typeof mv.tile === 'string') mv.tile = parseTile(mv.tile);
        t.moves.push(mv);
      }
      t._d = null;
      return t;
    }
  }

  // ==================================================================== beliefs
  // Exact tile probabilities over every deal consistent with the observations
  // (dominord/inference.py), generalised to "buckets": the unknown seats plus,
  // in the 1v1 game, the pozo.  Counts are exact integers in doubles (< 2^53).
  function buildBeliefs(table) {
    const r = table.rules, d = table.d, n = r.players;
    const unseen = table.unseen();
    const tiles = tilesOf(unseen);
    const buckets = [];
    for (const s of table.unknownSeats()) {
      buckets.push({ seat: s, cap: d.counts[s], allowed: unseen & ~suitsMask(d.voids[s]) });
    }
    if (d.pozo > 0) buckets.push({ seat: n, cap: d.pozo, allowed: unseen });
    // The first salida is forced: before it is laid, the opener holds the tile.
    if (!d.chain.length && table.forcedOpen >= 0 && ((unseen >> table.forcedOpen) & 1)) {
      const bit = 1 << table.forcedOpen;
      if (table.currentHand(table.opener) !== null) throw new Error(table.names[table.opener] + ' opens but does not hold [' + tileName(table.forcedOpen) + ']');
      for (const b of buckets) if (b.seat !== table.opener) b.allowed &= ~bit;
    }
    const caps = buckets.map((b) => b.cap);
    const capSum = caps.reduce((a, b) => a + b, 0);
    if (capSum !== tiles.length) {
      throw new Error(tiles.length + ' unseen tiles cannot fill hands of sizes ' + caps.join('/'));
    }
    const nb = buckets.length;
    const stride = [];
    let size = 1;
    for (let k = 0; k < nb; k++) { stride.push(size); size *= caps[k] + 1; }
    const capIdx = caps.reduce((a, c, k) => a + c * stride[k], 0);
    const allowIdx = tiles.map((t) => {
      const a = [];
      for (let k = 0; k < nb; k++) if ((buckets[k].allowed >> t) & 1) a.push(k);
      return a;
    });
    const digit = (idx, k) => Math.floor(idx / stride[k]) % (caps[k] + 1);

    function suffixCounts(allow) {
      const m = tiles.length;
      const suf = new Array(m + 1);
      suf[m] = new Float64Array(size); suf[m][0] = 1;
      for (let i = m - 1; i >= 0; i--) {
        const cur = new Float64Array(size), nxt = suf[i + 1];
        for (let idx = 0; idx < size; idx++) {
          const w = nxt[idx];
          if (!w) continue;
          for (const k of allow[i]) if (digit(idx, k) < caps[k]) cur[idx + stride[k]] += w;
        }
        suf[i] = cur;
      }
      return suf;
    }
    const suffix = suffixCounts(allowIdx);
    const total = tiles.length ? suffix[0][capIdx] : 1;
    if (!total) throw new Error('the recorded passes and hand sizes admit no legal deal');

    // Exact marginals by pairing prefix and suffix counts.
    const marg = new Float64Array(28 * nb);
    let prefix = new Float64Array(size); prefix[0] = 1;
    tiles.forEach((t, i) => {
      const next = new Float64Array(size);
      for (let used = 0; used < size; used++) {
        const w = prefix[used];
        if (!w) continue;
        for (const k of allowIdx[i]) {
          if (digit(used, k) >= caps[k]) continue;
          const rest = capIdx - used - stride[k];
          const tail = suffix[i + 1][rest];
          if (tail) marg[t * nb + k] += w * tail;
          next[used + stride[k]] += w;
        }
      }
      prefix = next;
    });
    for (let i = 0; i < marg.length; i++) marg[i] /= total;

    const bucketOf = {};
    buckets.forEach((b, i) => { bucketOf[b.seat] = i; });
    const bel = {
      buckets, tiles, total, caps, bucketOf, n,
      known: Array.from({ length: n }, (_, s) => table.currentHand(s)),
      /** P(seat holds tile); seat === players means the pozo. */
      prob(seat, t) {
        if (seat < n && this.known[seat] !== null) return (this.known[seat] >> t) & 1;
        const b = bucketOf[seat];
        return b === undefined ? 0 : marg[t * nb + b];
      },
      expectedPips(seat) {
        if (seat < n && this.known[seat] !== null) return pipsOf(this.known[seat]);
        let e = 0;
        for (const t of tiles) e += PIPS[t] * this.prob(seat, t);
        return e;
      },
      /** Exact P(seat holds at least one tile of `suit`) — WP6, a second DP. */
      suitProb(seat, suit) {
        if (seat < n && this.known[seat] !== null) return (this.known[seat] & SUIT[suit]) ? 1 : 0;
        const b = bucketOf[seat];
        if (b === undefined) return 0;
        const cacheKey = seat * 7 + suit;
        if (this._suit[cacheKey] !== undefined) return this._suit[cacheKey];
        const allow = allowIdx.map((a, i) => (hasSuit(tiles[i], suit) ? a.filter((k) => k !== b) : a));
        const suf = suffixCounts(allow);
        const none = tiles.length ? suf[0][capIdx] : 1;
        return (this._suit[cacheKey] = 1 - none / total);
      },
      _suit: {},
      /** Uniformly random consistent deal: an array of bucket masks. */
      sample(rnd) {
        const out = new Int32Array(nb);
        let free = capIdx;
        for (let i = 0; i < tiles.length; i++) {
          let tot = 0;
          const ws = [];
          for (const k of allowIdx[i]) {
            if (digit(free, k) === 0) continue;
            const w = suffix[i + 1][free - stride[k]];
            if (w) { ws.push(k, w); tot += w; }
          }
          let pick = rnd() * tot;
          for (let j = 0; j < ws.length; j += 2) {
            if (pick < ws[j + 1] || j + 2 >= ws.length) {
              const k = ws[j];
              out[k] |= 1 << tiles[i]; free -= stride[k];
              break;
            }
            pick -= ws[j + 1];
          }
        }
        return out;
      },
      /** Every consistent deal (only call when `total` is small). */
      enumerate(limit) {
        const out = [];
        const cur = new Int32Array(nb);
        const rec = (i, free) => {
          if (out.length >= limit) return;
          if (i === tiles.length) { out.push(Int32Array.from(cur)); return; }
          for (const k of allowIdx[i]) {
            if (digit(free, k) === 0) continue;
            if (!suffix[i + 1][free - stride[k]]) continue;
            cur[k] |= 1 << tiles[i];
            rec(i + 1, free - stride[k]);
            cur[k] &= ~(1 << tiles[i]);
          }
        };
        rec(0, capIdx);
        return out;
      },
    };
    return bel;
  }

  // ==================================================================== choice likelihood
  // WP1: weight each imagined deal by how plausible the observed plays of the
  // unseen seats are under it.  The policy is a softmax over the greedy
  // one-ply score — heavy tiles out, keep the ends you can answer.  Returned
  // as a ratio to a uniform chooser so weights stay near 1.
  function choiceWeight(table, bel, assign, temperature) {
    const r = table.rules;
    if (r.draw) return 1; // draw order is unobserved; keep the uniform prior
    const d = table.d, n = r.players;
    const st = new State(r);
    for (let s = 0; s < n; s++) {
      const h = table.currentHand(s);
      st.hands[s] = (h === null ? 0 : h) | d.playedBy[s];
    }
    bel.buckets.forEach((b, i) => { if (b.seat < n) st.hands[b.seat] = assign[i] | d.playedBy[b.seat]; });
    st.turn = table.opener; st.opener = table.opener;
    st.forced = table.forcedOpen;
    st.rehash();
    let w = 1;
    const buf = new Int16Array(40);
    for (const mv of table.moves) {
      const seat = mv.p;
      if (mv.k === 'play') {
        const code = st.chainLen === 0 ? mv.tile * 2 + 1 : mv.tile * 2 + (mv.end === 'L' ? 0 : 1);
        if (table.currentHand(seat) === null) {
          const k = st.gen(seat, buf, 0);
          if (k > 1) {
            const team = seat % 2;
            const scores = [];
            let obs = -1;
            for (let i = 0; i < k; i++) {
              const m = buf[i];
              st.apply(m);
              let v;
              if (st.isOver()) { v = terminalValue(st); if (team === 1) v = -v; } else v = staticEval(st, team);
              st.undo();
              scores.push(v);
              if (m === code) obs = i;
            }
            if (obs >= 0) {
              const mx = Math.max.apply(null, scores);
              let z = 0;
              for (const s of scores) z += Math.exp((s - mx) / temperature);
              w *= (Math.exp((scores[obs] - mx) / temperature) / z) * k;
            }
          }
        }
        st.apply(code);
      } else if (mv.k === 'pass') {
        st.apply(PASS);
      }
    }
    return Math.min(50, Math.max(0.02, w));
  }

  // ==================================================================== network
  // The self-play network (dominord/train).  stateFeatures / actionFeatures
  // are line-by-line twins of dominord/train/features.py and must stay so
  // (tests/test_train_env.py compares them number for number).  They read
  // only the acting seat's hand plus public history, so they are safe to call
  // on a determinized State.
  const STATE_DIM = 227, ACTION_DIM = 48;

  function stateFeatures(st, me, f) {
    f.fill(0);
    const n = st.n, r = st.r;
    let o = 0;
    const setBits = (off, mask) => { while (mask) { const b = mask & -mask; f[off + 31 - Math.clz32(b)] = 1; mask ^= b; } };
    setBits(o, st.hands[me]); o += 28;
    let played = 0;
    for (let k = 0; k < 4; k++) {
      if (k < n) { const s = (me + k) % n; setBits(o + k * 28, st.playedBy[s]); played |= st.playedBy[s]; }
    }
    o += 112;
    setBits(o, FULL & ~st.hands[me] & ~played); o += 28;
    for (let k = 1; k < 4; k++) {
      if (k < n) {
        const v = st.voids[(me + k) % n];
        for (let suit = 0; suit < 7; suit++) if ((v >> suit) & 1) f[o + (k - 1) * 7 + suit] = 1;
      }
    }
    o += 21;
    for (let k = 0; k < 4; k++) if (k < n) f[o + k] = popcount(st.hands[(me + k) % n]) / 7;
    o += 4;
    if (st.chainLen) { f[o + st.left] = 1; f[o + 7 + st.right] = 1; }
    o += 14;
    f[o] = st.chainLen === 0 ? 1 : 0; o += 1;
    f[o + Math.min(st.passes, 3)] = 1; o += 4;
    f[o] = (st.pozoLen - st.pozoPtr) / 14; o += 1;
    if (st.last >= 0) f[o + (((st.last - me) % n) + n) % n] = 1;
    o += 4;
    const team = me % 2;
    const pc = [st.pc0, st.pc1];
    f[o] = pc[team] / 2; f[o + 1] = pc[1 - team] / 2; o += 2;
    const flags = [n === 2, r.draw, r.handPoints === 'all_remaining', r.tranqueWinner === 'lowest_team_total',
      r.capicuaBonus > 0, r.chuchazoBonus > 0, r.pasoCorridoBonus > 0];
    for (let i = 0; i < 7; i++) f[o + i] = flags[i] ? 1 : 0;
    o += 7;
    f[o] = st.forced >= 0 && st.chainLen === 0 ? 1 : 0;
    return f;
  }

  function actionFeatures(st, m, a) {
    a.fill(0);
    let L = st.left, R = st.right;
    if (m === PASS) a[30] = 1;
    else if (m === DRAW) a[31] = 1;
    else {
      const t = m >> 1;
      a[t] = 1;
      if (st.chainLen === 0) { a[29] = 1; L = LOW[t]; R = HIGH[t]; }
      else {
        a[28 + (m & 1)] = 1;
        if (m & 1) R = LOW[t] === R ? HIGH[t] : LOW[t];
        else L = LOW[t] === L ? HIGH[t] : LOW[t];
      }
      a[46] = PIPS[t] / 12;
      a[47] = LOW[t] === HIGH[t] ? 1 : 0;
    }
    if (L >= 0) { a[32 + L] = 1; a[39 + R] = 1; }
    return a;
  }

  function b64ToF32(b64) {
    let bytes;
    if (typeof atob === 'function') {
      const s = atob(b64);
      bytes = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    } else {
      const buf = Buffer.from(b64, 'base64');
      bytes = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
    }
    return new Float32Array(bytes.buffer);
  }

  function dense(W, b, x, nin, nout, out, relu) {
    for (let i = 0; i < nout; i++) {
      let s = b[i];
      const row = i * nin;
      for (let j = 0; j < nin; j++) s += W[row + j] * x[j];
      out[i] = relu && s < 0 ? 0 : s;
    }
    return out;
  }

  /** The exported network (format dominord-net/1), forward pass only. */
  class Net {
    constructor(doc) {
      if (doc.format !== 'dominord-net/1') throw new Error('unknown network format ' + doc.format);
      if (doc.stateDim !== STATE_DIM || doc.actionDim !== ACTION_DIM) throw new Error('network features do not match this engine');
      const L = {};
      for (const k in doc.layers) L[k] = b64ToF32(doc.layers[k].data);
      this.L = L; this.meta = doc.meta || {};
      this.h = doc.hidden; this.qh = doc.qhidden; this.scale = doc.valueScale;
      this.h1 = new Float32Array(this.h); this.h2 = new Float32Array(this.h);
      this.qin = new Float32Array(this.h + ACTION_DIM); this.q1 = new Float32Array(this.qh);
      this.v1 = new Float32Array(64); this.one = new Float32Array(1);
    }
    /** Encode a state once; q(a) then scores moves against it. */
    trunk(s) {
      const L = this.L;
      dense(L['trunk.0.weight'], L['trunk.0.bias'], s, STATE_DIM, this.h, this.h1, true);
      dense(L['trunk.2.weight'], L['trunk.2.bias'], this.h1, this.h, this.h, this.h2, true);
      this.qin.set(this.h2, 0);
      return this.h2;
    }
    /** Q in hand points for the mover's pair. */
    q(a) {
      const L = this.L;
      this.qin.set(a, this.h);
      dense(L['q.0.weight'], L['q.0.bias'], this.qin, this.h + ACTION_DIM, this.qh, this.q1, true);
      return dense(L['q.2.weight'], L['q.2.bias'], this.q1, this.qh, 1, this.one, false)[0] * this.scale;
    }
    value() {
      const L = this.L;
      dense(L['v.0.weight'], L['v.0.bias'], this.h2, this.h, 64, this.v1, true);
      return dense(L['v.2.weight'], L['v.2.bias'], this.v1, 64, 1, this.one, false)[0] * this.scale;
    }
  }

  let NET = null;
  /** Install (or clear, with null) the network every analysis may use. */
  function setNet(doc) { NET = doc ? (doc instanceof Net ? doc : new Net(doc)) : null; return NET; }

  const _sf = new Float32Array(STATE_DIM), _af = new Float32Array(ACTION_DIM);
  /** Q (hand points, mover's pair) of each move for `seat` in `st`. */
  function netQs(net, st, seat, moves) {
    stateFeatures(st, seat, _sf);
    net.trunk(_sf);
    const out = new Float64Array(moves.length);
    for (let i = 0; i < moves.length; i++) out[i] = net.q(actionFeatures(st, moves[i], _af));
    return out;
  }

  // ------------------------------------------------------------ player styles
  // The archetypes the partner/opponent model scores (ROADMAP Phase 4).  They
  // match dominord/train/bots.py, which is also what the network trained
  // with and against.  Each returns a probability for every legal move.
  const STYLE_PRIOR = { net: 0.4, greedy: 0.2, heavy: 0.3, random: 0.1 };
  const STYLE_LABEL = { net: 'sharp', greedy: 'steady', heavy: 'heavy-first', random: 'erratic' };

  function softmax(xs, T) {
    let mx = -Infinity;
    for (const x of xs) if (x > mx) mx = x;
    const out = new Float64Array(xs.length);
    let z = 0;
    for (let i = 0; i < xs.length; i++) { out[i] = Math.exp((xs[i] - mx) / T); z += out[i]; }
    for (let i = 0; i < xs.length; i++) out[i] /= z;
    return out;
  }
  function greedyScores(st, seat, moves) {
    const team = seat % 2, saved = st.turn;
    st.turn = seat;
    const out = moves.map((m) => {
      st.apply(m);
      let v;
      if (st.isOver()) { v = terminalValue(st); if (team === 1) v = -v; } else v = staticEval(st, team);
      st.undo();
      return v;
    });
    st.turn = saved;
    return out;
  }
  function styleProbs(style, st, seat, moves, net) {
    if (moves.length === 1) return Float64Array.of(1);
    if (style === 'random') return new Float64Array(moves.length).fill(1 / moves.length);
    if (style === 'heavy') return softmax(moves.map((m) => (m >= 0 ? PIPS[m >> 1] : 0)), 0.6);
    if (style === 'greedy') return softmax(greedyScores(st, seat, moves), 4);
    if (style === 'net' && net) return softmax(Array.from(netQs(net, st, seat, moves)), 3);
    return new Float64Array(moves.length).fill(1 / moves.length);
  }
  /** One move for the side to move under a style (rollouts). */
  function styleMove(style, st, rnd, net) {
    const seat = st.turn;
    const k = st.gen(seat, _gbuf, 0);
    if (k === 1) return _gbuf[0];
    if (style === 'greedy' || (style === 'net' && !net)) return greedyMove(st, rnd);
    const moves = Array.from(_gbuf.subarray(0, k));
    if (style === 'random') return moves[Math.floor(rnd() * k)];
    if (style === 'heavy') {
      let best = moves[0];
      for (const m of moves) if (m >= 0 && PIPS[m >> 1] > PIPS[best >> 1]) best = m;
      return best;
    }
    const q = netQs(net, st, seat, moves);
    let bi = 0;
    for (let i = 1; i < k; i++) if (q[i] > q[bi]) bi = i;
    return moves[bi];
  }

  /**
   * Log-likelihood of every recorded choice by each unseen seat, under each
   * style, given one imagined deal: ll[seat * styles.length + i].  Draw games
   * are skipped (which drawn tiles were kept is not observable).
   */
  function historyLogLik(table, bel, assign, styles, net) {
    const r = table.rules, n = r.players;
    const ll = new Float64Array(n * styles.length);
    if (r.draw) return ll;
    const d = table.d;
    const st = new State(r);
    for (let s = 0; s < n; s++) {
      const h = table.currentHand(s);
      st.hands[s] = (h === null ? 0 : h) | d.playedBy[s];
    }
    bel.buckets.forEach((b, i) => {
      if (b.seat < n) st.hands[b.seat] = assign[i] | d.playedBy[b.seat];
      else { const pz = tilesOf(assign[i]); st.pozo.set(pz); st.pozoLen = pz.length; }
    });
    st.turn = table.opener; st.opener = table.opener; st.forced = table.forcedOpen;
    st.rehash();
    const buf = new Int16Array(40);
    for (const mv of table.moves) {
      const seat = mv.p;
      if (mv.k === 'play') {
        const code = st.chainLen === 0 ? mv.tile * 2 + 1 : mv.tile * 2 + (mv.end === 'L' ? 0 : 1);
        if (table.currentHand(seat) === null) {
          const k = st.gen(seat, buf, 0);
          if (k > 1) {
            const moves = Array.from(buf.subarray(0, k));
            const obs = moves.indexOf(code);
            if (obs >= 0) {
              styles.forEach((style, i) => {
                const p = styleProbs(style, st, seat, moves, net)[obs];
                ll[seat * styles.length + i] += Math.log(Math.max(p, 1e-6));
              });
            }
          }
        }
        st.apply(code);
      } else if (mv.k === 'pass') {
        st.apply(PASS);
      }
    }
    return ll;
  }

  // ==================================================================== analysis
  // Measured in Node on one core: solving every child of a determinized
  // position costs ~2 ms at 22 tiles in hand, ~15 ms at 24, ~75 ms at 26.
  // exactTiles: solve exactly at or below this many tiles in hand; nodeCap
  // bounds each exact solve (it falls back to a greedy playout when it trips).
  // `pyparity` is the Python engine's DEFAULT, kept for the duplicate harness.
  const EFFORT = {
    live: { timeMs: 500, minDeals: 24, maxDeals: 300, exactTiles: 22, nodeCap: 60000, enumerate: 300, otherDeals: 24 },
    normal: { timeMs: 1500, minDeals: 48, maxDeals: 800, exactTiles: 24, nodeCap: 250000, enumerate: 800, otherDeals: 40 },
    deep: { timeMs: 5000, minDeals: 96, maxDeals: 3000, exactTiles: 28, nodeCap: 1500000, enumerate: 3000, otherDeals: 80 },
    pyparity: { timeMs: 60000, minDeals: 80, maxDeals: 80, exactTiles: 14, nodeCap: Infinity, enumerate: 0, otherDeals: 0 },
  };

  /** Normal-ish 95% interval for a weighted mean, using the effective n. */
  function meanCI(sw, swx, swx2, sw2) {
    if (!sw) return [0, 0, 0];
    const mean = swx / sw;
    const varw = Math.max(0, swx2 / sw - mean * mean);
    const ess = sw * sw / (sw2 || 1);
    const se = ess > 1 ? Math.sqrt(varw / (ess - 1)) : Infinity;
    return [mean, mean - 1.96 * se, mean + 1.96 * se];
  }

  /**
   * Anytime PIMC analysis of a Table.  Call step(ms) repeatedly; each call
   * returns a JSON-able snapshot.  Every number in a snapshot comes from the
   * same set of deals (common random numbers across moves — WP4), so the bar,
   * the move list and the tranque panel never disagree.
   */
  class Analysis {
    constructor(table, opts) {
      opts = opts || {};
      this.table = table;
      this.cfg = Object.assign({}, EFFORT[opts.effort || 'live'], opts.cfg || {});
      this.weighting = opts.weighting !== undefined ? !!opts.weighting : true;
      this.temperature = opts.temperature || 6;
      this.allSeats = opts.allSeats !== undefined ? opts.allSeats : true;
      this.scores = opts.scores || null;           // match score [team0, team1]
      this.matchModel = opts.matchModel || null;
      const r = table.rules;
      const d = table.d;
      this.seat = d.turn;
      this.team = opts.team !== undefined ? opts.team
        : teamOf(table.hero !== null && table.hero !== undefined ? table.hero : d.turn);
      this.rnd = mulberry32(opts.seed || 12345);
      this.bel = buildBeliefs(table);
      this.exhaustive = this.bel.total <= this.cfg.enumerate;
      this.list = this.exhaustive ? shuffle(this.bel.enumerate(this.cfg.enumerate), mulberry32(7)) : null;
      this.maxDeals = this.exhaustive ? this.list.length : this.cfg.maxDeals;
      this.i = 0;
      this.stats = new Map();           // move -> accumulators (for this.seat)
      this.perDeal = [];                // [{w, vals: Map(move -> team0 value), res}]
      this.other = {};                  // seat -> Map(move -> acc)
      this.otherN = {};
      for (let s = 0; s < r.players; s++) if (s !== this.seat) { this.other[s] = new Map(); this.otherN[s] = 0; }
      this.nowWin = 0; this.wSum = 0; this.w2Sum = 0;
      this.started = null; this.elapsed = 0;
      this.knownSeat = table.currentHand(this.seat) !== null;
      this.over = table.isOver();
      // The network, if one is installed and wanted.
      this.net = opts.useNet === false ? null : (opts.net ? (opts.net instanceof Net ? opts.net : new Net(opts.net)) : NET);
      this.styles = this.net ? ['net', 'greedy', 'heavy', 'random'] : ['greedy', 'heavy', 'random'];
      this.strong = this.net ? 'net' : 'greedy';
      this.posterior = null;
      if (!this.over && this.weighting && !r.draw) this._modelSeats();
    }

    /**
     * Phase 4: a posterior over each unseen seat's style from the choices it
     * has made, averaged over imagined deals:
     *   p(style | history) ∝ prior(style) · E_deal[ Π_t π_style(move_t | deal) ]
     * shrunk toward the prior so one odd play cannot swing it too far.
     */
    _modelSeats() {
      const t = this.table, n = t.rules.players, S = this.styles;
      const K = Math.min(48, this.exhaustive ? this.list.length : 48);
      const rnd = mulberry32(99);
      const acc = Array.from({ length: n }, () => S.map(() => []));
      for (let i = 0; i < K; i++) {
        const assign = this.exhaustive ? this.list[i] : this.bel.sample(rnd);
        const ll = historyLogLik(t, this.bel, assign, S, this.net);
        for (let s = 0; s < n; s++) S.forEach((_, j) => acc[s][j].push(ll[s * S.length + j]));
      }
      const post = {};
      const priorZ = S.reduce((a, x) => a + STYLE_PRIOR[x], 0);
      for (const s of t.unknownSeats()) {
        const logm = S.map((_, j) => {
          const xs = acc[s][j];
          const mx = Math.max.apply(null, xs);
          return mx + Math.log(xs.reduce((a, x) => a + Math.exp(x - mx), 0) / xs.length);
        });
        const lp = logm.map((x, j) => x + Math.log(STYLE_PRIOR[S[j]] / priorZ));
        const mx = Math.max.apply(null, lp);
        const e = lp.map((x) => Math.exp(x - mx));
        const z = e.reduce((a, b) => a + b, 0);
        post[s] = S.map((x, j) => 0.85 * e[j] / z + 0.15 * STYLE_PRIOR[x] / priorZ);
      }
      this.posterior = post;
    }

    /** Deal weight under the style mixture, relative to a uniform chooser. */
    _dealWeight(assign) {
      const t = this.table, S = this.styles;
      if (!this.posterior) return 1;
      const ll = historyLogLik(t, this.bel, assign, S, this.net);
      const ri = S.indexOf('random');
      let w = 1;
      for (const s in this.posterior) {
        const p = this.posterior[s];
        const base = ll[s * S.length + ri];
        let mix = 0;
        S.forEach((_, j) => { mix += p[j] * Math.exp(ll[s * S.length + j] - base); });
        w *= mix;
      }
      return Math.min(50, Math.max(0.02, w));
    }

    /** Who plays how in this deal's rollouts: a style drawn from each posterior. */
    _policy() {
      const t = this.table, n = t.rules.players, S = this.styles;
      const styles = [];
      for (let s = 0; s < n; s++) {
        const p = this.posterior && this.posterior[s];
        if (!p) { styles.push(this.strong); continue; }
        let x = this.rnd(), pick = S[S.length - 1];
        for (let j = 0; j < S.length; j++) { if (x < p[j]) { pick = S[j]; break; } x -= p[j]; }
        styles.push(pick);
      }
      return { styles, net: this.net };
    }
    get done() { return this.over || this.i >= this.maxDeals; }

    _acc(map, m) {
      let a = map.get(m);
      if (!a) { a = { n: 0, w: 0, sv: 0, sv2: 0, sw2: 0, win: 0, tr: 0, trwin: 0, chosen: 0, exact: 0 }; map.set(m, a); }
      return a;
    }

    _evalSeat(st, seat, map, w, keep) {
      const cfg = this.cfg, rnd = this.rnd;
      const moverTeam = seat % 2;
      const ms = st.moves(seat);
      const pol = this.net || this.posterior ? this._policy() : null;
      let best = -Infinity, bestM = null;
      const vals = keep ? new Map() : null;
      for (const m of ms) {
        st.apply(m);
        const res = resolve(st, cfg, rnd, pol);
        st.undo();
        const v = moverTeam === 0 ? res.value : -res.value;
        const a = this._acc(map, m);
        a.n++; a.w += w; a.sv += w * v; a.sv2 += w * v * v; a.sw2 += w * w;
        if (res.winTeam === moverTeam) a.win += w;
        if (res.kind !== 0) { a.tr += w; if (res.winTeam === moverTeam) a.trwin += w; }
        if (res.exact) a.exact++;
        if (vals) vals.set(m, { v: res.value, kind: res.kind, win: res.winTeam });
        if (v > best) { best = v; bestM = m; }
      }
      if (bestM !== null) this._acc(map, bestM).chosen += w;
      return vals;
    }

    step(ms) {
      const t0 = Date.now();
      if (this.over) return this.snapshot();
      const deadline = t0 + ms;
      const r = this.table.rules;
      do {
        if (this.done) break;
        const assign = this.exhaustive ? this.list[this.i] : this.bel.sample(this.rnd);
        this.i++;
        const w = !this.weighting ? 1 : this.posterior ? this._dealWeight(assign)
          : choiceWeight(this.table, this.bel, assign, this.temperature);
        const st = this.table.toState(this.bel, assign, this.rnd);
        this.wSum += w; this.w2Sum += w * w;
        // "If the table died right now, who takes the count?"
        tranqueValue(st);
        if (RES_TEAM === this.team) this.nowWin += w;
        const vals = this._evalSeat(st, this.seat, this.stats, w, true);
        this.perDeal.push({ w, vals });
        if (this.allSeats && this.i <= this.cfg.otherDeals) {
          const saved = st.turn;
          for (let s = 0; s < r.players; s++) {
            if (s === this.seat) continue;
            st.turn = s;
            this._evalSeat(st, s, this.other[s], w, false);
            this.otherN[s] += w;
          }
          st.turn = saved;
        }
      } while (Date.now() < deadline);
      this.elapsed += Date.now() - t0;
      return this.snapshot();
    }

    _moveList(map, total, seat) {
      const list = [];
      for (const [m, a] of map) {
        const [ev, lo, hi] = meanCI(a.w, a.sv, a.sv2, a.sw2);
        list.push({
          m, seat,
          tile: m >= 0 ? m >> 1 : -1, end: m >= 0 ? moveEnd(m) : null,
          pass: m === PASS, draw: m === DRAW,
          ev, lo, hi,
          win: a.win / a.w, tranque: a.tr / a.w, tranqueWin: a.trwin / a.w,
          avail: total ? a.w / total : 0, choice: total ? a.chosen / total : 0,
          n: a.n, exact: a.exact / a.n,
        });
      }
      const known = this.table.currentHand(seat) !== null;
      list.sort(known ? (a, b) => b.ev - a.ev || b.win - a.win
        : (a, b) => b.choice - a.choice || b.ev - a.ev);
      return list;
    }

    snapshot() {
      const r = this.table.rules;
      const team = this.team, seat = this.seat;
      const snap = {
        team, seat, deals: this.i, total: this.bel.total, exhaustive: this.exhaustive,
        done: this.done, elapsed: this.elapsed, over: this.over,
        ess: this.w2Sum ? (this.wSum * this.wSum) / this.w2Sum : 0,
        net: !!this.net,
      };
      if (this.posterior) {
        snap.styles = {};
        for (const s in this.posterior) {
          snap.styles[s] = {};
          this.styles.forEach((x, j) => { snap.styles[s][x] = this.posterior[s][j]; });
        }
      }
      snap.pipsNow = [];
      for (let s = 0; s < r.players; s++) snap.pipsNow.push(this.bel.expectedPips(s));
      if (this.over || !this.perDeal.length) return snap;
      const moves = this._moveList(this.stats, this.wSum, seat);
      snap.moves = moves;
      // Outlook for `team`.  When we hold the seat on play, assume the move we
      // would actually choose (the top of the list), not a per-deal oracle.
      const pick = this.knownSeat && moves.length ? moves[0].m : null;
      let sw = 0, sv = 0, sv2 = 0, sw2 = 0, win = 0, tr = 0, trwin = 0;
      const outcomes = [];
      const moverTeam = seat % 2;
      for (const pd of this.perDeal) {
        let o = null;
        if (pick !== null) o = pd.vals.get(pick);
        if (!o) {
          for (const x of pd.vals.values()) {
            const xv = moverTeam === 0 ? x.v : -x.v;
            if (!o || xv > (moverTeam === 0 ? o.v : -o.v)) o = x;
          }
        }
        if (!o) continue;
        const v = team === 0 ? o.v : -o.v;
        sw += pd.w; sv += pd.w * v; sv2 += pd.w * v * v; sw2 += pd.w * pd.w;
        if (o.win === team) win += pd.w;
        if (o.kind !== 0) { tr += pd.w; if (o.win === team) trwin += pd.w; }
        outcomes.push([o.v, pd.w]);
      }
      const [ev, lo, hi] = meanCI(sw, sv, sv2, sw2);
      Object.assign(snap, {
        ev, lo, hi,
        advantage: Math.tanh(ev / 35),
        win: sw ? win / sw : 0,
        tranqueChance: sw ? tr / sw : 0,
        tranqueWin: tr ? trwin / tr : 0,
        winIfNow: this.wSum ? this.nowWin / this.wSum : 0,
      });
      if (this.matchModel && this.scores) {
        snap.matchWin = this.matchModel.winAfter(this.scores, outcomes, team);
        snap.matchWinBefore = this.matchModel.win(this.scores[0], this.scores[1], team);
      }
      // Tranque opportunity: the move that best engineers a winning block.
      if (moves.length) {
        const ours = moverTeam === team;
        const base = ours ? snap.tranqueWin : 1 - snap.tranqueWin;
        let top = moves[0];
        for (const m of moves) if (m.tranqueWin > top.tranqueWin) top = m;
        if (top.tranqueWin > 0 && !(top === moves[0] && top.tranqueWin <= base * 1.05)) {
          snap.opportunity = { move: top, seat, ours };
        }
      }
      // Separation of the top two (WP4): is the pick statistically clear?
      if (this.knownSeat && moves.length > 1) {
        const a = moves[0].m, b = moves[1].m;
        let n = 0, s = 0, s2 = 0;
        for (const pd of this.perDeal) {
          const x = pd.vals.get(a), y = pd.vals.get(b);
          if (!x || !y) continue;
          let dlt = x.v - y.v; if (moverTeam === 1) dlt = -dlt;
          n++; s += dlt; s2 += dlt * dlt;
        }
        if (n > 1) {
          const mean = s / n, sd = Math.sqrt(Math.max(0, s2 / n - mean * mean));
          snap.margin = { mean, z: sd > 0 ? mean / (sd / Math.sqrt(n - 1)) : (mean > 0 ? 99 : 0) };
        }
      }
      if (this.allSeats) {
        snap.seatMoves = {};
        for (const s in this.other) snap.seatMoves[s] = this._moveList(this.other[s], this.otherN[s], +s).slice(0, 5);
      }
      return snap;
    }
  }

  /** Run an analysis to completion (Node / tests / engine players). */
  function analyze(table, opts) {
    opts = opts || {};
    const a = new Analysis(table, opts);
    const budget = a.cfg.timeMs;
    const t0 = Date.now();
    let snap = a.step(0);
    while (!a.done && Date.now() - t0 < budget) {
      snap = a.step(Math.min(100, budget - (Date.now() - t0)));
      if (a.i >= a.cfg.minDeals && snap.margin && snap.margin.z > 3 && !opts.full) break;
    }
    return snap;
  }

  /** The engine's move for the seat on turn, from that seat's own view. */
  function chooseMove(table, opts) {
    opts = opts || {};
    const seat = table.turn;
    const view = table.viewFor(seat);
    const legal = view.legalPlays(seat);
    if (legal.length === 1) return legal[0];
    if (opts.level === 'easy') {
      // The patio default: heaviest tile that fits.
      let best = legal[0];
      for (const m of legal) if (m >= 0 && (best < 0 || PIPS[m >> 1] > PIPS[best >> 1])) best = m;
      return best;
    }
    if (opts.level === 'net') {
      // The network alone, no search: argmax Q from this seat's own view.
      // Any deal consistent with the view gives the same features.
      const net = opts.net ? (opts.net instanceof Net ? opts.net : new Net(opts.net)) : NET;
      if (!net) throw new Error('no network loaded');
      const bel = buildBeliefs(view);
      const st = view.toState(bel, bel.sample(mulberry32(1)), mulberry32(2));
      const q = netQs(net, st, seat, legal);
      let bi = 0;
      for (let i = 1; i < legal.length; i++) if (q[i] > q[bi]) bi = i;
      return legal[bi];
    }
    const snap = analyze(view, Object.assign({ allSeats: false }, opts));
    return snap.moves && snap.moves.length ? snap.moves[0].m : legal[0];
  }

  /** Turn an engine move code into a Table move record. */
  function toRecord(table, m) {
    const p = table.turn;
    if (m === PASS) return { k: 'pass', p };
    if (m === DRAW) return { k: 'draw', p, tile: -1 };
    return { k: 'play', p, tile: m >> 1, end: table.d.chain.length ? moveEnd(m) : 'R' };
  }

  // ==================================================================== match model
  // WP5, first cut: P(win the partida) from the score, with future hands drawn
  // i.i.d. from a points distribution harvested by greedy self-play under the
  // same rules.  The current hand uses the analysis' own per-deal outcomes.
  function handDistribution(r, hands, seed) {
    const rnd = mulberry32(seed || 99);
    const hist = new Map();
    let n = 0;
    for (let g = 0; g < hands; g++) {
      const tiles = shuffle(Array.from({ length: 28 }, (_, i) => i), rnd);
      const st = new State(r);
      for (let s = 0; s < r.players; s++) {
        st.hands[s] = tiles.slice(s * 7, s * 7 + 7).reduce((m, t) => m | (1 << t), 0);
      }
      const rest = tiles.slice(r.players * 7);
      if (r.players === 2) { st.pozo.set(rest); st.pozoLen = rest.length; }
      const open = firstOpening(r, Array.from(st.hands.subarray(0, r.players)));
      st.turn = st.opener = open.seat; st.forced = -1;
      st.rehash();
      const v = Math.abs(playout(st, rnd));
      hist.set(v, (hist.get(v) || 0) + 1);
      n++;
    }
    return Array.from(hist.entries()).map(([v, c]) => [v, c / n]).sort((a, b) => a[0] - b[0]);
  }

  function matchModel(r, hands) {
    const T = r.targetScore;
    const dist = handDistribution(r, hands || 1500).filter(([v]) => v > 0);
    const z = dist.reduce((a, b) => a + b[1], 0);
    dist.forEach((x) => { x[1] /= z; });
    // M[a][b] = P(team 0 wins from a-b), each future hand a coin flip for who scores.
    const M = Array.from({ length: T }, () => new Float64Array(T));
    for (let a = T - 1; a >= 0; a--) {
      for (let b = T - 1; b >= 0; b--) {
        let p = 0;
        for (const [v, q] of dist) {
          p += 0.5 * q * (a + v >= T ? 1 : M[a + v][b]);
          p += 0.5 * q * (b + v >= T ? 0 : M[a][b + v]);
        }
        M[a][b] = p;
      }
    }
    const at = (a, b) => (a >= T ? 1 : b >= T ? 0 : M[a][b]);
    return {
      dist,
      win(a, b, team) { const p = at(a, b); return team === 0 ? p : 1 - p; },
      /** After this hand ends with the per-deal outcomes (value for team 0, weight). */
      winAfter(scores, outcomes, team) {
        let sw = 0, sp = 0;
        for (const [v, w] of outcomes) {
          const a = scores[0] + (v > 0 ? Math.round(v) : 0);
          const b = scores[1] + (v < 0 ? Math.round(-v) : 0);
          sp += w * at(a, b); sw += w;
        }
        const p = sw ? sp / sw : at(scores[0], scores[1]);
        return team === 0 ? p : 1 - p;
      },
    };
  }

  // ==================================================================== deal
  /** Shuffle and deal: hands as masks, plus the pozo order (1v1). */
  function deal(r, rnd) {
    const tiles = shuffle(Array.from({ length: 28 }, (_, i) => i), rnd || Math.random);
    const hands = [];
    for (let s = 0; s < r.players; s++) hands.push(tiles.slice(s * 7, s * 7 + 7).reduce((m, t) => m | (1 << t), 0));
    return { hands, pozo: tiles.slice(r.players * 7) };
  }

  const api = {
    LOW, HIGH, PIPS, SUIT, FULL, CHUCHA, DOUBLE_SIX, PASS, DRAW,
    tileId, tileName, tileKey, parseTile, parseTiles, tilesOf, pipsOf, popcount, isDouble, hasSuit,
    mulberry32, shuffle,
    RULE_DEFAULTS, PRESETS, makeRules, teamOf, partnerOf, nextSeat, pozoSize, firstOpening,
    scoreTotals, tranqueWinner, scoreState, terminalValue, staticEval, greedyMove, playout,
    State, solve, minimax, resolve, clearTT, SEARCH,
    Table, buildBeliefs, choiceWeight,
    STATE_DIM, ACTION_DIM, stateFeatures, actionFeatures, Net, setNet, netQs, styleProbs, historyLogLik,
    STYLE_PRIOR, STYLE_LABEL,
    get NET() { return NET; },
    EFFORT, Analysis, analyze, chooseMove, toRecord, makeMove, moveEnd,
    handDistribution, matchModel, deal,
    get RES() { return { kind: RES_KIND, team: RES_TEAM }; },
  };
  root.Dominord = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
