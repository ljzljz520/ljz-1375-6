"""Flask API:管理端导入经确认公告;公共端查询历史/船班/登岛窗口/路线/计划/离线包。"""
import json
import time

from flask import Flask, g, jsonify, request, send_from_directory

from . import logic
from .db import connect, init_db


def create_app(db_path="lighthouse.db"):
    app = Flask(__name__, static_folder="static", static_url_path="/static")
    app.config["DB_PATH"] = db_path

    @app.before_request
    def _open():
        g.db = connect(app.config["DB_PATH"])

    @app.teardown_request
    def _close(exc):
        db = g.pop("db", None)
        if db is not None:
            db.close()

    # ---------- 页面 ----------
    @app.get("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    @app.get("/plan")
    def plan_page():
        return send_from_directory(app.static_folder, "plan.html")

    @app.get("/print/<int:plan_id>")
    def print_page(plan_id):
        return send_from_directory(app.static_folder, "print.html")

    # ---------- 管理端 ----------
    @app.post("/api/admin/announcements")
    def import_announcement():
        try:
            summary = logic.import_announcement(g.db, request.get_json(force=True))
            return jsonify(summary), (200 if summary["imported"] else 409 if summary.get("duplicate") is False else 200)
        except (ValueError, KeyError) as e:
            return jsonify({"error": str(e)}), 400

    @app.get("/api/admin/announcements")
    def list_announcements():
        rows = g.db.execute(
            "SELECT id,source,source_time,generation,kind,status,imported_at FROM announcement ORDER BY id DESC"
        ).fetchall()
        out = []
        for r in rows:
            scope = [dict(s) for s in g.db.execute(
                "SELECT valid_from,valid_to FROM announcement_scope WHERE announcement_id=?", (r["id"],))]
            out.append({**dict(r), "scope": scope})
        return jsonify(out)

    # ---------- 公共端 ----------
    @app.get("/api/time")
    def server_time():
        client = request.headers.get("X-Client-Clock")
        skew = None
        if client:
            try:
                skew = (logic.parse(client) - logic.now_utc()).total_seconds()
            except ValueError:
                pass
        return jsonify({"server_time": logic.iso(logic.now_utc()),
                        "client_clock": client, "clock_skew_seconds": skew,
                        "note": "页面一切有效期/核对时间判断以服务器时间为准"})

    @app.get("/api/history")
    def history():
        lh = [dict(r) for r in g.db.execute("SELECT * FROM lighthouse").fetchall()]
        keepers = [dict(r) for r in g.db.execute("SELECT * FROM keeper ORDER BY tenure_from").fetchall()]
        return jsonify({"lighthouse": lh, "keepers": keepers,
                        "note": "历史与守塔人资料为静态史料,不随船班取消等业务变动而失效"})

    @app.get("/api/ships")
    def ships():
        date = request.args.get("date")
        ds, de = logic.day_bounds(date)
        rows = g.db.execute(
            "SELECT * FROM ship_segment WHERE depart_at < ? AND arrive_at > ? ORDER BY depart_at",
            (logic.iso(de), logic.iso(ds))).fetchall()
        act = logic._active_rows(rows)
        return jsonify({"date": date, "server_time": logic.iso(logic.now_utc()),
                        "ships": [dict(r) for r in sorted(act, key=lambda r: r["depart_at"])]})

    @app.get("/api/conditions")
    def conditions():
        return jsonify(logic.compute_landing(g.db, request.args.get("date")))

    @app.get("/api/landing")
    def landing():
        date = request.args.get("date")
        mode = request.args.get("mode", "realtime")
        if mode == "precomputed":
            pre = logic.read_precomputed(g.db, date)
            if pre is None:
                return jsonify({"error": "该日期无预计算结果", "date": date}), 404
            pre["mode"] = "precomputed"
            pre["server_time"] = logic.iso(logic.now_utc())
            return jsonify(pre)
        if mode == "compare":
            t0 = time.perf_counter()
            rt = logic.compute_landing(g.db, date)
            t_rt = (time.perf_counter() - t0) * 1000
            t0 = time.perf_counter()
            pre = logic.read_precomputed(g.db, date)
            t_pre = (time.perf_counter() - t0) * 1000
            return jsonify({
                "date": date, "realtime": rt, "precomputed": pre,
                "latency_ms": {"realtime": round(t_rt, 3), "precomputed_read": round(t_pre, 3)},
                "consistent": (pre is not None and not pre["stale"]
                               and pre["verdict"] == rt["verdict"] and pre["windows"] == rt["windows"]),
                "tradeoff": "预计算:查询延迟低,但公告高频时缓存频繁失效;实时组合:始终最新,代价是每次多表查询+区间求交",
                "server_time": logic.iso(logic.now_utc())})
        return jsonify(logic.compute_landing(g.db, date))

    @app.post("/api/admin/precompute")
    def precompute():
        date = request.get_json(force=True)["date"]
        logic.recompute_daily_plan(g.db, date)
        return jsonify({"date": date, "precomputed": True})

    @app.get("/api/routes")
    def routes():
        out = []
        for r in g.db.execute("SELECT * FROM route WHERE status='approved'").fetchall():
            segs = [dict(s) for s in g.db.execute(
                "SELECT * FROM route_segment WHERE route_id=? ORDER BY seq", (r["id"],))]
            out.append({**dict(r), "segments": segs})
        return jsonify(out)

    @app.post("/api/routes/check")
    def route_check():
        body = request.get_json(force=True)
        try:
            return jsonify(logic.check_route(g.db, int(body["route_id"]), body["date"]))
        except KeyError as e:
            return jsonify({"error": str(e)}), 404

    # ---------- 收藏计划 ----------
    @app.post("/api/plans")
    def create_plan():
        body = request.get_json(force=True)
        snap = logic.take_snapshot(g.db, int(body["route_id"]), body["date"])
        cur = g.db.execute(
            "INSERT INTO plan(user_name,route_id,target_date,snapshot_json,created_at) VALUES(?,?,?,?,?)",
            (body["user"], int(body["route_id"]), body["date"],
             json.dumps(snap, ensure_ascii=False), logic.iso(logic.now_utc())))
        g.db.commit()
        return jsonify({"id": cur.lastrowid, "snapshot": snap}), 201

    @app.get("/api/plans")
    def list_plans():
        user = request.args.get("user", "")
        rows = g.db.execute("SELECT * FROM plan WHERE user_name=? ORDER BY id", (user,)).fetchall()
        return jsonify([{**dict(r), "snapshot": json.loads(r["snapshot_json"])} for r in rows])

    @app.get("/api/plans/<int:plan_id>/reconnect")
    def reconnect(plan_id):
        row = g.db.execute("SELECT * FROM plan WHERE id=?", (plan_id,)).fetchone()
        if not row:
            return jsonify({"error": "计划不存在"}), 404
        before = json.loads(row["snapshot_json"])
        after = logic.take_snapshot(g.db, row["route_id"], row["target_date"])
        return jsonify({"plan_id": plan_id, "user": row["user_name"],
                        "before": before, "after": after,
                        "changes": logic.diff_snapshots(before, after),
                        "server_time": logic.iso(logic.now_utc())})

    # ---------- 离线包 ----------
    @app.post("/api/offline")
    def make_offline():
        body = request.get_json(force=True)
        return jsonify(logic.make_offline_package(
            g.db, body["user"], body["date"], int(body.get("ttl_hours", 12)))), 201

    @app.get("/api/offline/<int:pkg_id>/status")
    def offline_status(pkg_id):
        try:
            return jsonify(logic.offline_status(g.db, pkg_id, request.headers.get("X-Client-Clock")))
        except KeyError as e:
            return jsonify({"error": str(e)}), 404

    # ---------- 打印页数据 ----------
    @app.get("/api/print/<int:plan_id>")
    def print_data(plan_id):
        row = g.db.execute("SELECT * FROM plan WHERE id=?", (plan_id,)).fetchone()
        if not row:
            return jsonify({"error": "计划不存在"}), 404
        before = json.loads(row["snapshot_json"])
        now = logic.take_snapshot(g.db, row["route_id"], row["target_date"])
        landing = now["landing"]
        validity = [{"condition": logic.CONDITION_LABELS[k],
                     "last_verified_at": c["last_verified_at"], "generation": c["generation"]}
                    for k, c in landing["conditions"].items()]
        return jsonify({
            "plan": {"id": plan_id, "user": row["user_name"], "route_id": row["route_id"],
                     "target_date": row["target_date"], "created_at": row["created_at"]},
            "snapshot_at_save": before, "current": now,
            "changes_since_save": logic.diff_snapshots(before, now),
            "validity": validity, "undetermined": landing["undetermined"],
            "disclaimer": logic.DISCLAIMER,
            "offline_note": "任何旧离线包均不得描述为现场安全或交通保证;以现场公告为准。",
            "server_time": logic.iso(logic.now_utc())})

    return app


if __name__ == "__main__":
    import sys
    db = sys.argv[1] if len(sys.argv) > 1 else "lighthouse.db"
    conn = connect(db)
    init_db(conn)
    conn.close()
    create_app(db).run(host="0.0.0.0", port=5000, debug=False)
