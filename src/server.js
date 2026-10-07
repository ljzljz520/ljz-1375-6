// HTTP 服务：Web 只读视图 + 管理 API（经确认公告导入、预计算）。零依赖。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { PORT, ADMIN_TOKEN } from './config.js';
import { parseOffsetISO, offsetISO, dayBounds, addDays } from './util/time.js';
import { dbStats, load } from './db/store.js';
import { importNotice, activeNotices, presentNotice } from './domain/notices.js';
import { landingDecision, boatCondition, weatherCondition, tideCondition, venueSetCondition } from './domain/conditions.js';
import { checkRoute } from './domain/routes.js';
import { listKeepers } from './domain/history.js';
import { precomputeDay, getPlan, compare } from './domain/plans.js';
import { saveFavorite, listFavorites, reconnect } from './domain/favorites.js';
import { buildPack, evaluatePack } from './domain/offline.js';
import { assessClock } from './domain/clock.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, '..', 'public');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

const json = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 1e6) reject(new Error('body too large')); });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
});

// 用请求头 X-Client-Time 纠偏；所有“现在”都来自服务器
function clockOf(req) {
  const client = req.headers['x-client-time'];
  const clientMs = client ? Number(client) : NaN;
  const server = Date.now();
  const assess = assessClock(Number.isFinite(clientMs) ? clientMs : NaN, server);
  return assess;
}

function windowFromQuery(u) {
  const start = u.searchParams.get('start');
  const end = u.searchParams.get('end');
  const day = u.searchParams.get('day'); // YYYY-MM-DD 或 dayOffset
  if (start && end) return { start: parseOffsetISO(start), end: parseOffsetISO(end) };
  let base;
  if (day && /^-?\d+$/.test(day)) base = addDays(Date.now(), Number(day));
  else if (day) base = parseOffsetISO(day);
  else base = Date.now();
  return dayBounds(base);
}

async function staticFile(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

export const server = createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;
  const clock = clockOf(req);
  const now = clock.correctedNow;

  try {
    // ---------- 服务器时间（客户端时钟纠偏） ----------
    if (p === '/api/time' && req.method === 'GET') {
      return json(res, 200, {
        serverTime: offsetISO(now), serverTimeMs: now,
        clientTime: clock.clientTime ? offsetISO(clock.clientTime) : null,
        skewSeconds: clock.skewSeconds, trusted: clock.trusted, warning: clock.warning,
      });
    }

    // ---------- Web 只读视图 ----------
    if (p === '/api/landing' && req.method === 'GET') {
      const win = windowFromQuery(u);
      const t0 = process.hrtime.bigint();
      const result = landingDecision(win, { venueId: u.searchParams.get('venueId'), now });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      return json(res, 200, {
        window: { start: offsetISO(win.start), end: offsetISO(win.end) },
        composedAtRequest: true, computeMs: Math.round(ms * 1000) / 1000,
        ...result,
      });
    }
    for (const [name, fn] of [['boat', boatCondition], ['weather', weatherCondition], ['tide', tideCondition]]) {
      if (p === `/api/conditions/${name}` && req.method === 'GET') {
        const win = windowFromQuery(u);
        return json(res, 200, { window: { start: offsetISO(win.start), end: offsetISO(win.end) }, ...fn(win, { now }) });
      }
    }
    if (p === '/api/conditions/venue' && req.method === 'GET') {
      const win = windowFromQuery(u);
      return json(res, 200, { window: { start: offsetISO(win.start), end: offsetISO(win.end) }, ...venueSetCondition(win, { now }) });
    }
    if (p === '/api/notices' && req.method === 'GET') {
      const win = windowFromQuery(u);
      const topic = u.searchParams.get('topic');
      return json(res, 200, {
        window: { start: offsetISO(win.start), end: offsetISO(win.end) },
        notices: activeNotices(win, topic ? { topic } : {}).map(presentNotice),
      });
    }
    if (p === '/api/history' && req.method === 'GET') {
      return json(res, 200, {
        keepers: listKeepers(),
        note: '历史资料独立于实时交通流：临时取消不会使其失效，也不构成安全/交通保证',
      });
    }
    if (p === '/api/routes' && req.method === 'GET') {
      return json(res, 200, { routes: load().routes });
    }
    if (p === '/api/routes/check' && req.method === 'GET') {
      const routeId = u.searchParams.get('routeId');
      const date = u.searchParams.get('date') || 0;
      const win = windowFromQuery(u);
      const base = /^-?\d+$/.test(String(date)) ? addDays(now, Number(date)) : parseOffsetISO(date);
      return json(res, 200, checkRoute(routeId, base, win, now));
    }
    if (p === '/api/plans' && req.method === 'GET') {
      const dayParam = u.searchParams.get('day') || 0;
      const base = /^-?\d+$/.test(String(dayParam)) ? addDays(now, Number(dayParam)) : parseOffsetISO(dayParam);
      return json(res, 200, getPlan(base, now));
    }
    if (p === '/api/plans/compare' && req.method === 'GET') {
      const dayParam = u.searchParams.get('day') || 0;
      const base = /^-?\d+$/.test(String(dayParam)) ? addDays(now, Number(dayParam)) : parseOffsetISO(dayParam);
      return json(res, 200, compare(base, now));
    }
    if (p === '/api/favorites' && req.method === 'GET') {
      return json(res, 200, { favorites: listFavorites() });
    }
    if (p.match(/^\/api\/favorites\/[^/]+\/reconnect$/) && req.method === 'POST') {
      const id = p.split('/')[3];
      return json(res, 200, reconnect(id, now));
    }
    if (p === '/api/offline/pack' && req.method === 'GET') {
      const pack = buildPack(now);
      const status = evaluatePack(pack, now);
      return json(res, 200, { pack, status, evaluatedWith: '服务器时间（不信任客户端时钟）' });
    }
    if (p === '/api/admin/stats' && req.method === 'GET') {
      return json(res, 200, { ...dbStats(), serverTime: offsetISO(now) });
    }

    // ---------- 管理 API（需 token） ----------
    if (p === '/api/admin/notices' && req.method === 'POST') {
      if (req.headers['x-admin-token'] !== ADMIN_TOKEN) return json(res, 401, { error: '管理令牌无效' });
      const body = await readBody(req);
      const items = Array.isArray(body) ? body : [body];
      const results = items.map((it) => importNotice(it, now));
      return json(res, 200, { results, contentGeneration: load().generation });
    }
    if (p === '/api/admin/precompute' && req.method === 'POST') {
      if (req.headers['x-admin-token'] !== ADMIN_TOKEN) return json(res, 401, { error: '管理令牌无效' });
      const body = await readBody(req);
      const days = body.days ?? 3;
      const out = [];
      for (let d = 0; d < days; d++) out.push(precomputeDay(addDays(now, d), now));
      return json(res, 200, { plans: out.map((pl) => ({ day: pl.day, decision: pl.decision, generation: pl.generation })) });
    }
    if (p === '/api/favorites' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, saveFavorite(body, now));
    }

    // ---------- 静态资源 ----------
    if (req.method === 'GET') return staticFile(req, res, p);
    return json(res, 404, { error: 'not found', path: p });
  } catch (e) {
    return json(res, 500, { error: String(e?.message || e) });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`灯塔旅行指南 listening on http://localhost:${PORT}`));
}
