"""SQLite database layer for Program Approval Status Tracker."""

import re
import sqlite3
import os
from datetime import datetime
from contextlib import contextmanager

# A step_entered_date matching this pattern was written by a prior-scan
# fallback (datetime.now().isoformat()), not extracted from CourseLeaf.
# Example: "2026-04-16T21:14:13.042753". Real dates come in RFC-822 GMT
# format ("Thu, 05 May 2022 17:50:38 GMT"). Treat these as "no real date
# available" so a later scan that does extract a real date can replace
# them (and so we fall back to first_seen rather than preserving junk).
_STALE_ISO_FALLBACK = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+$')


def _is_stale_fallback(value):
    return bool(value) and bool(_STALE_ISO_FALLBACK.match(value))

DB_PATH = os.path.join(os.path.dirname(__file__), 'data', 'tracker.db')


@contextmanager
def get_db():
    """Context manager for database connections."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    """Create database tables if they don't exist."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS programs (
                id INTEGER PRIMARY KEY,
                banner_code TEXT,
                name TEXT NOT NULL,
                status TEXT,
                current_step TEXT,
                total_steps INTEGER DEFAULT 0,
                completed_steps INTEGER DEFAULT 0,
                current_approver_emails TEXT,
                program_type TEXT,
                college TEXT,
                department TEXT,
                degree TEXT,
                date_submitted TEXT,
                step_entered_date TEXT,
                curriculum_html TEXT DEFAULT '',
                completion_date TEXT DEFAULT '',
                campus TEXT DEFAULT '',
                first_seen TIMESTAMP,
                last_updated TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS workflow_steps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                program_id INTEGER NOT NULL,
                step_order INTEGER NOT NULL,
                step_name TEXT NOT NULL,
                step_status TEXT DEFAULT 'pending',
                approver_emails TEXT,
                FOREIGN KEY (program_id) REFERENCES programs(id),
                UNIQUE(program_id, step_order)
            );

            CREATE TABLE IF NOT EXISTS scan_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                scan_time TIMESTAMP NOT NULL,
                program_id INTEGER NOT NULL,
                previous_step TEXT,
                new_step TEXT,
                change_type TEXT,
                FOREIGN KEY (program_id) REFERENCES programs(id)
            );

            CREATE TABLE IF NOT EXISTS scans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                scan_time TIMESTAMP NOT NULL,
                programs_scanned INTEGER DEFAULT 0,
                programs_with_workflow INTEGER DEFAULT 0,
                changes_detected INTEGER DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_programs_college ON programs(college);
            CREATE INDEX IF NOT EXISTS idx_programs_current_step ON programs(current_step);
            CREATE INDEX IF NOT EXISTS idx_programs_status ON programs(status);
            CREATE INDEX IF NOT EXISTS idx_workflow_steps_program ON workflow_steps(program_id);
            CREATE INDEX IF NOT EXISTS idx_scan_history_time ON scan_history(scan_time);
            CREATE INDEX IF NOT EXISTS idx_scan_history_program ON scan_history(program_id);

            CREATE TABLE IF NOT EXISTS reference_curriculum (
                program_id INTEGER PRIMARY KEY,
                version_id INTEGER,
                version_date TEXT,
                curriculum_html TEXT,
                fetched_at TIMESTAMP,
                FOREIGN KEY (program_id) REFERENCES programs(id)
            );

            CREATE TABLE IF NOT EXISTS custom_references (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                source_type TEXT,           -- 'docx', 'doc', 'pdf', 'txt'
                source_filename TEXT,
                title TEXT,                 -- detected from the document
                curriculum_html TEXT,
                sections_json TEXT,         -- structured preview data
                notes TEXT,
                created_at TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS regulatory_approved_courses (
                program_id INTEGER PRIMARY KEY,
                campus TEXT NOT NULL,         -- Vancouver / Miami / Portland / Charlotte / Toronto / Arlington / Seattle
                source_file TEXT NOT NULL,    -- e.g. 'BC Approved Courses.xlsx'
                sheet_name TEXT NOT NULL,     -- tab name within the workbook
                sheet_title TEXT,             -- row-0 A1 text
                edited_by TEXT,               -- row-0 col-D provenance string
                unit_header TEXT,             -- 'SH' or 'QH' (from sheet header row)
                confidence REAL DEFAULT 0,    -- 0-1 match score
                match_reason TEXT,            -- debug/audit string
                courses_json TEXT,            -- JSON list [{code,title,sh,section,note}, ...]
                sections_json TEXT,           -- JSON list of ordered section headers
                fetched_at TIMESTAMP,
                FOREIGN KEY (program_id) REFERENCES programs(id)
            );
            CREATE INDEX IF NOT EXISTS idx_regulatory_campus ON regulatory_approved_courses(campus);

            CREATE TABLE IF NOT EXISTS courses (
                id TEXT PRIMARY KEY,
                code TEXT NOT NULL,
                title TEXT NOT NULL,
                status TEXT,
                current_step TEXT,
                total_steps INTEGER DEFAULT 0,
                completed_steps INTEGER DEFAULT 0,
                current_approver_emails TEXT,
                college TEXT,
                date_submitted TEXT,
                step_entered_date TEXT,
                credits TEXT DEFAULT '',
                description TEXT DEFAULT '',
                academic_level TEXT DEFAULT '',
                first_seen TIMESTAMP,
                last_updated TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS course_workflow_steps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                course_id TEXT NOT NULL,
                step_order INTEGER NOT NULL,
                step_name TEXT NOT NULL,
                step_status TEXT DEFAULT 'pending',
                approver_emails TEXT,
                FOREIGN KEY (course_id) REFERENCES courses(id),
                UNIQUE(course_id, step_order)
            );

            CREATE TABLE IF NOT EXISTS course_scan_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                scan_time TIMESTAMP NOT NULL,
                course_id TEXT NOT NULL,
                previous_step TEXT,
                new_step TEXT,
                change_type TEXT,
                FOREIGN KEY (course_id) REFERENCES courses(id)
            );

            CREATE TABLE IF NOT EXISTS course_scans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                scan_time TIMESTAMP NOT NULL,
                courses_scanned INTEGER DEFAULT 0,
                courses_with_workflow INTEGER DEFAULT 0,
                changes_detected INTEGER DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_courses_college ON courses(college);
            CREATE INDEX IF NOT EXISTS idx_courses_current_step ON courses(current_step);
            CREATE INDEX IF NOT EXISTS idx_courses_status ON courses(status);
            CREATE INDEX IF NOT EXISTS idx_course_workflow_steps_course ON course_workflow_steps(course_id);
            CREATE INDEX IF NOT EXISTS idx_course_scan_history_time ON course_scan_history(scan_time);
            CREATE INDEX IF NOT EXISTS idx_course_scan_history_course ON course_scan_history(course_id);
        """)


def upsert_program(program_data):
    """Insert or update a program. Returns True if the program changed.

    For metadata fields (college, department, degree, banner_code, curriculum_html),
    we preserve existing values when the new value is empty — this prevents transient
    XML fetch failures from wiping out good data.
    """
    with get_db() as conn:
        existing = conn.execute(
            "SELECT * FROM programs WHERE id = ?",
            (program_data['id'],)
        ).fetchone()

        now = datetime.now().isoformat()
        changed = False

        if existing is None:
            conn.execute("""
                INSERT INTO programs (id, banner_code, name, status, current_step,
                    total_steps, completed_steps, current_approver_emails,
                    program_type, college, department, degree, date_submitted,
                    step_entered_date, curriculum_html, completion_date, campus,
                    first_seen, last_updated)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                program_data['id'],
                program_data.get('banner_code', ''),
                program_data['name'],
                program_data.get('status', ''),
                program_data.get('current_step', ''),
                program_data.get('total_steps', 0),
                program_data.get('completed_steps', 0),
                program_data.get('current_approver_emails', ''),
                program_data.get('program_type', 'Unknown'),
                program_data.get('college', ''),
                program_data.get('department', ''),
                program_data.get('degree', ''),
                program_data.get('date_submitted', ''),
                program_data.get('step_entered_date', now),
                program_data.get('curriculum_html', ''),
                program_data.get('completion_date', ''),
                program_data.get('campus', ''),
                now, now
            ))
            changed = True
        else:
            old_step = existing['current_step']
            new_step = program_data.get('current_step', '')
            if old_step != new_step or existing['status'] != program_data.get('status', ''):
                changed = True

            # If step changed, update step_entered_date
            step_entered = program_data.get('step_entered_date', '')
            if old_step == new_step:
                step_entered = existing['step_entered_date'] or now

            # Preserve existing metadata when new values are empty (protects against
            # transient XML fetch failures wiping out good data).
            def keep(field, default=''):
                new_val = program_data.get(field, default)
                if new_val in ('', None):
                    existing_val = existing[field] if field in existing.keys() else default
                    return existing_val if existing_val not in ('', None) else default
                return new_val

            # completion_date: only set/cleared explicitly — if the caller
            # provides one, use it; otherwise preserve existing. If the caller
            # provides the empty string and the program is now back in the
            # workflow (current_step non-empty), clear completion_date so the
            # program rejoins the active pipeline.
            new_completion = program_data.get('completion_date', None)
            if new_completion is None:
                completion_val = existing['completion_date'] if 'completion_date' in existing.keys() else ''
            elif new_completion == '' and (program_data.get('current_step') or ''):
                completion_val = ''
            elif new_completion == '':
                # Empty override but still not in an active step — preserve existing.
                completion_val = existing['completion_date'] if 'completion_date' in existing.keys() else ''
            else:
                completion_val = new_completion

            conn.execute("""
                UPDATE programs SET
                    banner_code = ?, name = ?, status = ?, current_step = ?,
                    total_steps = ?, completed_steps = ?,
                    current_approver_emails = ?, program_type = ?,
                    college = ?, department = ?, degree = ?,
                    date_submitted = ?, step_entered_date = ?,
                    curriculum_html = ?,
                    completion_date = ?, campus = ?,
                    last_updated = ?
                WHERE id = ?
            """, (
                keep('banner_code'),
                program_data['name'],
                program_data.get('status', ''),
                program_data.get('current_step', ''),
                program_data.get('total_steps', 0),
                program_data.get('completed_steps', 0),
                program_data.get('current_approver_emails', ''),
                keep('program_type', 'Unknown'),
                keep('college'),
                keep('department'),
                keep('degree'),
                keep('date_submitted'),
                step_entered,
                keep('curriculum_html'),
                completion_val,
                keep('campus'),
                now,
                program_data['id']
            ))

        return changed


