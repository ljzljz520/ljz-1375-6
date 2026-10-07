// 测试夹具：每个测试用独立的临时数据文件，避免污染开发库。
import { reset } from '../src/db/store.js';
import { siteMidnight, addDays, offsetISO } from '../src/util/time.js';
import { importNotice } from '../src/domain/notices.js';
import { addKeeper } from '../src/domain/history.js';
import { addRoute } from '../src/domain/routes.js';
import { precomputeDay } from '../src/domain/plans.js';

export const day = (base, d, h = 0, mi = 0) => addDays(siteMidnight(base), d) + h * 3600000 + mi * 60000;
export const W = (a, b) => ({ start: offsetISO(a), end: offsetISO(b) });

export function setupScenario(now = Date.UTC(2026, 9, 7, 14, 0, 0)) {
  reset();
  const N = (o) => importNotice({ status: 'confirmed', ...o }, now);
  const d = (n, h = 0, mi = 0) => day(now, n, h, mi);

  N({ topic:'boat', resourceId:'ferry', predicate:'operates', title:'班期', legs:['outbound','return'],
      applicableWindows:[W(d(0,6,30),d(0,8)),W(d(0,14),d(0,15,30)),W(d(1,6,30),d(1,8)),W(d(1,14),d(1,15,30))],
      source:{name:'航运',sourceTime:offsetISO(now)} });
  N({ topic:'boat', resourceId:'ferry', predicate:'cancelled', title:'D1早班取消', legs:['outbound'],
      applicableWindows:[W(d(1,6,30),d(1,7,30))], source:{name:'航运',sourceTime:offsetISO(now)} });
  N({ topic:'weather', resourceId:'island', predicate:'forecast', title:'晴',
      applicableWindows:[W(d(0,0),d(3,0))], payload:{severity:'fair'},
      source:{name:'气象',sourceTime:offsetISO(now)} });
  N({ topic:'tide', resourceId:'rock', predicate:'window', title:'潮位',
      applicableWindows:[W(d(0,5),d(0,9)),W(d(1,5),d(1,9)),W(d(1,23,30),d(2,2,30))],
      source:{name:'潮汐台',sourceTime:offsetISO(now)} });
  N({ topic:'venue', resourceId:'tower', predicate:'open', title:'灯塔开放',
      applicableWindows:[W(d(0,9),d(3,9))], source:{name:'管理处',sourceTime:offsetISO(now)} });
  N({ topic:'venue', resourceId:'view', predicate:'open', title:'观景台开放',
      applicableWindows:[W(d(0,0),d(3,0))], source:{name:'管理处',sourceTime:offsetISO(now)} });
  N({ topic:'venue', resourceId:'view', predicate:'closed', title:'观景台临时关闭',
      applicableWindows:[W(d(1,13),d(1,17))], source:{name:'运维',sourceTime:offsetISO(now)} });

  addKeeper({ name:'老陈', lighthouse:'北礁', yearsOfService:'1952-1989',
    biography:'日志三册', verifiedAt: offsetISO(addDays(now,-10)) }, now);

  addRoute({ id:'r1', name:'经典线', reviewed:true, legs:[
    { id:'ferry', label:'渡轮', resourceTopic:'boat', resourceId:'ferry', start:'06:30', end:'08:00' },
    { id:'tide', label:'靠泊', resourceTopic:'tide', resourceId:'rock', start:'06:30', end:'07:30' },
    { id:'view', label:'观景台', resourceTopic:'venue', resourceId:'view', start:'10:00', end:'11:00' },
    { id:'tower', label:'登塔', resourceTopic:'venue', resourceId:'tower', start:'10:30', end:'12:00' },
    { id:'back', label:'返程', resourceTopic:'boat', resourceId:'ferry', start:'14:00', end:'15:30' },
  ]});
  addRoute({ id:'draft', name:'未审', reviewed:false, legs:[
    { id:'x', label:'x', resourceTopic:'boat', resourceId:'ferry', start:'06:30', end:'07:30' }] });

  for (let i=0;i<3;i++) precomputeDay(d(i), now);
  return { now, d };
}
