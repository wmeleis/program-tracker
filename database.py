"""SQLite database layer for Program Approval Status Tracker."""

import sqlite3
import os
from datetime import datetime
from contextlib import contextmanager

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
        """)


def upsert_program(program_data):
    """Insert or update a program. Returns True if the program changed."""
    with get_db() as conn:
        existing = conn.execute(
            "SELECT current_step, status, step_entered_date FROM programs WHERE id = ?",
            (program_data['id'],)
        ).fetchone()

        now = datetime.now().isoformat()
        changed = False

        if existing is None:
            conn.execute("""
                INSERT INTO programs (id, banner_code, name, status, current_step,
                    total_steps, completed_steps, current_approver_emails,
                    program_type, college, department, degree, date_submitted,
                    step_entered_date, curriculum_html, first_seen, last_updated)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

            conn.execute("""
                UPDATE programs SET
                    banner_code = ?, name = ?, status = ?, current_step = ?,
                    total_steps = ?, completed_steps = ?,
                    current_approver_emails = ?, program_type = ?,
                    college = ?, department = ?, degree = ?,
                    date_submitted = ?, step_entered_date = ?,
                    curriculum_html = ?,
                    last_updated = ?
                WHERE id = ?
            """, (
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
                step_entered,
                program_data.get('curriculum_html', ''),
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
    """Get all programs with active workflows."""
    with get_db() as conn:
        return [dict(row) for row in conn.execute("""
            SELECT * FROM programs
            WHERE current_step IS NOT NULL AND current_step != ''
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
    """Get all people who are current approvers, with program counts."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT ws.approver_emails, p.id, p.name
            FROM workflow_steps ws
            JOIN programs p ON ws.program_id = p.id
            WHERE ws.step_status = 'current'
              AND ws.approver_emails IS NOT NULL
              AND ws.approver_emails != ''
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
        }
        for col, typedef in new_cols.items():
            if col not in existing_cols:
                conn.execute(f"ALTER TABLE programs ADD COLUMN {col} {typedef}")
                print(f"  Added column: {col}")