def upsert_workflow_steps(program_id, steps):
    """Replace workflow steps for a program."""
    with get_db() as conn:
        conn.execute("DELETE FROM workflow_steps WHERE program_id = ?", (program_id,))
        for step in steps:
            conn.execute("""
                INSERT INTO workflow_steps (program_id, step_order, step_name, step_status, approver_emails)
                VALUES (?, ?, ?, ?, ?)
            """, (
                program_id,
                step['order'],
                step['name'],
                step['status'],
                step.get('emails', '')
            ))


def record_change(scan_time, program_id, previous_step, new_step, change_type):
    """Record a workflow step change."""
    with get_db() as conn:
        conn.execute("""
            INSERT INTO scan_history (scan_time, program_id, previous_step, new_step, change_type)
            VALUES (?, ?, ?, ?, ?)
        """, (scan_time, program_id, previous_step, new_step, change_type))


def record_scan(scan_time, programs_scanned, programs_with_workflow, changes_detected):
    """Record scan metadata."""
    with get_db() as conn:
        conn.execute("""
            INSERT INTO scans (scan_time, programs_scanned, programs_with_workflow, changes_detected)
            VALUES (?, ?, ?, ?)
        """, (scan_time, programs_scanned, programs_with_workflow, changes_detected))


def get_all_programs():
    """Get all programs that are either in an active workflow step OR have
    completed the workflow (completion_date set).

    Programs with empty current_step AND empty completion_date are ingest
    artifacts (e.g., archived/placeholder IDs with no workflow data) and
    filtered out. The frontend uses `completion_date` to render completed
    programs differently (no progress bar, "Approved on <date>" column).
    """
    with get_db() as conn:
        return [dict(row) for row in conn.execute("""
            SELECT * FROM programs
            WHERE (current_step IS NOT NULL AND current_step != '')
               OR (completion_date IS NOT NULL AND completion_date != '')
            ORDER BY program_type, name
        """).fetchall()]


