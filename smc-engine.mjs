// Smart Money Concepts (SMC) engine - SPOT, LONG ONLY. Pure functions, no network.
// Used by smc.mjs (live signals + backtest). Same code for both, so the backtest is honest.

export const TF_MS = { '5m': 3e5, '15m': 9e5, '30m': 18e5, '1h': 36e5, '2h': 72e5, '4h': 144e5, '1d': 864e5 };

export const DEF = {
  L: 3,            // swing pivot strength (candles each side)
  win: 160,        // candles looked back for structure
  bosAge: 36,      // break of structure must be this recent (candles)
  legAge: 80,      // impulse leg origin must be this recent
  disp: 0.9,       // displacement candle body >= disp * ATR
  approach: 2.5,   // price must be within this many ATR above the zone (or inside it)
  minRR: 1.3,      // minimum reward:risk to TP1
  maxTP1R: 2.5,    // TP1 capped at this R multiple
  maxRisk: 0.08,   // skip if stop is further than 8%
  minRisk: 0.004,  // skip if stop is tighter than 0.4% (fees eat it)
  slBuf: 0.3,      // stop buffer below zone, in ATR
  maxRSI: 68,      // do not buy overbought
  minScore: 6,     // confluence score needed (0-10)
  fillBars: 12,    // limit order lives this many candles
  maxHold: 72,     // max candles to stay in a trade after entry
  fee: 0.002,      // 0.1% per side round trip
  w1: 0.7,         // share sold at TP1
  cool: 12         // candles between two signals on the same coin
};

export const parse = a => a.map(x => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5], ct: +x[6] }));

export function ema(a, n) { const k = 2 / (n + 1), o = []; let p = a[0]; for (let i = 0; i < a.length; i++) { p = i ? a[i] * k + p * (1 - k) : a[i]; o.push(p); } return o; }

function rsiArr(c, n = 14) {
  const o = Array(c.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], G = Math.max(d, 0), L = Math.max(-d, 0);
    if (i <= n) { g += G; l += L; if (i === n) { g /= n; l /= n; o[i] = 100 - 100 / (1 + g / (l || 1e-9)); } }
    else { g = (g * (n - 1) + G) / n; l = (l * (n - 1) + L) / n; o[i] = 100 - 100 / (1 + g / (l || 1e-9)); }
  }
  return o;
}

function atrArr(c, n = 14) {
  const o = []; let p = 0;
  for (let i = 0; i < c.length; i++) {
    const tr = i ? Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)) : c[i].h - c[i].l;
    p = i < n ? (p * i + tr) / (i + 1) : (p * (n - 1) + tr) / n; o.push(p);
  }
  return o;
}

export function prepare(c) {
  const cl = c.map(x => x.c);
  const vavg = c.map((_, i) => { if (i < 20) return 0; let s = 0; for (let j = i - 20; j < i; j++) s += c[j].v; return s / 20; });
  return { c, cl, ema50: ema(cl, 50), ema200: ema(cl, 200), atr: atrArr(c), rsi: rsiArr(cl), vavg };
}

