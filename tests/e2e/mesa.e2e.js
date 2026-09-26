// End-to-end check of the bundled page in Chromium.
//   python3 scripts/build_web.py && NODE_PATH=$(npm root -g) node tests/e2e/mesa.e2e.js [outdir]
// Drives reconstruction and play (1v1 and 2v2), fails on any page error.
'use strict';
const path = require('path');
const { chromium } = require('playwright');

const OUT = process.argv[2] || path.join(__dirname, 'out');
const FILE = 'file://' + path.resolve(__dirname, '../../dist/dominord-mesa.html');

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.goto(FILE);

  // 1. Demo reconstruction: the engine answers with ranked moves for the hero.
  await page.waitForSelector('#analysis table.moves', { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('#evalbar').classList.contains('busy'), null, { timeout: 15000 });
  require('fs').mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, '1-reconstruct.png'), fullPage: true });
  const firstMove = await page.textContent('#analysis table.moves tbody tr');
  console.log('demo best move row:', firstMove.replace(/\s+/g, ' ').trim());

  // Hero plays the suggested tile by tapping it in the grid, then record a pass by Juan via quick entry.
  await page.click('.grid28 .cell.best');
  if (await page.$('.endpick')) await page.click('.endpick [data-e="L"]');
  await page.fill('#cmd', 'paso');
  await page.press('#cmd', 'Enter');
  const msg = await page.textContent('#entry .msg');
  console.log('after quick entry:', msg.trim());
  // A bad entry must be rejected with a message, not a crash.
  await page.fill('#cmd', 'socio 6-1');
  await page.press('#cmd', 'Enter');
  console.log('bad entry message:', (await page.textContent('#entry .msg')).trim());
  await page.fill('#cmd', 'undo');
  await page.press('#cmd', 'Enter');

  // 2. Play 1v1 (drawing) against the engine to the end of a hand, taking the best legal tile each time.
  async function playMode(rulesKey, level, shot) {
    await page.click('[data-act="newmatch"]');
    await page.click('[data-act="su-mode"][data-v="play"]');
    await page.click(`[data-act="su-rules"][data-v="${rulesKey}"]`);
    await page.selectOption('#su-level', level);
    await page.click('[data-act="su-start"]');
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      const phase = await page.evaluate(() => JSON.parse(localStorage.getItem('dominord.mesa')).phase);
      if (phase !== 'hand') break;
      // The panel re-renders as analysis streams in, so click by selector and retry.
      try {
        if (await page.$('.myhand button:not([disabled])')) {
          await page.click('.myhand button:not([disabled])', { timeout: 2000 });
          if (await page.$('.endpick')) await page.click('.endpick [data-e="R"]', { timeout: 2000 });
        }
      } catch (e) { /* re-rendered mid-click; try again next loop */ }
      await page.waitForTimeout(250);
    }
    const st = await page.evaluate(() => JSON.parse(localStorage.getItem('dominord.mesa')));
    console.log(`${rulesKey}/${level}: phase ${st.phase}, moves ${st.table.moves.length}, score ${st.match.scores.join('-')}, result`, JSON.stringify(st.lastResult && { kind: st.lastResult.kind, winner: st.lastResult.winner, points: st.lastResult.points }));
    await page.screenshot({ path: path.join(OUT, shot), fullPage: true });
    if (!['handover', 'matchover'].includes(st.phase)) errors.push(`${rulesKey}: hand did not finish (phase ${st.phase})`);
  }
  await playMode('mano', 'normal', '2-play-1v1.png');
  await page.click('[data-act="nexthand"]');
  await page.waitForTimeout(500);
  await playMode('patio', 'easy', '3-play-2v2.png');

  // 3. Phone width renders without horizontal scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log('phone horizontal overflow px:', overflow);
  if (overflow > 1) errors.push('horizontal scroll at phone width: ' + overflow + 'px');
  await page.screenshot({ path: path.join(OUT, '4-phone.png'), fullPage: true });

  await browser.close();
  if (errors.length) { console.error('FAIL\n' + errors.join('\n')); process.exit(1); }
  console.log('e2e OK');
})();