def get_program_workflow(program_id):
    """Get workflow steps for a specific program."""
    with get_db() as conn:
        return [dict(row) for row in conn.execute("""
            SELECT * FROM workflow_steps
            WHERE program_id = ?
            ORDER BY step_order
        """, (program_id,)).fetchall()]


def get_pipeline_counts(tracked_roles):
    """Get count of programs at each tracked workflow step."""
    with get_db() as conn:
        counts = {}
        for role in tracked_roles:
            result = conn.execute("""
                SELECT COUNT(*) as cnt FROM programs
                WHERE current_step = ? AND current_step != ''
            """, (role,)).fetchone()
            counts[role] = result['cnt']
        return counts


def get_recent_changes(limit=50):
    """Get recent changes across all programs."""
    with get_db() as conn:
        return [dict(row) for row in conn.execute("""
            SELECT sh.*, p.name as program_name, p.banner_code
            FROM scan_history sh
            JOIN programs p ON sh.program_id = p.id
            ORDER BY sh.scan_time DESC
            LIMIT ?
        """, (limit,)).fetchall()]


def get_last_scan():
    """Get the most recent scan info."""
    with get_db() as conn:
        result = conn.execute("""
            SELECT * FROM scans ORDER BY scan_time DESC LIMIT 1
        """).fetchone()
        return dict(result) if result else None


