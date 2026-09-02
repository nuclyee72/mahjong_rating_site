from flask import Flask, Blueprint, request, jsonify, render_template, Response, redirect, url_for, session
from flask_cors import CORS
import sqlite3
from datetime import datetime
import os
import io
import csv
import json
import secrets
import importlib.util as _ilu
from functools import wraps
from PIL import Image, ImageOps

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# 외부(madang_web)에서 경로를 주입받을 수 있도록 모듈 레벨 변수로 분리
DB_PATH = os.path.join(BASE_DIR, "games.db")
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")

def get_config():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

CLUB_NAME = "<동아리명>"  # 동아리 이름 (변경 가능)

# 마작 포인트 계산용 설정은 config.json에서 관리합니다.

# 관리자 비밀번호. 외부(madang_web)에서 configure()로 주입되거나,
# 단독 실행 시 __main__ 블록에서 채워집니다.
ADMIN_PASSWORD = None


def configure(db_path=None, config_path=None, club_name=None, admin_password=None):
    """외부 프로젝트(madang_web 등)에서 DB/Config 경로, 동아리명, 관리자 비밀번호를 주입할 때 사용합니다."""
    global DB_PATH, CONFIG_PATH, CLUB_NAME, ADMIN_PASSWORD
    if db_path:
        DB_PATH = db_path
    if config_path:
        CONFIG_PATH = config_path
    if club_name:
        CLUB_NAME = club_name
    if admin_password:
        ADMIN_PASSWORD = admin_password


def require_admin_page(f):
    """세션에 로그인된 관리자만 통과. 브라우저로 직접 열람/제출하는 페이지·폼 라우트용
    (미인증 시 로그인 페이지로 리다이렉트)."""
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("is_admin"):
            return redirect(url_for("mahjong.admin_login", next=request.path))
        return f(*args, **kwargs)
    return wrapper


def require_admin_api(f):
    """세션에 로그인된 관리자만 통과. fetch()로 호출되는 JSON API 라우트용
    (미인증 시 401 JSON을 반환)."""
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("is_admin"):
            return jsonify({"error": "관리자 로그인이 필요합니다."}), 401
        return f(*args, **kwargs)
    return wrapper




def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()

    # 개인전 게임 기록 (4인 마작)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS games (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            player1_name TEXT NOT NULL,
            player2_name TEXT NOT NULL,
            player3_name TEXT NOT NULL,
            player4_name TEXT NOT NULL,
            player1_score INTEGER NOT NULL,
            player2_score INTEGER NOT NULL,
            player3_score INTEGER NOT NULL,
            player4_score INTEGER NOT NULL
        )
    """)

    # 대회전 게임 기록 (개인전과 동일 스키마)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS tournament_games (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            player1_name TEXT NOT NULL,
            player2_name TEXT NOT NULL,
            player3_name TEXT NOT NULL,
            player4_name TEXT NOT NULL,
            player1_score INTEGER NOT NULL,
            player2_score INTEGER NOT NULL,
            player3_score INTEGER NOT NULL,
            player4_score INTEGER NOT NULL
        )
    """)


    # 뱃지 정의
    conn.execute("""
        CREATE TABLE IF NOT EXISTS badges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code INTEGER UNIQUE NOT NULL,
            name TEXT NOT NULL,
            grade TEXT NOT NULL,
            description TEXT
        )
    """)

    # 플레이어별 뱃지 부여
    conn.execute("""
        CREATE TABLE IF NOT EXISTS player_badges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_name TEXT NOT NULL,
            badge_code INTEGER NOT NULL,
            granted_at TEXT NOT NULL
        )
    """)

    # 시즌 아카이브
    conn.execute("""
        CREATE TABLE IF NOT EXISTS archives (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS archive_games (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            archive_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            player1_name TEXT NOT NULL,
            player2_name TEXT NOT NULL,
            player3_name TEXT NOT NULL,
            player4_name TEXT NOT NULL,
            player1_score INTEGER NOT NULL,
            player2_score INTEGER NOT NULL,
            player3_score INTEGER NOT NULL,
            player4_score INTEGER NOT NULL
        )
    """)

    # 사이트 설정 (관리자 토글 등 key-value 저장)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    """)
    conn.commit()
    conn.close()


def get_setting(key, default=None):
    conn = get_db()
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    conn.close()
    return row["value"] if row else default


def set_setting(key, value):
    conn = get_db()
    conn.execute("""
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    """, (key, value))
    conn.commit()
    conn.close()


def is_tournament_visible():
    return get_setting("tournament_visible", "1") != "0"


app = Flask(__name__, static_folder="static", template_folder="templates")
# 한글 등 비아스키 문자 처리를 위해
app.config['JSON_AS_ASCII'] = False
# HTML 템플릿 자동 리로드 (파일 수정 시 서버 재시작 없이 반영)
app.config['TEMPLATES_AUTO_RELOAD'] = True

# 마작 레이팅 서브 앱 Blueprint
mahjong_bp = Blueprint('mahjong', __name__)

@app.context_processor
def inject_club_name():
    cfg = get_config()
    return dict(club_name=CLUB_NAME, config=cfg)

CORS(app)
# init_db()는 단독 실행 시 __main__ 블록에서, 외부 import 시 configure() 후 명시적으로 호출됩니다.

# 마작 포인트 계산용 상수 (Moved to top)


# ================== 개인전 API ==================

@mahjong_bp.route("/api/games", methods=["GET"])
def list_games():
    conn = get_db()
    cur = conn.execute("SELECT * FROM games ORDER BY id DESC")
    rows = cur.fetchall()
    conn.close()
    return jsonify([dict(row) for row in rows])


