"""One-shot: backfill program_approvals (and course_approvals) for every
program/course already in the DB by re-fetching their workflow HTML.

batch_fetch_*_details was extended to persist `meta.approvals` to the new
tables on every call, so we just need to invoke it across every known ID.
The DB state for programs/courses themselves is left alone — this writes
only to the new approval tables.

Usage:
    python3 bootstrap_approvals.py                   # programs only
    python3 bootstrap_approvals.py --courses         # programs + courses
    python3 bootstrap_approvals.py --courses-only
"""
import argparse
import sys
import time

from database import get_db
from scraper import (
    batch_fetch_program_details,
    batch_fetch_course_details,
    check_courseleaf_session,
)


def get_all_program_ids():
    with get_db() as conn:
        return [r[0] for r in conn.execute("SELECT id FROM programs ORDER BY id").fetchall()]


def get_all_course_ids():
    with get_db() as conn:
        return [r[0] for r in conn.execute("SELECT id FROM courses ORDER BY id").fetchall()]


def backfill_programs():
    ids = get_all_program_ids()
    print(f"[programs] {len(ids)} program IDs to refetch", flush=True)
    t0 = time.time()
    batch_fetch_program_details(ids, batch_size=25)
    elapsed = time.time() - t0
    with get_db() as conn:
        n_rows = conn.execute("SELECT COUNT(*) FROM program_approvals").fetchone()[0]
        n_progs = conn.execute(
            "SELECT COUNT(DISTINCT program_id) FROM program_approvals"
        ).fetchone()[0]
    print(
        f"[programs] done in {elapsed:.1f}s: {n_rows} approval rows across "
        f"{n_progs}/{len(ids)} programs",
        flush=True,
    )


def backfill_courses():
    ids = get_all_course_ids()
    print(f"[courses] {len(ids)} course IDs to refetch", flush=True)
    t0 = time.time()
    batch_fetch_course_details(ids, batch_size=25)
    elapsed = time.time() - t0
    with get_db() as conn:
        n_rows = conn.execute("SELECT COUNT(*) FROM course_approvals").fetchone()[0]
        n_crs = conn.execute(
            "SELECT COUNT(DISTINCT course_id) FROM course_approvals"
        ).fetchone()[0]
    print(
        f"[courses] done in {elapsed:.1f}s: {n_rows} approval rows across "
        f"{n_crs}/{len(ids)} courses",
        flush=True,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--courses", action="store_true", help="also do courses")
    ap.add_argument("--courses-only", action="store_true", help="skip programs")
    args = ap.parse_args()

    sess = check_courseleaf_session()
    if not sess.get("ok"):
        print(f"ABORT: {sess.get('error')}: {sess.get('detail')}", file=sys.stderr)
        sys.exit(2)
    print(f"Session: {sess.get('detail')}", flush=True)

    if not args.courses_only:
        backfill_programs()
    if args.courses or args.courses_only:
        backfill_courses()


if __name__ == "__main__":
    main()
