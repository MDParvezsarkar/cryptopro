// Runs on GitHub Actions every ~5 min. Checks Binance and sends Telegram alerts.
import fs from 'fs';
const cfg = JSON.parse(fs.readFileSync('coins.json', 'utf8'));
const TOK = process.env.TELEGRAM_BOT_TOKEN, CHAT = process.env.TELEGRAM_CHAT_ID;
const H = ['https://data-api.binance.vision', 'https://api.binance.com'];
const st = fs.existsSync('state.json') ? JSON.parse(fs.readFileSync('state.json', 'utf8')) : {};
const STB = /^(USDC|FDUSD|TUSD|USDP|BUSD|DAI|EUR|AEUR|USDE|XUSD|USD1)$/;
async function api(p) { for (const h of H) { try { const r = await fetch(h + p); if (r.ok) return await r.json(); } catch (e) {} } throw new Error('Binance unreachable: ' + p); }
async function tg(t) {
  if (!TOK || !CHAT) { console.log('[no Telegram secrets set]\n' + t); return; }
  const r = await fetch(`https://api.telegram.org/bot${TOK}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: CHAT, text: t.slice(0, 4000) }) });
  if (!r.ok) console.log('Telegram error', r.status, await r.text());
}
/* indicators - same rules as the website */
const ema = (a, n) => { const k = 2 / (n + 1), o = []; let p = a[0]; a.forEach((v, i) => { p = i ? v * k + p * (1 - k) : v; o.push(p); }); return o; };
function rsi(c, n = 14) { const o = Array(c.length).fill(null); let g = 0, l = 0; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1], G = Math.max(d, 0), L = Math.max(-d, 0); if (i <= n) { g += G; l += L; if (i == n) { g /= n; l /= n; o[i] = 100 - 100 / (1 + g / (l || 1e-9)); } } else { g = (g * (n - 1) + G) / n; l = (l * (n - 1) + L) / n; o[i] = 100 - 100 / (1 + g / (l || 1e-9)); } } return o; }
function bb(c, n = 20) { return c.map((_, i) => { if (i < n - 1) return null; const s = c.slice(i - n + 1, i + 1), m = s.reduce((a, b) => a + b) / n, sd = Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / n); return { u: m + 2 * sd, l: m - 2 * sd }; }); }
function build(k) { const c = k.map(x => +x[4]), a = ema(c, 12), b = ema(c, 26), m = c.map((_, i) => a[i] - b[i]), g = ema(m, 9); return { c, r: rsi(c), e1: ema(c, 20), e2: ema(c, 50), h: m.map((v, i) => v - g[i]), b: bb(c) }; }
function score(I, i) {
  let s = 0; const r = I.r[i], h = I.h[i], hp = I.h[i - 1], b = I.b[i], p = I.c[i];
  if (r < 30) s += 2; else if (r < 40) s += 1; else if (r > 70) s -= 2; else if (r > 60) s -= 1;
  s += I.e1[i] > I.e2[i] ? 1 : -1;
  if (h > 0 && h > hp) s += 1; else if (h < 0 && h < hp) s -= 1;
  if (p < b.l) s += 1; else if (p > b.u) s -= 1;
  return s;
}
async function analyse(sym) { const I = build(await api(`/api/v3/klines?symbol=${sym}USDT&interval=${cfg.iv || '1h'}&limit=500`)), i = I.c.length - 1; return { p: I.c[i], s: score(I, i) }; }

const msgs = [];
for (const c of cfg.coins || []) {
  try {
    const { p, s } = await analyse(c.s), S0 = st[c.s] = st[c.s] || { sig: '', hit: [], stop: false };
    const tp = c.tp || 10, sl = c.sl || 10, es = c.entries || [];
    const sig = s >= 3 ? 'BUY' : s <= -3 ? 'SELL' : '';
    if (sig && sig !== S0.sig) msgs.push(`${sig == 'BUY' ? '🟢 BUY' : '🔴 SELL'} signal: ${c.s} at $${p} (score ${s > 0 ? '+' : ''}${s} of 5)`);
    S0.sig = sig;
    S0.hit = S0.hit.filter(j => es[j] && p >= es[j].p * (1 + tp / 100) * 0.97);
    es.forEach((e, i) => { if (p >= e.p * (1 + tp / 100) && !S0.hit.includes(i)) { S0.hit.push(i); msgs.push(`✅ ${c.s}: entry #${i + 1} (bought $${e.p}) reached the +${tp}% target. Price $${p}. Consider selling. Profit about $${(e.u / e.p * p - e.u).toFixed(2)}`); } });
    const q = es.reduce((a, e) => a + e.u / e.p, 0), inv = es.reduce((a, e) => a + e.u, 0), stop = q > 0 && p <= (inv / q) * (1 - sl / 100);
    if (stop && !S0.stop) msgs.push(`⛔ ${c.s}: STOP-LOSS. Price $${p} is ${sl}% below your average buy $${(inv / q).toFixed(4)}. Consider selling to limit loss.`);
    S0.stop = stop;
  } catch (e) { console.log('skip', c.s, e.message); }
}
if (cfg.scan && cfg.scan.on) {
  try {
    const list = (await api('/api/v3/ticker/24hr')).filter(x => x.symbol.endsWith('USDT') && !STB.test(x.symbol.slice(0, -4)) && +x.quoteVolume > 5e6).sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, cfg.scan.top || 20), now = [];
    for (let i = 0; i < list.length; i += 8) await Promise.all(list.slice(i, i + 8).map(async x => { try { const n = x.symbol.slice(0, -4), r = await analyse(n); if (r.s >= (cfg.scan.minScore || 4)) now.push(`${n} $${r.p}`); } catch (e) {} }));
    const prev = st._m || [], fresh = now.filter(x => !prev.includes(x.split(' ')[0]) && !prev.includes(x));
    st._m = now.map(x => x.split(' ')[0]);
    if (fresh.length) msgs.push('🟢 Market scan - new STRONG BUY signals:\n' + fresh.join('\n'));
  } catch (e) { console.log('scan failed', e.message); }
}
fs.writeFileSync('state.json', JSON.stringify(st, null, 1));
if (msgs.length) await tg(msgs.join('\n\n') + '\n\n(Analysis only, not financial advice.)'); else console.log('No new alerts.');