@mahjong_bp.route("/api/games", methods=["POST"])
def create_game():
    data = request.get_json() or {}

    required = [
        "player1_name", "player2_name", "player3_name", "player4_name",
        "player1_score", "player2_score", "player3_score", "player4_score",
    ]
    if not all(k in data for k in required):
        return jsonify({"error": "missing fields"}), 400

    p1 = str(data["player1_name"]).strip()
    p2 = str(data["player2_name"]).strip()
    p3 = str(data["player3_name"]).strip()
    p4 = str(data["player4_name"]).strip()
    if not (p1 and p2 and p3 and p4):
        return jsonify({"error": "all player names required"}), 400

    try:
        s1 = int(data["player1_score"])
        s2 = int(data["player2_score"])
        s3 = int(data["player3_score"])
        s4 = int(data["player4_score"])
    except (ValueError, TypeError):
        return jsonify({"error": "scores must be integers"}), 400

    # 네 명 점수 합 체크
    cfg = get_config()["MAHJONG_CONFIG"]
    target_sum = cfg["START_SCORE"] * 4
    if s1 + s2 + s3 + s4 != target_sum:
        return jsonify({"error": f"total score must be {target_sum}"}), 400

    created_at = datetime.now().isoformat(timespec="minutes")

    conn = get_db()
    cur = conn.execute("""
        INSERT INTO games (
            created_at,
            player1_name, player2_name, player3_name, player4_name,
            player1_score, player2_score, player3_score, player4_score
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (created_at, p1, p2, p3, p4, s1, s2, s3, s4))
    conn.commit()
    new_id = cur.lastrowid
    conn.close()

    return jsonify({"id": new_id}), 201


@mahjong_bp.route("/api/games/<int:game_id>", methods=["DELETE"])
def delete_game(game_id):
    conn = get_db()
    cur = conn.execute("DELETE FROM games WHERE id = ?", (game_id,))
    conn.commit()
    deleted = cur.rowcount
    conn.close()

    if deleted == 0:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True})


# ---- 개인전 CSV 내보내기 ----

@mahjong_bp.route("/export", methods=["GET"])
def export_games():
    conn = get_db()
    cur = conn.execute("""
        SELECT
            id, created_at,
            player1_name, player2_name, player3_name, player4_name,
            player1_score, player2_score, player3_score, player4_score
        FROM games
        ORDER BY id ASC
    """)
    rows = cur.fetchall()
    conn.close()

    def calc_pts(scores):
        cfg = get_config()["MAHJONG_CONFIG"]
        ret = cfg["RETURN_SCORE"]
        uma_vals = cfg["UMA"]
        oka = cfg["OKA_TO_1ST"]

        order = sorted(range(4), key=lambda i: scores[i], reverse=True)

        uma_for_player = [0, 0, 0, 0]
        for rank, idx in enumerate(order):
            uma_for_player[idx] = uma_vals[rank] + (oka if rank == 0 else 0)

        pts = []
        for i in range(4):
            base = (scores[i] - ret) / 1000.0
            pts.append(base + uma_for_player[i])
        return pts

    output = io.StringIO()
    writer = csv.writer(output)

    writer.writerow([
        "ID", "시간",
        "P1 이름", "P1 점수", "P1 pt",
        "P2 이름", "P2 점수", "P2 pt",
        "P3 이름", "P3 점수", "P3 pt",
        "P4 이름", "P4 점수", "P4 pt",
    ])

    for row in rows:
        s1 = row["player1_score"]
        s2 = row["player2_score"]
        s3 = row["player3_score"]
        s4 = row["player4_score"]
        scores = [s1, s2, s3, s4]
        pts = calc_pts(scores)

        writer.writerow([
            row["id"],
            row["created_at"],
            row["player1_name"], s1, f"{pts[0]:.1f}",
            row["player2_name"], s2, f"{pts[1]:.1f}",
            row["player3_name"], s3, f"{pts[2]:.1f}",
            row["player4_name"], s4, f"{pts[3]:.1f}",
        ])

    csv_data = output.getvalue()
    output.close()

    csv_bytes = csv_data.encode("utf-8-sig")

    return Response(
        csv_bytes,
        mimetype="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": "attachment; filename=mahjong_rating.csv"
        },
    )


# ---- 개인전 CSV 업로드 ----

@mahjong_bp.route("/import", methods=["GET", "POST"])
@require_admin_page
def import_games():
    if request.method == "GET":
        return f"""
        <!DOCTYPE html>
        <html lang="ko">
        <head>
          <meta charset="UTF-8">
          <title>개인전 CSV 업로드 - {CLUB_NAME} 마작 레이팅</title>
          <link rel="stylesheet" href="/static/style.css">
        </head>
        <body>
          <div class="top-bar">
            <h1>{CLUB_NAME} 개인전 CSV 업로드</h1>
            <div class="view-switch">
              <a href="/" class="view-switch-btn">메인으로 돌아가기</a>
            </div>
          </div>
          <div class="main-layout">
            <div class="left-panel">
              <section class="games-panel">
                <h2>개인전 CSV 업로드</h2>
                <p class="hint-text">
                  * /export 에서 받은 CSV나<br>
                  * ID / 시간 / P1 이름 / P1 점수 / ... 형식의 파일 모두 인식합니다.
                </p>
                <form method="post" enctype="multipart/form-data">
                  <p><input type="file" name="file" accept=".csv" required></p>
                  <p><button type="submit">업로드</button></p>
                </form>
              </section>
            </div>
          </div>
        </body>
        </html>
        """

    file = request.files.get("file")
    if not file:
        return "파일이 없습니다.", 400

    raw = file.read()
    text = None
    for enc in ("utf-8-sig", "utf-8", "cp949"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue

    if text is None:
        return "알 수 없는 인코딩입니다. UTF-8 또는 CP949로 저장해주세요.", 400

    import io as _io
    sample = "\n".join(text.splitlines()[:5])
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;")
    except Exception:
        dialect = csv.excel
        dialect.delimiter = ","

    reader = csv.DictReader(_io.StringIO(text), dialect=dialect)

    def pick(row, keys, default=""):
        for k in keys:
            if k in row and row[k] not in (None, ""):
                return row[k]
        return default

    def pick_int(row, keys, default=0):
        val = pick(row, keys, None)
        if val is None or val == "":
            return default
        try:
            return int(float(val))
        except (ValueError, TypeError):
            return default

    conn = get_db()
    inserted = 0

    for row in reader:
        created_at = pick(row, ["created_at", "시간"])
        if not created_at:
            created_at = datetime.now().isoformat(timespec="minutes")

        p1_name = pick(row, ["player1_name", "P1 이름", "P1이름"])
        p2_name = pick(row, ["player2_name", "P2 이름", "P2이름"])
        p3_name = pick(row, ["player3_name", "P3 이름", "P3이름"])
        p4_name = pick(row, ["player4_name", "P4 이름", "P4이름"])

        s1 = pick_int(row, ["player1_score", "P1 점수", "P1점수"])
        s2 = pick_int(row, ["player2_score", "P2 점수", "P2점수"])
        s3 = pick_int(row, ["player3_score", "P3 점수", "P3점수"])
        s4 = pick_int(row, ["player4_score", "P4 점수", "P4점수"])

        if not (p1_name or p2_name or p3_name or p4_name):
            continue

        conn.execute("""
            INSERT INTO games (
                created_at,
                player1_name, player2_name, player3_name, player4_name,
                player1_score, player2_score, player3_score, player4_score
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (created_at,
              p1_name, p2_name, p3_name, p4_name,
              s1, s2, s3, s4))
        inserted += 1

    conn.commit()
    conn.close()

    print(f"[IMPORT] inserted rows: {inserted}")
    return redirect(url_for("mahjong.index_page"))

@mahjong_bp.route("/api/tournament_games", methods=["GET"])
def list_tournament_games():
    conn = get_db()
    cur = conn.execute("SELECT * FROM tournament_games ORDER BY id DESC")
    rows = cur.fetchall()
    conn.close()
    return jsonify([dict(row) for row in rows])


@mahjong_bp.route("/api/tournament_games", methods=["POST"])
def create_tournament_game():
    data = request.get_json() or {}

    required = [
        "player1_name", "player2_name", "player3_name", "player4_name",
        "player1_score", "player2_score", "player3_score", "player4_score",
    ]
    if not all(k in data for k in required):
        return jsonify({"error": "missing fields"}), 400

    p1 = str(data["player1_name"]).strip()
    p2 = str(data["player2_name"]).strip()
    p3 = str(data["player3_name"]).strip()
    p4 = str(data["player4_name"]).strip()
    if not (p1 and p2 and p3 and p4):
        return jsonify({"error": "all player names required"}), 400

    try:
        s1 = int(data["player1_score"])
        s2 = int(data["player2_score"])
        s3 = int(data["player3_score"])
        s4 = int(data["player4_score"])
    except (ValueError, TypeError):
        return jsonify({"error": "scores must be integers"}), 400

    # ✅ 합 서버에서도 체크
    cfg = get_config()["MAHJONG_CONFIG"]
    target_sum = cfg["START_SCORE"] * 4
    if (s1 + s2 + s3 + s4) != target_sum:
        return jsonify({"error": f"total score must be {target_sum}"}), 400

    created_at = datetime.now().isoformat(timespec="minutes")

    conn = get_db()
    cur = conn.execute("""
        INSERT INTO tournament_games (
            created_at,
            player1_name, player2_name, player3_name, player4_name,
            player1_score, player2_score, player3_score, player4_score
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (created_at, p1, p2, p3, p4, s1, s2, s3, s4))
    conn.commit()
    new_id = cur.lastrowid
    conn.close()

    return jsonify({"id": new_id}), 201


@mahjong_bp.route("/api/tournament_games/<int:game_id>", methods=["DELETE"])
def delete_tournament_game(game_id):
    conn = get_db()
    cur = conn.execute("DELETE FROM tournament_games WHERE id = ?", (game_id,))
    conn.commit()
    deleted = cur.rowcount
    conn.close()
    if deleted == 0:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True})


# ================== 뱃지 / 관리자 API ==================

@mahjong_bp.route("/api/badges", methods=["GET", "POST"])
def badges_api():
    if request.method == "POST":
        if not session.get("is_admin"):
            return jsonify({"error": "관리자 로그인이 필요합니다."}), 401
        data = request.get_json() or {}
        try:
            code = int(data.get("code", 0))
        except (TypeError, ValueError):
            return jsonify({"error": "code must be integer"}), 400

        name = str(data.get("name", "")).strip()
        grade = str(data.get("grade", "")).strip()
        description = str(data.get("description", "")).strip()

        if not code or not name or not grade:
            return jsonify({"error": "code, name, grade required"}), 400

        conn = get_db()
        try:
            cur = conn.execute(
                "INSERT INTO badges (code, name, grade, description) VALUES (?, ?, ?, ?)",
                (code, name, grade, description),
            )
            conn.commit()
            new_id = cur.lastrowid
        except sqlite3.IntegrityError:
            conn.close()
            return jsonify({"error": "badge code already exists"}), 400
        conn.close()
        return jsonify({"id": new_id}), 201

    # GET
    conn = get_db()
    cur = conn.execute("""
        SELECT id, code, name, grade, description
        FROM badges
        ORDER BY code ASC
    """)
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return jsonify(rows)


@mahjong_bp.route("/api/badges/<int:badge_id>", methods=["DELETE"])
@require_admin_api
def delete_badge(badge_id):
    conn = get_db()
    cur = conn.execute("SELECT code FROM badges WHERE id = ?", (badge_id,))
    row = cur.fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "badge not found"}), 404

    code = row["code"]

    conn.execute("DELETE FROM player_badges WHERE badge_code = ?", (code,))
    cur = conn.execute("DELETE FROM badges WHERE id = ?", (badge_id,))
    conn.commit()
    deleted = cur.rowcount
    conn.close()

    if deleted == 0:
        return jsonify({"error": "badge not found"}), 404
    return jsonify({"ok": True})

@mahjong_bp.route("/api/player_badges", methods=["GET", "POST"])
def player_badges_api():
    if request.method == "GET":
        conn = get_db()
        cur = conn.execute("""
            SELECT
                pb.id,
                pb.player_name,
                pb.badge_code,
                pb.granted_at,
                b.name AS badge_name,
                b.grade AS badge_grade,
                b.description AS badge_description
            FROM player_badges pb
            LEFT JOIN badges b ON pb.badge_code = b.code
            ORDER BY pb.id DESC
        """)
        rows = cur.fetchall()
        conn.close()

        return jsonify([
            {
                "id": r["id"],
                "player_name": r["player_name"],
                "badge_code": r["badge_code"],
                "code": r["badge_code"],  # 프론트 편의용(옵션)
                "granted_at": r["granted_at"],
                "name": r["badge_name"] or "",
                "grade": r["badge_grade"] or "",
                "description": r["badge_description"] or "",
            }
            for r in rows
        ])

    # ===== POST (기존 assign_badge 내용 그대로) =====
    if not session.get("is_admin"):
        return jsonify({"error": "관리자 로그인이 필요합니다."}), 401
    data = request.get_json() or {}
    player_name = str(data.get("player_name", "")).strip()
    try:
        badge_code = int(data.get("badge_code", 0))
    except (TypeError, ValueError):
        return jsonify({"error": "badge_code must be integer"}), 400

    if not (player_name and badge_code):
        return jsonify({"error": "player_name and badge_code required"}), 400

    granted_at = datetime.now().isoformat(timespec="minutes")
    conn = get_db()

    cur = conn.execute("SELECT 1 FROM badges WHERE code = ?", (badge_code,))
    if not cur.fetchone():
        conn.close()
        return jsonify({"error": "badge not found"}), 400

    conn.execute("""
        INSERT INTO player_badges (player_name, badge_code, granted_at)
        VALUES (?, ?, ?)
    """, (player_name, badge_code, granted_at))
    conn.commit()
    conn.close()
    return jsonify({"ok": True}), 201



@mahjong_bp.route("/api/player_badges/by_player/<player_name>", methods=["GET"])
def list_player_badges(player_name):
    name = player_name.strip()
    conn = get_db()
    cur = conn.execute("""
        SELECT
            pb.id,
            pb.player_name,
            pb.badge_code AS code,
            pb.granted_at,
            b.name,
            b.grade,
            b.description
        FROM player_badges pb
        LEFT JOIN badges b ON pb.badge_code = b.code
        WHERE pb.player_name = ?
        ORDER BY pb.granted_at ASC, pb.id ASC
    """, (name,))
    rows = cur.fetchall()
    conn.close()

    result = []
    for r in rows:
        result.append({
            "id": r["id"],
            "player_name": r["player_name"],
            "code": r["code"],
            "name": r["name"] or "",
            "grade": r["grade"] or "",
            "description": r["description"] or "",
            "granted_at": r["granted_at"],
        })
    return jsonify(result)


@mahjong_bp.route("/api/player_badges/<int:assign_id>", methods=["DELETE"])
@require_admin_api
def delete_player_badge(assign_id):
    conn = get_db()
    cur = conn.execute("DELETE FROM player_badges WHERE id = ?", (assign_id,))
    conn.commit()
    deleted = cur.rowcount
    conn.close()
    if deleted == 0:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True})




# ================== 뱃지 CSV 내보내기/업로드 ==================

@mahjong_bp.route("/export_badges", methods=["GET"])
def export_badges():
    conn = get_db()
    cur = conn.execute("""
        SELECT code, name, grade, description
        FROM badges
        ORDER BY code ASC
    """)
    rows = cur.fetchall()
    conn.close()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["code", "name", "grade", "description"])

    for r in rows:
        writer.writerow([r["code"], r["name"], r["grade"], r["description"] or ""])

    csv_data = output.getvalue()
    output.close()
    csv_bytes = csv_data.encode("utf-8-sig")

    return Response(
        csv_bytes,
        mimetype="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=badges.csv"},
    )


@mahjong_bp.route("/import_badges", methods=["GET", "POST"])
@require_admin_page
def import_badges():
    if request.method == "GET":
        return f"""
        <!DOCTYPE html>
        <html lang="ko">
        <head>
          <meta charset="UTF-8">
          <title>뱃지 목록 CSV 업로드 - {CLUB_NAME} 마작 레이팅</title>
          <link rel="stylesheet" href="/static/style.css">
        </head>
        <body>
          <div class="top-bar">
            <h1>{CLUB_NAME} 뱃지 목록 CSV 업로드</h1>
            <div class="view-switch">
              <a href="/" class="view-switch-btn">메인으로 돌아가기</a>
            </div>
          </div>
          <div class="main-layout">
            <div class="left-panel">
              <section class="admin-panel">
                <h2>뱃지 목록 CSV 업로드</h2>
                <p class="hint-text">
                  * 헤더 예시: code,name,grade,description<br>
                  * code는 숫자(고유)입니다.
                </p>
                <form method="post" enctype="multipart/form-data">
                  <p><input type="file" name="file" accept=".csv" required></p>
                  <p><button type="submit">업로드</button></p>
                </form>
              </section>
            </div>
          </div>
        </body>
        </html>
        """

    file = request.files.get("file")
    if not file:
        return "파일이 없습니다.", 400

    raw = file.read()
    text = None
    for enc in ("utf-8-sig", "utf-8", "cp949"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        return "알 수 없는 인코딩입니다. UTF-8 또는 CP949로 저장해주세요.", 400

    import io as _io
    sample = "\n".join(text.splitlines()[:5])
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;")
    except Exception:
        dialect = csv.excel
        dialect.delimiter = ","

    reader = csv.DictReader(_io.StringIO(text), dialect=dialect)

    def pick(row, keys, default=""):
        for k in keys:
            if k in row and row[k] not in (None, ""):
                return row[k]
        return default

    conn = get_db()
    conn.execute("DELETE FROM badges")
    inserted = 0
    updated = 0

    for row in reader:
        try:
            code = int(float(pick(row, ["code", "코드"], "0")))
        except Exception:
            code = 0

        name = str(pick(row, ["name", "이름"], "")).strip()
        grade = str(pick(row, ["grade", "등급"], "")).strip()
        desc = str(pick(row, ["description", "설명"], "")).strip()

        if not code or not name or not grade:
            continue

        # code 기준 업서트(있으면 update, 없으면 insert)
        try:
            conn.execute(
                "INSERT INTO badges (code, name, grade, description) VALUES (?, ?, ?, ?)",
                (code, name, grade, desc),
            )
            inserted += 1
        except sqlite3.IntegrityError:
            conn.execute(
                "UPDATE badges SET name = ?, grade = ?, description = ? WHERE code = ?",
                (name, grade, desc, code),
            )
            updated += 1

    conn.commit()
    conn.close()

    print(f"[IMPORT_BADGES] inserted={inserted}, updated={updated}")
    return redirect(url_for("mahjong.index_page"))


# ================== 플레이어 뱃지 부여 CSV 내보내기/업로드 ==================

@mahjong_bp.route("/export_player_badges", methods=["GET"])
def export_player_badges():
    conn = get_db()
    cur = conn.execute("""
        SELECT player_name, badge_code, granted_at
        FROM player_badges
        ORDER BY id ASC
    """)
    rows = cur.fetchall()
    conn.close()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["player_name", "badge_code", "granted_at"])

    for r in rows:
        writer.writerow([
            r["player_name"],
            r["badge_code"],
            r["granted_at"],
        ])

    csv_data = output.getvalue()
    output.close()
    csv_bytes = csv_data.encode("utf-8-sig")

    return Response(
        csv_bytes,
        mimetype="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=player_badges.csv"},
    )


@mahjong_bp.route("/import_player_badges", methods=["GET", "POST"])
@require_admin_page
def import_player_badges():
    if request.method == "GET":
        return f"""
        <!DOCTYPE html>
        <html lang="ko">
        <head>
          <meta charset="UTF-8">
          <title>{CLUB_NAME} 플레이어 뱃지 부여 CSV 업로드</title>
          <link rel="stylesheet" href="/static/style.css">
        </head>
        <body>
          <div class="top-bar">
            <h1>{CLUB_NAME} 플레이어 뱃지 부여 CSV 업로드</h1>
            <div class="view-switch">
              <a href="/" class="view-switch-btn">메인으로 돌아가기</a>
            </div>
          </div>
          <div class="main-layout">
            <div class="left-panel">
              <section class="admin-panel">
                <h2>플레이어 뱃지 부여 CSV 업로드</h2>
                <p class="hint-text">
                  * 헤더 예시: player_name,badge_code,granted_at<br>
                  * granted_at이 비어있으면 업로드 시각으로 저장됩니다.
                </p>
                <form method="post" enctype="multipart/form-data">
                  <p><input type="file" name="file" accept=".csv" required></p>
                  <p><button type="submit">업로드</button></p>
                </form>
              </section>
            </div>
          </div>
        </body>
        </html>
        """

    file = request.files.get("file")
    if not file:
        return "파일이 없습니다.", 400

    raw = file.read()
    text = None
    for enc in ("utf-8-sig", "utf-8", "cp949"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        return "알 수 없는 인코딩입니다. UTF-8 또는 CP949로 저장해주세요.", 400

    import io as _io
    sample = "\n".join(text.splitlines()[:5])
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;")
    except Exception:
        dialect = csv.excel
        dialect.delimiter = ","

    reader = csv.DictReader(_io.StringIO(text), dialect=dialect)

    def pick(row, keys, default=""):
        for k in keys:
            if k in row and row[k] not in (None, ""):
                return row[k]
        return default

    conn = get_db()
    conn.execute("DELETE FROM player_badges")
    inserted = 0
    skipped = 0

    for row in reader:
        player_name = str(pick(row, ["player_name", "플레이어", "이름"], "")).strip()
        try:
            badge_code = int(float(pick(row, ["badge_code", "code", "뱃지코드", "뱃지 코드"], "0")))
        except Exception:
            badge_code = 0

        granted_at = str(pick(row, ["granted_at", "부여시각", "시간"], "")).strip()
        if not granted_at:
            granted_at = datetime.now().isoformat(timespec="minutes")

        if not player_name or not badge_code:
            skipped += 1
            continue

        # 중복 방지(완전 동일 row면 skip)
        cur = conn.execute("""
            SELECT 1 FROM player_badges
            WHERE player_name = ? AND badge_code = ? AND granted_at = ?
            LIMIT 1
        """, (player_name, badge_code, granted_at))
        if cur.fetchone():
            skipped += 1
            continue

        conn.execute("""
            INSERT INTO player_badges (player_name, badge_code, granted_at)
            VALUES (?, ?, ?)
        """, (player_name, badge_code, granted_at))
        inserted += 1

    conn.commit()
    conn.close()

    print(f"[IMPORT_PLAYER_BADGES] inserted={inserted}, skipped={skipped}")
    return redirect(url_for("mahjong.index_page"))


# ================== 아카이브 API ==================

@mahjong_bp.route("/api/archives", methods=["GET"])
def archives_api():
    conn = get_db()
    cur = conn.execute(
        """
        SELECT
            a.id,
            a.name,
            a.created_at,
            COUNT(ag.id) AS game_count
        FROM archives a
        LEFT JOIN archive_games ag ON ag.archive_id = a.id
        GROUP BY a.id, a.name, a.created_at
        ORDER BY a.id DESC
        """
    )
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return jsonify(rows)


@mahjong_bp.route("/api/archives/<int:archive_id>/games", methods=["GET"])
def archive_games_api(archive_id):
    conn = get_db()
    cur = conn.execute(
        """
        SELECT
            id,
            created_at,
            player1_name, player2_name, player3_name, player4_name,
            player1_score, player2_score, player3_score, player4_score
        FROM archive_games
        WHERE archive_id = ?
        ORDER BY id ASC
        """,
        (archive_id,),
    )
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return jsonify(rows)


@mahjong_bp.route("/api/archives/<int:archive_id>", methods=["DELETE"])
@require_admin_api
def delete_archive(archive_id):
    conn = get_db()
    conn.execute("DELETE FROM archive_games WHERE archive_id = ?", (archive_id,))
    cur = conn.execute("DELETE FROM archives WHERE id = ?", (archive_id,))
    conn.commit()
    deleted = cur.rowcount
    conn.close()
    if deleted == 0:
        return jsonify({"error": "archive not found"}), 404
    return jsonify({"ok": True})

@mahjong_bp.route("/admin/archive_import", methods=["POST"])
@require_admin_page
def admin_archive_import():
    archive_name = (request.form.get("archive_name") or "").strip()
    file = request.files.get("file")

    if not archive_name:
        return "아카이브 이름이 필요합니다.", 400
    if not file:
        return "CSV 파일이 필요합니다.", 400

    raw = file.read()
    text = None
    for enc in ("utf-8-sig", "utf-8", "cp949"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        return "알 수 없는 인코딩입니다. UTF-8 또는 CP949로 저장해주세요.", 400

    # CSV 파싱
    sample = "\n".join(text.splitlines()[:5])
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;")
    except Exception:
        dialect = csv.excel
        dialect.delimiter = ","

    reader = csv.DictReader(io.StringIO(text), dialect=dialect)

    def pick(row, keys, default=""):
        for k in keys:
            if k in row and row[k] not in (None, ""):
                return row[k]
        return default

    def pick_int(row, keys, default=0):
        val = pick(row, keys, None)
        if val is None or val == "":
            return default
        try:
            return int(float(val))
        except (ValueError, TypeError):
            return default

    conn = get_db()
    created_at = datetime.now().isoformat(timespec="minutes")

    # archives 테이블에 먼저 등록
    cur = conn.execute(
        "INSERT INTO archives (name, created_at) VALUES (?, ?)",
        (archive_name, created_at),
    )
    archive_id = cur.lastrowid

    inserted = 0
    for row in reader:
        # 시간
        game_time = pick(row, ["created_at", "시간"])
        if not game_time:
            game_time = created_at

        # 이름
        p1_name = pick(row, ["player1_name", "P1 이름", "P1이름"])
        p2_name = pick(row, ["player2_name", "P2 이름", "P2이름"])
        p3_name = pick(row, ["player3_name", "P3 이름", "P3이름"])
        p4_name = pick(row, ["player4_name", "P4 이름", "P4이름"])

        # 점수
        s1 = pick_int(row, ["player1_score", "P1 점수", "P1점수"])
        s2 = pick_int(row, ["player2_score", "P2 점수", "P2점수"])
        s3 = pick_int(row, ["player3_score", "P3 점수", "P3점수"])
        s4 = pick_int(row, ["player4_score", "P4 점수", "P4점수"])

        # 네 명 이름이 다 비어 있으면 스킵
        if not (p1_name or p2_name or p3_name or p4_name):
            continue

        conn.execute(
            """
            INSERT INTO archive_games (
                archive_id,
                created_at,
                player1_name, player2_name, player3_name, player4_name,
                player1_score, player2_score, player3_score, player4_score
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                archive_id,
                game_time,
                p1_name, p2_name, p3_name, p4_name,
                s1, s2, s3, s4,
            ),
        )
        inserted += 1

    if inserted == 0:
        # 유효 데이터가 하나도 없으면 아카이브도 되돌리기
        conn.execute("DELETE FROM archive_games WHERE archive_id = ?", (archive_id,))
        conn.execute("DELETE FROM archives WHERE id = ?", (archive_id,))
        conn.commit()
        conn.close()
        return "CSV에서 읽을 수 있는 대국 기록이 없습니다.", 400

    conn.commit()
    conn.close()

    # 다시 메인 화면으로
    return redirect(url_for("mahjong.index_page"))

# ---- 대회전 CSV 내보내기 ----

@mahjong_bp.route("/export_tournament", methods=["GET"])
def export_tournament_games():
    conn = get_db()
    cur = conn.execute("""
        SELECT
            id, created_at,
            player1_name, player2_name, player3_name, player4_name,
            player1_score, player2_score, player3_score, player4_score
        FROM tournament_games
        ORDER BY id ASC
    """)
    rows = cur.fetchall()
    conn.close()

    def calc_pts(scores):
        cfg = get_config()["MAHJONG_CONFIG"]
        ret = cfg["RETURN_SCORE"]
        uma_vals = cfg["UMA"]
        oka = cfg["OKA_TO_1ST"]

        order = sorted(range(4), key=lambda i: scores[i], reverse=True)

        uma_for_player = [0, 0, 0, 0]
        for rank, idx in enumerate(order):
            uma_for_player[idx] = uma_vals[rank] + (oka if rank == 0 else 0)

        pts = []
        for i in range(4):
            base = (scores[i] - ret) / 1000.0
            pts.append(base + uma_for_player[i])
        return pts

    output = io.StringIO()
    writer = csv.writer(output)

    writer.writerow([
        "ID", "시간",
        "P1 이름", "P1 점수", "P1 pt",
        "P2 이름", "P2 점수", "P2 pt",
        "P3 이름", "P3 점수", "P3 pt",
        "P4 이름", "P4 점수", "P4 pt",
    ])

    for row in rows:
        scores = [
            row["player1_score"],
            row["player2_score"],
            row["player3_score"],
            row["player4_score"],
        ]
        pts = calc_pts(scores)

        writer.writerow([
            row["id"],
            row["created_at"],
            row["player1_name"], scores[0], f"{pts[0]:.1f}",
            row["player2_name"], scores[1], f"{pts[1]:.1f}",
            row["player3_name"], scores[2], f"{pts[2]:.1f}",
            row["player4_name"], scores[3], f"{pts[3]:.1f}",
        ])

    csv_data = output.getvalue()
    output.close()

    csv_bytes = csv_data.encode("utf-8-sig")

    return Response(
        csv_bytes,
        mimetype="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": "attachment; filename=mahjong_tournament.csv"
        },
    )


