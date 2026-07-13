#!/usr/bin/env python3
"""fetch_course_inventory.py — pull the Registrar's "Course Inventory" Tableau
view into the tracker DB as an authoritative course catalog (credit hours,
active/inactive status, owning college, repeat limit, level) for the Registrar
pre-check's data rules.

Why: the `courses` table only holds courses that themselves went through CIM
workflow, so it can't answer "what are this course's approved credits / is it
still active / who owns it". Course Inventory is the full Banner course catalog
(~22k courses), and ~98% of program-listed course codes match it.

Mechanism: Tableau REST, same PAT pattern as the Section Tracker. The view
exports fully via the plain view-data endpoint (no custom view needed):

    /api/{ver}/sites/{site}/views/{view_id}/data   ->  CSV

The catalog is versioned (many rows per course over time); we keep each course's
LATEST version (by Eff Term Code), which carries its current status + credits.

Credentials: reuses the Section Tracker's gitignored data/tableau_pat.json (per
Waleed), falling back to this project's data/tableau_pat.json if present.
"""
import os
import re
import csv
import io
import json
import time
import sqlite3
import urllib.request
import urllib.error
import urllib.parse

_DIR = os.path.dirname(os.path.abspath(__file__))
_DB = os.path.join(_DIR, 'data', 'tracker.db')

# Reuse the Section Tracker's PAT (Waleed's choice); fall back to a local copy.
_PAT_CANDIDATES = [
    os.path.expanduser('~/committees/nu-docs/Curriculum/SectionTracker/data/tableau_pat.json'),
    os.path.join(_DIR, 'data', 'tableau_pat.json'),
]

TABLEAU_HOST = 'https://tableau.northeastern.edu'
SITE_NAME = 'Registrar'
API_VERSION = '3.24'
WORKBOOK = 'Course Inventory'
VIEW_NAME = 'Course Inventory Part 1'


def _pat_path():
    for p in _PAT_CANDIDATES:
        if os.path.exists(p):
            return p
    raise RuntimeError('No tableau_pat.json found (looked in SectionTracker + local data/)')


def _http(method, url, headers=None, body=None, timeout=300):
    req = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _signin():
    with open(_pat_path()) as f:
        creds = json.load(f)
    body = json.dumps({'credentials': {
        'personalAccessTokenName': creds['token_name'],
        'personalAccessTokenSecret': creds['token_secret'],
        'site': {'contentUrl': SITE_NAME},
    }}).encode()
    status, raw = _http('POST', f'{TABLEAU_HOST}/api/{API_VERSION}/auth/signin',
                        {'Content-Type': 'application/json', 'Accept': 'application/json'}, body)
    if status != 200:
        raise RuntimeError(f'Tableau signin failed: HTTP {status}: {raw[:200]}')
    d = json.loads(raw)
    return d['credentials']['token'], d['credentials']['site']['id']


def _signout(token):
    try:
        _http('POST', f'{TABLEAU_HOST}/api/{API_VERSION}/auth/signout',
              {'X-Tableau-Auth': token}, timeout=20)
    except Exception:
        pass


def _find_view_id(token, site_id):
    url = (f'{TABLEAU_HOST}/api/{API_VERSION}/sites/{site_id}/views'
           f'?filter=workbookName:eq:{urllib.parse.quote(WORKBOOK)}')
    status, raw = _http('GET', url, {'X-Tableau-Auth': token, 'Accept': 'application/json'})
    if status != 200:
        raise RuntimeError(f'list views HTTP {status}: {raw[:200]}')
    views = json.loads(raw).get('views', {}).get('view', [])
    for v in views:
        if (v.get('name') or '').strip().lower() == VIEW_NAME.lower():
            return v['id']
    if views:
        return views[0]['id']
    raise RuntimeError(f'No views found in workbook {WORKBOOK!r}')


def _download_csv(token, site_id, view_id):
    url = f'{TABLEAU_HOST}/api/{API_VERSION}/sites/{site_id}/views/{view_id}/data?maxAge=1'
    status, raw = _http('GET', url, {'X-Tableau-Auth': token, 'Accept': '*/*'})
    if status != 200:
        raise RuntimeError(f'view data HTTP {status}: {raw[:200]}')
    return raw.decode('utf-8-sig', errors='replace')


def _norm_code(c):
    return re.sub(r'\s+', ' ', (c or '').strip()).upper()