/* Look for a bullish SMC setup using ONLY candles up to index i (no look-ahead). */
export function detectAt(X, i, o) {
  const { c, atr, ema50, ema200, rsi } = X;
  if (i < 210) return null;
  const r = rsi[i]; if (r == null || r > o.maxRSI) return null;
  const s = Math.max(0, i - o.win), L = o.L, H = [], Lw = [];
  for (let j = s + L; j <= i - L; j++) {
    let ph = true, pl = true;
    for (let k = 1; k <= L; k++) {
      if (c[j].h <= c[j - k].h || c[j].h < c[j + k].h) ph = false;
      if (c[j].l >= c[j - k].l || c[j].l > c[j + k].l) pl = false;
    }
    if (ph) H.push({ i: j, p: c[j].h }); if (pl) Lw.push({ i: j, p: c[j].l });
  }
  if (!H.length || !Lw.length) return null;

  // 1) recent bullish break of structure (close above a swing high)
  let brk = null;
  for (let a = H.length - 1; a >= 0; a--) {
    const sh = H[a]; let b = -1;
    for (let j = sh.i + 1; j <= i; j++) if (c[j].c > sh.p) { b = j; break; }
    if (b > 0 && i - b <= o.bosAge) { brk = { sh, b, a }; break; }
  }
  if (!brk) return null;
  const { sh, b, a } = brk;
  const choch = a > 0 && H[a - 1].p > sh.p; // broke a LOWER high = change of character

  // 2) impulse leg: origin swing low -> range high
  let LL = null; for (let k = Lw.length - 1; k >= 0; k--) if (Lw[k].i < b) { LL = Lw[k]; break; }
  if (!LL || i - LL.i > o.legAge) return null;
  let RH = sh.p; for (let j = b; j <= i; j++) if (c[j].h > RH) RH = c[j].h;
  const RL = LL.p, rg = RH - RL; if (rg <= 0) return null;

  // 3) displacement candle (strong bullish body)
  let d = -1, mb = 0; for (let j = LL.i + 1; j <= b; j++) { const bd = c[j].c - c[j].o; if (bd > mb) { mb = bd; d = j; } }
  if (d < 0 || mb < o.disp * atr[d]) return null;

  // 4) bullish order block = last bearish candle before the displacement
  let ob = null;
  for (let j = d - 1; j >= Math.max(s, LL.i - 2); j--) if (c[j].c < c[j].o) { ob = { i: j, lo: c[j].l, hi: c[j].o }; break; }
  if (!ob || ob.hi <= ob.lo) return null;
  // must be fresh: never closed below, never touched before the current candle
  for (let j = d + 1; j <= i; j++) { if (c[j].c < ob.lo) return null; if (j < i && c[j].l <= ob.hi) return null; }

  // 5) price must be approaching / inside the zone
  const px = c[i].c; if (px - ob.hi > o.approach * atr[i]) return null;

  // 6) discount only (below 50% of the dealing range)
  const mid = (ob.lo + ob.hi) / 2; if (mid > RL + 0.5 * rg) return null;
  const ote = ob.hi >= RH - 0.79 * rg && ob.lo <= RH - 0.618 * rg;

  // 7) unfilled bullish fair value gap overlapping the order block
  let fvg = false;
  for (let k = LL.i + 1; k <= i - 1 && !fvg; k++) {
    const lo = c[k - 1].h, hi = c[k + 1].l; if (hi <= lo) continue;
    let filled = false; for (let m = k + 2; m <= i; m++) if (c[m].l <= lo) { filled = true; break; }
    if (!filled && lo <= ob.hi && hi >= ob.lo) fvg = true;
  }

  // 8) sell-side liquidity sweep: leg low took out an earlier swing low and closed back above it
  let sweep = false, P = null; for (let k = Lw.length - 1; k >= 0; k--) if (Lw[k].i < LL.i) { P = Lw[k]; break; }
  if (P && LL.i - P.i <= 60 && P.p > LL.p) for (let j = LL.i; j <= Math.min(i, LL.i + 3); j++) if (c[j].c > P.p) { sweep = true; break; }

  const vol = X.vavg[d] > 0 && c[d].v >= 1.3 * X.vavg[d];
  const bias = px > ema50[i] && ema50[i] > ema200[i] ? 2 : px > ema200[i] ? 1 : 0;
  if (bias === 0 && !(choch && sweep)) return null;

  // score + human reasons
  let sc = 2; const why = [];
  why.push(bias === 2 ? 'Trend is up (price > EMA50 > EMA200)' : bias === 1 ? 'Price above EMA200 (trend not broken)' : 'Trend was down, but reversal confirmed (CHoCH + sweep)');
  sc += bias;
  if (choch) { sc += 1; why.push('CHoCH: broke a lower high, trend may be turning up'); } else { sc += 2; why.push('BOS: price broke above a swing high (uptrend continues)'); }
  why.push('Bullish order block (last sell candle before the strong up move) - fresh, untouched');
  if (fvg) { sc += 1; why.push('Fair value gap overlaps the order block (extra support)'); }
  if (sweep) { sc += 2; why.push('Liquidity sweep: stops below old lows were taken, then price recovered'); }
  if (ote) { sc += 1; why.push('Zone is in the 61.8%-79% retracement (optimal entry area)'); } else why.push('Zone is in the discount half of the range (cheap side)');
  if (vol) { sc += 1; why.push('Strong volume on the up move (real buying)'); }
  sc = Math.min(10, sc);

  // levels
  const e0 = ob.lo + 0.7 * (ob.hi - ob.lo), entry = Math.min(e0, px), now = px <= e0;
  const slBase = (ob.lo - LL.p <= atr[i] ? Math.min(ob.lo, LL.p) : ob.lo), sl = slBase - o.slBuf * atr[i];
  const risk = entry - sl, riskPct = risk / entry;
  if (!(risk > 0) || riskPct > o.maxRisk || riskPct < o.minRisk) return null;
  if ((RH - entry) / risk < o.minRR) return null;
  const tp1 = Math.min(RH, entry + o.maxTP1R * risk);
  const tp2 = Math.min(entry + 5 * risk, Math.max(RL + 1.272 * rg, tp1 + risk));
  return { i, t: c[i].t, price: px, zone: { lo: ob.lo, hi: ob.hi }, entry, now, sl, tp1, tp2, riskPct, rr1: (tp1 - entry) / risk, score: sc, why, flags: { choch, sweep, fvg, ote, vol } };
}