def get_programs_by_step(step_name):
    """Get all programs currently at a specific step."""
    with get_db() as conn:
        return [dict(row) for row in conn.execute("""
            SELECT * FROM programs WHERE current_step = ?
            ORDER BY name
        """, (step_name,)).fetchall()]


def get_colleges():
    """Get all distinct colleges."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT DISTINCT college FROM programs
            WHERE college IS NOT NULL AND college != ''
            ORDER BY college
        """).fetchall()
        return [row['college'] for row in rows]


def get_current_approvers():
    """Get all people who are current approvers, with program counts.

    Only counts programs with a non-empty current_step, so the dropdown counts
    match what you actually see when the filter is applied.
    """
    with get_db() as conn:
        rows = conn.execute("""
            SELECT ws.approver_emails, p.id, p.name
            FROM workflow_steps ws
            JOIN programs p ON ws.program_id = p.id
            WHERE ws.step_status = 'current'
              AND ws.approver_emails IS NOT NULL
              AND ws.approver_emails != ''
              AND p.current_step IS NOT NULL AND p.current_step != ''
        """).fetchall()

        # Parse into per-person counts
        approver_map = {}  # email -> {name_guess, count, program_ids}
        for row in rows:
            for email in row['approver_emails'].split(';'):
                email = email.strip()
                if not email or '@' not in email:
                    continue
                if email not in approver_map:
                    # Format as "LastName, F." from email prefix (e.g. h.daly -> Daly, H.)
                    prefix = email.split('@')[0]
                    parts = prefix.split('.')
                    if len(parts) >= 2:
                        first_initial = parts[0][0].upper() + '.'
                        last_name = parts[-1].capitalize()
                        display = f"{last_name}, {first_initial}"
                    else:
                        display = parts[0].capitalize()
                    approver_map[email] = {'email': email, 'display': display, 'count': 0}
                approver_map[email]['count'] += 1

        return sorted(approver_map.values(), key=lambda x: x['display'])


def get_program_curriculum(program_id):
    """Get curriculum HTML for a single program."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT curriculum_html FROM programs WHERE id = ?",
            (program_id,)
        ).fetchone()
        return row['curriculum_html'] if row else ''


def get_all_curriculum():
    """Get curriculum HTML for all programs (for static export)."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, curriculum_html FROM programs WHERE curriculum_html != ''"
        ).fetchall()
        return {str(row['id']): row['curriculum_html'] for row in rows}


def get_programs_by_approver(email):
    """Get all programs where the given email is the current approver."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT DISTINCT p.*
            FROM programs p
            JOIN workflow_steps ws ON ws.program_id = p.id
            WHERE ws.step_status = 'current'
              AND ws.approver_emails LIKE ?
              AND p.current_step IS NOT NULL AND p.current_step != ''
            ORDER BY p.name
        """, (f'%{email}%',)).fetchall()
        return [dict(row) for row in rows]


