// SMC spot signal bot. Runs on GitHub Actions together with alerts.mjs.
// 1) tracks open signals (fill / TP1 / TP2 / stop / expiry) and sends updates
// 2) after each new candle closes: scans the market with Smart Money Concepts, backtests the same rules,
//    picks the best 1-5 setups of the day, sizes the money, sends Telegram, writes signals.json for the website.
import fs from 'fs';
import { TF_MS, DEF, parse, prepare, detectAt, backtest, replay, summ, typicalHold } from './smc-engine.mjs';

const cfg = JSON.parse(fs.readFileSync('coins.json', 'utf8'));
const SM = {
  on: true, tf: '1h', top: 30, minVol: 2e7,
  budget: 1000, risk: 1, maxPos: 25, maxOpen: 60, maxDay: 5,
  minScore: 6, minWin: 70, minWinB: 55, minN: 4, k: 6,
  fillBars: DEF.fillBars, maxHold: DEF.maxHold, history: 2000,
  tz: 'Asia/Dhaka', fallbackHour: 14, noteHour: 21, ...(cfg.smc || {})
};
if (!SM.on) { console.log('SMC is off in coins.json'); process.exit(0); }
const O = { ...DEF, minScore: SM.minScore, fillBars: SM.fillBars, maxHold: SM.maxHold };
const MS = TF_MS[SM.tf] || 36e5, FORCE = !!process.env.FORCE;
const TOK = process.env.TELEGRAM_BOT_TOKEN, CHAT = process.env.TELEGRAM_CHAT_ID;
const H = ['https://data-api.binance.vision', 'https://api.binance.com'];
const STB = /^(USDC|FDUSD|TUSD|USDP|BUSD|DAI|EUR|AEUR|USDE|XUSD|USD1)$/;
const SF = 'signals.json';
const st = fs.existsSync(SF) ? JSON.parse(fs.readFileSync(SF, 'utf8')) : {};
st.signals = st.signals || [];

