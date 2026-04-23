#!/usr/bin/env python3
"""One-shot bootstrap to ingest ALL CIM program history into the tracker DB.

Walks every program ID in the given range (default 1..2100), fetches each
program's workflow HTML and XML metadata via the logged-in Chrome session,
and upserts both active and completed programs.

Usage:
    python3 bootstrap_history.py             # default range
    python3 bootstrap_history.py 1 500        # subset (first scan slice)
    python3 bootstrap_history.py --batch 50   # tune XHR batch size

Prerequisites (same as a regular scan):
    - Chrome is running with a CourseLeaf session
    - A programadmin-tab is open (URL contains "programadmin")
    - "Allow JavaScript from Apple Events" is enabled in Chrome

After the sweep, `run_full_scan`'s phase-3 logic continues to be the
authority on `current_step` for programs still in an active approval —
the sweep only writes `current_step` when a program has fully completed.
"""

import sys
import argparse
from scraper import sweep_all_program_ids, check_courseleaf_session
from database import init_db, migrate_db


def main():
    ap = argparse.ArgumentParser(description="Bootstrap ingest of all CIM program history.")
    ap.add_argument('start', type=int, nargs='?', default=1, help="Starting program ID (inclusive)")
    ap.add_argument('end', type=int, nargs='?', default=2100, help="Ending program ID (inclusive)")
    ap.add_argument('--batch', type=int, default=25, help="XHR batch size per AppleScript call")
    args = ap.parse_args()

    init_db()
    migrate_db()

    session = check_courseleaf_session()
    if not session.get('ok'):
        print(f"CourseLeaf session is not ready: {session.get('detail', '')}")
        sys.exit(2)

    result = sweep_all_program_ids(
        start_id=args.start,
        end_id=args.end,
        batch_size=args.batch,
        log=True,
    )
    print(f"\nBootstrap done: {result}")


if __name__ == '__main__':
    main()
