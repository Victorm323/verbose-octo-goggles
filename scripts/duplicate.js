#!/usr/bin/env node
// Duplicate-scored match harness (ROADMAP Phase 0) for the browser engine.
//
// Every deal is played twice with the two engines swapping pairs, so deal luck
// cancels and what is left is skill.  Reports A's paired margin in hand
// points per deal, its sd, a 95% CI and the unpaired sd for comparison.
//
//   node scripts/duplicate.js --a live --b pyparity --deals 100
//   node scripts/duplicate.js --a live --b greedy --deals 200 --rules patio
//
// Engines: greedy (heaviest legal tile), random, pyparity (the Python
// engine's DEFAULT config), live | normal | deep, and `net` (the trained
// network alone, argmax Q, no search).  Flags after a colon: ":noweight"
// switches off reading the players' choices, ":net" lets the search use the
// network (rollouts, style model).  --net picks the network file
// (default web/models/dominord-net.json).
'use strict';
const D = require('../web/engine.js');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const A = arg('a', 'live'), B = arg('b', 'pyparity');
const DEALS = +arg('deals', 50);
const RULES = D.makeRules(arg('rules', 'patio'));
const SEED = +arg('seed', 1);
const TIME = arg('time') ? +arg('time') : null;
const NET_PATH = arg('net', require('path').join(__dirname, '..', 'web', 'models', 'dominord-net.json'));
let netLoaded = false;
function needNet() {
  if (!netLoaded) { D.setNet(JSON.parse(require('fs').readFileSync(NET_PATH, 'utf8'))); netLoaded = true; }
}

function chooser(spec) {
  const [name, ...flags] = spec.split(':');
  if (name === 'net') { needNet(); return (t) => D.chooseMove(t, { level: 'net' }); }
  if (name === 'greedy') return (t) => D.chooseMove(t, { level: 'easy' });
  if (name === 'random') {
    const rnd = D.mulberry32(SEED * 7 + 1);
    return (t) => { const ms = t.viewFor(t.turn).legalPlays(t.turn); return ms[Math.floor(rnd() * ms.length)]; };
  }
  const useNet = flags.includes('net');
  if (useNet) needNet();
  const opts = { effort: name, weighting: !flags.includes('noweight'), seed: SEED, useNet };
  if (TIME) opts.cfg = { timeMs: TIME };
  return (t) => D.chooseMove(t, opts);
}

function playHand(dl, open, chooserFor) {
  const t = new D.Table({ rules: RULES, opener: open.seat, hero: 0, forcedOpen: open.tile });
  dl.hands.forEach((h, s) => t.setHand(s, h));
  const pozo = dl.pozo.slice();
  let guard = 0;
  while (!t.isOver() && guard++ < 400) {
    const m = chooserFor(t.turn)(t);
    const rec = D.toRecord(t, m);
    if (rec.k === 'draw') rec.tile = pozo.shift();
    t.record(rec);
  }
  const pips = [];
  for (let s = 0; s < RULES.players; s++) pips.push(D.pipsOf(t.currentHand(s)));
  return t.scoreFinished(pips);
}

const signed = (res, team) => (res.winningTeam === null ? 0 : res.winningTeam === team ? res.points : -res.points);

const ca = chooser(A), cb = chooser(B);
const rnd = D.mulberry32(SEED);
const margins = [], singles = [];
let agree = 0;
const t0 = Date.now();
for (let i = 0; i < DEALS; i++) {
  const dl = D.deal(RULES, rnd);
  const open = D.firstOpening(RULES, dl.hands);
  // Game 1: A holds the even seats (team 0).  Game 2: A holds the odd seats.
  const g1 = playHand(dl, open, (s) => (s % 2 === 0 ? ca : cb));
  const g2 = playHand(dl, open, (s) => (s % 2 === 1 ? ca : cb));
  const m1 = signed(g1, 0), m2 = signed(g2, 1);
  margins.push((m1 + m2) / 2);
  singles.push(m1, m2);
  if (m1 === -m2) agree++;
  if ((i + 1) % 10 === 0 || i + 1 === DEALS) {
    const n = margins.length;
    const mean = margins.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(margins.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
    const sm = singles.reduce((a, b) => a + b, 0) / singles.length;
    const ssd = Math.sqrt(singles.reduce((a, b) => a + (b - sm) ** 2, 0) / Math.max(1, singles.length - 1));
    const half = 1.96 * sd / Math.sqrt(n);
    console.log(`${A} vs ${B} | deals ${n} | margin ${mean.toFixed(2)} pts/hand for ${A} `
      + `[${(mean - half).toFixed(2)}, ${(mean + half).toFixed(2)}] | paired sd ${sd.toFixed(1)} `
      + `(unpaired ${ssd.toFixed(1)}) | identical outcomes ${agree}/${n} | ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
