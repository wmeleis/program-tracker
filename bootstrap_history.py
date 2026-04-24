#!/usr/bin/env python3
"""One-shot bootstrap to ingest ALL CIM program (or course) history.

Walks every program ID (default) or course ID in the given range, fetches
each item's workflow HTML and XML metadata via the logged-in Chrome
session, and upserts both active and completed records.

Usage:
    python3 bootstrap_history.py                   # programs, default range
    python3 bootstrap_history.py 1 500              # programs, subset
    python3 bootstrap_history.py --courses          # courses, default range
    python3 bootstrap_history.py --courses 1 500    # courses, subset
    python3 bootstrap_history.py --batch 50          # tune XHR batch size

Prerequisites (same as a regular scan):
    - Chrome is running with a CourseLeaf session
    - A programadmin tab is open (URL contains "programadmin"). Course XHRs
      reuse the same tab — they're same-origin.
    - "Allow JavaScript from Apple Events" is enabled in Chrome

After a program sweep, `run_full_scan`'s phase-3 logic remains the
authority on `current_step` for items still in active approval — the
sweep only writes `current_step` when an item has fully completed.
"""

import sys
import argparse
from scraper import (
    sweep_all_program_ids, sweep_all_course_ids, check_courseleaf_session,
)
from database import init_db, migrate_db


def main():
    ap = argparse.ArgumentParser(description="Bootstrap ingest of CIM history.")
    ap.add_argument('start', type=int, nargs='?', help="Starting ID (inclusive)")
    ap.add_argument('end', type=int, nargs='?', help="Ending ID (inclusive)")
    ap.add_argument('--batch', type=int, default=25, help="XHR batch size per AppleScript call")
    ap.add_argument('--courses', action='store_true',
                    help="Sweep courses instead of programs")
    args = ap.parse_args()

    init_db()
    migrate_db()

    session = check_courseleaf_session()
    if not session.get('ok'):
        print(f"CourseLeaf session is not ready: {session.get('detail', '')}")
        sys.exit(2)

    if args.courses:
        start = args.start if args.start is not None else 1
        end = args.end if args.end is not None else 25000
        print(f"Sweeping COURSES (IDs {start}..{end})")
        result = sweep_all_course_ids(
            start_id=start, end_id=end, batch_size=args.batch, log=True,
        )
    else:
        start = args.start if args.start is not None else 1
        end = args.end if args.end is not None else 2100
        print(f"Sweeping PROGRAMS (IDs {start}..{end})")
        result = sweep_all_program_ids(
            start_id=start, end_id=end, batch_size=args.batch, log=True,
        )
    print(f"\nBootstrap done: {result}")


if __name__ == '__main__':
    main()
