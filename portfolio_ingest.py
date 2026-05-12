"""
Parse the OTP Excel and Smartsheet TSV, merge into a unified program list,
link each entry to the CIM pipeline, and upsert into portfolio_programs.

Called by the /api/portfolio/refresh endpoint, or directly:
    python3 portfolio_ingest.py
"""

import os
import sys
import re
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime

# portfolio_ingest.py lives in the worktree but must use the main project DB.
# Strategy: ensure the worktree's own database.py is imported (it has the new
# portfolio functions), then patch database.DB_PATH to the main project's DB.
_WORKTREE_DIR = os.path.dirname(os.path.abspath(__file__))
if _WORKTREE_DIR not in sys.path:
    sys.path.insert(0, _WORKTREE_DIR)

# Find the directory that actually has data/tracker.db (may be main project).
def _find_db_path():
    candidate = _WORKTREE_DIR
    for _ in range(6):
        db = os.path.join(candidate, 'data', 'tracker.db')
        if os.path.exists(db):
            return db
        candidate = os.path.dirname(candidate)
    return os.path.join(_WORKTREE_DIR, 'data', 'tracker.db')

import database as _db_module
_db_module.DB_PATH = _find_db_path()

XLSX_PATH = os.path.expanduser("~/Downloads/portfolio_sharepoint.xlsx")
TSV_PATH  = os.path.expanduser("~/Downloads/portfolio_smartsheet.tsv")
OTP_SHEET = "OTP Program Tracking"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _norm(s):
    """Normalize a program name for matching: lowercase, collapse spaces."""
    return re.sub(r'\s+', ' ', (s or '').strip().lower())


def _make_id(name, campus):
    safe_name = re.sub(r'[^a-z0-9]+', '_', _norm(name))
    safe_campus = re.sub(r'[^a-z0-9]+', '_', (campus or '').strip().lower())
    return f"{safe_name}__{safe_campus}" if safe_campus else safe_name


# ---------------------------------------------------------------------------
# Parse OTP Excel
# ---------------------------------------------------------------------------

