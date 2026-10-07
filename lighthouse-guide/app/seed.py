"""种子数据:灯塔历史、守塔人、已审路线,以及 2026-10-08 的初始公告。"""
from .db import connect, init_db
from . import logic

D = "2026-10-08"

def seed(path="lighthouse.db"):
    conn = connect(path)
    init_db(conn)
    # 历史与守塔人(静态史料)
    conn.execute("DELETE FROM lighthouse"); conn.execute("DELETE FROM keeper")
    conn.execute("INSERT INTO lighthouse(name,built_year,history) VALUES(?,?,?)",
                 ("孤岛灯塔", 1873,
                  "1873 年由海关营造司始建,花岗岩塔身,海拔 78 米,射程 22 海里。"
                  "历经 1937 年战火损毁、1954 年重建,1998 年改为太阳能供电,2013 年列入文物保护单位。"))
    for k in [("陈守礁", "1902", "1931", "守塔 29 年,手写日记记录 400 余次风暴,1911 年台风夜徒手修复灯器。"),
              ("林晚灯", "1931", "1958", "首位女守塔人,建立潮汐观测簿,岛上人称'灯姐'。"),
              ("周望", "1958", "1986", "参与灯塔电气化改造,退休后将守塔日志捐赠海事博物馆。")]:
        conn.execute("INSERT INTO keeper(name,tenure_from,tenure_to,story) VALUES(?,?,?,?)", k)
    conn.commit()

    anns = [
        # 船班:两去两回
        {"source": "海事局客运调度", "source_time": "2026-10-06T09:00:00+08:00", "generation": 1,
         "kind": "ship", "scope": [{"valid_from": D, "valid_to": D}],
         "payload": {"items": [
             {"notify_key": "FERRY-1008-OUT1", "route_code": "HD-101", "direction": "out",
              "depart_port": "石浦港", "arrive_port": "灯塔岛码头",
              "depart_at": f"{D}T08:30:00+08:00", "arrive_at": f"{D}T09:15:00+08:00", "status": "scheduled"},
             {"notify_key": "FERRY-1008-OUT2", "route_code": "HD-103", "direction": "out",
              "depart_port": "石浦港", "arrive_port": "灯塔岛码头",
              "depart_at": f"{D}T13:00:00+08:00", "arrive_at": f"{D}T13:45:00+08:00", "status": "scheduled"},
             {"notify_key": "FERRY-1008-RET1", "route_code": "HD-102", "direction": "return",
              "depart_port": "灯塔岛码头", "arrive_port": "石浦港",
              "depart_at": f"{D}T11:00:00+08:00", "arrive_at": f"{D}T11:45:00+08:00", "status": "scheduled"},
             {"notify_key": "FERRY-1008-RET2", "route_code": "HD-104", "direction": "return",
              "depart_port": "灯塔岛码头", "arrive_port": "石浦港",
              "depart_at": f"{D}T16:30:00+08:00", "arrive_at": f"{D}T17:15:00+08:00", "status": "scheduled"}]}},
        # 天气
        {"source": "县气象站", "source_time": "2026-10-06T10:00:00+08:00", "generation": 1,
         "kind": "weather", "scope": [{"valid_from": D, "valid_to": D}],
         "payload": {"items": [
             {"area": "灯塔岛海域", "start_at": f"{D}T06:00:00+08:00", "end_at": f"{D}T20:00:00+08:00",
              "status": "ok", "summary": "多云,东北风 3 级,浪高 0.8 米"}]}},
        # 潮汐(两段有利窗口)
        {"source": "海洋预报台", "source_time": "2026-10-06T11:00:00+08:00", "generation": 1,
         "kind": "tide", "scope": [{"valid_from": D, "valid_to": D}],
         "payload": {"items": [
             {"station": "灯塔岛验潮站", "start_at": f"{D}T08:00:00+08:00", "end_at": f"{D}T12:00:00+08:00",
              "status": "ok", "level": "平潮期,适合靠泊"},
             {"station": "灯塔岛验潮站", "start_at": f"{D}T13:30:00+08:00", "end_at": f"{D}T17:00:00+08:00",
              "status": "ok", "level": "平潮期,适合靠泊"}]}},
        # 场所开放
        {"source": "景区管理处", "source_time": "2026-10-06T12:00:00+08:00", "generation": 1,
         "kind": "venue", "scope": [{"valid_from": D, "valid_to": D}],
         "payload": {"items": [
             {"venue": "登岛码头", "start_at": f"{D}T07:00:00+08:00", "end_at": f"{D}T19:00:00+08:00", "status": "open"},
             {"venue": "灯塔观景台", "start_at": f"{D}T08:00:00+08:00", "end_at": f"{D}T18:00:00+08:00", "status": "open"},
             {"venue": "灯塔展厅", "start_at": f"{D}T09:00:00+08:00", "end_at": f"{D}T17:00:00+08:00", "status": "open"}]}},
    ]
    for a in anns:
        logic.import_announcement(conn, a)

    # 已审路线:去程 HD-101 -> 观景台 -> 展厅 -> 返程 HD-102
    conn.execute("DELETE FROM route_segment"); conn.execute("DELETE FROM route")
    cur = conn.execute("INSERT INTO route(name,status) VALUES('灯塔半日环线(已审)','approved')")
    rid = cur.lastrowid
    # 路线航段按航次键引用船班(公告代次更新、行被取代后引用仍指向同一航次)
    segs = [(1, "ship", "FERRY-1008-OUT1", None, None, "乘 HD-101 前往灯塔岛"),
            (2, "visit", "灯塔观景台", f"{D}T09:30:00+08:00", f"{D}T10:10:00+08:00", "观景台观海"),
            (3, "visit", "灯塔展厅", f"{D}T10:10:00+08:00", f"{D}T10:40:00+08:00", "参观灯塔展厅"),
            (4, "ship", "FERRY-1008-RET1", None, None, "乘 HD-102 返回石浦港")]
    for s in segs:
        conn.execute("INSERT INTO route_segment(route_id,seq,kind,ref,planned_start,planned_end,label)"
                     " VALUES(?,?,?,?,?,?,?)", (rid, *s))
    conn.commit()
    # 后台预计算当日计划
    logic.recompute_daily_plan(conn, D)
    conn.close()
    print(f"seeded {path}, route_id={rid}")

if __name__ == "__main__":
    import sys
    seed(sys.argv[1] if len(sys.argv) > 1 else "lighthouse.db")