# ---- 대회전 CSV 업로드 ----

@mahjong_bp.route("/import_tournament", methods=["GET", "POST"])
@require_admin_page
def import_tournament_games():
    if request.method == "GET":
        return f"""
        <!DOCTYPE html>
        <html lang="ko">
        <head>
          <meta charset="UTF-8">
          <title>{CLUB_NAME} 대회전 CSV 업로드</title>
          <link rel="stylesheet" href="/static/style.css">
        </head>
        <body>
          <div class="top-bar">
            <h1>{CLUB_NAME} 대회전 CSV 업로드</h1>
            <div class="view-switch">
              <a href="/" class="view-switch-btn">메인으로 돌아가기</a>
            </div>
          </div>
          <div class="main-layout">
            <div class="left-panel">
              <section class="games-panel">
                <h2>대회전 CSV 업로드</h2>
                <p class="hint-text">
                  * /export_tournament 에서 받은 CSV나<br>
                  * ID / 시간 / P1 이름 / P1 점수 / ... 형식의 파일 모두 인식합니다.
                </p>
                <form method="post" enctype="multipart/form-data">
                  <p><input type="file" name="file" accept=".csv" required></p>
                  <p><button type="submit">업로드</button></p>
                </form>
              </section>
            </div>
          </div>
        </body>
        </html>
        """

    file = request.files.get("file")
    if not file:
        return "파일이 없습니다.", 400

    raw = file.read()
    text = None
    for enc in ("utf-8-sig", "utf-8", "cp949"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue

    if text is None:
        return "알 수 없는 인코딩입니다. UTF-8 또는 CP949로 저장해주세요.", 400

    import io as _io
    sample = "\n".join(text.splitlines()[:5])
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;")
    except Exception:
        dialect = csv.excel
        dialect.delimiter = ","

    reader = csv.DictReader(_io.StringIO(text), dialect=dialect)

    def pick(row, keys, default=""):
        for k in keys:
            if k in row and row[k] not in (None, ""):
                return row[k]
        return default

    def pick_int(row, keys, default=0):
        val = pick(row, keys, None)
        if val is None or val == "":
            return default
        try:
            return int(float(val))
        except (ValueError, TypeError):
            return default

    conn = get_db()
    inserted = 0

    for row in reader:
        created_at = pick(row, ["created_at", "시간"])
        if not created_at:
            created_at = datetime.now().isoformat(timespec="minutes")

        p1_name = pick(row, ["player1_name", "P1 이름", "P1이름"])
        p2_name = pick(row, ["player2_name", "P2 이름", "P2이름"])
        p3_name = pick(row, ["player3_name", "P3 이름", "P3이름"])
        p4_name = pick(row, ["player4_name", "P4 이름", "P4이름"])

        s1 = pick_int(row, ["player1_score", "P1 점수", "P1점수"])
        s2 = pick_int(row, ["player2_score", "P2 점수", "P2점수"])
        s3 = pick_int(row, ["player3_score", "P3 점수", "P3점수"])
        s4 = pick_int(row, ["player4_score", "P4 점수", "P4점수"])

        if not (p1_name or p2_name or p3_name or p4_name):
            continue

        conn.execute("""
            INSERT INTO tournament_games (
                created_at,
                player1_name, player2_name, player3_name, player4_name,
                player1_score, player2_score, player3_score, player4_score
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (created_at,
              p1_name, p2_name, p3_name, p4_name,
              s1, s2, s3, s4))
        inserted += 1

    conn.commit()
    conn.close()

    print(f"[IMPORT_TOURNAMENT] inserted rows: {inserted}")
    return redirect(url_for("mahjong.index_page"))

# ================== 개인전 기록 초기화(시즌 리셋) ==================

@mahjong_bp.route("/api/admin/reset_games", methods=["POST"])
@require_admin_api
def reset_games():
    """
    모든 개인전 대국 기록을 삭제하고 ID도 다시 1부터 시작하도록 초기화합니다.
    (badges / player_badges / archive 등은 건드리지 않음)
    """
    conn = get_db()
    try:
        # games 테이블 전체 삭제
        conn.execute("DELETE FROM games")

        # SQLite AUTOINCREMENT 리셋 (선택사항이지만, 시즌별로 ID 깔끔하게 보이게 하려고)
        try:
            conn.execute("DELETE FROM sqlite_sequence WHERE name = 'games'")
        except Exception:
            # sqlite_sequence가 없는 경우도 있으니 무시
            pass

        conn.commit()
    finally:
        conn.close()

    return jsonify({"ok": True})

@mahjong_bp.route("/api/admin/reset_tournament", methods=["POST"])
@require_admin_api
def reset_tournament():
    """
    모든 대회 대국 기록을 삭제하고 ID도 다시 1부터 시작하도록 초기화합니다.
    (badges / player_badges / archive 등은 건드리지 않음)
    """
    conn = get_db()
    try:
        # tournament_games 테이블 전체 삭제
        conn.execute("DELETE FROM tournament_games")

        # SQLite AUTOINCREMENT 리셋
        try:
            conn.execute("DELETE FROM sqlite_sequence WHERE name = 'tournament_games'")
        except Exception:
            pass

        conn.commit()
    finally:
        conn.close()

    return jsonify({"ok": True})


# ================== 사이트 설정 (대회 창 표시 on/off 등) ==================

@mahjong_bp.route("/api/settings/tournament_visible", methods=["GET"])
def get_tournament_visible_setting():
    return jsonify({"visible": is_tournament_visible()})


@mahjong_bp.route("/api/settings/tournament_visible", methods=["POST"])
@require_admin_api
def set_tournament_visible_setting():
    data = request.get_json(silent=True) or {}
    visible = bool(data.get("visible"))
    set_setting("tournament_visible", "1" if visible else "0")
    return jsonify({"ok": True, "visible": visible})


# ================== 시즌 수상자 자동 계산 ==================
# 대국 기록 CSV를 업로드하면 시상별 수상자를 계산합니다.
# (마작대회, 역만의 증표 관련 시상은 수동 판정 대상이라 제외)

def _award_calc_pts(scores, cfg):
    """점수 4개로 각자의 pt를 계산 (게임당 소수 1자리 반올림 후 합산 — 실제 랭킹 화면과 동일한 방식)."""
    ret = cfg["RETURN_SCORE"]
    uma_vals = cfg["UMA"]
    oka = cfg["OKA_TO_1ST"]

    order = sorted(range(4), key=lambda i: scores[i], reverse=True)
    uma_for_player = [0, 0, 0, 0]
    for rank, idx in enumerate(order):
        uma_for_player[idx] = uma_vals[rank] + (oka if rank == 0 else 0)

    pts = []
    for i in range(4):
        base = (scores[i] - ret) / 1000.0
        pts.append(round(base + uma_for_player[i], 1))
    return pts


def _parse_games_csv_for_awards(raw_bytes):
    """대국 기록 CSV(원본 형식 또는 /export 형식 모두 지원)를 파싱합니다."""
    text = None
    for enc in ("utf-8-sig", "utf-8", "cp949"):
        try:
            text = raw_bytes.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        return None, "알 수 없는 인코딩입니다. UTF-8 또는 CP949로 저장해주세요."

    sample = "\n".join(text.splitlines()[:5])
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;")
    except Exception:
        dialect = csv.excel
        dialect.delimiter = ","

    reader = csv.DictReader(io.StringIO(text), dialect=dialect)

    def pick(row, keys, default=""):
        for k in keys:
            if k in row and row[k] not in (None, ""):
                return row[k]
        return default

    def pick_int(row, keys, default=0):
        val = pick(row, keys, None)
        if val is None or val == "":
            return default
        try:
            return int(float(val))
        except (ValueError, TypeError):
            return default

    games = []
    for row in reader:
        game_time = pick(row, ["created_at", "시간"])
        names = [
            str(pick(row, ["player1_name", "P1 이름", "P1이름"])).strip(),
            str(pick(row, ["player2_name", "P2 이름", "P2이름"])).strip(),
            str(pick(row, ["player3_name", "P3 이름", "P3이름"])).strip(),
            str(pick(row, ["player4_name", "P4 이름", "P4이름"])).strip(),
        ]
        if not any(names):
            continue
        scores = [
            pick_int(row, ["player1_score", "P1 점수", "P1점수"]),
            pick_int(row, ["player2_score", "P2 점수", "P2점수"]),
            pick_int(row, ["player3_score", "P3 점수", "P3점수"]),
            pick_int(row, ["player4_score", "P4 점수", "P4점수"]),
        ]
        games.append({"created_at": game_time or "", "names": names, "scores": scores})

    if not games:
        return None, "CSV에서 읽을 수 있는 대국 기록이 없습니다."
    return games, None


def _build_player_stats(games):
    """플레이어별 통계(총pt, 등수 분포, 토비, 최고점수, 폭주상용 pt 시퀀스, 사키행동상 등)를 계산합니다."""
    cfg = get_config()["MAHJONG_CONFIG"]
    raw = {}

    for g in sorted(games, key=lambda g: g["created_at"]):
        scores = g["scores"]
        names = g["names"]
        pts = _award_calc_pts(scores, cfg)

        order = sorted(range(4), key=lambda i: scores[i], reverse=True)
        ranks = [0, 0, 0, 0]
        for rank, idx in enumerate(order):
            ranks[idx] = rank + 1

        for i in range(4):
            name = names[i]
            if not name:
                continue
            st = raw.setdefault(name, {
                "games": 0, "total_pt": 0.0, "rank_counts": [0, 0, 0, 0],
                "tobi_count": 0, "max_score": None, "pt_seq": [],
                "near_start_count": 0,
            })
            st["games"] += 1
            st["total_pt"] += pts[i]
            st["rank_counts"][ranks[i] - 1] += 1
            if scores[i] < 0:
                st["tobi_count"] += 1
            if st["max_score"] is None or scores[i] > st["max_score"]:
                st["max_score"] = scores[i]
            st["pt_seq"].append(pts[i])
            if 24500 <= scores[i] <= 25500:
                st["near_start_count"] += 1

    stats = {}
    for name, st in raw.items():
        games_n = st["games"]
        rc = st["rank_counts"]

        # 폭주상: 연속된(시간순) 10국 pt 합의 최댓값
        seq = st["pt_seq"]
        burst_max10 = None
        if len(seq) >= 10:
            window = sum(seq[:10])
            burst_max10 = window
            for i in range(10, len(seq)):
                window += seq[i] - seq[i - 10]
                if window > burst_max10:
                    burst_max10 = window

        stats[name] = {
            "games": games_n,
            "total_pt": round(st["total_pt"], 1),
            "rank_counts": rc,
            "yonde_rate": round((rc[0] + rc[1]) * 100 / games_n, 1) if games_n else 0.0,
            "last_avoid_rate": round((games_n - rc[3]) * 100 / games_n, 1) if games_n else 0.0,
            "tobi_rate": round(st["tobi_count"] * 100 / games_n, 1) if games_n else 0.0,
            "tobi_count": st["tobi_count"],
            "max_score": st["max_score"],
            "burst_max10": round(burst_max10, 1) if burst_max10 is not None else None,
            "near_start_count": st["near_start_count"],
        }
    return stats


def _competition_rank_top_n(entries, n, reverse=True):
    """entries: [(name, value, games), ...]. 동점자는 같은 순위로 묶는 1224 방식 랭킹으로 상위 n위까지 반환."""
    ranked = sorted(entries, key=lambda e: e[1], reverse=reverse)
    result = []
    rank = 0
    prev_val = None
    for idx, e in enumerate(ranked):
        if prev_val is None or e[1] != prev_val:
            rank = idx + 1
            prev_val = e[1]
        if rank > n:
            break
        result.append((e[0], e[1], e[2], rank))
    return result


def _fmt_award_value(metric, value):
    if metric == "total_pt":
        return f"{value:.1f} pt"
    if metric == "games":
        return f"{value}판"
    if metric in ("yonde_rate", "last_avoid_rate", "tobi_rate"):
        return f"{value:.1f}%"
    if metric == "max_score":
        return f"{value:,}점"
    if metric == "burst_max10":
        return f"{value:.1f} pt (연속 10국)"
    if metric == "near_start_count":
        return f"{value}회"
    return str(value)


# 파트별로 묶고, 같은 파트 안에서는 높은 등급(위 tier)을 받으면 그 사람은
# 아래 tier 후보에서 빠지도록(상위 상 수상자는 하위 상 중복 수상 안 함) 순서대로 처리합니다.
# suffix/badge_name은 "시즌 결산" 기능에서 뱃지 코드(시즌 블록 + suffix)와
# 뱃지 이름(시즌 이름 + badge_name)을 자동 생성할 때 사용합니다.
AWARD_PARTS = [
    {
        "part_name": "총pt",
        "tiers": [
            {"name": "TOP 1",  "suffix": 1, "badge_name": "총pt TOP 1",  "metric": "total_pt", "n": 1,  "min_games": 20, "grade": "플래티넘", "reverse": True},
            {"name": "TOP 3",  "suffix": 2, "badge_name": "총pt TOP 3",  "metric": "total_pt", "n": 3,  "min_games": 20, "grade": "골드",     "reverse": True},
            {"name": "TOP 10", "suffix": 3, "badge_name": "총pt TOP 10", "metric": "total_pt", "n": 10, "min_games": 20, "grade": "실버",     "reverse": True},
            {"name": "TOP -1", "suffix": 5, "badge_name": "총pt TOP -1", "metric": "total_pt", "n": 1,  "min_games": 20, "grade": "브론즈",   "reverse": False},
        ],
    },
    {
        "part_name": "참가상",
        "tiers": [
            {"name": "참가상", "suffix": 4, "badge_name": "참가상", "metric": "games", "min_games": 4, "grade": "브론즈", "mode": "all"},
        ],
    },
    {
        "part_name": "총 판수",
        "tiers": [
            {"name": "TOP 1", "suffix": 6, "badge_name": "총 판수 TOP 1", "metric": "games", "n": 1, "min_games": 0, "grade": "플래티넘", "reverse": True},
            {"name": "TOP 3", "suffix": 7, "badge_name": "총 판수 TOP 3", "metric": "games", "n": 3, "min_games": 0, "grade": "골드",     "reverse": True},
            {"name": "TOP 5", "suffix": 8, "badge_name": "총 판수 TOP 5", "metric": "games", "n": 5, "min_games": 0, "grade": "실버",     "reverse": True},
        ],
    },
    {
        "part_name": "연대율",
        "tiers": [
            {"name": "TOP 1", "suffix": 11, "badge_name": "연대율 TOP 1", "metric": "yonde_rate", "n": 1, "min_games": 20, "grade": "플래티넘", "reverse": True},
            {"name": "TOP 3", "suffix": 12, "badge_name": "연대율 TOP 3", "metric": "yonde_rate", "n": 3, "min_games": 20, "grade": "골드",     "reverse": True},
            {"name": "TOP 5", "suffix": 13, "badge_name": "연대율 TOP 5", "metric": "yonde_rate", "n": 5, "min_games": 20, "grade": "실버",     "reverse": True},
        ],
    },
    {
        "part_name": "라스회피",
        "tiers": [
            {"name": "TOP 1", "suffix": 21, "badge_name": "라스회피 TOP 1", "metric": "last_avoid_rate", "n": 1, "min_games": 20, "grade": "플래티넘", "reverse": True},
            {"name": "TOP 3", "suffix": 22, "badge_name": "라스회피 TOP 3", "metric": "last_avoid_rate", "n": 3, "min_games": 20, "grade": "골드",     "reverse": True},
        ],
    },
    {
        "part_name": "최고점수",
        "tiers": [
            {"name": "TOP 1", "suffix": 31, "badge_name": "최고점수 TOP 1", "metric": "max_score", "n": 1, "min_games": 0, "grade": "플래티넘", "reverse": True},
            {"name": "TOP 3", "suffix": 32, "badge_name": "최고점수 TOP 3", "metric": "max_score", "n": 3, "min_games": 0, "grade": "골드",     "reverse": True},
        ],
    },
    {
        "part_name": "토비율",
        "tiers": [
            {"name": "TOP 1", "suffix": 51, "badge_name": "토비율 TOP 1", "metric": "tobi_rate", "n": 1, "min_games": 20, "grade": "브론즈", "reverse": True},
        ],
    },
    {
        "part_name": "폭주상",
        "tiers": [
            {"name": "TOP 1", "suffix": 81, "badge_name": "폭주상 TOP 1", "metric": "burst_max10", "n": 1, "min_games": 20, "grade": "플래티넘", "reverse": True},
            {"name": "TOP 3", "suffix": 82, "badge_name": "폭주상 TOP 3", "metric": "burst_max10", "n": 3, "min_games": 20, "grade": "골드",     "reverse": True},
        ],
    },
    {
        "part_name": "사키행동상",
        "tiers": [
            {"name": "사키행동상", "suffix": 91, "badge_name": "사키행동상", "metric": "near_start_count", "n": 1, "min_games": 0, "grade": "골드", "reverse": True},
        ],
    },
]

# 자동 계산 대상이 아니지만(수동 판정) 시즌 뱃지 세트를 만들 때 같이 생성해두는 뱃지들.
MANUAL_SEASON_BADGES = [
    {"suffix": 61, "badge_name": "역만의 증표", "grade": "플래티넘"},
]


def _compute_awards(games):
    stats = _build_player_stats(games)
    parts_result = []

    for part in AWARD_PARTS:
        excluded = set()
        rows = []

        for tier in part["tiers"]:
            metric = tier["metric"]
            min_games = tier["min_games"]
            entries = [
                (name, s[metric], s["games"])
                for name, s in stats.items()
                if s.get(metric) is not None and s["games"] >= min_games and name not in excluded
            ]

            if tier.get("mode") == "all":
                entries.sort(key=lambda e: (-e[2], e[0]))
                winners = [(e[0], e[1], e[2], None) for e in entries]
            else:
                winners = _competition_rank_top_n(entries, tier["n"], reverse=tier["reverse"])
                for w in winners:
                    excluded.add(w[0])

            if not winners:
                rows.append({
                    "grade": tier["grade"], "tier_name": tier["name"], "min_games": min_games,
                    "suffix": tier["suffix"], "badge_name": tier["badge_name"],
                    "rank": None, "name": None, "display": None, "games": None,
                })
            else:
                for w in winners:
                    rows.append({
                        "grade": tier["grade"], "tier_name": tier["name"], "min_games": min_games,
                        "suffix": tier["suffix"], "badge_name": tier["badge_name"],
                        "rank": w[3], "name": w[0], "display": _fmt_award_value(metric, w[1]), "games": w[2],
                    })

        parts_result.append({"part_name": part["part_name"], "rows": rows})

    return parts_result


@mahjong_bp.route("/api/admin/compute_awards", methods=["POST"])
@require_admin_api
def compute_awards_api():
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "파일이 없습니다."}), 400

    games, err = _parse_games_csv_for_awards(file.read())
    if err:
        return jsonify({"error": err}), 400

    parts = _compute_awards(games)
    return jsonify({"parts": parts, "game_count": len(games)})


# ================== 시즌 결산 (아카이브 + 뱃지 세트 + 자동 부여 일괄 처리) ==================

def _fetch_live_games_for_award_calc():
    conn = get_db()
    rows = conn.execute("""
        SELECT created_at, player1_name, player2_name, player3_name, player4_name,
               player1_score, player2_score, player3_score, player4_score
        FROM games ORDER BY id ASC
    """).fetchall()
    conn.close()
    return [
        {
            "created_at": r["created_at"] or "",
            "names": [r["player1_name"], r["player2_name"], r["player3_name"], r["player4_name"]],
            "scores": [r["player1_score"], r["player2_score"], r["player3_score"], r["player4_score"]],
        }
        for r in rows
    ]


def _existing_badge_blocks():
    """뱃지를 100 단위(시즌)로 묶어서 반환합니다."""
    conn = get_db()
    rows = conn.execute("SELECT code, name FROM badges ORDER BY code ASC").fetchall()
    conn.close()

    groups = {}
    for r in rows:
        block = (r["code"] // 100) * 100
        groups.setdefault(block, []).append(r["name"])

    return [
        {"block": block, "count": len(names), "sample_name": names[0] if names else ""}
        for block, names in sorted(groups.items())
    ]


def _next_season_block():
    conn = get_db()
    row = conn.execute("SELECT MAX(code) AS m FROM badges WHERE code >= 2000 AND code < 9000").fetchone()
    conn.close()
    max_code = row["m"] if row else None
    if max_code is None:
        return 2000
    return (max_code // 100) * 100 + 100


@mahjong_bp.route("/api/admin/season_badge_blocks", methods=["GET"])
@require_admin_api
def season_badge_blocks_api():
    return jsonify(_existing_badge_blocks())


@mahjong_bp.route("/api/admin/season_wrap/create_archive", methods=["POST"])
@require_admin_api
def season_wrap_create_archive():
    data = request.get_json(silent=True) or {}
    archive_name = str(data.get("archive_name", "")).strip()
    if not archive_name:
        return jsonify({"error": "아카이브 이름을 입력해주세요."}), 400

    conn = get_db()
    rows = conn.execute("""
        SELECT created_at, player1_name, player2_name, player3_name, player4_name,
               player1_score, player2_score, player3_score, player4_score
        FROM games ORDER BY id ASC
    """).fetchall()

    if not rows:
        conn.close()
        return jsonify({"error": "현재 개인전 기록이 없습니다."}), 400

    created_at = datetime.now().isoformat(timespec="minutes")
    cur = conn.execute("INSERT INTO archives (name, created_at) VALUES (?, ?)", (archive_name, created_at))
    archive_id = cur.lastrowid

    for r in rows:
        conn.execute("""
            INSERT INTO archive_games (
                archive_id, created_at,
                player1_name, player2_name, player3_name, player4_name,
                player1_score, player2_score, player3_score, player4_score
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            archive_id, r["created_at"],
            r["player1_name"], r["player2_name"], r["player3_name"], r["player4_name"],
            r["player1_score"], r["player2_score"], r["player3_score"], r["player4_score"],
        ))

    conn.commit()
    conn.close()

    return jsonify({
        "ok": True, "archive_id": archive_id, "archive_name": archive_name, "game_count": len(rows),
    })


@mahjong_bp.route("/api/admin/season_wrap/create_season_badges", methods=["POST"])
@require_admin_api
def season_wrap_create_badges():
    data = request.get_json(silent=True) or {}
    season_label = str(data.get("season_label", "")).strip()
    if not season_label:
        return jsonify({"error": "시즌 이름을 입력해주세요."}), 400

    block = _next_season_block()

    entries = []
    for part in AWARD_PARTS:
        for tier in part["tiers"]:
            entries.append((tier["suffix"], tier["badge_name"], tier["grade"]))
    for m in MANUAL_SEASON_BADGES:
        entries.append((m["suffix"], m["badge_name"], m["grade"]))

    conn = get_db()
    created = []
    for suffix, badge_name, grade in entries:
        code = block + suffix
        full_name = f"{season_label} {badge_name}"
        try:
            conn.execute(
                "INSERT INTO badges (code, name, grade, description) VALUES (?, ?, ?, ?)",
                (code, full_name, grade, ""),
            )
            created.append({"code": code, "name": full_name, "grade": grade})
        except sqlite3.IntegrityError:
            pass  # 이미 있으면 건너뜀

    conn.commit()
    conn.close()

    return jsonify({"ok": True, "block": block, "season_label": season_label, "created": created})


@mahjong_bp.route("/api/admin/season_wrap/grant_awards", methods=["POST"])
@require_admin_api
def season_wrap_grant_awards():
    data = request.get_json(silent=True) or {}
    try:
        block = int(data.get("block"))
    except (TypeError, ValueError):
        return jsonify({"error": "뱃지 블록을 선택해주세요."}), 400

    # 항상 현재(live) 개인전 기록 기준으로 계산합니다 (①에서 아카이브를 만들었는지 여부와 무관).
    games = _fetch_live_games_for_award_calc()
    if not games:
        return jsonify({"error": "계산할 대국 기록이 없습니다."}), 400

    parts = _compute_awards(games)

    conn = get_db()
    existing_codes = {r["code"] for r in conn.execute("SELECT code FROM badges").fetchall()}

    granted = 0
    duplicates = 0
    missing_badge = 0
    granted_at = datetime.now().isoformat(timespec="minutes")

    for part in parts:
        for row in part["rows"]:
            if row["name"] is None:
                continue
            code = block + row["suffix"]
            if code not in existing_codes:
                missing_badge += 1
                continue
            exists = conn.execute(
                "SELECT 1 FROM player_badges WHERE player_name = ? AND badge_code = ? LIMIT 1",
                (row["name"], code),
            ).fetchone()
            if exists:
                duplicates += 1
                continue
            conn.execute(
                "INSERT INTO player_badges (player_name, badge_code, granted_at) VALUES (?, ?, ?)",
                (row["name"], code, granted_at),
            )
            granted += 1

    conn.commit()
    conn.close()

    return jsonify({
        "ok": True, "block": block, "game_count": len(games),
        "granted": granted, "duplicates": duplicates, "missing_badge": missing_badge,
        "parts": parts,
    })


# ================== 기본 페이지 ==================

@mahjong_bp.route("/")
def index_page():
    return render_template(
        "index.html", club_name=CLUB_NAME,
        is_admin=bool(session.get("is_admin")),
        tournament_visible=is_tournament_visible(),
    )

@mahjong_bp.route("/admin")
@require_admin_page
def admin_page():
    return render_template(
        "index.html", club_name=CLUB_NAME,
        is_admin=True,
        tournament_visible=is_tournament_visible(),
    )


@mahjong_bp.route("/admin/login", methods=["GET", "POST"])
def admin_login():
    error = None
    next_url = request.args.get("next") or url_for("mahjong.admin_page")
    if request.method == "POST":
        pw = request.form.get("password", "")
        if ADMIN_PASSWORD and pw == ADMIN_PASSWORD:
            session["is_admin"] = True
            return redirect(request.form.get("next") or next_url)
        error = "비밀번호가 올바르지 않습니다."

    error_html = f'<p style="color:#c0392b;">{error}</p>' if error else ""
    return f"""
    <!DOCTYPE html>
    <html lang="ko">
    <head>
      <meta charset="UTF-8">
      <title>관리자 로그인 - {CLUB_NAME} 마작 레이팅</title>
      <link rel="stylesheet" href="/static/style.css">
    </head>
    <body>
      <div class="top-bar">
        <h1>{CLUB_NAME} 마작 레이팅 관리자 로그인</h1>
        <div class="view-switch">
          <a href="/" class="view-switch-btn">메인으로 돌아가기</a>
        </div>
      </div>
      <div class="main-layout">
        <div class="left-panel">
          <section class="games-panel">
            <h2>관리자 로그인</h2>
            {error_html}
            <form method="post">
              <input type="hidden" name="next" value="{next_url}">
              <p><input type="password" name="password" placeholder="관리자 비밀번호" required autofocus></p>
              <p><button type="submit">로그인</button></p>
            </form>
          </section>
        </div>
      </div>
    </body>
    </html>
    """


@mahjong_bp.route("/admin/logout", methods=["POST"])
def admin_logout():
    session.pop("is_admin", None)
    return redirect(url_for("mahjong.index_page"))


app.register_blueprint(mahjong_bp, url_prefix="/")

# ── 시즌 말 결산(Review) 서브모듈 로드 ──
# mahjong_rating_review가 submodule로 init된 경우에만 로드 (없으면 graceful skip)
review_module = None  # madang_web에서 mahjong_module.review_module로 접근가능
_review_app_path = os.path.join(BASE_DIR, "mahjong_rating_review", "app.py")
_review_spec = _ilu.spec_from_file_location("review_app", _review_app_path)
if _review_spec is not None and os.path.exists(_review_app_path):
    review_module = _ilu.module_from_spec(_review_spec)
    _review_spec.loader.exec_module(review_module)
    review_module.configure(
        db_path=DB_PATH,
        config_path=CONFIG_PATH,
        club_name=CLUB_NAME,
    )
    app.register_blueprint(review_module.review_bp, url_prefix="/review")
    print("[INFO] mahjong_rating_review submodule loaded → /review")
else:
    print("[WARN] mahjong_rating_review submodule not found, skipping /review")

def _get_or_create_secret(path, label):
    """secret 파일이 있으면 읽고, 없으면 새로 생성해서 저장합니다 (instance/ 는 git에 커밋되지 않음)."""
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            value = f.read().strip()
        if value:
            return value
    os.makedirs(os.path.dirname(path), exist_ok=True)
    value = secrets.token_urlsafe(16)
    with open(path, "w", encoding="utf-8") as f:
        f.write(value)
    print(f"[INFO] {label}이(가) 없어 새로 생성했습니다 → {path}")
    print(f"[INFO] {label}: {value}")
    return value


if __name__ == "__main__":
    # 단독 실행(madang_web 없이) 시에는 configure()가 호출되지 않으므로
    # 세션 secret key와 관리자 비밀번호를 직접 준비합니다.
    _instance_dir = os.path.join(BASE_DIR, "instance")
    app.secret_key = os.environ.get("FLASK_SECRET_KEY") or _get_or_create_secret(
        os.path.join(_instance_dir, "flask_secret.key"), "Flask SECRET_KEY"
    )
    if not ADMIN_PASSWORD:
        ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD") or _get_or_create_secret(
            os.path.join(_instance_dir, "admin_password.txt"), "관리자 비밀번호"
        )

    init_db()  # 단독 실행 시 항상 DB 초기화 (CREATE TABLE IF NOT EXISTS이므로 안전)
    app.run(host="0.0.0.0", port=5000, debug=True)