def upsert_reference_curriculum(program_id, version_id, version_date, html):
    """Insert or update reference curriculum for a program."""
    with get_db() as conn:
        now = datetime.now().isoformat()
        conn.execute("""
            INSERT INTO reference_curriculum (program_id, version_id, version_date, curriculum_html, fetched_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(program_id) DO UPDATE SET
                version_id = excluded.version_id,
                version_date = excluded.version_date,
                curriculum_html = excluded.curriculum_html,
                fetched_at = excluded.fetched_at
        """, (program_id, version_id, version_date, html, now))


def get_reference_curriculum(program_id):
    """Get reference curriculum for a single program."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT version_id, version_date, curriculum_html FROM reference_curriculum WHERE program_id = ?",
            (program_id,)
        ).fetchone()
        return dict(row) if row else None


def get_all_reference_curriculum():
    """Get reference curriculum for all programs (for static export)."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT program_id, version_date, curriculum_html FROM reference_curriculum"
        ).fetchall()
        return {str(row['program_id']): {'version_date': row['version_date'], 'html': row['curriculum_html']} for row in rows}


# ---- Regulatory approved courses (from GlobalRegulatoryAffairs SharePoint) ----

def upsert_regulatory_approved(program_id, campus, source_file, sheet_name,
                               sheet_title, edited_by, unit_header,
                               confidence, match_reason, courses_json, sections_json):
    """Insert or update regulatory approved-course data for a program."""
    with get_db() as conn:
        now = datetime.now().isoformat()
        conn.execute("""
            INSERT INTO regulatory_approved_courses
                (program_id, campus, source_file, sheet_name, sheet_title,
                 edited_by, unit_header, confidence, match_reason,
                 courses_json, sections_json, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(program_id) DO UPDATE SET
                campus = excluded.campus,
                source_file = excluded.source_file,
                sheet_name = excluded.sheet_name,
                sheet_title = excluded.sheet_title,
                edited_by = excluded.edited_by,
                unit_header = excluded.unit_header,
                confidence = excluded.confidence,
                match_reason = excluded.match_reason,
                courses_json = excluded.courses_json,
                sections_json = excluded.sections_json,
                fetched_at = excluded.fetched_at
        """, (program_id, campus, source_file, sheet_name, sheet_title,
              edited_by, unit_header, confidence, match_reason,
              courses_json, sections_json, now))


def delete_regulatory_approved(program_id):
    """Clear regulatory match for a program (e.g. when re-scan finds no match)."""
    with get_db() as conn:
        conn.execute("DELETE FROM regulatory_approved_courses WHERE program_id = ?", (program_id,))


def get_regulatory_approved(program_id):
    """Return {campus, source_file, sheet_name, sheet_title, edited_by, unit_header,
    confidence, match_reason, courses, sections, fetched_at} or None."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM regulatory_approved_courses WHERE program_id = ?",
            (program_id,)
        ).fetchone()
        if not row:
            return None
        import json as _json
        d = dict(row)
        d['courses'] = _json.loads(d.pop('courses_json') or '[]')
        d['sections'] = _json.loads(d.pop('sections_json') or '[]')
        return d


def get_all_regulatory_approved():
    """All regulatory approved-course rows, keyed by program_id (for static export)."""
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM regulatory_approved_courses").fetchall()
        import json as _json
        out = {}
        for row in rows:
            d = dict(row)
            d['courses'] = _json.loads(d.pop('courses_json') or '[]')
            d['sections'] = _json.loads(d.pop('sections_json') or '[]')
            out[str(d['program_id'])] = d
        return out


# ---- Custom references (uploaded curriculum docs) ----

def create_custom_reference(name, source_type, source_filename, title, curriculum_html, sections_json, notes=''):
    """Create a new custom reference. Returns the new id."""
    with get_db() as conn:
        now = datetime.now().isoformat()
        cur = conn.execute("""
            INSERT INTO custom_references
                (name, source_type, source_filename, title, curriculum_html, sections_json, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (name, source_type, source_filename, title, curriculum_html, sections_json, notes, now))
        return cur.lastrowid


def list_custom_references():
    """List all custom references (metadata only, no full HTML)."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT id, name, source_type, source_filename, title, notes, created_at,
                   length(curriculum_html) as html_size
            FROM custom_references
            ORDER BY created_at DESC
        """).fetchall()
        return [dict(r) for r in rows]


