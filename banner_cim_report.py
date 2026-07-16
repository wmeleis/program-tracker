#!/usr/bin/env python3
"""Generate a trustworthy Banner↔CIM code-discrepancy workbook from the
AUTHORITATIVE reconciliation (`banner_reconciliation.code_mismatch` in
data/reports/portfolio_mismatches.json), which already:
  • excludes CPS "P-" quarter programs (going away) on both sides, and
  • shows the ACTUAL current Banner code(s) for the program (matched by
    subject+degree when the CIM code isn't found verbatim).

This replaces the old hand-made ~/Downloads/banner_cim_discrepancies.xlsx, whose
"Banner code" column was mis-derived (most of its codes didn't exist in Banner).

Writes data/reports/banner_cim_discrepancies.xlsx.  Run: python3 banner_cim_report.py
"""
import os
import json
import sqlite3
import openpyxl
from openpyxl.styles import Font, PatternFill

_DIR = os.path.dirname(os.path.abspath(__file__))
_MISMATCHES = os.path.join(_DIR, 'data', 'portfolio_mismatches.json')
_DB = os.path.join(_DIR, 'data', 'tracker.db')
_OUT = os.path.join(_DIR, 'data', 'reports', 'banner_cim_discrepancies.xlsx')


def _credential(conn, cim_code, program):
    """Best-effort credential label from the CIM program's degree, else the
    program name's trailing degree token."""
    row = conn.execute("SELECT degree FROM programs WHERE banner_code=? AND degree!='' LIMIT 1",
                       (cim_code,)).fetchone()
    if row and row[0]:
        return row[0]
    tail = (program or '').rsplit(',', 1)[-1].strip()
    return tail


def generate():
    with open(_MISMATCHES) as f:
        cm = json.load(f).get('banner_reconciliation', {}).get('code_mismatch', []) or []
    conn = sqlite3.connect(_DB)
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = 'Banner-CIM code mismatch'
    headers = ['Program', 'Credential', 'CIM Code', 'Banner Code(s)']
    ws.append(headers)
    hfill = PatternFill('solid', fgColor='1F3864')
    for c in ws[1]:
        c.font = Font(bold=True, color='FFFFFF')
        c.fill = hfill
    for e in sorted(cm, key=lambda x: x.get('program', '')):
        prog = e.get('program', '')
        ws.append([prog, _credential(conn, e.get('cim_code', ''), prog),
                   e.get('cim_code', ''), e.get('banner_code', '')])
    widths = [46, 16, 16, 60]
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(i)].width = w
    ws.freeze_panes = 'A2'
    wb.save(_OUT)
    conn.close()
    print(f"Wrote {len(cm)} code-mismatch rows to {_OUT}")
    return len(cm)


if __name__ == '__main__':
    generate()