async function api(p) { for (const h of H) { try { const r = await fetch(h + p); if (r.ok) return await r.json(); } catch (e) {} } throw new Error('Binance unreachable: ' + p); }
async function tg(t) {
  if (!TOK || !CHAT) { console.log('[no Telegram secrets set]\n' + t + '\n'); return; }
  const r = await fetch(`https://api.telegram.org/bot${TOK}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: CHAT, text: t.slice(0, 4000) }) });
  if (!r.ok) console.log('Telegram error', r.status, await r.text());
}
async function klines(sym, tf, total, forming) {
  let out = [], end = null;
  while (out.length < total) {
    const lim = Math.min(1000, total - out.length);
    const a = await api(`/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${lim}` + (end ? `&endTime=${end}` : ''));
    if (!a.length) break; out = a.concat(out); end = a[0][0] - 1; if (a.length < lim) break;
  }
  let c = parse(out); if (!forming) { const now = Date.now(); c = c.filter(x => x.ct < now); } return c;
}
async function pmap(list, n, fn) { for (let i = 0; i < list.length; i += n) await Promise.all(list.slice(i, i + n).map(fn)); }

/* ---------- formatting helpers ---------- */
const P = p => p >= 1000 ? p.toFixed(1) : p >= 100 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p >= 0.01 ? p.toFixed(5) : p.toFixed(8);
const pc = (a, b) => ((a / b - 1) * 100).toFixed(1);
const dk = t => new Intl.DateTimeFormat('en-CA', { timeZone: SM.tz }).format(t);
const lh = t => +new Intl.DateTimeFormat('en-GB', { timeZone: SM.tz, hour: '2-digit', hourCycle: 'h23' }).format(t);
const TT = t => new Date(t).toLocaleString('en-GB', { timeZone: SM.tz, hour12: false, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const hrs = bars => Math.max(1, Math.round(bars * MS / 36e5));
const ROUND = (x, d = 2) => +x.toFixed(d);

function newMsg(s) {
  const nowLine = s.now ? `Price is already inside the zone - you can buy now around $${P(s.entry)}` : `Place a LIMIT BUY at $${P(s.entry)}`;
  return `🟢 SPOT BUY SIGNAL - ${s.sym}/USDT   [Grade ${s.grade}${s.grade === 'B' ? ' - moderate confidence, half size' : ''}]
Smart Money setup on the ${s.tf} chart | score ${s.score}/10
Estimated win chance: ~${s.conf.p}%  (past setups: ${s.conf.w} of ${s.conf.n} won on ${s.sym}; all coins ${s.conf.poolWr}% of ${s.conf.poolN} won)

📥 BUY ZONE: $${P(s.zone[0])} - $${P(s.zone[1])}
   ${nowLine}
🛑 STOP-LOSS: $${P(s.sl)}  (${pc(s.sl, s.entry)}%)
🎯 SELL ZONE:
   TP1 $${P(s.tp1)} (+${pc(s.tp1, s.entry)}%) - sell 70%, then move stop-loss to entry
   TP2 $${P(s.tp2)} (+${pc(s.tp2, s.entry)}%) - sell the rest
💰 INVEST: $${s.size}  (${ROUND(s.size / SM.budget * 100, 0)}% of your $${SM.budget} fund)
   Risk if stopped: about $${s.riskUsd} | Profit at TP1: about $${s.tp1Usd}
⏱ TIME: order valid until ${TT(s.validUntil)} (${hrs(s.fb)}h). Typical hold ~${s.hold}h. Max hold ${hrs(s.mh)}h, then close.

Why: ${s.why.map(x => '• ' + x).join('\n')}

Cancel the order if price closes below $${P(s.sl)} before it fills. Spot only, no leverage.`;
}
function evMsg(s, e) {
  const t = `${s.sym}/USDT`;
  switch (e.k) {
    case 'filled': return `✅ ${t}: price reached your entry $${P(s.entry)}. If your limit order was placed, you are in. Stop-loss $${P(s.sl)}, TP1 $${P(s.tp1)}.`;
    case 'tp1': return `🎯 ${t}: TP1 $${P(s.tp1)} HIT. Sell 70% now and move your stop-loss to entry $${P(s.entry)}. Rest runs to TP2 $${P(s.tp2)}.`;
    case 'tp2': return `🏆 ${t}: TP2 $${P(s.tp2)} HIT. Sell the rest. Trade closed with profit.`;
    case 'sl': return `⛔ ${t}: STOP-LOSS $${P(s.sl)} hit. Close the trade. Loss about $${s.riskUsd}. Wait for the next signal.`;
    case 'be': return `↩️ ${t}: price came back to entry after TP1. Close the rest at break-even. Trade closed (TP1 profit kept).`;
    case 'timeout': return `⌛ ${t}: max hold time reached. Close the trade at market.`;
    case 'expired': return `⌛ ${t}: buy zone was not reached in time. Cancel your limit order - signal expired.`;
    case 'missed': return `🚫 ${t}: price rushed to TP1 without touching your entry. Cancel the order and skip this trade.`;
  }
  return null;
}

/* ---------- 1) track open signals ---------- */
async function track(out) {
  const open = st.signals.filter(s => !s.done), syms = [...new Set(open.map(s => s.sym))], cache = {};
  await pmap(syms, 6, async y => { try { cache[y] = await klines(y + 'USDT', SM.tf, 300, true); } catch (e) { console.log('track fail', y); } });
  for (const s of open) {
    const c = cache[s.sym]; if (!c) continue;
    const start = c.findIndex(x => x.t >= s.candleT + (TF_MS[s.tf] || MS)); if (start < 0) continue;
    const r = replay(s, c, start, { fillBars: s.fb, maxHold: s.mh, fee: DEF.fee, w1: s.w1 });
    s.status = r.status; s.done = r.final; s.tp1Hit = r.tp1Hit; s.pnl = r.final ? r.pnl : null;
    s.times = {}; r.events.forEach(e => { s.times[e.k] = c[e.j].t; });
    for (const e of r.events) if (!s.sent.includes(e.k)) { s.sent.push(e.k); const m = evMsg(s, e); if (m) out.push(m); }
  }
}

/* ---------- 2) scan market for new setups ---------- */
async function scan(out) {
  const btcC = await klines('BTCUSDT', SM.tf, 5, false), lastC = btcC[btcC.length - 1].t;
  if (!FORCE && st.lastScan && st.lastScan.candle === lastC) { console.log('No new candle yet - scan skipped.'); return; }

  const all = await api('/api/v3/ticker/24hr');
  const list = all.filter(x => x.symbol.endsWith('USDT') && !STB.test(x.symbol.slice(0, -4)) && +x.quoteVolume > SM.minVol).sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, SM.top).map(x => x.symbol.slice(0, -4));
  if (!list.includes('BTC')) list.push('BTC');
  const R = [];
  await pmap(list, 6, async sym => {
    try {
      const c = await klines(sym + 'USDT', SM.tf, SM.history, false); if (c.length < 450) return;
      const X = prepare(c), i = c.length - 1;
      R.push({ sym, c, X, set: detectAt(X, i, O), bt: backtest(X, O) });
    } catch (e) { console.log('skip', sym, e.message); }
  });
  if (R.length < 5) throw new Error('too few coins analysed');

  // market context from BTC
  const bt = R.find(r => r.sym === 'BTC'); let mk = 'mixed';
  if (bt) { const i = bt.c.length - 1, cl = bt.c[i].c, e5 = bt.X.ema50[i], e2 = bt.X.ema200[i]; mk = cl > e5 && e5 > e2 ? 'strong' : cl < e2 && e5 < e2 ? 'weak' : 'mixed'; }
  const mf = mk === 'weak' ? .5 : mk === 'mixed' ? .75 : 1, minSc = SM.minScore + (mk === 'weak' ? 1 : 0);

  // pooled statistics of the same strategy on all coins (bigger sample = more honest estimate)
  const allT = R.flatMap(r => r.bt.T), pool = summ(allT), poolWr = pool.n >= 20 ? pool.wr : .5, poolR = pool.n >= 20 ? pool.avgR : 0;
  const hPool = typicalHold(allT);
  st.pool = { n: pool.n, w: pool.w, wr: ROUND(pool.wr * 100, 0), avgR: ROUND(pool.avgR, 2) };
  st.market = mk;

  const now = Date.now(), today = dk(now), sentToday = st.signals.filter(s => dk(s.created) === today).length;
  const openSyms = new Set(st.signals.filter(s => !s.done).map(s => s.sym));
  const recent = new Set(st.signals.filter(s => now - s.created < O.cool * MS).map(s => s.sym));
  const exposure = st.signals.filter(s => !s.done).reduce((a, s) => a + s.size, 0);
  let room = SM.budget * SM.maxOpen / 100 - exposure, slots = SM.maxDay - sentToday;

  // candidates with blended (shrunk) win-rate: coin history + pooled history
  const cand = [];
  for (const r of R) {
    if (!r.set || r.set.score < minSc || openSyms.has(r.sym) || recent.has(r.sym)) continue;
    const n = r.bt.n, k = SM.k, p = (r.bt.w + k * poolWr) / (n + k), ex = (r.bt.sR + k * poolR) / (n + k);
    const grade = n >= SM.minN && p * 100 >= SM.minWin && ex > .1 ? 'A' : p * 100 >= SM.minWinB && ex > 0 ? 'B' : null;
    if (grade) cand.push({ r, p, ex, grade });
  }
  cand.sort((a, b) => (a.grade === b.grade ? 0 : a.grade === 'A' ? -1 : 1) || (b.p + b.r.set.score * .01) - (a.p + a.r.set.score * .01));
  const fb = sentToday === 0 && lh(now) >= SM.fallbackHour; // one moderate idea if the day is empty
  console.log(`Scanned ${R.length} coins | market ${mk} | pooled ${pool.w}/${pool.n} | setups ${cand.length} | today ${sentToday}/${SM.maxDay}`);

  let usedB = 0;
  for (const { r, p, ex, grade } of cand) {
    if (slots <= 0 || room < 10) break;
    if (grade === 'B' && (!fb || usedB)) continue;
    const s = r.set, rp = s.riskPct + DEF.fee;
    let size = Math.min(SM.budget * SM.maxPos / 100, SM.budget * SM.risk / 100 / rp) * mf * (grade === 'B' ? .5 : 1);
    size = Math.floor(Math.min(size, room)); if (size < 10) continue;
    const n = r.bt.n, hb = n >= 3 ? typicalHold(r.bt.T) : hPool;
    const sig = {
      id: r.sym + '-' + s.t, sym: r.sym, tf: SM.tf, created: now, candleT: s.t, grade, score: s.score, price: s.price,
      zone: [s.zone.lo, s.zone.hi], entry: s.entry, now: s.now, sl: s.sl, tp1: s.tp1, tp2: s.tp2, riskPct: s.riskPct, rr: ROUND(s.rr1, 2),
      size, qty: size / s.entry, riskUsd: ROUND(size * rp, 2), tp1Usd: ROUND(size * ((s.tp1 - s.entry) / s.entry - DEF.fee), 2),
      conf: { p: ROUND(p * 100, 0), n, w: r.bt.w, exp: ROUND(ex, 2), poolWr: st.pool.wr, poolN: pool.n },
      hold: hrs(hb || 12), fb: SM.fillBars, mh: SM.maxHold, w1: DEF.w1, validUntil: s.t + MS + SM.fillBars * MS,
      why: s.why, status: 'pending', done: false, sent: ['new']
    };
    st.signals.push(sig); out.push(newMsg(sig)); room -= size; slots--; if (grade === 'B') usedB++;
  }
  if (!out.length && sentToday === 0 && lh(now) >= SM.noteHour && st.noteDay !== today) {
    st.noteDay = today;
    out.push(`ℹ️ SMC update: no setup passed the quality filters today (market ${mk}). Staying in cash is also a position. Next scan after the next ${SM.tf} candle closes.`);
  }
  st.lastScan = { candle: lastC, at: now };
}

/* ---------- run ---------- */
const out = [];
try { await track(out); } catch (e) { console.log('track error', e.message); }
try { await scan(out); } catch (e) { console.log('scan error', e.message); }

// output file for the website
const done = st.signals.filter(s => s.done), openS = st.signals.filter(s => !s.done);
const trades = st.signals.filter(s => s.tp1Hit || ['sl', 'be', 'tp2', 'timeout'].includes(s.status));
const wins = trades.filter(s => s.tp1Hit).length, fin = done.filter(s => ['sl', 'be', 'tp2', 'timeout'].includes(s.status));
st.record = {
  n: trades.length, w: wins, wr: trades.length ? ROUND(wins / trades.length * 100, 0) : null,
  avgR: fin.length ? ROUND(fin.reduce((a, s) => a + s.pnl / s.riskPct, 0) / fin.length, 2) : null,
  pnlUsd: ROUND(fin.reduce((a, s) => a + s.size * s.pnl, 0), 2)
};
st.signals = [...openS, ...done.slice(-100)].sort((a, b) => a.created - b.created);
st.updated = Date.now(); st.cfg = { tf: SM.tf, budget: SM.budget, risk: SM.risk, maxDay: SM.maxDay, minWin: SM.minWin, tz: SM.tz };
fs.writeFileSync(SF, JSON.stringify(st));

for (const m of out) await tg(m + '\n\n(Analysis only, not financial advice. Win chance is an estimate from history, not a promise.)');
if (!out.length) console.log('SMC: nothing new.');