def get_custom_reference(ref_id):
    """Fetch a single custom reference, including its curriculum HTML."""
    with get_db() as conn:
        row = conn.execute("SELECT * FROM custom_references WHERE id = ?", (ref_id,)).fetchone()
        return dict(row) if row else None


def delete_custom_reference(ref_id):
    """Delete a custom reference. Clears any program overrides pointing to it.

    Returns the number of programs whose overrides were cleared.
    """
    with get_db() as conn:
        cleared = conn.execute(
            "UPDATE programs SET custom_reference_id = NULL WHERE custom_reference_id = ?",
            (ref_id,),
        ).rowcount
        conn.execute("DELETE FROM custom_references WHERE id = ?", (ref_id,))
        return cleared


def set_program_reference_override(program_id, custom_reference_id):
    """Set or clear a program's custom reference override."""
    with get_db() as conn:
        if custom_reference_id is None:
            conn.execute("UPDATE programs SET custom_reference_id = NULL WHERE id = ?", (program_id,))
        else:
            conn.execute(
                "UPDATE programs SET custom_reference_id = ? WHERE id = ?",
                (custom_reference_id, program_id),
            )


def get_program_reference_override_id(program_id):
    """Return the custom_reference_id for a program, or None."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT custom_reference_id FROM programs WHERE id = ?",
            (program_id,),
        ).fetchone()
        return row['custom_reference_id'] if row else None


def get_all_program_reference_overrides():
    """Return {program_id: custom_reference_id} for all programs with an override."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, custom_reference_id FROM programs WHERE custom_reference_id IS NOT NULL"
        ).fetchall()
        return {r['id']: r['custom_reference_id'] for r in rows}


