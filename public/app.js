/* 灯塔旅行指南前端：所有“现在/过期/最后核对”判定以服务器时间为准；离线时只读本地包且不承诺安全。 */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  serverNow: null,
  skewSeconds: 0,
  clientClockOffsetMs: 0,   // 演示用：人为给客户端时钟加偏移
  offline: false,
  pack: null,
  packStatus: null,
  savedFav: null,
};

// ---------- 网络封装：离线模式下只允许读本地包 ----------
async function api(path, opts = {}) {
  if (state.offline && !path.startsWith('/api/offline/')) {
    throw new Error('OFFLINE');
  }
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  // 始终上报客户端自报时间，由服务器纠偏（演示偏移也包含在内）
  headers['X-Client-Time'] = String(Date.now() + state.clientClockOffsetMs);
  const res = await fetch(path, { ...opts, headers });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const badge = (s) => {
  const map = { TRUE:'TRUE 成立', FALSE:'FALSE 不成立', UNKNOWN:'UNKNOWN 未知', CONFLICT:'CONFLICT 冲突',
    MIXED:'MIXED 部分', OK:'OK 可通行', BLOCKED:'BLOCKED 受阻', NO_OVERLAP:'窗口无交集',
    NOT_NEEDED:'本航段不需要', LANDING_POSSIBLE:'可登岛（四条件同时成立）',
    NO_LANDING:'不可登岛', 'NULL':'未知' };
  return `<span class="badge b-${s}">${map[s] || s}</span>`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const short = (iso) => iso ? iso.replace('+08:00','').replace('T',' ') : '—';
const hhmm = (iso) => iso ? iso.slice(11,16) : '';

// ---------- 服务器时间 & 时钟纠偏 ----------
async function syncTime() {
  try {
    const t = await api('/api/time');
    state.serverNow = t.serverTimeMs;
    state.serverTimeISO = t.serverTime;
    state.skewSeconds = t.skewSeconds;
    $('#serverTime').textContent = `${short(t.serverTime)}（UTC+8）`;
    const banner = $('#clockBanner');
    if (!t.trusted) {
      banner.textContent = `⚠ ${t.warning}；页面时间与过期判断均已改用服务器时间`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  } catch (e) {
    $('#serverTime').textContent = '无法连接（离线）';
  }
}

// ---------- Tabs ----------
$$('#tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
  $$('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== `tab-${b.dataset.tab}`));
}));

// ---------- 初始化日期控件 ----------
function localInputValue(d) {
  // datetime-local 需要“墙上时间”，这里直接用服务器时间字符串裁掉时区
  const iso = new Date(d + 8 * 3600000).toISOString();
  return iso.slice(0, 16);
}
function initControls() {
  const today = new Date(state.serverNow + 8*3600000);
  const dayStr = today.toISOString().slice(0,10);
  $('#planDay').value = dayStr;
  $('#cmpDay').value = dayStr;
  $('#routeDay').value = dayStr;
  $('#condStart').value = dayStr + 'T06:00';
  $('#condEnd').value = dayStr + 'T16:00';
  $('#routeWinStart').value = dayStr + 'T06:00';
  $('#routeWinEnd').value = dayStr + 'T16:00';
}

// ---------- 登岛综合判定 ----------
async function loadPlan() {
  const day = $('#planDay').value;
  try {
    const r = await api(`/api/landing?day=${day}`);
    state.lastPlan = r;
    const lc = r.lastChecked;
    const checkedRows = Object.entries(lc).map(([k,v]) =>
      `<tr><td>${condName(k)}</td><td>${v.checkedAtISO ? short(v.checkedAtISO) : '无数据'}</td>
       <td>${v.stale ? '<span class="stale">已陈旧</span>' : '新鲜'}</td></tr>`).join('');
    $('#planResult').innerHTML = `
      <div class="verdict-big">${badge(r.decision)}</div>
      <p class="hint">${esc(r.reason || '四类条件在所选窗口全部成立')}</p>
      <div class="checked">窗口 ${short(r.window.start)} → ${short(r.window.end)} · 请求时实时组合耗时 ${r.computeMs}ms</div>
      <table>
        <thead><tr><th>条件</th><th>最后核对时间（来源时间）</th><th>状态</th></tr></thead>
        <tbody>${checkedRows}</tbody>
      </table>
      <h4>逐条件结论</h4>
      <div class="grid4">${Object.entries(r.conditions).map(([k,c]) => condCard(k,c)).join('')}</div>`;
    renderPrintMeta(r);
  } catch (e) { offlineError('#planResult', e); }
}
const condName = (k) => ({boat:'船班',weather:'天气',tide:'潮汐',venue:'场所开放'}[k] || k);

function condCard(k, c) {
  const perVenue = c.perVenue ? c.perVenue.map((v) =>
    `<div class="meta">· ${esc(v.resourceId)} ${badge(v.verdict)}</div>`).join('') : '';
  return `<div class="card">
    <h4>${condName(k)} ${badge(c.verdict)}</h4>
    <div class="meta">${esc(c.reason || '')}</div>
    ${perVenue}
    <div class="checked">最后核对：${c.checkedAtISO ? short(c.checkedAtISO) : '—'}${c.stale ? ' · <span class="stale">陈旧</span>' : ''}</div>
    ${(c.segments||[]).map((s) => `<div class="seg ${s.status}">${hhmm(s.start)}–${hhmm(s.end)} ${badge(s.status)}</div>`).join('')}
  </div>`;
}

// ---------- 四条件明细 ----------
async function loadConditions() {
  const s = $('#condStart').value, e = $('#condEnd').value;
  try {
    const [b,w,t,v] = await Promise.all([
      api(`/api/conditions/boat?start=${encodeURIComponent(s+'+08:00')}&end=${encodeURIComponent(e+'+08:00')}`),
      api(`/api/conditions/weather?start=${encodeURIComponent(s+'+08:00')}&end=${encodeURIComponent(e+'+08:00')}`),
      api(`/api/conditions/tide?start=${encodeURIComponent(s+'+08:00')}&end=${encodeURIComponent(e+'+08:00')}`),
      api(`/api/conditions/venue?start=${encodeURIComponent(s+'+08:00')}&end=${encodeURIComponent(e+'+08:00')}`),
    ]);
    $('#condResult').innerHTML = [['boat',b],['weather',w],['tide',t],['venue',v]]
      .map(([k,c]) => condCard(k,c)).join('');
  } catch (err) { offlineError('#condResult', err); }
}

// ---------- 路线 ----------
async function loadRoutes() {
  const r = await api('/api/routes');
  $('#routeSelect').innerHTML = r.routes.map((x) =>
    `<option value="${x.id}">${x.reviewed ? '' : '⛔'}${esc(x.name)}</option>`).join('');
}
async function checkRoute() {
  const routeId = $('#routeSelect').value;
  const day = $('#routeDay').value;
  const s = $('#routeWinStart').value, e = $('#routeWinEnd').value;
  try {
    const r = await api(`/api/routes/check?routeId=${routeId}&date=${day}` +
      `&start=${encodeURIComponent(s+'+08:00')}&end=${encodeURIComponent(e+'+08:00')}`);
    if (r.error) { $('#routeResult').innerHTML = `<p class="disclaimer">${esc(r.error)}</p>`; return; }
    $('#routeResult').innerHTML = `
      <h3>${esc(r.routeName)} ${badge(r.overall)}</h3>
      <p class="meta">基准日 ${r.day} · 你的窗口 ${short(r.userWindow.start)} → ${short(r.userWindow.end)}</p>
      <p class="hint">${esc(r.rule)}</p>
      ${r.legs.map((l) => `<div class="leg">
        <h4>${esc(l.label)} ${badge(l.status)}</h4>
        <div class="meta">资源：${l.resource.topic}/${esc(l.resource.resourceId)} · 计划 ${short(l.planned.start)}–${short(l.planned.end)} ·
        与你的窗口${l.intersectsUserWindow ? `交集 ${short(l.intersection.start)}–${short(l.intersection.end)}` : '无交集'}</div>
        <div>${esc(l.reason)}</div>
        ${l.segments.map((sg)=>`<div class="seg ${sg.status}">${hhmm(sg.start)}–${hhmm(sg.end)} ${badge(sg.status)}
          ${sg.evidence.length ? '依据：'+sg.evidence.map(x=>esc(x.summary)).join('；') : ''}</div>`).join('')}
      </div>`).join('')}`;
  } catch (err) { offlineError('#routeResult', err); }
}

// ---------- 历史 ----------
async function loadHistory() {
  const r = await api('/api/history');
  $('#historyResult').innerHTML = `<p class="hint">${esc(r.note)}</p>` + r.keepers.map((k) => `
    <div class="keeper">
      <h3>${esc(k.name)} · ${esc(k.lighthouse)}</h3>
      <div class="meta">服役年份：${esc(k.yearsOfService)} · 资料核对时间：${short(k.verifiedAt)}（独立于公告代次）</div>
      <p>${esc(k.biography)}</p>
      <div class="meta">来源：${k.sources.map((s)=>esc(s.archive||s.name)).join('、')}</div>
      <div class="checked">${esc(k.note)}</div>
    </div>`).join('');
}

// ---------- 收藏 ----------
async function loadFavorites() {
  const r = await api('/api/favorites');
  if (!r.favorites.length) { $('#favList').innerHTML = '<p class="hint">还没有收藏。在“登岛窗口”页收藏当日计划。</p>'; return; }
  $('#favList').innerHTML = r.favorites.map((f) => `
    <div class="keeper" id="fav-${f.id}">
      <h3>${esc(f.name)}</h3>
      <div class="meta">保存于 ${short(f.savedAt)} · 代次 ${f.contentGeneration} · 窗口 ${short(f.window.start)}→${short(f.window.end)}</div>
      <button onclick="reconnectFav('${f.id}')">重新联网核对（展示变化前后）</button>
      <div class="favdiff"></div>
    </div>`).join('');
}
async function saveCurrentFav() {
  const day = $('#planDay').value;
  await api('/api/favorites', { method:'POST', body: JSON.stringify({ name:`${day} 登岛计划`, window:{start:day+'T00:00',end:day+'T23:59:59'} }) });
  alert('已收藏（快照已冻结）');
}
window.reconnectFav = async (id) => {
  const box = $(`#fav-${id} .favdiff`);
  try {
    const r = await api(`/api/favorites/${id}/reconnect`, { method:'POST' });
    const rows = r.diff.map((d) => `
      <div class="diff-row ${d.changed?'changed':''}">
        <div>${d.field}</div>
        <div class="meta">前：${esc(d.before ?? '—')}</div>
        <div class="meta">后：${esc(d.after ?? '—')}</div>
        <div>${d.changed ? '🔁 变化' : '一致'}</div>
      </div>`).join('');
    box.innerHTML = `<h4>重连结果：整体 ${badge(r.after.decision)}（保存时 ${badge(r.before.decision)}）${r.changed ? '，存在变化' : '，无变化'}</h4>
      <div class="diff-row diff-head"><div>字段</div><div>变化前</div><div>变化后</div><div></div></div>${rows}`;
  } catch (e) { box.innerHTML = `<p class="disclaimer">离线：无法重连核对，保留上次快照，不声称现场情况未变。</p>`; }
};

// ---------- 离线包 ----------
async function buildPack() {
  const r = await api('/api/offline/pack');
  state.pack = r.pack; state.packStatus = r.status;
  renderPack();
}
function renderPack() {
  if (!state.pack) { $('#packResult').innerHTML = '<p class="hint">尚未生成离线包。</p>'; return; }
  const el = $('#packResult');
  // 离线时用本地缓存状态；在线时用服务器 status
  const st = state.offline ? {
    expired: state.serverNow == null ? null : state.serverNow > state.pack.expiresAt,
    secondsLeft: state.pack.expiresAt - state.serverNow,
    guidance: state.serverNow > state.pack.expiresAt
      ? '离线包已过期：只能作历史参考，不能据此声称安全或保证交通'
      : '离线包在有效期内，仍建议重新联网确认四类条件',
  } : state.packStatus;
  el.innerHTML = `
    <h3>离线包 ${st.expired ? badge('NO_LANDING') : badge('TRUE')} ${st.expired ? '已过期' : '有效'}</h3>
    <div class="meta">生成时间：${short(state.pack.generatedAtISO)} · 有效期至：${short(state.pack.expiresAtISO)}
      （剩余 ${Math.round((st.secondsLeft??0)/3600)} 小时）· 内容代次 ${state.pack.contentGeneration}</div>
    <p class="disclaimer">${esc(state.pack.disclaimer)}</p>
    <p>${esc(st.guidance)}</p>
    <h4>包内逐日结论（生成时快照，不代表现场）</h4>
    ${state.pack.days.map((d)=>`<div class="meta">${d.day}：${badge(d.decision.decision)} — ${esc(d.decision.reason||'四条件同时成立')}</div>`).join('')}
    <h4>守塔人资料（历史资料，不随取消失效）</h4>
    ${state.pack.keepers.map((k)=>`<div class="meta">· ${esc(k.name)}（${esc(k.lighthouse)}），核对于 ${short(k.verifiedAt)}</div>`).join('')}`;
  renderOfflinePrint();
}
$('#offlineMode').addEventListener('change', (e) => {
  state.offline = e.target.checked;
  document.body.classList.toggle('offline', state.offline);
  let strip = document.getElementById('offlineStrip');
  if (state.offline) {
    strip = document.createElement('div');
    strip.id = 'offlineStrip'; strip.className = 'offline-strip';
    strip.textContent = '离线模式：仅可浏览已下载离线包；任何结论均不是现场安全或交通保证';
    document.body.prepend(strip);
    syncTime();
  } else if (strip) strip.remove();
  renderPack();
});

// ---------- 预计算 vs 实时 ----------
async function comparePlan() {
  const day = $('#cmpDay').value;
  const r = await api(`/api/plans/compare?day=${day}`);
  $('#cmpResult').innerHTML = `
    <h3>${r.day} · 当前内容代次 ${r.contentGeneration}</h3>
    <table><thead><tr><th></th><th>后台预计算（缓存）</th><th>请求时组合（实时）</th></tr></thead><tbody>
    <tr><td>结论</td><td>${r.precomputed ? badge(r.precomputed.decision) : '无缓存'}</td><td>${badge(r.requestTime.decision)}</td></tr>
    <tr><td>生成/计算</td><td>${r.precomputed ? short(r.precomputed.generatedAt)+'，代次 '+r.precomputed.generation+(r.precomputed.stale?' <span class="stale">[已 stale：代次落后]</span>':'') : '—'}</td><td>本次请求实时归约</td></tr>
    <tr><td>耗时</td><td>${r.precomputed ? r.precomputed.computeMs+'ms（落库时）/ ~0ms（读缓存）' : '—'}</td><td>${r.requestTime.computeMs}ms</td></tr>
    <tr><td>结论是否变化</td><td colspan="2">${r.decisionChanged===null?'—':(r.decisionChanged?'<span class="stale">是：缓存与实时不一致</span>':'否')}</td></tr>
    </tbody></table>
    <h4>取舍说明</h4>
    <p class="meta">公告频率：${esc(r.tradeoff.announcementFrequency)}</p>
    <p class="meta">查询延迟：${esc(r.tradeoff.queryLatency)}</p>
    <p class="meta">缓存失效：${esc(r.tradeoff.cacheInvalidation)}</p>`;
}
async function recompute() {
  const token = $('#adminToken').value;
  await api('/api/admin/precompute', { method:'POST', headers:{'X-Admin-Token':token}, body: JSON.stringify({ days:5 }) });
  comparePlan();
}

// ---------- 管理导入 ----------
function adminOut(x) { $('#adminResult').textContent = JSON.stringify(x, null, 2); }
async function adminImport(body) {
  const token = $('#adminToken').value;
  return api('/api/admin/notices', { method:'POST', headers:{'X-Admin-Token':token}, body: JSON.stringify(body) });
}
function tomorrowIso(h, mi) {
  const d = new Date(state.serverNow + 8*3600000 + 86400000);
  const pad = (n)=>String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}T${pad(h)}:${pad(mi)}:00+08:00`;
}

async function sendDuplicate() {
  // 取一条现有 boat operates 公告原文回灌
  const list = await api('/api/notices?topic=boat');
  const n = list.notices.find((x)=>x.predicate==='operates');
  const payload = { status:'confirmed', topic:n.topic, resourceId:n.resourceId, predicate:n.predicate,
    title:n.title, summary:n.summary, legs:n.legs, applicableWindows:n.applicableWindows, source:n.source };
  adminOut(await adminImport(payload));
}
async function sendCancel() {
  const body = { status:'confirmed', topic:'venue', resourceId:'viewpoint-north', predicate:'closed',
    title:'新增临时关闭：管理导入演练', summary:'重连对比演示用，明晚 1 小时关闭',
    applicableWindows:[{start:tomorrowIso(20,0), end:tomorrowIso(21,0)}],
    payload:{reason:'管理端导入演练'}, source:{name:'管理处·临时', sourceTime: new Date(state.serverNow).toISOString()} };
  adminOut(await adminImport(body));
}
async function sendDraft() {
  try {
    await adminImport({ status:'draft', topic:'boat', resourceId:'ferry-main', predicate:'operates',
      title:'不应入库', applicableWindows:[{start:tomorrowIso(6,30), end:tomorrowIso(8,0)}] });
  } catch (e) { adminOut({ rejected: String(e.message) }); }
}

// ---------- 打印元数据 ----------
function renderPrintMeta(plan) {
  $('#printFooter').classList.remove('hidden');
  const undecided = Object.entries(plan.conditions)
    .filter(([,c]) => c.verdict !== 'TRUE').map(([k,c]) => `${condName(k)}（${c.verdict}: ${c.reason || '未确定'}）`);
  $('#printMeta').innerHTML = `
    <p>资料生成时间（服务器 UTC+8）：${state.serverTimeISO || '—'}；
       本页查询窗口：${short(plan.window.start)} → ${short(plan.window.end)}。</p>
    <p>各条件最后核对时间：船班 ${short(plan.lastChecked.boat.checkedAtISO)}，天气 ${short(plan.lastChecked.weather.checkedAtISO)}，
       潮汐 ${short(plan.lastChecked.tide.checkedAtISO)}，场所 ${short(plan.lastChecked.venue.checkedAtISO)}。</p>
    <p>未确定事项：${undecided.length ? undecided.join('；') : '本窗口四条件当前均有正向数据，但任何打印内容都不替代出发前重新核对。'}</p>
    <p>离线包有效期：${state.pack ? `至 ${short(state.pack.expiresAtISO)}` : '本次未携带离线包'}；过期后仅可作历史参考。</p>`;
}
function renderOfflinePrint() {
  if (state.pack) $('#printFooter').classList.remove('hidden');
}

function offlineError(sel, e) {
  $(sel).innerHTML = e.message === 'OFFLINE'
    ? '<p class="disclaimer">当前离线：该实时视图不可用。请改用已下载离线包；离线资料不构成现场安全或交通保证。</p>'
    : `<p class="disclaimer">加载失败：${esc(e.message)}</p>`;
}

// ---------- 演示控件：人为拨偏客户端时钟 ----------
function injectClockDemo() {
  const bar = document.createElement('div');
  bar.className = 'controls';
  bar.style.cssText = 'padding:6px 20px;background:#0a111c';
  bar.innerHTML = `<span class="meta">时钟演练：人为设置客户端偏差</span>
    <button data-sk="-3600">-1 小时</button><button data-sk="0">校准</button><button data-sk="7200">+2 小时</button>`;
  document.querySelector('.topbar').after(bar);
  bar.querySelectorAll('button').forEach((b)=>b.addEventListener('click', async ()=>{
    state.clientClockOffsetMs = Number(b.dataset.sk)*1000;
    await syncTime();
  }));
}

// ---------- 绑定 & 启动 ----------
$('#planGo').addEventListener('click', loadPlan);
$('#planFav').addEventListener('click', saveCurrentFav);
$('#condGo').addEventListener('click', loadConditions);
$('#routeGo').addEventListener('click', checkRoute);
$('#favRefresh').addEventListener('click', loadFavorites);
$('#packBuild').addEventListener('click', buildPack);
$('#cmpGo').addEventListener('click', comparePlan);
$('#cmpRecompute').addEventListener('click', recompute);
$('#adminStats').addEventListener('click', async ()=> adminOut(await api('/api/admin/stats')));
$('#adminSendDup').addEventListener('click', sendDuplicate);
$('#adminSendCancel').addEventListener('click', sendCancel);
$('#adminSendDraft').addEventListener('click', sendDraft);

(async function init() {
  injectClockDemo();
  await syncTime();
  initControls();
  loadPlan(); loadRoutes(); loadHistory(); loadFavorites();
  setInterval(syncTime, 30000);
})();
