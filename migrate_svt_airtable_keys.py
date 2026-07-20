#!/usr/bin/env python3
"""One-time (idempotent) remap of SVT disposition/reviewed keys from the old
Smartsheet "New Intake ID" (e.g. 'p762') to Airtable's native Airtable_ID
(e.g. '756'), needed because SVT moved from Smartsheet to Airtable (2026-07).

`svt_overrides` and `svt_seen` are keyed by `svt_key`. Before the ingest starts
emitting Airtable_ID keys, each existing row must be re-keyed to the Airtable_ID
of the record whose `Smartsheet_Intake_ID` matches the old key — otherwise every
disposition and reviewed-state orphans.

Mapping source: data/portfolio_feeds/svt.json (the Airtable fetch), which carries
both Smartsheet_Intake_ID and Airtable_ID on each record.

Idempotent: only rows whose current svt_key is a known old Smartsheet id are
touched; already-migrated numeric keys are left alone. Run:  python3 migrate_svt_airtable_keys.py
"""
import os
import json
import sqlite3

_DIR = os.path.dirname(os.path.abspath(__file__))
_DB = os.path.join(_DIR, 'data', 'tracker.db')
_SVT = os.path.join(_DIR, 'data', 'portfolio_feeds', 'svt.json')


def _build_map():
    """old Smartsheet_Intake_ID -> new Airtable_ID (both as str)."""
    with open(_SVT) as f:
        data = json.load(f)
    m = {}
    for rec in data.get('records', []):
        fld = rec.get('fields', {})
        old = str(fld.get('Smartsheet_Intake_ID') or '').strip()
        new = str(fld.get('Airtable_ID') or '').strip()
        if old and new:
            m[old] = new
    return m


def _remap_table(conn, table, id2new):
    rows = conn.execute(f"SELECT svt_key FROM {table}").fetchall()
    existing = {r[0] for r in rows}
    remapped = skipped_nomatch = skipped_collision = already = 0
    for old_key in list(existing):
        if str(old_key).isdigit():
            already += 1                     # already an Airtable_ID
            continue
        new_key = id2new.get(str(old_key))
        if not new_key:
            skipped_nomatch += 1             # old intake id not in Airtable feed
            continue
        if new_key in existing and new_key != old_key:
            skipped_collision += 1           # target key already present — leave both
            continue
        conn.execute(f"UPDATE {table} SET svt_key=? WHERE svt_key=?", (new_key, old_key))
        existing.discard(old_key)
        existing.add(new_key)
        remapped += 1
    print(f"  {table}: remapped={remapped} already-migrated={already} "
          f"no-match={skipped_nomatch} collision={skipped_collision}")
    return remapped


def _rebaseline_svt_seen(conn):
    """Recompute each svt_seen row's fingerprint+snapshot from the CURRENT
    (Airtable) feed and adopt it as the reviewed baseline, so the source switch
    doesn't spuriously flag entries 'changed' (which would reset overrides).
    Only touches rows whose key is in the feed; leaves is_new/last_reviewed alone
    and clears any phantom last_changed back to first_seen."""
    import re
    import portfolio_ingest as P
    def fp_snap(p):
        snap = {
            'name':            re.sub(r'\s+', ' ', (p.get('program_name') or '')).strip(),
            'code':            (p.get('program_code') or '').strip(),
            'campus':          (p.get('campus') or '').strip(),
            'courseleaf_key':  (p.get('courseleaf_key') or '').strip(),
            'initiative_type': (p.get('initiative_type') or '').strip(),
        }
        fp = '␟'.join(snap[k] for k in ('name', 'code', 'campus', 'courseleaf_key', 'initiative_type'))
        return fp, snap
    rows = {p['svt_key']: p for p in P.parse_svt() if p.get('svt_key')}
    existing = {r[0] for r in conn.execute("SELECT svt_key FROM svt_seen")}
    n = 0
    for k in existing & set(rows):
        fp, snap = fp_snap(rows[k])
        conn.execute(
            "UPDATE svt_seen SET fingerprint=?, snapshot_json=?, change_detail_json='', "
            "last_changed=first_seen WHERE svt_key=?",
            (fp, json.dumps(snap, separators=(',', ':')), k))
        n += 1
    print(f"  svt_seen rebaselined to current feed: {n} rows")


def main():
    id2new = _build_map()
    print(f"Airtable map: {len(id2new)} Smartsheet_Intake_ID -> Airtable_ID entries")
    conn = sqlite3.connect(_DB, timeout=30)
    try:
        conn.execute("BEGIN IMMEDIATE")
        total = 0
        for t in ('svt_overrides', 'svt_seen'):
            total += _remap_table(conn, t, id2new)
        _rebaseline_svt_seen(conn)
        conn.commit()
        print(f"Done. {total} rows remapped.")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == '__main__':
    main()