def upsert_course(course_data):
    """Insert or update a course. Returns True if the course changed.

    Preserves existing metadata (code, title, college, credits, description,
    academic_level) when new values are empty — protects against transient
    XML fetch failures wiping out good data.
    """
    with get_db() as conn:
        existing = conn.execute(
            "SELECT * FROM courses WHERE id = ?",
            (course_data['id'],)
        ).fetchone()

        now = datetime.now().isoformat()
        changed = False

        if existing is None:
            # New course: prefer a real date from scraper; else use `now` so we
            # at least have *something*. Subsequent scans can replace this via
            # the stale-fallback detection in the update path.
            step_entered = course_data.get('step_entered_date') or now
            conn.execute("""
                INSERT INTO courses (id, code, title, status, current_step,
                    total_steps, completed_steps, current_approver_emails,
                    college, date_submitted, step_entered_date,
                    credits, description, academic_level, first_seen, last_updated)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                course_data['id'],
                course_data.get('code', ''),
                course_data['title'],
                course_data.get('status', ''),
                course_data.get('current_step', ''),
                course_data.get('total_steps', 0),
                course_data.get('completed_steps', 0),
                course_data.get('current_approver_emails', ''),
                course_data.get('college', ''),
                course_data.get('date_submitted', ''),
                step_entered,
                course_data.get('credits', ''),
                course_data.get('description', ''),
                course_data.get('academic_level', ''),
                now, now
            ))
            changed = True
        else:
            old_step = existing['current_step']
            new_step = course_data.get('current_step', '')
            if old_step != new_step or existing['status'] != course_data.get('status', ''):
                changed = True

            # Step-entered-date resolution order:
            #   1. Real date from this scrape (scraper returns non-empty).
            #   2. If step didn't change AND existing value is a real date
            #      (not a stale datetime.now() fallback), preserve it.
            #   3. Otherwise fall back to first_seen, so the user sees
            #      "days since we first observed this course" instead of a
            #      counter that resets every scan.
            step_entered = course_data.get('step_entered_date', '')
            if not step_entered:
                existing_date = existing['step_entered_date']
                if (old_step == new_step
                        and existing_date
                        and not _is_stale_fallback(existing_date)):
                    step_entered = existing_date
                else:
                    step_entered = existing['first_seen'] or now

            # Preserve existing metadata when new values are empty (guards against
            # transient XML fetch failures wiping out good data).
            def keep(field, default=''):
                new_val = course_data.get(field, default)
                if new_val in ('', None):
                    existing_val = existing[field] if field in existing.keys() else default
                    return existing_val if existing_val not in ('', None) else default
                return new_val

            conn.execute("""
                UPDATE courses SET
                    code = ?, title = ?, status = ?, current_step = ?,
                    total_steps = ?, completed_steps = ?,
                    current_approver_emails = ?, college = ?,
                    date_submitted = ?, step_entered_date = ?,
                    credits = ?, description = ?, academic_level = ?,
                    last_updated = ?
                WHERE id = ?
            """, (
                keep('code'),
                keep('title') or course_data['title'],
                course_data.get('status', ''),
                course_data.get('current_step', ''),
                course_data.get('total_steps', 0),
                course_data.get('completed_steps', 0),
                course_data.get('current_approver_emails', ''),
                keep('college'),
                keep('date_submitted'),
                step_entered,
                keep('credits'),
                keep('description'),
                keep('academic_level'),
                now,
                course_data['id']
            ))

        return changed


def upsert_course_workflow_steps(course_id, steps):
    """Replace workflow steps for a course."""
    with get_db() as conn:
        conn.execute("DELETE FROM course_workflow_steps WHERE course_id = ?", (course_id,))
        for step in steps:
            conn.execute("""
                INSERT INTO course_workflow_steps (course_id, step_order, step_name, step_status, approver_emails)
                VALUES (?, ?, ?, ?, ?)
            """, (
                course_id,
                step['order'],
                step['name'],
                step['status'],
                step.get('emails', '')
            ))


def record_course_change(scan_time, course_id, previous_step, new_step, change_type):
    """Record a course workflow step change."""
    with get_db() as conn:
        conn.execute("""
            INSERT INTO course_scan_history (scan_time, course_id, previous_step, new_step, change_type)
            VALUES (?, ?, ?, ?, ?)
        """, (scan_time, course_id, previous_step, new_step, change_type))


def record_course_scan(scan_time, courses_scanned, courses_with_workflow, changes_detected):
    """Record course scan metadata."""
    with get_db() as conn:
        conn.execute("""
            INSERT INTO course_scans (scan_time, courses_scanned, courses_with_workflow, changes_detected)
            VALUES (?, ?, ?, ?)
        """, (scan_time, courses_scanned, courses_with_workflow, changes_detected))


def get_all_courses():
    """Get all courses with active workflows."""
    with get_db() as conn:
        return [dict(row) for row in conn.execute("""
            SELECT * FROM courses
            WHERE current_step IS NOT NULL AND current_step != ''
            ORDER BY code
        """).fetchall()]


def get_course_workflow(course_id):
    """Get workflow steps for a specific course."""
    with get_db() as conn:
        return [dict(row) for row in conn.execute("""
            SELECT * FROM course_workflow_steps
            WHERE course_id = ?
            ORDER BY step_order
        """, (course_id,)).fetchall()]


def get_course_pipeline_counts(tracked_roles):
    """Get count of courses at each tracked workflow step."""
    with get_db() as conn:
        counts = {}
        for role in tracked_roles:
            result = conn.execute("""
                SELECT COUNT(*) as cnt FROM courses
                WHERE current_step = ? AND current_step != ''
            """, (role,)).fetchone()
            counts[role] = result['cnt']
        return counts


def get_recent_course_changes(limit=50):
    """Get recent changes across all courses."""
    with get_db() as conn:
        return [dict(row) for row in conn.execute("""
            SELECT sh.*, c.code, c.title
            FROM course_scan_history sh
            JOIN courses c ON sh.course_id = c.id
            ORDER BY sh.scan_time DESC
            LIMIT ?
        """, (limit,)).fetchall()]


def get_last_course_scan():
    """Get the most recent course scan info."""
    with get_db() as conn:
        result = conn.execute("""
            SELECT * FROM course_scans ORDER BY scan_time DESC LIMIT 1
        """).fetchone()
        return dict(result) if result else None


def get_courses_by_step(step_name):
    """Get all courses currently at a specific step."""
    with get_db() as conn:
        return [dict(row) for row in conn.execute("""
            SELECT * FROM courses WHERE current_step = ?
            ORDER BY code
        """, (step_name,)).fetchall()]


def get_course_colleges():
    """Get all distinct colleges with courses."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT DISTINCT college FROM courses
            WHERE college IS NOT NULL AND college != ''
            ORDER BY college
        """).fetchall()
        return [row['college'] for row in rows]


def get_course_current_approvers():
    """Get all people who are current approvers for courses, with course counts."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT ws.approver_emails, c.id, c.code
            FROM course_workflow_steps ws
            JOIN courses c ON ws.course_id = c.id
            WHERE ws.step_status = 'current'
              AND ws.approver_emails IS NOT NULL
              AND ws.approver_emails != ''
              AND c.current_step IS NOT NULL AND c.current_step != ''
        """).fetchall()

        approver_map = {}
        for row in rows:
            for email in row['approver_emails'].split(';'):
                email = email.strip()
                if not email or '@' not in email:
                    continue
                if email not in approver_map:
                    prefix = email.split('@')[0]
                    parts = prefix.split('.')
                    if len(parts) >= 2:
                        first_initial = parts[0][0].upper() + '.'
                        last_name = parts[-1].capitalize()
                        display = f"{last_name}, {first_initial}"
                    else:
                        display = parts[0].capitalize()
                    approver_map[email] = {'email': email, 'display': display, 'count': 0}
                approver_map[email]['count'] += 1

        return sorted(approver_map.values(), key=lambda x: x['display'])


def get_courses_by_approver(email):
    """Get all courses where the given email is the current approver."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT DISTINCT c.*
            FROM courses c
            JOIN course_workflow_steps ws ON ws.course_id = c.id
            WHERE ws.step_status = 'current'
              AND ws.approver_emails LIKE ?
              AND c.current_step IS NOT NULL AND c.current_step != ''
            ORDER BY c.code
        """, (f'%{email}%',)).fetchall()
        return [dict(row) for row in rows]


def migrate_db():
    """Add new columns to existing database if needed."""
    with get_db() as conn:
        # Check if columns exist, add if missing
        cursor = conn.execute("PRAGMA table_info(programs)")
        existing_cols = {row['name'] for row in cursor.fetchall()}
        new_cols = {
            'college': 'TEXT DEFAULT ""',
            'department': 'TEXT DEFAULT ""',
            'degree': 'TEXT DEFAULT ""',
            'date_submitted': 'TEXT DEFAULT ""',
            'step_entered_date': 'TEXT DEFAULT ""',
            'curriculum_html': 'TEXT DEFAULT ""',
            'completion_date': 'TEXT DEFAULT ""',   # last approval date once fully approved; empty while in pipeline
            'campus': 'TEXT DEFAULT ""',            # XML campus code (e.g. BOS, VAN); parsed from program name otherwise
        }
        for col, typedef in new_cols.items():
            if col not in existing_cols:
                conn.execute(f"ALTER TABLE programs ADD COLUMN {col} {typedef}")
                print(f"  Added column: {col}")

        # Courses table: add credits + description if missing
        cursor = conn.execute("PRAGMA table_info(courses)")
        existing_course_cols = {row['name'] for row in cursor.fetchall()}
        for col, typedef in {'credits': 'TEXT DEFAULT ""', 'description': 'TEXT DEFAULT ""', 'academic_level': 'TEXT DEFAULT ""'}.items():
            if col not in existing_course_cols:
                conn.execute(f"ALTER TABLE courses ADD COLUMN {col} {typedef}")
                print(f"  Added courses column: {col}")

        # Create reference_curriculum table if it doesn't exist
        conn.execute("""
            CREATE TABLE IF NOT EXISTS reference_curriculum (
                program_id INTEGER PRIMARY KEY,
                version_id INTEGER,
                version_date TEXT,
                curriculum_html TEXT,
                fetched_at TIMESTAMP,
                FOREIGN KEY (program_id) REFERENCES programs(id)
            )
        """)

        # Custom references (uploaded .docx etc.) — programs may point to one of these
        conn.execute("""
            CREATE TABLE IF NOT EXISTS custom_references (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                source_type TEXT,
                source_filename TEXT,
                title TEXT,
                curriculum_html TEXT,
                sections_json TEXT,
                notes TEXT,
                created_at TIMESTAMP
            )
        """)
        # Add custom_reference_id column to programs if missing
        if 'custom_reference_id' not in existing_cols:
            try:
                conn.execute("ALTER TABLE programs ADD COLUMN custom_reference_id INTEGER")
                print("  Added column: custom_reference_id")
            except sqlite3.OperationalError:
                pass  # already added
