// 种子数据：以“运行当天”为 D0 生成确定性相对日期，覆盖全部验收场景。
import { reset, load } from '../src/db/store.js';
import { importNotice } from '../src/domain/notices.js';
import { addKeeper } from '../src/domain/history.js';
import { addRoute } from '../src/domain/routes.js';
import { precomputeDay } from '../src/domain/plans.js';
import { siteMidnight, addDays, offsetISO } from '../src/util/time.js';

const day = (d, h = 0, mi = 0) => addDays(siteMidnight(), d) + h * 3600000 + mi * 60000;
const W = (a, b) => ({ start: offsetISO(a), end: offsetISO(b) });
const now = Date.now();

reset();

const notice = (o) => importNotice({ status: 'confirmed', ...o }, now);

// ---------- 船班 ----------
// 常规船班 D0-D2（含早班 06:30 与午后班 14:00）
notice({
  topic: 'boat', resourceId: 'ferry-main', predicate: 'operates',
  title: '灯塔渡轮常规班期', summary: '每日 06:30 / 14:00 两班，航程约 50 分钟',
  legs: ['outbound', 'return'],
  applicableWindows: [
    W(day(0, 6, 30), day(0, 8, 0)), W(day(0, 14, 0), day(0, 15, 30)),
    W(day(1, 6, 30), day(1, 8, 0)), W(day(1, 14, 0), day(1, 15, 30)),
    W(day(2, 6, 30), day(2, 8, 0)), W(day(2, 14, 0), day(2, 15, 30)),
  ],
  payload: { trips: ['06:30', '14:00'] },
  source: { name: '灯塔航运公司', sourceTime: offsetISO(now) },
});
// D1 早班临时取消（只影响早班去程/回程窗口；午后班不受影响）
notice({
  topic: 'boat', resourceId: 'ferry-main', predicate: 'cancelled',
  title: '临时取消：D1 早班渡轮', summary: '因船舶例行检修，D1 06:30 班次取消，14:00 班正常',
  legs: ['outbound'],
  applicableWindows: [W(day(1, 6, 30), day(1, 7, 30))],
  payload: { cancelledTrip: '06:30', reason: '例行检修' },
  source: { name: '灯塔航运公司', sourceTime: offsetISO(now) },
});

// ---------- 天气 ----------
notice({
  topic: 'weather', resourceId: 'island', predicate: 'forecast',
  title: '晴好预报', summary: '海况良好，风力 3 级，适航',
  applicableWindows: [W(day(0, 0), day(3, 0))],
  payload: { severity: 'fair', windLevel: 3 },
  source: { name: '海区气象台', sourceTime: offsetISO(now) },
});
notice({
  topic: 'weather', resourceId: 'island', predicate: 'warning',
  title: '大风预警', summary: '阵风 9 级，所有海上活动应暂停',
  applicableWindows: [W(day(3, 6), day(4, 6))],
  payload: { severity: 'storm', windLevel: 9 },
  source: { name: '海区气象台·预警中心', sourceTime: offsetISO(now) },
});

// ---------- 潮汐（含跨日窗口 23:30–02:30） ----------
notice({
  topic: 'tide', resourceId: 'landing-rock', predicate: 'window',
  title: '潮位登岛窗口（D0 上午）', summary: '潮高 1.2–2.0m，礁石码头可靠泊',
  applicableWindows: [W(day(0, 5, 0), day(0, 9, 0)), W(day(0, 13, 0), day(0, 16, 0))],
  payload: { tideRangeM: [1.2, 2.0] },
  source: { name: '海洋潮汐台', sourceTime: offsetISO(now) },
});
notice({
  topic: 'tide', resourceId: 'landing-rock', predicate: 'window',
  title: '跨日潮汐窗口（D1 深夜–D2 凌晨）', summary: '夜潮窗口 23:30 至次日 02:30，跨日记录',
  applicableWindows: [W(day(1, 23, 30), day(2, 2, 30))],
  payload: { tideRangeM: [1.1, 1.9], overnight: true },
  source: { name: '海洋潮汐台', sourceTime: offsetISO(now) },
});
// D1 上午潮位（让“早班+靠泊”在上午成立；下午则无潮位数据 -> 逐段未知）
notice({
  topic: 'tide', resourceId: 'landing-rock', predicate: 'window',
  title: '潮位登岛窗口（D1 上午）', summary: '潮高 1.2–2.0m',
  applicableWindows: [W(day(1, 5, 0), day(1, 9, 0))],
  payload: { tideRangeM: [1.2, 2.0] },
  source: { name: '海洋潮汐台', sourceTime: offsetISO(now) },
});
notice({
  topic: 'tide', resourceId: 'landing-rock', predicate: 'window',
  title: '潮位登岛窗口（D2 上午）', summary: '潮高 1.3–2.1m',
  applicableWindows: [W(day(2, 5, 0), day(2, 9, 0))],
  payload: { tideRangeM: [1.3, 2.1] },
  source: { name: '海洋潮汐台', sourceTime: offsetISO(now - 30*3600000) },
});