def _parse_xlsx_sheet(path, sheet_name):
    """Return list of dicts for one sheet using stdlib only."""
    with zipfile.ZipFile(path) as z:
        # Shared strings
        strings = []
        if 'xl/sharedStrings.xml' in z.namelist():
            tree = ET.parse(z.open('xl/sharedStrings.xml'))
            ns = {'ns': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
            for si in tree.findall('.//ns:si', ns):
                strings.append(''.join(t.text or '' for t in si.findall('.//ns:t', ns)))

        # Find the target sheet
        wb = ET.parse(z.open('xl/workbook.xml'))
        wb_ns = {'ns': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
        rels = ET.parse(z.open('xl/_rels/workbook.xml.rels'))
        rel_map = {r.get('Id'): r.get('Target')
                   for r in rels.findall('.//{http://schemas.openxmlformats.org/package/2006/relationships}Relationship')}
        sheet_path = None
        for s in wb.findall('.//ns:sheet', wb_ns):
            if s.get('name') == sheet_name:
                rid = s.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
                target = rel_map.get(rid, '')
                sheet_path = f'xl/{target}' if not target.startswith('/') else target.lstrip('/')
                break
        if not sheet_path or sheet_path not in z.namelist():
            return []

        sn = {'ns': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
        sheet_tree = ET.parse(z.open(sheet_path))

        def cell_value(cell):
            v = cell.find('ns:v', sn)
            if v is None or not v.text:
                return ''
            return strings[int(v.text)] if cell.get('t') == 's' else v.text

        rows = []
        for row in sheet_tree.findall('.//ns:row', sn):
            cells = {}
            for c in row.findall('ns:c', sn):
                col = ''.join(ch for ch in (c.get('r') or '') if ch.isalpha())
                cells[col] = cell_value(c)
            rows.append(cells)
        return rows


def parse_otp(path=XLSX_PATH):
    """Return list of OTP program dicts from the OTP Program Tracking sheet."""
    raw = _parse_xlsx_sheet(path, OTP_SHEET)
    # Row 0 is the header: A=CollegeShort B=NoMarketScore C=CampusShort D=ProgramName
    # E=MarketPotential F=MarketSignal G=InternalPerformance H=Status
    # I=SubStatus J=Q3Status K=EffectiveTerm L=Notes
    programs = []
    for row in raw[1:]:  # skip header
        name = row.get('D', '').strip()
        if not name:
            continue
        programs.append({
            'program_name': name,
            'college':      row.get('A', '').strip(),
            'campus':       row.get('C', '').strip(),
            'otp_status':   row.get('H', '').strip(),
            'otp_sub_status':              row.get('I', '').strip(),
            'otp_market_potential':        row.get('E', '').strip(),
            'otp_market_signal':           row.get('F', '').strip(),
            'otp_internal_performance':    row.get('G', '').strip(),
            'otp_q3_status':               row.get('J', '').strip(),
            'otp_effective_term':          row.get('K', '').strip(),
        })
    return programs


# ---------------------------------------------------------------------------
# Parse Smartsheet TSV
# ---------------------------------------------------------------------------

def parse_smartsheet(path=TSV_PATH):
    """Return list of IPD program dicts from the exported Smartsheet TSV.

    Column layout (0-indexed, data rows have a leading empty col[0]):
      [1]  program name (Primary)
      [5]  proposal type (How Can We Help You)
      [6]  college
      [7]  additional college impact
      [8]  status
    """
    if not os.path.exists(path):
        return []

    # Known status values from the Smartsheet
    KNOWN_STATUSES = {
        'Approved for Development by IPD',
        'Approved for Development by College',
        'Approved for Development by Mobility',
        'EDGE - Development',
        'EDGE - Development & Delivery',
        'Launch in Progress',
        'Intake',
        'In Discovery',
        'Discovery',
        'On Hold',
        'Not Moving Forward',
        'Regulatory Validation In Progress',
    }

    programs = []
    with open(path) as f:
        for line in f:
            cols = line.rstrip('\n').split('\t')
            if len(cols) < 6:
                continue
            name = cols[1].strip()
            # Skip header, group headers, totals, blanks
            if (not name or name in ('Primary', 'Total')
                    or name.startswith('Status ')
                    or name.startswith('Count ')):
                continue
            proposal_type      = cols[5].strip() if len(cols) > 5 else ''
            college            = cols[6].strip() if len(cols) > 6 else ''
            additional_college = cols[7].strip() if len(cols) > 7 else ''
            status             = cols[8].strip() if len(cols) > 8 else ''

            # Skip rows with no recognisable status (summary/header rows)
            if not status:
                continue
            programs.append({
                'program_name':           name,
                'ipd_status':             status,
                'ipd_proposal_type':      proposal_type,
                'ipd_college':            college,
                'ipd_additional_college': additional_college,
            })
    return programs


# ---------------------------------------------------------------------------
# Link to CIM
# ---------------------------------------------------------------------------

def _load_cim_programs():
    """Return {norm_name: {cim_program_id, cim_step, cim_completion_date}}."""
    from database import get_db
    with get_db() as conn:
        rows = conn.execute("""
            SELECT id, name, current_step, completion_date
            FROM programs
            WHERE (current_step IS NOT NULL AND current_step != '')
               OR (completion_date IS NOT NULL AND completion_date != '')
        """).fetchall()
    result = {}
    for r in rows:
        for field in ('name',):
            key = _norm(r[field] or '')
            if key and key not in result:
                result[key] = {
                    'cim_program_id':      r['id'],
                    'cim_step':            r['current_step'] or '',
                    'cim_completion_date': r['completion_date'] or '',
                }
    return result


# ---------------------------------------------------------------------------
# Merge and ingest
# ---------------------------------------------------------------------------

def ingest(xlsx_path=XLSX_PATH, tsv_path=TSV_PATH):
    """Parse both sources, merge, link to CIM, replace portfolio_programs table."""
    from database import replace_all_portfolio_programs

    if not os.path.exists(xlsx_path):
        raise FileNotFoundError(f"OTP Excel not found: {xlsx_path}")

    otp_rows   = parse_otp(xlsx_path)
    ipd_rows   = parse_smartsheet(tsv_path)
    cim_index  = _load_cim_programs()

    now = datetime.now().isoformat()

    # Build unified dict keyed by (norm_name, norm_campus)
    unified = {}  # id -> row dict

    # 1. Seed from OTP (authoritative for college/campus/status)
    for p in otp_rows:
        pid = _make_id(p['program_name'], p['campus'])
        unified[pid] = {
            'id':           pid,
            'program_name': p['program_name'],
            'college':      p['college'],
            'campus':       p['campus'],
            'otp_status':              p['otp_status'],
            'otp_sub_status':          p['otp_sub_status'],
            'otp_market_potential':    p['otp_market_potential'],
            'otp_market_signal':       p['otp_market_signal'],
            'otp_internal_performance': p['otp_internal_performance'],
            'otp_q3_status':           p['otp_q3_status'],
            'otp_effective_term':      p['otp_effective_term'],
            'ipd_status':          '',
            'ipd_proposal_type':   '',
            'ipd_additional_college': '',
            'cim_program_id':    None,
            'cim_step':          '',
            'cim_completion_date': '',
            'last_refreshed':    now,
        }

    # 2. Merge IPD data by normalized name (campus-agnostic match: update all
    #    OTP rows whose name matches; if none found, add a new campus-less row)
    ipd_index = {}  # norm_name -> first matching ipd row
    for p in ipd_rows:
        key = _norm(p['program_name'])
        if key not in ipd_index:
            ipd_index[key] = p

    for pid, row in unified.items():
        key = _norm(row['program_name'])
        if key in ipd_index:
            ipd = ipd_index[key]
            row['ipd_status']             = ipd['ipd_status']
            row['ipd_proposal_type']      = ipd['ipd_proposal_type']
            row['ipd_additional_college'] = ipd['ipd_additional_college']

    # Add IPD-only programs (not in OTP at all)
    otp_norm_names = {_norm(r['program_name']) for r in otp_rows}
    for p in ipd_rows:
        key = _norm(p['program_name'])
        if key in otp_norm_names:
            continue
        pid = _make_id(p['program_name'], '')
        if pid not in unified:
            unified[pid] = {
                'id':           pid,
                'program_name': p['program_name'],
                'college':      p['ipd_college'],
                'campus':       '',
                'otp_status':              '',
                'otp_sub_status':          '',
                'otp_market_potential':    '',
                'otp_market_signal':       '',
                'otp_internal_performance': '',
                'otp_q3_status':           '',
                'otp_effective_term':      '',
                'ipd_status':             p['ipd_status'],
                'ipd_proposal_type':      p['ipd_proposal_type'],
                'ipd_additional_college': p['ipd_additional_college'],
                'cim_program_id':    None,
                'cim_step':          '',
                'cim_completion_date': '',
                'last_refreshed':    now,
            }

    # 3. Link each row to CIM by name
    for row in unified.values():
        key = _norm(row['program_name'])
        if key in cim_index:
            cim = cim_index[key]
            row['cim_program_id']      = cim['cim_program_id']
            row['cim_step']            = cim['cim_step']
            row['cim_completion_date'] = cim['cim_completion_date']

    rows = list(unified.values())
    replace_all_portfolio_programs(rows)
    print(f"Portfolio ingest: {len(rows)} programs "
          f"({len(otp_rows)} OTP, {len(ipd_rows)} IPD, "
          f"{sum(1 for r in rows if r['cim_program_id'])} linked to CIM)")
    return len(rows)


if __name__ == '__main__':
    ingest()
