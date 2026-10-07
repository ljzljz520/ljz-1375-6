// 公共工具:一切以服务器时间为准,客户端时钟仅用于显示偏差
let serverOffset = 0; // server - client (ms)

async function fetchJSON(url, opts) {
  const r = await fetch(url, opts);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
async function syncClock() {
  const t = await fetchJSON('/api/time');
  serverOffset = new Date(t.server_time) - Date.now();
  const el = document.getElementById('srvtime');
  if (el) {
    const skew = t.clock_skew_seconds;
    el.textContent = '服务器时间 ' + fmt(t.server_time) +
      (skew !== null && skew !== undefined ? ` | 您的时钟偏差 ${Math.round(skew)} 秒(判断以服务器为准)` : '');
  }
}
function serverNow() { return new Date(Date.now() + serverOffset); }
function fmt(s) {
  if (!s) return '—';
  return new Date(s).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}
const COND = { ship: '船班', weather: '天气', tide: '潮汐', venue: '场所开放' };
const STATUS_CN = { favorable: '有利', adverse: '不利', unknown: '未知' };
const VERDICT_CN = { LANDABLE: '可登岛', NOT_LANDABLE: '不可登岛', UNKNOWN: '未知(数据不足/冲突)' };
function badge(st) {
  const cls = st === 'favorable' || st === 'ok' ? 'b-ok' : st === 'adverse' || st === 'broken' ? 'b-bad' : 'b-unk';
  return `<span class="badge ${cls}">${STATUS_CN[st] || st}</span>`;
}
function condCard(key, c) {
  const spans = (c.ok && c.ok.length ? c.ok : (c.stays || []))
    .map(w => `${fmt(w.start)} ~ ${fmt(w.end)}`).join('<br>');
  const bad = (c.bad || []).map(w => `不利: ${fmt(w.start)} ~ ${fmt(w.end)}`).join('<br>');
  const cancelled = (c.cancelled || []).map(x => `已取消: ${x.route_code}`).join('<br>');
  return `<div class="card"><h3>${COND[key]} ${badge(c.status)}</h3>
    <div>${spans || '<span class="muted">无有利窗口</span>'}</div>
    ${bad ? `<div>${bad}</div>` : ''}${cancelled ? `<div>${cancelled}</div>` : ''}
    ${(c.reasons || []).map(r => `<div class="muted">${r}</div>`).join('')}
    <div class="muted">最后核对: ${fmt(c.last_verified_at)} | 代次: ${c.generation ?? '—'}</div></div>`;
}
