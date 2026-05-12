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

XLSX_PATH   = os.path.expanduser("~/Downloads/portfolio_sharepoint.xlsx")
TSV_PATH    = os.path.expanduser("~/Downloads/portfolio_smartsheet.tsv")
ROSTER_PATH = os.path.expanduser("~/Downloads/portfolio_roster.tsv")
OTP_SHEET   = "OTP Program Tracking"


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
# Parse GLS Roster of Record TSV
# ---------------------------------------------------------------------------

def parse_roster(path=ROSTER_PATH):
    """Parse the roster TSV produced by fetch_portfolio_data.fetch_roster_dashboards().

    Each line: source_name \\t source_type \\t program_name \\t col5_value \\t
               col5_label \\t status \\t sub_status \\t proposal_type \\t launch_date
    """
    if not os.path.exists(path):
        return []

    programs = []
    seen = set()

    with open(path, encoding='utf-8') as f:
        for line in f:
            parts = line.rstrip('\n').split('\t')
            if len(parts) < 9:
                continue

            source_name  = parts[0]   # e.g., 'Arlington', 'Bouve'
            source_type  = parts[1]   # 'campus' or 'college'
            prog_name    = parts[2].strip()
            col5_value   = parts[3].strip()
            # col5_label   = parts[4]  # 'Campus' or 'College' (informational)
            status       = parts[5].strip()
            sub_status   = parts[6].strip()
            proposal     = parts[7].strip()
            launch_date  = parts[8].strip()

            if not prog_name or prog_name == 'Primary':
                continue

            # Determine campus and college from source context
            if source_type == 'campus':
                campus  = source_name
                college = col5_value
            else:  # college
                campus  = col5_value
                college = source_name

            # Normalise placeholder campus values
            if campus in ('Not Applicable', 'N/A', 'Online', ''):
                campus = campus if campus == 'Online' else ''

            key = (_norm(prog_name), _norm(campus))
            if key in seen:
                continue
            seen.add(key)

            programs.append({
                'program_name':       prog_name,
                'campus':             campus,
                'college':            college,
                'roster_status':      status,
                'roster_sub_status':  sub_status,
                'roster_proposal_type': proposal,
                'roster_launch_date': launch_date,
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

def ingest(xlsx_path=XLSX_PATH, tsv_path=TSV_PATH, roster_path=ROSTER_PATH):
    """Parse all sources, merge, link to CIM, replace portfolio_programs table."""
    from database import replace_all_portfolio_programs

    if not os.path.exists(xlsx_path):
        raise FileNotFoundError(f"OTP Excel not found: {xlsx_path}")

    otp_rows    = parse_otp(xlsx_path)
    ipd_rows    = parse_smartsheet(tsv_path)
    roster_rows = parse_roster(roster_path)
    cim_index   = _load_cim_programs()

    now = datetime.now().isoformat()

    _EMPTY_ROW = {
        'otp_status': '', 'otp_sub_status': '', 'otp_market_potential': '',
        'otp_market_signal': '', 'otp_internal_performance': '',
        'otp_q3_status': '', 'otp_effective_term': '',
        'ipd_status': '', 'ipd_proposal_type': '', 'ipd_additional_college': '',
        'roster_status': '', 'roster_sub_status': '', 'roster_proposal_type': '',
        'roster_launch_date': '',
        'cim_program_id': None, 'cim_step': '', 'cim_completion_date': '',
        'last_refreshed': now,
    }

    # Build unified dict keyed by id = norm_name__norm_campus
    unified = {}

    # 1. Seed from OTP (authoritative for college/campus/status)
    for p in otp_rows:
        pid = _make_id(p['program_name'], p['campus'])
        unified[pid] = dict(_EMPTY_ROW, **{
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
        })

    # 2. Merge IPD data by normalized name (campus-agnostic)
    ipd_index = {}
    for p in ipd_rows:
        key = _norm(p['program_name'])
        if key not in ipd_index:
            ipd_index[key] = p

    for row in unified.values():
        key = _norm(row['program_name'])
        if key in ipd_index:
            ipd = ipd_index[key]
            row['ipd_status']             = ipd['ipd_status']
            row['ipd_proposal_type']      = ipd['ipd_proposal_type']
            row['ipd_additional_college'] = ipd['ipd_additional_college']

    # Add IPD-only programs (not in OTP)
    otp_norm_names = {_norm(r['program_name']) for r in otp_rows}
    for p in ipd_rows:
        if _norm(p['program_name']) in otp_norm_names:
            continue
        pid = _make_id(p['program_name'], '')
        if pid not in unified:
            unified[pid] = dict(_EMPTY_ROW, **{
                'id':           pid,
                'program_name': p['program_name'],
                'college':      p['ipd_college'],
                'campus':       '',
                'ipd_status':             p['ipd_status'],
                'ipd_proposal_type':      p['ipd_proposal_type'],
                'ipd_additional_college': p['ipd_additional_college'],
            })

    # 3. Merge Roster data by (norm_name, norm_campus)
    for p in roster_rows:
        key_name   = _norm(p['program_name'])
        key_campus = _norm(p['campus'])
        pid        = _make_id(p['program_name'], p['campus'])

        if pid in unified:
            row = unified[pid]
        else:
            # Try name-only match against existing rows
            matched = None
            for existing_pid, existing_row in unified.items():
                if (_norm(existing_row['program_name']) == key_name and
                        _norm(existing_row['campus']) == key_campus):
                    matched = existing_row
                    break
            if matched:
                row = matched
            else:
                # Roster-only program
                unified[pid] = dict(_EMPTY_ROW, **{
                    'id':           pid,
                    'program_name': p['program_name'],
                    'college':      p['college'],
                    'campus':       p['campus'],
                })
                row = unified[pid]

        row['roster_status']        = p['roster_status']
        row['roster_sub_status']    = p['roster_sub_status']
        row['roster_proposal_type'] = p['roster_proposal_type']
        row['roster_launch_date']   = p['roster_launch_date']
        # Fill college/campus from roster if blank in OTP/IPD
        if not row.get('college') and p['college']:
            row['college'] = p['college']
        if not row.get('campus') and p['campus']:
            row['campus'] = p['campus']

    # 4. Link each row to CIM by name
    for row in unified.values():
        key = _norm(row['program_name'])
        if key in cim_index:
            cim = cim_index[key]
            row['cim_program_id']      = cim['cim_program_id']
            row['cim_step']            = cim['cim_step']
            row['cim_completion_date'] = cim['cim_completion_date']

    rows = list(unified.values())
    replace_all_portfolio_programs(rows)
    roster_linked = sum(1 for r in rows if r.get('roster_status'))
    print(f"Portfolio ingest: {len(rows)} programs "
          f"({len(otp_rows)} OTP, {len(ipd_rows)} IPD, {len(roster_rows)} Roster, "
          f"{sum(1 for r in rows if r['cim_program_id'])} linked to CIM, "
          f"{roster_linked} with roster data)")
    return len(rows)


if __name__ == '__main__':
    ingest()