// ---------- 场所 ----------
notice({
  topic: 'venue', resourceId: 'lighthouse-tower', predicate: 'open',
  title: '灯塔本体开放', summary: '灯塔塔楼每日 09:00–17:00 开放登塔',
  applicableWindows: [W(day(0, 9), day(6, 9))],
  payload: { hours: '09:00-17:00' },
  source: { name: '灯塔管理处', sourceTime: offsetISO(now) },
});
notice({
  topic: 'venue', resourceId: 'viewpoint-north', predicate: 'open',
  title: '北观景台开放', summary: '北观景台全天开放',
  applicableWindows: [W(day(0, 0), day(6, 0))],
  source: { name: '灯塔管理处', sourceTime: offsetISO(now) },
});
// 观景点临时关闭（小窗口挖洞）
notice({
  topic: 'venue', resourceId: 'viewpoint-north', predicate: 'closed',
  title: '临时关闭：北观景台 D1 下午维护', summary: '护栏维护，D1 13:00–17:00 临时关闭',
  applicableWindows: [W(day(1, 13), day(1, 17))],
  payload: { reason: '护栏维护' },
  source: { name: '灯塔管理处·运维', sourceTime: offsetISO(now) },
});

// D5：故意不给任何数据 —— 期望整体 UNKNOWN（数据不足保留未知）

// ---------- 守塔人历史资料 ----------
addKeeper({
  name: '陈守夜', lighthouse: '北礁灯塔', yearsOfService: '1952–1989',
  biography: '任内维护电石灯与雾钟，日志记载 1960 年三次台风夜航标坚守。',
  sources: [{ name: '航海日志手抄本', archive: '市档案馆 J-31' }],
  verifiedAt: offsetISO(day(-30, 10)), validUntil: null,
}, now);
addKeeper({
  name: '林照海', lighthouse: '北礁灯塔', yearsOfService: '1978–2005',
  biography: '主持灯塔由乙炔灯改造为太阳能供电，培养年轻守塔人七名。',
  sources: [{ name: '管理处口述史', archive: '管理处档案室' }],
  verifiedAt: offsetISO(day(-12, 10)), validUntil: null,
}, now);

// ---------- 已审路线 ----------
addRoute({
  id: 'route-classic', name: '灯塔经典线（已审核）', reviewed: true,
  legs: [
    { id: 'leg-ferry', label: '渡轮去程', resourceTopic: 'boat', resourceId: 'ferry-main', start: '06:30', end: '08:00' },
    { id: 'leg-tide', label: '靠泊（潮汐窗口）', resourceTopic: 'tide', resourceId: 'landing-rock', start: '06:30', end: '07:30' },
    { id: 'leg-view', label: '北观景台', resourceTopic: 'venue', resourceId: 'viewpoint-north', start: '10:00', end: '11:00' },
    { id: 'leg-tower', label: '登塔参观', resourceTopic: 'venue', resourceId: 'lighthouse-tower', start: '10:30', end: '12:00' },
    { id: 'leg-return', label: '渡轮返程', resourceTopic: 'boat', resourceId: 'ferry-main', start: '14:00', end: '15:30' },
  ],
});
addRoute({
  id: 'route-draft', name: '未审核试走线', reviewed: false,
  legs: [
    { id: 'l1', label: '试走航段', resourceTopic: 'boat', resourceId: 'ferry-main', start: '06:30', end: '07:30' },
  ],
});

// ---------- 后台预计算 D0–D4（旧代次，导入新公告后即 stale，用于对比演示） ----------
for (let d = 0; d <= 4; d++) precomputeDay(day(d), now);

const db = load();
console.log('seed done:', {
  generation: db.generation,
  notices: db.notices.length,
  keepers: db.history.length,
  routes: db.routes.length,
  planDays: Object.keys(db.plans.byDate),
});