def _credit_num(raw):
    """Single numeric credit value, or None for ranges ('1 to 4') / blanks."""
    s = (raw or '').strip()
    if re.fullmatch(r'\d+(\.\d+)?', s):
        return float(s)
    return None


def _ensure_table(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS course_inventory (
        code TEXT PRIMARY KEY,
        title TEXT, credit_hours TEXT, credit_num REAL,
        college TEXT, subject_code TEXT, status TEXT, level TEXT,
        repeat_max TEXT, eff_term_code TEXT, inactive_as_of TEXT, fetched_at TEXT)""")


def parse_inventory(csv_text):
    """CSV text -> {norm_code: latest-version row-dict + '_inactive_as_of'}.

    The catalog is versioned by Eff Term Code and deactivations are FUTURE-DATED
    (a course stays Active through term N and flips to Inactive as of term N+1).
    So we keep the latest version's fields AND compute `_inactive_as_of`: the
    effective term at which the course's FINAL, still-current Inactive run begins
    (None if the latest version is Active). A course is "inactive as of term T"
    iff `_inactive_as_of` is set and T >= it.
    """
    rd = csv.DictReader(io.StringIO(csv_text))
    rd.fieldnames = [f.strip() for f in (rd.fieldnames or [])]  # 'Status ' has a trailing space
    versions = {}
    for r in rd:
        code = _norm_code(r.get('Course ID'))
        if not code:
            continue
        versions.setdefault(code, []).append(
            ((r.get('Eff Term Code') or '').strip() or '0', r))
    out = {}
    for code, vs in versions.items():
        vs.sort(key=lambda t: t[0])
        latest = vs[-1][1]
        inactive_as_of = None
        if (latest.get('Status') or '').strip() == 'Inactive':
            # Walk back while the run stays Inactive; the run's first term is the
            # deactivation term.
            start = vs[-1][0]
            for et, rr in reversed(vs):
                if (rr.get('Status') or '').strip() == 'Inactive':
                    start = et
                else:
                    break
            inactive_as_of = start
        latest = dict(latest)
        latest['_inactive_as_of'] = inactive_as_of
        out[code] = latest
    return out


def fetch_course_inventory():
    """Pull + upsert the catalog. Returns the number of courses stored."""
    token, site_id = _signin()
    try:
        vid = _find_view_id(token, site_id)
        csv_text = _download_csv(token, site_id, vid)
    finally:
        _signout(token)
    catalog = parse_inventory(csv_text)
    now = time.strftime('%Y-%m-%dT%H:%M:%S')
    conn = sqlite3.connect(_DB)
    conn.execute("DROP TABLE IF EXISTS course_inventory")  # rebuild (schema may change)
    _ensure_table(conn)
    conn.executemany(
        "INSERT OR REPLACE INTO course_inventory (code,title,credit_hours,credit_num,"
        "college,subject_code,status,level,repeat_max,eff_term_code,inactive_as_of,fetched_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        [(code,
          (r.get('Title Long') or r.get('Title Short') or '').strip(),
          (r.get('Credit Hours') or '').strip(),
          _credit_num(r.get('Credit Hours')),
          (r.get('College') or '').strip(),
          (r.get('Subject Code') or '').strip(),
          (r.get('Status') or '').strip(),
          (r.get('Level') or '').strip(),
          (r.get('Repeat Max') or '').strip(),
          (r.get('Eff Term Code') or '').strip(),
          r.get('_inactive_as_of'),
          now)
         for code, r in catalog.items()])
    conn.commit()
    n = conn.execute("SELECT COUNT(*) FROM course_inventory").fetchone()[0]
    conn.close()
    return n


def load_map(conn=None):
    """Return {code: dict(credit_num, credit_hours, status, college, repeat_max, title)}.
    Empty dict if the table isn't populated yet."""
    own = conn is None
    if own:
        conn = sqlite3.connect(_DB)
    try:
        try:
            rows = conn.execute("SELECT code,credit_num,credit_hours,status,college,"
                                "repeat_max,title,inactive_as_of FROM course_inventory").fetchall()
        except sqlite3.OperationalError:
            return {}
    finally:
        if own:
            conn.close()
    return {r[0]: {'credit_num': r[1], 'credit_hours': r[2], 'status': r[3],
                   'college': r[4], 'repeat_max': r[5], 'title': r[6],
                   'inactive_as_of': r[7]} for r in rows}


if __name__ == '__main__':
    n = fetch_course_inventory()
    print(f"course_inventory: stored {n} courses")