/* Replay one trade on candles starting at index `start`. Deterministic; used by backtest AND live tracking.
   Rules (conservative): if SL and TP are both inside one candle, SL is assumed first. */
export function replay(s, c, start, o) {
  const fee = o.fee, w1 = o.w1, g = p => (p - s.entry) / s.entry, ev = [];
  let st = 'pending', fi = -1, tp1 = false, cs = s.sl;
  const end = (status, j, px) => {
    let pnl;
    if (status === 'expired' || status === 'missed') pnl = 0;
    else if (status === 'sl') pnl = g(s.sl) - fee;
    else if (status === 'be') pnl = w1 * g(s.tp1) - fee;
    else if (status === 'tp2') pnl = w1 * g(s.tp1) + (1 - w1) * g(s.tp2) - fee;
    else pnl = (tp1 ? w1 * g(s.tp1) + (1 - w1) * g(px) : g(px)) - fee;
    return { status, events: ev, fi, tp1Hit: tp1, final: true, endIdx: j, pnl };
  };
  for (let j = start; j < c.length; j++) {
    const k = c[j];
    if (st === 'pending') {
      if (j - start >= o.fillBars) { ev.push({ k: 'expired', j, p: k.o }); return end('expired', j); }
      if (k.l <= s.entry) { st = 'active'; fi = j; ev.push({ k: 'filled', j, p: s.entry }); }
      else { if (k.h >= s.tp1) { ev.push({ k: 'missed', j, p: s.tp1 }); return end('missed', j); } continue; }
    }
    if (k.l <= cs) { if (tp1) { ev.push({ k: 'be', j, p: s.entry }); return end('be', j); } ev.push({ k: 'sl', j, p: s.sl }); return end('sl', j); }
    if (!tp1 && k.h >= s.tp1) { tp1 = true; cs = s.entry; ev.push({ k: 'tp1', j, p: s.tp1 }); }
    if (tp1 && k.h >= s.tp2) { ev.push({ k: 'tp2', j, p: s.tp2 }); return end('tp2', j); }
    if (j - fi >= o.maxHold) { ev.push({ k: 'timeout', j, p: k.c }); return end('timeout', j, k.c); }
  }
  return { status: st === 'pending' ? 'pending' : tp1 ? 'tp1' : 'active', events: ev, fi, tp1Hit: tp1, final: false, endIdx: c.length - 1, pnl: null };
}

/* Replay every past setup of this exact strategy on this coin. Win = TP1 reached before stop. */
export function backtest(X, o) {
  const n = X.c.length, T = []; let last = -999;
  for (let i = 210; i < n - 2; i++) {
    if (i - last < o.cool) continue;
    const s = detectAt(X, i, o); if (!s || s.score < o.minScore) continue;
    last = i;
    const r = replay(s, X.c, i + 1, o);
    if (!r.final || r.status === 'expired' || r.status === 'missed') continue;
    const t1 = r.events.find(e => e.k === 'tp1');
    T.push({ win: r.tp1Hit ? 1 : 0, R: r.pnl / s.riskPct, h1: t1 ? t1.j - r.fi : null, hold: r.endIdx - r.fi, fill: r.fi - (i + 1) });
  }
  return { T, ...summ(T) };
}

export function summ(T) {
  const n = T.length, w = T.reduce((a, x) => a + x.win, 0), sR = T.reduce((a, x) => a + x.R, 0);
  return { n, w, sR, wr: n ? w / n : 0, avgR: n ? sR / n : 0 };
}
export function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }
export function typicalHold(T) { const w = T.filter(x => x.h1 != null).map(x => x.h1 + 1); return w.length >= 3 ? median(w) : median(T.map(x => x.hold + 1)); }
