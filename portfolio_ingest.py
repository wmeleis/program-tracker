"""
Parse external tracking feeds (OTP Excel, IPD Smartsheet, SVT Roster, GLS Tableau),
merge with CIM program data, and upsert into portfolio_programs.

Called by the /api/portfolio/refresh endpoint, or directly:
    python3 portfolio_ingest.py
"""

import os
import sys
import re
import json
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
GLS_PATH    = os.path.expanduser("~/Downloads/portfolio_gls.csv")
SCORING_2025_PATH = os.path.expanduser(
    "~/committees/nu-docs/Programs/Program review/Program review 2025/"
    "Graduate Program Scoring-Boston-for WM-9-16-25.xlsx"
)
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

    The Smartsheet export contains multiple sections, each preceded by a header
    row starting with blank col[0] and 'Primary' in col[1].  Data rows have
    three extra leading blank cols vs. the header (the +3 shift rule), so the
    data column index for any header field is: header_index + 3.

    We detect section boundaries dynamically and remap columns per section.
    """
    if not os.path.exists(path):
        return []

    # Column remapping state (updated on each 'Primary' header row)
    status_col      = -1
    proposal_col    = -1
    college_col     = -1
    add_college_col = -1

    programs = []
    with open(path) as f:
        for line in f:
            cols = line.rstrip('\n').split('\t')
            if len(cols) < 3:
                continue

            # Section header row: blank col[0], 'Primary' col[1]
            if cols[0] == '' and cols[1].strip() == 'Primary':
                header = [c.strip() for c in cols]
                def _hcol(label):
                    try: return header.index(label) + 3
                    except ValueError: return -1
                status_col        = _hcol('Status')
                proposal_col      = _hcol('How Can We Help You')
                college_col       = _hcol('College')
                add_college_col   = _hcol('Additional College Impact')
                continue

            name = cols[1].strip()
            if (not name or name in ('Primary', 'Total')
                    or name.startswith('Status ')
                    or name.startswith('Count ')
                    or name.startswith('- *') or ('* - *' in name)):
                continue

            def _col(idx):
                return cols[idx].strip() if idx >= 0 and len(cols) > idx else ''
            status             = _col(status_col)
            proposal_type      = _col(proposal_col)
            college            = _col(college_col)
            additional_college = _col(add_college_col)

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
# Parse 2025 Graduate Program Scoring Excel (Boston)
# ---------------------------------------------------------------------------

# Explicit overrides for entries whose names are too abbreviated to auto-match.
# Keys = _norm of the Excel "Program Desc" column (after degree-prefix inversion).
# Values = _norm of the portfolio program name (without campus parenthetical).
_SCORING_2025_OVERRIDES = {
    # Degree codes not in the general prefix list
    'chemical engineering, msche':               'chemical engineering, mschemical engineering',
    # Use portfolio canonical name fragments instead
    'engineering management, msem':              'engineering management, msem',
    'industrial engineering, msie':              'industrial engineering, msie',
    'mechanical engineering, msme':              'mechanical engineering, msme',
    'civil engineering, mscive':                 'civil engineering, mscive',
    'sports leadership, msld':                   'sports leadership, msld',
    'counseling psychology, mscp':               'counseling psychology, mscp',
    'accounting, msa':                           'accounting, msa',
    'public policy, mpp':                        'public policy, mpp',
    # Truncated / abbreviated names
    'app qnt methods & soc anlys, ms':           'applied quantitative methods and social analysis, ms',
    'applied educational psych, ms':             'applied educational psychology, ms',
    'applied logistics (cps), mps':              'applied logistics, mps',
    'applied machine lntel(cps), mps':           'applied machine intelligence, mps',
    'architecture 2 year, march':                'architecture 2 year, march',
    'business admin-evening, mba':               'business administration, mba—part-time',
    'business admini-full time, mba':            'business administration, mba—full-time',
    'commerce & econ dvpmt (cps), ms':           'commerce and economic development, ms',
    'computer science - align, mscs':            'computer science—align, mscs',
    'corp/orgn comm (cps), ms':                  'corporate and organizational communication, ms',
    'critical care acnp (de), ms':               'nursing—adult-gerontology nurse practitioner, acute care, ms',
    'critical care nurs nnp (de), ms':           'nursing—neonatal nurse practitioner, ms',
    'cyber-physical systems, ms':                'cyber-physical systems, ms',
    'data architecture and mgmt, ms':            'data architecture and management, ms',
    'digital media - connect, mps':              'digital media—connect, mps',
    'environmental sci & policy, ms':            'environmental science and policy, ms',
    'finance/business evenin, msfmba':           'finance/business admin, msfmba',
    'global stu/intl reltn (cps), ms':           'global studies and international relations, ms',
    'human movement & rehab sci, ms':            'human movement and rehabilitation sciences, ms',
    'human resources mgmt (cps), ms':            'human resources management, ms',
    'info dsgn & data visualztn, mfa':           'information design and data visualization, mfa',
    'info dsgn & data visualztn, ms':            'information design and data visualization, ms',
    'information syst - bridge, msis':           'information systems, msis (bridge)',
    'media innov and data comm, ms':             'media innovation and data communication, ms',
    'medicinal chem & drug disc, ms':            'medicinal chemistry and drug discovery, ms',
    'mpp public policy':                         'public policy, mpp',
    'msa accounting':                            'accounting, msa',
    'msamba accounting/business adm':            'accounting/business administration, msamba',
    'msche chemical engineering':                'chemical engineering, msche',
    'mscive civil engineering':                  'civil engineering, mscive',
    'mscp counseling psychology':                'counseling psychology, mscp',
    'msecel elec and comp engr lead':            'electrical and computer engineering leadership, msecel',
    'msem engineering management':               'engineering management, msem',
    'msie industrial engineering':               'industrial engineering, msie',
    'msld sports leadership (cps)':              'sports leadership, msld',
    'msme mechanical engineering':               'mechanical engineering, msme',
    'nonprofit management (cps), ms':            'nonprofit management, ms',
    'nurse anesthesia, dnp':                     'nurse anesthesia, dnp',
    'nursing (de), ms':                          'nursing, ms',
    'nursing, dnp':                              'nursing, dnp',
    'operations research as, msor':              'operations research as, ms',
    'organizational ldrshp (cps), ms':           'organizational leadership, ms',
    'ped acute prim care pnp(de), ms':           'nursing—pediatric nurse practitioner, acute and primary care, ms',
    'primary care nurs anp (de), ms':            'nursing—adult gerontology nurse practitioner, primary care, ms',
    'primary care nurs fnp (de), ms':            'nursing—family nurse practitioner, primary care, ms',
    'project management (cps), ms':              'project management, ms',
    'psych-mental health (de), ms':              'nursing—psychiatric-mental mental health nurse practitioner, ms',
    'public administration, mpa':                'public administration, mpa',
    'quant finance/bus admin, msfmba':           'quant finance and business admin, msfmba',
    'regulatory affairs (cps), ms':              'regulatory affairs, ms',
    'security & intelligence stu, ma':           'security and intelligence studies, ma',
    'sustain urban envrt-1year, mdes':           'sustainable urban environments, mdes',
    'sustainable bldg sys, mssbs':               'sustainable building systems, mssbs',
    # Excel degree token differs from CIM name (degree prefix not inverted)
    'msecel elec and comp engr lead':            'ece leadership, ms',
    'msenes energy systems - al':                'energy systems (al), ms',
}

def parse_scoring_2025(path=SCORING_2025_PATH):
    """Parse the 2025 graduate program scoring workbook.

    Returns a list of dicts with keys:
      norm_name, degree, words, market_2025, performance_2025
    Column B = Program Desc (e.g. 'MSCS Computer Science', may be truncated)
    Column G = Category (e.g. 'Good Market, Bad Internal Performance')
    """
    if not os.path.exists(path):
        return []
    raw = _parse_xlsx_sheet(path, 'Sheet1')
    result = []
    for row in raw:
        name_raw = row.get('B', '').strip()
        category = row.get('G', '').strip()
        if not name_raw or not category:
            continue
        mkt_match  = re.search(r'^(Good|Bad)\s+Market', category, re.I)
        perf_match = re.search(r'(Good|Bad)\s+Internal Performance', category, re.I)
        market      = mkt_match.group(1).capitalize()  if mkt_match  else ''
        performance = perf_match.group(1).capitalize() if perf_match else ''
        if not market and not performance:
            continue
        market_score      = row.get('E', '').strip()
        performance_score = row.get('F', '').strip()
        # Invert "DEGREE Name" → "Name, DEGREE" (e.g. "MSCS Computer Science" → "Computer Science, MSCS")
        _deg_pfx = re.match(
            r'^(ms|ma|mps|mpa|mph|mba|mfa|med|mem|march|mdes|mscs|msis|msor|msfmba|msece|'
            r'msene|mssbs|dnp|dpt|dmsc|edd|phd|jd|llm|dlp|bs|ba|bfa|barch|bsn|bsba|bscf|'
            r'certg?|mat|mbe)\s+(?:in\s+|of\s+)?(.+)$', name_raw.strip(), re.I)
        if _deg_pfx:
            name_raw = f'{_deg_pfx.group(2).strip()}, {_deg_pfx.group(1).upper()}'
        norm_name = _norm(name_raw)
        # Apply explicit override if available (maps abbreviated → canonical)
        norm_name = _SCORING_2025_OVERRIDES.get(norm_name, norm_name)
        # Extract degree suffix for filtering
        deg_m = re.search(r',\s*([A-Za-z]+(?:\s+[A-Za-z]+)?)\s*$', norm_name)
        degree = deg_m.group(1).strip().lower() if deg_m else ''
        # Content words (no degree tokens, no stop words) for fuzzy overlap
        stop = {'in', 'of', 'and', 'the', 'for', 'a', 'an', 'with', 'at', 'cps',
                'ms', 'ma', 'mps', 'mba', 'mfa', 'phd', 'edd', 'dnp', 'dpt',
                'mscs', 'msis', 'msor', 'msece', 'msme', 'msfmba', 'msn',
                'llm', 'jd', 'mat', 'med', 'march', 'certg', 'cert',
                'de', 'sc', 'eve', 'evening', 'time', 'full', 'year', '1', '2', '3'}
        # Normalize &→and, strip parentheticals like (cps)/(de), collapse punctuation
        clean = re.sub(r'\([^)]*\)', ' ', norm_name)  # strip (cps), (de), etc.
        clean = re.sub(r'\s*[-–]\s*', ' ', clean)      # dash → space
        clean = clean.replace('&', ' and ')
        words = set(re.sub(r'[^a-z0-9\s]', ' ', clean).split()) - stop
        result.append({'norm_name': norm_name, 'degree': degree,
                       'words': words,
                       'market_2025': market, 'performance_2025': performance,
                       'market_score_2025': market_score, 'performance_score_2025': performance_score})
    return result


def _match_scoring_2025(scoring_entries, portfolio_norm_key):
    """Find the best scoring entry for a portfolio program (normalized name).

    Returns the entry dict or None.
    Tries exact match first, then degree-matched word-overlap (≥0.6 Jaccard).
    """
    # Extract degree from portfolio key
    deg_m = re.search(r',\s*([A-Za-z]+(?:\s+[A-Za-z]+)?)\s*$', portfolio_norm_key)
    p_degree = deg_m.group(1).strip().lower() if deg_m else ''
    stop = {'in', 'of', 'and', 'the', 'for', 'a', 'an', 'with', 'at', 'cps',
            'ms', 'ma', 'mps', 'mba', 'mfa', 'phd', 'edd', 'dnp', 'dpt',
            'mscs', 'msis', 'msor', 'msece', 'msme', 'msfmba', 'msn',
            'llm', 'jd', 'mat', 'med', 'march', 'certg', 'cert',
            'de', 'sc', 'eve', 'evening', 'time', 'full', 'year', '1', '2', '3'}

    def _norm_words(s):
        s = re.sub(r'\([^)]*\)', ' ', s)
        s = re.sub(r'\s*[-–]\s*', ' ', s)
        s = s.replace('&', ' and ')
        return set(re.sub(r'[^a-z0-9\s]', ' ', s).split()) - stop

    p_words = _norm_words(portfolio_norm_key)

    exact = [e for e in scoring_entries if e['norm_name'] == portfolio_norm_key]
    if exact:
        return exact[0]

    best, best_score = None, 0.0
    for e in scoring_entries:
        if e['degree'] != p_degree:
            continue
        inter = len(e['words'] & p_words)
        union = len(e['words'] | p_words)
        if union == 0:
            continue
        score = inter / union
        if score > best_score and score >= 0.45:
            best_score = score
            best = e
    return best


# ---------------------------------------------------------------------------
# Parse SVT Roster of Record TSV
# ---------------------------------------------------------------------------

def parse_roster(path=ROSTER_PATH):
    """Parse the SVT roster TSV produced by fetch_portfolio_data.fetch_roster_dashboards().

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
            if len(parts) < 6:
                continue

            source_name  = parts[0]   # e.g., 'Arlington', 'Bouve'
            source_type  = parts[1]   # 'campus' or 'college'
            prog_name    = parts[2].strip()
            col5_value   = parts[3].strip()
            # col5_label   = parts[4]  # 'Campus' or 'College' (informational)
            status       = parts[5].strip()
            sub_status   = parts[6].strip() if len(parts) > 6 else ''
            proposal     = parts[7].strip() if len(parts) > 7 else ''
            launch_date  = parts[8].strip() if len(parts) > 8 else ''

            if not prog_name or prog_name == 'Primary':
                continue

            # Skip multi-program bundle rows (Smartsheet groups, e.g. "- *Program A* - *Program B*")
            if prog_name.startswith('- *') or ('* - *' in prog_name):
                continue

            # Skip market-research / non-degree entries
            _prop_lower = proposal.lower()
            if any(kw in _prop_lower for kw in (
                    'market research', 'general market', 'market study',
                    'market analysis', 'feasibility')):
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
                'svt_status':         status,
                'roster_sub_status':  sub_status,
                'roster_proposal_type': proposal,
                'roster_launch_date': launch_date,
            })

    return programs


# ---------------------------------------------------------------------------
# Parse GLS Tableau CSV
# ---------------------------------------------------------------------------

# Explicit GLS raw_name → portfolio canonical name overrides (for abbreviations
# that are too short/different for the fuzzy matcher to resolve).
# Key = exact GLS "Program" column value; Value = portfolio program_name.
_GLS_NAME_MAP = {
    'MS App Quant Methods & Soc Analysis':  'Applied Quantitative Methods And Social Analysis, Ms',
    'MS Human Movement and Rehab Sci':      'Human Movement and Rehabilitation Sciences, MS (Boston)',
    'MS Media Innov and Data Comm':         'Media Innovation and Data Communication, MS (Boston)',
    'MS Critical Care ACNP (DE)':           'Nursing—Adult-Gerontology Nurse Practitioner, Acute Care, MS',
    'MS Critical Care Nurs NNP (DE)':       'Nursing—Neonatal Nurse Practitioner, MS',
    'MS Ped Acute Prim Care (PNP) (DE)':   'Nursing—Pediatric Nurse Practitioner, Acute and Primary Care, MS',
    'MS Primary Care Nurse ANP (DE)':       'Nursing—Adult-Gerontology Nurse Practitioner, Primary Care, MS',
    'MS Psych-Mental Health (DE)':          'Nursing—Psychiatric-Mental Health Nurse Practitioner, MS',
}

# Known degree abbreviations that can appear as the first token in GLS names
_GLS_DEGREES = {
    'MS', 'PhD', 'MA', 'MBA', 'MFA', 'MPH', 'MPS', 'MEd', 'MArch', 'MSW',
    'DNP', 'DPT', 'PharmD', 'JD', 'LLM', 'CAGS', 'CERTG', 'BS', 'BA', 'BFA',
    'BArch', 'BM', 'EdD', 'DPS', 'DMSc', 'MSCP', 'MSIS', 'MSCS', 'MSECE',
    'MSCivE', 'MSCIVE', 'MSDS', 'MSML', 'MSME', 'MHI', 'MPA', 'MPP', 'MRED',
    'MSBA', 'MSIT', 'MEM', 'MIS', 'MHA',
}
_STOP = {'', 'and', 'the', 'of', 'in', 'for', 'a', 'an', 'at', 'to', 'with',
         'science', 'studies', 'arts', 'management'}


def _gls_key_words(s):
    """Return a frozenset of meaningful words from a string, for GLS matching."""
    return frozenset(w for w in re.split(r'[\W_]+', s.lower()) if w and w not in _STOP)


def parse_gls(path=GLS_PATH):
    """Parse the Tableau GLS CSV into a list of structured entry dicts.

    GLS uses "DEGREE Subject" name format; portfolio uses "Subject, DEGREE".
    Returns list of {degree, subject_words, campus, status, raw_name}.
    Returns [] when the file is missing or unparseable.
    """
    if not os.path.exists(path):
        return []

    import csv
    entries = []
    try:
        with open(path, encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            if not reader.fieldnames:
                return []
            for row in reader:
                raw_name = (row.get('Program') or '').strip()
                status   = (row.get('Status')  or '').strip()
                campus   = (row.get('Campus')  or '').strip()
                if not raw_name or not status:
                    continue
                tokens = raw_name.split()
                if tokens and tokens[0].upper() in _GLS_DEGREES:
                    degree = tokens[0].upper()
                    subj   = ' '.join(tokens[1:])
                else:
                    degree = ''
                    subj   = raw_name
                entries.append({
                    'degree':        degree,
                    'subject_words': _gls_key_words(subj),
                    'campus':        campus,
                    'status':        status,
                    'raw_name':      raw_name,
                })
    except Exception as e:
        print(f"  GLS CSV parse error: {e}")
        return []
    return entries


# ---------------------------------------------------------------------------
# Normalization helpers
# ---------------------------------------------------------------------------

_CAMPUS_NAMES = {
    'BOS': 'Boston', 'OAK': 'Oakland', 'TOR': 'Toronto', 'POR': 'Portland',
    'SV': 'Silicon Valley', 'SJ': 'Silicon Valley', 'SEA': 'Seattle',
    'MIA': 'Miami', 'ARL': 'Arlington', 'VAN': 'Vancouver',
    'CHA': 'Charlotte', 'LON': 'London',
    # All online variants collapse to a single "Online" campus. Anything that
    # starts with "online" or "primarily online" — including suffix-tagged
    # deployment notes like "Online - Vancouver Requirements" or
    # "Primarily Online - Vancouver Requirements" — is one campus for the
    # portfolio.
    'Primarily Online': 'Online',
    'Primarily Online - Vancouver Requirements': 'Online',
    'Online - Vancouver Requirements': 'Online',
    'Online - deactivated duplicate record': 'Online',
}

# Long-form degree name → short abbreviation
_LONG_DEGREE_MAP = [
    (re.compile(r'^masters?\s+of\s+science\s*(?:\([^)]*\))?\s*(?:in\s+)?', re.I), 'MS'),
    (re.compile(r'^masters?\s+of\s+arts\s+(?:in\s+)?', re.I), 'MA'),
    (re.compile(r'^masters?\s+of\s+business\s+administration\s*(?:in\s+)?', re.I), 'MBA'),
    (re.compile(r'^masters?\s+of\s+(?:public\s+)?health\s*(?:in\s+)?', re.I), 'MPH'),
    (re.compile(r'^masters?\s+of\s+fine\s+arts\s+(?:in\s+)?', re.I), 'MFA'),
    (re.compile(r'^masters?\s+of\s+education\s+(?:in\s+)?', re.I), 'MEd'),
    (re.compile(r'^masters?\s+of\s+architecture\s*(?:in\s+)?', re.I), 'MArch'),
    (re.compile(r'^masters?\s+of\s+public\s+administration\s*(?:in\s+)?', re.I), 'MPA'),
    (re.compile(r'^masters?\s+of\s+professional\s+studies\s*(?:in\s+)?', re.I), 'MPS'),
    (re.compile(r'^doctor\s+of\s+philosophy\s*(?:in\s+)?', re.I), 'PhD'),
    (re.compile(r'^doctor\s+of\s+education\s*(?:in\s+)?', re.I), 'EdD'),
    (re.compile(r'^doctor\s+of\s+nursing\s+practice\s*(?:in\s+)?', re.I), 'DNP'),
    (re.compile(r'^doctor\s+of\s+physical\s+therapy\s*(?:in\s+)?', re.I), 'DPT'),
    (re.compile(r'^doctor\s+of\s+professional\s+studies\s*(?:in\s+)?', re.I), 'DPS'),
    (re.compile(r'^doctor\s+of\s+law\s+and\s+policy\s*(?:in\s+)?', re.I), 'DLP'),
    (re.compile(r'^bachelor\s+of\s+science\s*(?:in\s+)?', re.I), 'BS'),
    (re.compile(r'^bachelor\s+of\s+arts\s*(?:in\s+)?', re.I), 'BA'),
    (re.compile(r'^bachelor\s+of\s+fine\s+arts\s*(?:in\s+)?', re.I), 'BFA'),
    (re.compile(r'^graduate\s+certificate\s*(?:in\s+)?', re.I), 'Graduate Certificate'),
    (re.compile(r'^certificate\s*(?:in\s+)?', re.I), 'Graduate Certificate'),
    # Generic "Master(s) in X" / "Masters of X" without a more specific phrase.
    # The actual CIM credential could be MS / MA / MEd; we default to MS and
    # rely on the campus-aware fallback in _lookup_cim() to bridge to MA/MEd
    # when no MS variant exists.
    (re.compile(r'^masters?\s+in\s+', re.I), 'MS'),
    (re.compile(r'^masters?\s+of\s+', re.I), 'MS'),
    (re.compile(r'^bachelors?\s+in\s+', re.I), 'BS'),
]

# When a long-form degree like "Doctor of Professional Studies" has no subject
# (e.g., "Doctor of Professional Studies - New Concentrations"), use this implicit subject.
_DEGREE_IMPLICIT_SUBJECT = {
    'DPS': 'Professional Studies',
    'DLP': 'Law and Policy',
    'DNP': 'Nursing Practice',
}

# Deployment suffix on subject after short-prefix parse: "MS Data Science - Align" or
# "MS Cybersecurity, Align" → subject="...", degree="MS-Align" (matches CIM's "MS—Align")
_DEPLOYMENT_SUFFIX_RE = re.compile(
    r'\s*(?:[-–—]|,)\s*(align|connect|bridge|accelerated|part[\s\-]?time|online|full[\s\-]?time)\s*$',
    re.I
)

# Short degree prefix pattern (e.g. "MS Computer Science", "PhD Biology")
_SHORT_DEGREE_PREFIX_RE = re.compile(
    r'^(MS|MA|MBA|MFA|MPH|MPS|MPA|MEd|MArch|MDes|MSCS|MSIS|MSOR|MSFMBA|MSECE|'
    r'MSENE|MSSBS|DNP|DPT|DMSc|EdD|PhD|JD|LLM|DLP|BS|BA|BFA|BArch|BSN|BSBA|BSCF|'
    r'CERTG?|MAT|MBE|MSCP|MSLD|MSEM|MSME|MSCivE|MSCIVE|MSML|MSBA|DPS|MSDS|MHI|'
    r'MSAMBA|MSA|MPP|MSFMBA|MHA|MEM|MIS|MRED)\s+(?:in\s+|of\s+)?(.+)$',
    re.I
)


# ---------------------------------------------------------------------------
# OTP abbreviation expansion
# ---------------------------------------------------------------------------

# Word-boundary substitutions applied to OTP names before matching.
# OTP uses abbreviated forms not found in CIM (e.g. "Mgmt", "Comm", "Intl").
# Pairs are (compiled regex, replacement); applied in order.
_OTP_ABBREV_SUBS = [
    # Degree-prefix & → and (most common mismatch source)
    (re.compile(r'\s*&\s*', re.I), ' and '),
    # Common subject word abbreviations
    (re.compile(r'\bmgmt\b', re.I), 'management'),
    (re.compile(r'\bsci\b', re.I), 'science'),
    (re.compile(r'\bcomm\b', re.I), 'communication'),
    (re.compile(r'\bstu\b', re.I), 'studies'),
    (re.compile(r'\bintl\b', re.I), 'international'),
    (re.compile(r'\breltns?\b', re.I), 'relations'),
    (re.compile(r'\borgn\b', re.I), 'organizational'),
    (re.compile(r'\bcorp\b', re.I), 'corporate'),
    (re.compile(r'\bdvpmt\b', re.I), 'development'),
    (re.compile(r'\bdsgn\b', re.I), 'design'),
    (re.compile(r'\bvisualztn\b', re.I), 'visualization'),
    (re.compile(r'\benvrt\b', re.I), 'environments'),
    (re.compile(r'\brehab\b', re.I), 'rehabilitation'),
    (re.compile(r'\binnov\b', re.I), 'innovation'),
    (re.compile(r'\bpsych\b', re.I), 'psychology'),
    (re.compile(r'\banlys\b', re.I), 'analysis'),
    (re.compile(r'\blntel\b', re.I), 'intelligence'),
    (re.compile(r'\bldrshp\b', re.I), 'leadership'),
    (re.compile(r'\binfo\b', re.I), 'information'),
    (re.compile(r'\bqnt\b', re.I), 'quantitative'),
    (re.compile(r'\bquant\b', re.I), 'quantitative'),
    (re.compile(r'\bapp\b', re.I), 'applied'),
    (re.compile(r'\bsoc\b', re.I), 'social'),
    (re.compile(r'\bnurs\b', re.I), 'nursing'),
    (re.compile(r'\badmin\b', re.I), 'administration'),
    (re.compile(r'\bhlth\b', re.I), 'health'),
    # "sustain" / "sustainability" → "sustainable" (CIM: "Sustainable Urban Environments" etc.)
    (re.compile(r'\bsustainability\b', re.I), 'sustainable'),
    (re.compile(r'\bsustain\b', re.I), 'sustainable'),
    # "Chem" → "Chemistry" (e.g. "Medicinal Chem and Drug Discovery")
    (re.compile(r'\bchem\b', re.I), 'chemistry'),
    (re.compile(r'\bmtls\b', re.I), 'materials'),
    (re.compile(r'\benvtl\b', re.I), 'environmental'),
    (re.compile(r'\benvrnt\b', re.I), 'environments'),
    # Slash-separated subjects: "Applied Physics/Engineering" → "Applied Physics and Engineering"
    (re.compile(r'\s*/\s*', re.I), ' and '),
]


def _preprocess_otp_name(name):
    """Expand OTP-specific abbreviations before name matching."""
    s = name
    for pat, repl in _OTP_ABBREV_SUBS:
        s = pat.sub(repl, s)
    # Collapse any double spaces introduced by substitution
    s = re.sub(r'\s{2,}', ' ', s).strip()
    return s


# ---------------------------------------------------------------------------
# Non-program detection
# ---------------------------------------------------------------------------

_NON_PROGRAM_RE = re.compile(
    r'\b('
    r'boot\s*camp|bootcamp'
    r'|badge[sd]?'
    r'|non[\-\s]?credit'
    r'|workforce\s+re[\-\s]?entry'
    r'|chaplaincy'
    r'|apprenticeship'
    r'|pilot\s+(program|course|ai|coach|initiative)'
    r'|layoff\s+response'
    r'|lead\s+by\s+learning'
    r'|federal\s+layoff'
    r'|non[\-\s]?degree'
    r'|workforce\s+initiative'
    r'|summer\s+institute'
    r'|ai\s+for\s+workforce'
    r'|3[\-\s]year\s+apprenticeship'
    r'|converted\s+to\s+fully\s+online'       # "CPS Degrees converted to fully online via EDGE"
    r'|\bminor\s+in\b'                        # "Minor in Creative Writing"
    r'|\bhalf[\s-]?major\b'                   # "Half Major, Applied Creative Writing"
    r'|\bpost[\s-]?baccalaureate\b'           # "Post Baccalaureate Certificate – Pre-Dental"
    r'|\bug\s+concentration\b'               # "UG Concentration in Regulatory Affairs"
    r'|\bundergrad\s+(certificate|concentration)\b'  # "Undergrad Certificate in Addiction Counseling"
    r'|\bcredentialed?\s+learning\b'         # "Participatory Practices credentialed learning pathway"
    r'|\bexit[\s-]?only\s+degree\b'          # "Proposal for an Exit-Only Degree Program"
    r'|pre[\s-]?dental\b'                    # "Pre-Dental" (extends pre-nursing/college/med)
    r'|\bgis\s+at\b'                         # "GIS at Northeastern"
    r'|badging\b'                            # "Global Leadership Summit badging"
    r'|\binactivate\b'                       # "Inactivate EdD in Workplace Learning"
    r'|\bsuspension\s+of\b'                  # "Suspension of MPS Insurance Analytics"
    r'|\bdeactivation\b'                     # "Global Health and Nutrition Cert deactivation"
    r'|\bworkforce\s+development\b'          # "Energy workforce development"
    r'|\bsummer[\s-]?in\b'                   # "SummerIn Portland"
    r'|\bproficiency\s+course\b'             # "Online English Proficiency Course"
    r'|\bcourses\s*\('                       # "Security Ops Center Courses (AAI 0500-0509)"
    r'|\bpre[\s-]?college\b'                 # "Pre-College" / "Pre-CollEDGE"
    r'|\bsurvey\b'                           # "Doctor of Law & Policy Survey"
    r'|\blaunch\s+of\s+the\b'               # "Launch of the MFA in X" (status update, not program)
    r')\b',
    re.I
)

# Raw course codes like "ALY 6040" or "RGA 1234"
_COURSE_CODE_RE = re.compile(r'^[A-Z]{2,5}\s+\d{4}\b', re.I)

# Multi-program bundle: two or more degree tokens around "and" (e.g. "MSIS and MSIS Bridge",
# "MS CEE and MS BIOE in TOR").  Requires the SAME short degree token to appear at least twice,
# OR two different well-known short degrees around "and".
_MULTI_PROG_DEGREE_TOKENS = (
    r'MS|MA|MBA|MFA|MPH|MPS|MPA|MEd|MArch|MDes|MSCS|MSIS|MSOR|MSECE|MSCP|MSML|MSBA|'
    r'DNP|DPT|EdD|PhD|JD|LLM|DPS|DLP|BS|BA|BFA|BArch|CAGS'
)
_MULTI_PROG_DEGREE_RE = re.compile(
    r'\b(' + _MULTI_PROG_DEGREE_TOKENS + r')\b'
    r'.+?\band\b.+'
    r'\b(' + _MULTI_PROG_DEGREE_TOKENS + r')\b',
    re.I
)


def _is_non_program(name):
    """Return True if the entry is clearly not an academic degree program."""
    if _NON_PROGRAM_RE.search(name):
        return True
    if _COURSE_CODE_RE.match((name or '').strip()):
        return True
    # Semicolon-separated bundle entries list multiple programs and are not a single degree
    if ';' in (name or ''):
        return True
    # Two degree tokens with "and" between them → multi-program bundle
    # (e.g. "MSIS and MSIS Bridge In Miami", "MS CEE and MS BIOE in TOR")
    if _MULTI_PROG_DEGREE_RE.search(name or ''):
        return True
    return False


# Non-programs that are completely silent — don't report them in the non_programs list.
# These are recurring process artifacts or multi-program bundles with no actionable tracking
# implication. They already pass _is_non_program(); this second gate just drops them from
# the console output so they stop cluttering the report.
_SILENT_NON_PROGRAM_RE = re.compile(
    r';'                                # multi-program semicolon bundles
    r'|\binactivate\b'                  # "Inactivate EdD in ..."
    r'|\bdeactivation\b'               # "Global Health and Nutrition Cert deactivation"
    r'|\bsuspension\s+of\b'            # "Suspension of MPS Insurance Analytics"
    r'|\bexit[\s-]?only\s+degree\b'    # "Exit-Only Degree Program"
    r'|\blaunch\s+of\s+the\b'          # "Launch of the MFA in X"
    r'|\band/or\b',                    # "Executive MBA and/or MS Management"
    re.I
)


def _is_silent_non_program(name):
    """Return True for non-programs that should be completely dropped (not listed at all)."""
    if _SILENT_NON_PROGRAM_RE.search(name or ''):
        return True
    # Multi-degree bundles like "MS CEE and MS BIOE in TOR", "MSIS and MSIS Bridge In Miami"
    if _MULTI_PROG_DEGREE_RE.search(name or ''):
        return True
    return False


# Regex to find known campus names in a program name string
_CAMPUS_FIND_RE = re.compile(
    r'\b(Boston|Oakland|Portland|Toronto|Seattle|Miami|Arlington|'
    r'Vancouver|Charlotte|London|Silicon Valley|Online)\b',
    re.I
)


def _expand_multi_campus(name, source_campus=''):
    """If a name mentions multiple campus names, return one (skeleton_name, campus) per campus.

    Handles patterns like:
      "Urban Analytics, Boston, Arlington and Oakland, Graduate Certificate"
      → [("Urban Analytics, Graduate Certificate", "Boston"),
         ("Urban Analytics, Graduate Certificate", "Arlington"),
         ("Urban Analytics, Graduate Certificate", "Oakland")]

    "Degree in Subject in CampusA and CampusB"
      → [("Degree in Subject", "CampusA"), ("Degree in Subject", "CampusB")]

    Returns [(name, source_campus)] unchanged if fewer than 2 campus names found.
    """
    s = name.strip()
    # Don't expand if campus already in parens — that's a single campus marker
    s_check = re.sub(r'\([^)]+\)', '', s)

    hits = list(_CAMPUS_FIND_RE.finditer(s_check))
    if len(hits) < 2:
        return [(name, source_campus)]

    campuses = [h.group(0) for h in hits]

    # Remove all campus name occurrences from the string, plus adjacent connectors
    # ("and", ",", "in") to get the program skeleton.
    skeleton = s_check
    # Remove ", CampusName" / "CampusName," / " and CampusName" / "in CampusName" patterns
    for campus in campuses:
        skeleton = re.sub(
            r'(?:,\s*|\s+(?:and|in)\s+)' + re.escape(campus) + r'\b',
            '', skeleton, flags=re.I)
        skeleton = re.sub(
            r'\b' + re.escape(campus) + r'(?:\s*,|\s+(?:and|in)\b)?',
            '', skeleton, flags=re.I)
    # Clean up orphaned separators and whitespace
    skeleton = re.sub(r',\s*,', ',', skeleton)
    skeleton = re.sub(r',\s*(and|or|in)\s*,', ',', skeleton, flags=re.I)
    skeleton = re.sub(r'\s+(and|or|in)\s*$', '', skeleton, flags=re.I)
    skeleton = re.sub(r'^\s*(and|or|in)\s+', '', skeleton, flags=re.I)
    skeleton = re.sub(r'\s{2,}', ' ', skeleton)
    skeleton = skeleton.strip(' ,').strip()

    if not skeleton:
        return [(name, source_campus)]

    return [(skeleton, c) for c in campuses]


def _normalize_campus(campus):
    """Resolve campus code abbreviations to full names.

    All online variants — 'Online', 'Primarily Online', 'Online - <anything>',
    'Primarily Online - <anything>' — collapse to a single 'Online' campus.
    The Portfolio treats every online deployment as one campus regardless of
    suffix annotations; explicit map entries in _CAMPUS_NAMES handle the
    known variants, and the lowercase prefix check below catches any new
    online suffixes a future CIM/IPD/SVT change might introduce.
    """
    c = (campus or '').strip()
    mapped = _CAMPUS_NAMES.get(c, c)
    if mapped:
        low = mapped.lower()
        if low.startswith('online') or low.startswith('primarily online'):
            return 'Online'
    return mapped or 'Boston'


# Canonical college names used in CIM's XML <college> field. External feeds
# (SVT roster, IPD smartsheet, OTP) often supply abbreviated forms or—worse—
# leak unrelated column values into the college slot. _normalize_college()
# rewrites known abbreviations to the canonical full name and drops obvious
# garbage so the Portfolio College dropdown stops accumulating duplicates and
# bogus options like "Deploy Program to Network".
_COLLEGE_ALIASES = {
    # Khoury
    'khoury':                                'Khoury Coll of Comp Sciences',
    'khoury college':                        'Khoury Coll of Comp Sciences',
    'khoury college of computer sciences':   'Khoury Coll of Comp Sciences',
    'khoury coll of comp sciences':          'Khoury Coll of Comp Sciences',
    'khy':                                   'Khoury Coll of Comp Sciences',
    # Bouve
    'bouve':                                 'Bouve College of Hlth Sciences',
    'bouve college':                         'Bouve College of Hlth Sciences',
    'bouve college of health sciences':      'Bouve College of Hlth Sciences',
    'bouve college of hlth sciences':        'Bouve College of Hlth Sciences',
    'bve':                                   'Bouve College of Hlth Sciences',
    # CPS
    'cps':                                   'Coll of Professional Studies',
    'college of professional studies':       'Coll of Professional Studies',
    'coll of professional studies':          'Coll of Professional Studies',
    # CSSH
    'cssh':                                  'Coll of Soc Sci & Humanities',
    'college of social sciences and humanities': 'Coll of Soc Sci & Humanities',
    'coll of soc sci & humanities':          'Coll of Soc Sci & Humanities',
    # CAMD
    'camd':                                  'Coll of Arts, Media & Design',
    'college of arts media and design':      'Coll of Arts, Media & Design',
    'coll of arts, media & design':          'Coll of Arts, Media & Design',
    # COS
    'cos':                                   'College of Science',
    'college of science':                    'College of Science',
    # COE
    'coe':                                   'College of Engineering',
    'college of engineering':                'College of Engineering',
    # DMSB
    'dmsb':                                  "D'Amore-McKim School Business",
    'damore-mckim':                          "D'Amore-McKim School Business",
    "d'amore-mckim school business":         "D'Amore-McKim School Business",
    "d'amore-mckim school of business":      "D'Amore-McKim School Business",
    # School of Law
    'sol':                                   'School of Law',
    'law':                                   'School of Law',
    'school of law':                         'School of Law',
    # Mills
    'mcnu':                                  'Mills College at NU',
    'mills':                                 'Mills College at NU',
    'mills college at nu':                   'Mills College at NU',
    'mills college at northeastern':         'Mills College at NU',
    # Provost — includes University Interdisciplinary Program (UIP), which
    # is administratively housed under the Provost's office.
    'provost':                               'Office of the Provost',
    'office of the provost':                 'Office of the Provost',
    'uip':                                                'Office of the Provost',
    'university interdisciplinary program':               'Office of the Provost',
    'university interdisciplinary program (uip)':         'Office of the Provost',
}

# Values that are definitely NOT colleges — IPD proposal-type values, campus
# names, and similar mismaps that have leaked into the college field. These
# are blanked at normalization time so they never reach the dropdown.
_COLLEGE_BLOCKLIST = {
    'deploy program to network',
    'launch term change request',
    'new program',
    'change',
    'inactivation',
    'nu-london',
    'london',
    'boston',
    'oakland',
    'portland',
    'seattle',
    'miami',
    'charlotte',
    'arlington',
    'toronto',
    'vancouver',
    'silicon valley',
    'new york',
}


# ---------------------------------------------------------------------------
# Inactivation-of-Admission helpers
# ---------------------------------------------------------------------------
# A program's "Inactivation of Admission" semester is the first term in which
# the program will no longer admit new students — derived from the catalog
# year of the inactivation proposal. "Catalog 2026-2027" → "Fall 2026".
# The Portfolio's Admitting Today column compares this against today's date.

def _eff_cat_to_semester(eff_cat):
    """Convert a CIM catalog-year string to 'Fall YYYY'.

    Accepts raw '2026-2027', full 'Catalog 2026-2027', or plain '2026'.
    Returns '' when the value can't be parsed.
    """
    if not eff_cat:
        return ''
    s = re.sub(r'^[Cc]atalog\s*', '', eff_cat.strip())
    m = re.match(r'^(\d{4})[–\-]\d{4}$', s)
    if m:
        return f'Fall {m.group(1)}'
    m2 = re.match(r'^(\d{4})$', s)
    if m2:
        return f'Fall {m2.group(1)}'
    return ''


def _best_eff_cat(eff_cat, completion_date, cim_step=''):
    """Return the best available catalog-year string from multiple sources.

    Priority:
      1. completion_date with catalog year (most authoritative — comes from
         the actual Catalog Setup step).
      2. Year embedded in cim_step name (used when program is still in workflow).
      3. eff_cat from CIM XML.
    """
    if completion_date:
        m = re.search(r'(\d{4}[–\-]\d{4})', completion_date)
        if m:
            return m.group(1)
    if cim_step:
        m = re.search(r'(\d{4})[–\-](\d{2,4})', cim_step)
        if m:
            yr = m.group(2)
            return m.group(1) + '-' + (yr if len(yr) == 4 else str(int(m.group(1)) // 100) + yr)
    if eff_cat:
        return eff_cat
    return ''


# ── Portfolio data-quality framework ──────────────────────────────────────
# Restored from commit 9fbab3e (and its predecessors) which was wiped by the
# 79de674 ingest rewrite. Drives REMOVE / RENAME / Roux-strip / explicit
# concentration parent-linking / synthetic-parent creation so every
# concentration row ends up nested under a real or synthesized parent.

_ABBREV_MAP = [
    (r'\s*&\s*',      ' and '),
    (r'\bmgmt\b',     'management'),
    (r'\bsci\b',      'science'),
    (r'\bsciences\b', 'science'),
    (r'\bsvcs\b',     'services'),
    (r'\badmin\b',    'administration'),
    (r'\benvrnt\b',   'environment'),
    (r'\benv\b',      'environment'),
    (r'\bsustain\b',  'sustainable'),
    (r'\bapp\b',      'applied'),
    (r'\brehab\b',    'rehabilitation'),
    (r'\binfo\b',     'information'),
    (r'\bintl\b',     'international'),
    (r'\bsoc\b',      'social'),
    (r'\beduc\b',     'education'),
    (r'\bquant\b',    'quantitative'),
    (r'\binnov\b',    'innovation'),
    (r'\bcomm\b',     'communication'),
    (r'\bchem\b',     'chemistry'),
    (r'\bsystems\b',  'system'),
]
_ABBREV_RE = [(re.compile(p, re.I), r) for p, r in _ABBREV_MAP]

# Deployment-variant suffixes to strip before core comparison
_DEPLOY_SUFFIX = re.compile(
    r'[\s,]*[-—]?\s*(align|connect|bridge|accelerated|part.?time)\b.*$', re.I)

# Leading "DEGREE in/of X" form
_DEGREE_PREFIX = re.compile(
    r'^(ms|ma|mps|mpa|mph|mba|mfa|med|mem|march|mdes|mscs|msis|msor|msfmba|msece|'
    r'msene|mssbs|dnp|dpt|dmsc|edd|phd|jd|llm|dlp|bs|ba|bfa|barch|bsn|bsba|bscf|'
    r'certg?|mat|mbe)\s+(?:in\s+|of\s+)?(.+)$', re.I)

# Concentration parent-name patterns
_CONC_WITH = re.compile(
    r'^(.+?)\s+with\s+(?:a\s+)?Concentration\s+in\s+[^,]+,\s+([A-Z][^\s(,]+(?:\s*\([^)]+\))?)\s*$',
    re.I)
_CONC_DASH = re.compile(
    r'^(.+?)\s*[-—]\s*[^-—,]+?\s+Concentration,?\s+([A-Z][^\s(,]+(?:\s*\([^)]+\))?)\s*$',
    re.I)


def _expand_abbrevs(s):
    for pat, repl in _ABBREV_RE:
        s = pat.sub(repl, s)
    return s


def _degree_core(name):
    """Normalized key with degree but no campus/deployment suffix.
    'MS Computer Science' and 'Computer Science, MS (Boston)' both produce
    'computer science, ms'."""
    s = _norm(name).replace('—', '-').replace('–', '-')
    s = re.sub(r'\([^)]*\)', '', s)
    s = _DEPLOY_SUFFIX.sub('', s)
    s = re.sub(r'\bgraduate\s+certificate\b', 'certg', s, flags=re.I)
    s = re.sub(r'\bmaster\s+of\s+\w+(\s+(in|of))?\s*', 'ms ', s, flags=re.I)
    s = _expand_abbrevs(s)
    m = _DEGREE_PREFIX.match(s.strip())
    if m:
        deg, rest = m.group(1).lower(), m.group(2).strip()
        s = f"{rest}, {deg}"
    return re.sub(r'\s+', ' ', s).strip().rstrip(',').strip()


def _extract_parent_name(name):
    """Extract a parent program name from a concentration name, or None."""
    m = _CONC_WITH.match(name)
    if m:
        return f"{m.group(1).strip()}, {m.group(2).strip()}"
    m = _CONC_DASH.match(name)
    if m:
        return f"{m.group(1).strip()}, {m.group(2).strip()}"
    # "X with <Anything> Concentration, DEG" — adjective form
    # e.g. "International Affairs with African Studies Concentration, BA"
    m = re.match(
        r'^(.+?)\s+with\s+[^,]+?\s+Concentration,?\s+([A-Z][A-Za-z0-9\-]*)\s*(?:\([^)]+\))?\s*$',
        name, re.I)
    if m:
        return f"{m.group(1).strip()}, {m.group(2).strip()}"
    # "Concentration in X - DEG" / "Concentration in X, DEG"
    # e.g. "Concentration in Health Care Management & Policy - MPP"
    m = re.match(
        r'^Concentration\s+in\s+(.+?)\s*[-—,]\s*([A-Z][A-Za-z0-9\-]*)\s*$',
        name, re.I)
    if m:
        return f"{m.group(1).strip()}, {m.group(2).strip()}"
    # "X and concentrations, DEG" / "X and concentration, DEG"
    m = re.match(
        r'^(.+?)\s+and\s+concentrations?,\s+([A-Z][A-Za-z0-9\-]*)\s*$',
        name, re.I)
    if m:
        return f"{m.group(1).strip()}, {m.group(2).strip()}"
    # "X, concentration in Y, DEG" (with extra comma)
    # e.g. "Journalism and Art, with a concentration in Visual Studies"
    m = re.match(
        r'^(.+?)\s*,\s*with\s+(?:a\s+)?concentration\s+in\s+',
        name, re.I)
    if m:
        return m.group(1).strip()
    # "X (... concentration ...), DEG" / "X (new concentration in Y), DEG"
    m = re.match(
        r'^(.+?)\s*\(\s*[^)]*concentration[^)]*\)\s*,\s*([A-Z][A-Za-z0-9\-]*)\s*$',
        name, re.I)
    if m:
        return f"{m.group(1).strip()}, {m.group(2).strip()}"
    # "X, ... concentration, DEG" / "X concentration Bridge Program, MS"
    m = re.match(
        r'^(.+?)[\s,]+[^,]+?\s+concentration\b[^,]*,\s+([A-Z][A-Za-z0-9\-]*)\s*(?:\([^)]+\))?\s*$',
        name, re.I)
    if m:
        return f"{m.group(1).strip()}, {m.group(2).strip()}"
    return None


# Program names to exclude entirely (descriptive notes, course codes, fragments).
_PORTFOLIO_REMOVE = frozenset({
    'AI (New COE Concentration in High Performance and Edge AI), MS',
    'Healthcare program expansion to Saudi Arabia',
    'Half-Major in Sustainability Studies',
    'Jewish Community Chaplaincy on Campus',
    'Queens University Gift City India Expansion',
    'Research-aligned MSs at Roux: MS Robotics',
    'and Concentration, Medical Science Liaison, Graduate Certificate',
    'INPR 0399 : Leadership for Sustainability',
    'ALY 6983 Special Topics: AI for Cybersecurity',
    'RGA 0500 : Artificial Intelligence (AI) in Regulatory Sciences',
    'Cybersecurity Microcredential Badges (non-credit levels 1-3)',
    'Future You: Leveraging AI for Success - EM EDGE Badge',
    'Global Leadership Summit badging',
    'Entrepreneurship Boot Camp',
    'Global Pathways in Portland (Khoury, CPS)',
    'Pre-College Online Program',
    'SummerIn Portland: Innovating to Address Complex Health Challenges',
    'University of Philippines Global Campus partnership',
    'AI CERT in SV',
})

# Exact name → (corrected_name, college_override, campus_override). '' keeps existing.
_PORTFOLIO_RENAME = {
    'Data Science, MS - new CAMD concentration':
        ('Data Science, MS', 'Office of the Provost', ''),
    'AI (New COE Concentration in Human-AI Collaboration), MS':
        ('Artificial Intelligence, MS', 'College of Engineering', ''),
    'Computational Creativity Concentration for UIP Masters in AI':
        ('Computational Creativity, MS', 'Office of the Provost', ''),
    'Doctor of Professional Studies at Roux':
        ('Professional Studies, DPS', 'Coll of Professional Studies', 'Portland'),
    'at Roux, EDD':
        ('Education, EdD', '', 'Portland'),
    'and MSIS Bridge In Miami, MSIS':
        ('Information Systems, MSIS (Bridge)', '', 'Miami'),
    'Artificial Intelligence - Omics Concentration (COS), MS':
        ('Omics', 'College of Science', 'Boston'),
    'AI (new concentration) Bouve, MS':
        ('Bouve Health AI', 'Bouve College of Hlth Sciences', 'Boston'),
    'Data Science - CAMD Concentration, MS':
        ('Data Science, MS', 'Coll of Arts, Media & Design', 'Boston'),
    'Data Science - Health Data concentration, MS':
        ('Data Science, MS', 'Office of the Provost', 'Boston'),
}

_ROUX_RE = re.compile(r'\s+at\s+Roux\b|\s*,?\s*\(for\s+Maine\)\s*', re.I)

# Explicit concentration-parent regex mappings.
# (pattern, parent_program_name, campus_override_or_None)
_EXPLICIT_CONC_PARENTS = [
    (re.compile(r'^Business Concentration in ', re.I),
     'Business Administration, BSBA', 'Boston'),
    (re.compile(r'^Political Science Concentration in ', re.I),
     'Political Science, BA', 'Boston'),
    (re.compile(r'^Electrical and Computer Engineering with Concentration in .+MSECE', re.I),
     'Electrical and Computer Engineering, MSECE', None),
    (re.compile(r'^Mechanical Engineering with Concentration in .+MSME', re.I),
     'Mechanical Engineering, MSME', None),
    (re.compile(r'^Electrical Engineering and Music with Concentration in .+BSEE', re.I),
     'Electrical Engineering and Music, BSEE', 'Boston'),
    # Bioengineering concentration variants — both the "Master of Science in
    # Bioengineering, concentration in X" and "Bioengineering, concentration
    # in X" forms (also "Bioengineering X Concentration Bridge Program").
    (re.compile(r'^(?:Master of Science in\s+)?Bioengineering[,\s]+concentration in ', re.I),
     'Bioengineering, MS', None),
    (re.compile(r'^Bioengineering\s+.+?\s+Concentration\b', re.I),
     'Bioengineering, MS', None),
    # Civil Engineering MSCivE concentrations whose concentration phrase has
    # internal commas (regex extraction fails on these).
    (re.compile(r'^Civil Engineering with Concentration in .+,\s*MSCivE\b', re.I),
     'Civil Engineering, MSCivE', None),
    (re.compile(r'^UG Concentration in ', re.I),
     'Regulatory Affairs, BS', 'Boston'),
    (re.compile(r'^Omics$', re.I),
     'Artificial Intelligence, MS', 'Boston'),
    (re.compile(r'^Bouve Health AI$', re.I),
     'Artificial Intelligence, MS', 'Boston'),
    # "AI - X Concentration, MS" → AI MS (the canonical Boston program;
    # synonym 'AI' for 'Artificial Intelligence').
    (re.compile(r'^AI\s*[-—,]\s*.+?\s+Concentration\b', re.I),
     'Artificial Intelligence, MS', 'Boston'),
]


# Concentration headings to skip — purely structural / generic.
_CONC_SKIP = re.compile(
    r'^concentrations?$'
    r'|^concentrations?\s+(or|and|for\s+all|options?|courses?|list)\b'
    r'|\bconcentration\s+(courses?|list|options?|requirements?)\b'
    r'|\bconcentration\s+or\s+'
    r'|\b(without|no)\s+concentration\b'
    r'|\(without\s+concentration\)'
    r'|^excluded\s+courses'
    r'|^coursework\s+option\b',
    re.I
)


def _extract_concentrations_from_html(html):
    """Return sorted list of named concentration names from CIM curriculum HTML.

    Walks the program's curriculum h2/h3/h4 headings, keeps the ones with the
    word "concentration", and normalizes them into the concentration name
    itself (stripping prefixes like "Optional Concentration in", suffixes
    like "Concentration(s)" / "(Optional)" / college attributions).
    """
    if not html:
        return []
    headings = re.findall(r'<h[234][^>]*>(.*?)</h[234]>', html, re.I | re.S)
    results = []
    seen = set()
    for raw in headings:
        h = re.sub(r'<[^>]+>', '', raw).replace('\xa0', ' ').strip()
        h = re.sub(r'\s+', ' ', h).strip()
        if 'concentration' not in h.lower():
            continue
        if _CONC_SKIP.search(h):
            continue
        h = re.sub(r'\s*[—]\s*\S.*College.*$', '', h).strip()
        h = re.sub(r'\s*\([Oo]ptional\)$', '', h).strip()
        h = re.sub(r'\s*\([Rr]equired\)$', '', h).strip()
        h = h.rstrip('*† ').strip()
        m = re.match(r'^(?:optional\s+)?concentration\s+in\s+(.+)$', h, re.I)
        if m:
            h = m.group(1).strip()
        elif re.search(r'\bwith\s+a?\s*concentration\s+in\s+', h, re.I):
            h = re.sub(r'^.*\bwith\s+a?\s*concentration\s+in\s+', '', h, flags=re.I).strip()
        elif re.search(r'\bconcentrations?$', h, re.I):
            h = re.sub(r'\s*\bconcentrations?\s*$', '', h, flags=re.I).strip()
        else:
            if re.match(r'^concentration\s', h, re.I):
                continue
        if h and h.lower() not in seen:
            seen.add(h.lower())
            results.append(h)
    return results


def _normalize_college(college):
    """Canonicalize a college name.

    - Maps known abbreviations and variant spellings to the canonical full
      name used by CIM's XML <college> field.
    - Returns '' for values on the blocklist (IPD proposal-type leaks, campus
      names, etc.) so they don't appear in the College filter dropdown.
    - Returns the input unchanged for anything else (e.g.
      "University Interdisciplinary Program (UIP)" which is legitimate).
    """
    c = (college or '').strip()
    if not c:
        return ''
    key = c.lower()
    if key in _COLLEGE_BLOCKLIST:
        return ''
    return _COLLEGE_ALIASES.get(key, c)


def _norm_campus(campus):
    """Normalized campus for index key (lowercase)."""
    return _normalize_campus(campus).lower()


def _norm_degree(degree_str):
    """Normalize a degree token to a canonical uppercase short form.

    Handles:
      'Master of Science' → 'MS'
      'M.S.' → 'MS'
      'Ph.D.' → 'PhD'
      'ms' → 'MS'
      'graduate certificate' → 'Graduate Certificate'
      'MSCS' → 'MSCS'  (specific degrees NOT remapped to generic)
    """
    s = (degree_str or '').strip()
    # Remove internal dots: "M.S." → "MS", "Ph.D." → "PhD"
    s_nodots = re.sub(r'\.', '', s)
    # Normalize em-dash/en-dash to hyphen so "MS—Align" and "MS-Align" produce the same key
    s_nodots = re.sub(r'[—–]', '-', s_nodots)
    # Try long-form first
    for pat, short in _LONG_DEGREE_MAP:
        if pat.match(s):
            # Return Graduate Certificate as-is (has a space)
            return short
    # Short form: uppercase only
    upper = s_nodots.upper()
    # Special case: "GRADUATE CERTIFICATE" → "Graduate Certificate"
    if upper in ('GRADUATE CERTIFICATE', 'GRADCERT', 'CERTG', 'CERT'):
        return 'Graduate Certificate'
    # Canonical mixed case for degrees CIM displays that way.
    # Keeps SVT/IPD-added rows reading "X, PhD (Oakland)" instead of "X, PHD".
    _CASE_MAP = {
        'PHD': 'PhD', 'EDD': 'EdD', 'MED': 'MEd', 'MARCH': 'MArch',
        'MDES': 'MDes', 'MENG': 'MEng', 'BARCH': 'BArch',
        'PHARMD': 'PharmD', 'DMSC': 'DMSc',
    }
    if upper in _CASE_MAP:
        return _CASE_MAP[upper]
    return upper if upper else s


# Campus names that should never be treated as degree codes (e.g., "OAKLAND" is all-caps
# letters and would otherwise pass the degree regex).
_DEGREE_BLOCKLIST = frozenset({
    'boston', 'oakland', 'portland', 'toronto', 'seattle', 'miami', 'arlington',
    'vancouver', 'charlotte', 'london', 'online', 'roux',
    'silicon', 'valley',  # "Silicon Valley" split
    'new', 'old', 'bridge', 'align', 'connect',  # common descriptor tokens
})


def _is_valid_degree(degree_str):
    """Return True only for recognizable academic degree codes or Graduate Certificate.

    Valid: 'MS', 'PhD', 'LLM', 'BS', 'MFA', 'MSCS', 'Graduate Certificate', 'DNP'
    Invalid: '' (empty), 'NEW CAMD CONCENTRATION', 'OCCUPATIONAL THERAPY',
             'APPLIED CREATIVE WRITING', 'OAKLAND AND BOSTON', 'STEM DESIGNATED'
    """
    normed = _norm_degree(degree_str)
    if normed.lower() == 'graduate certificate':
        return True
    # Reject campus/location/descriptor names that happen to be all-caps letters
    if normed.lower() in _DEGREE_BLOCKLIST:
        return False
    # Allow hyphenated deployment suffixes like "MS-ALIGN", "MPS-CONNECT", "MSIS-BRIDGE".
    # Accept mixed-case CIM convention degrees (PhD, EdD, MEd, MArch, MDes, MEng,
    # BArch, PharmD, DMSc) by matching case-insensitively but requiring a leading
    # uppercase letter.
    return bool(re.match(r'^[A-Z][A-Za-z0-9]{1,9}(-[A-Za-z][A-Za-z0-9-]*)?$', normed))


def _norm_subject(subject_str):
    """Normalize a subject string for index key lookup."""
    s = (subject_str or '').strip()
    # em-dash/en-dash → hyphen
    s = re.sub(r'[—–]', '-', s)
    # & → and (OTP and other sources use & instead of 'and')
    s = re.sub(r'\s*&\s*', ' and ', s)
    # collapse whitespace
    s = re.sub(r'\s+', ' ', s).strip()
    return s.lower()


def _parse_cim_name(full_name):
    """Parse a CIM name 'Subject, Degree (Campus)' into components.

    Returns (subject, degree, campus) — all raw strings.
    Campus defaults to '' (meaning Boston) when absent.
    """
    name = (full_name or '').strip()
    # Extract campus from trailing parens
    campus = ''
    m = re.search(r'\(([^)]+)\)\s*$', name)
    if m:
        campus = m.group(1).strip()
        name = name[:m.start()].strip()

    # Find last comma to split subject and degree
    idx = name.rfind(',')
    if idx >= 0:
        subject = name[:idx].strip()
        degree  = name[idx+1:].strip()
    else:
        subject = name
        degree  = ''

    return subject, degree, campus


def _parse_external_name(name_raw):
    """Parse an external (OTP/IPD/SVT) program name into (subject, degree, campus).

    Tries in order:
      1. Long-form prefix: "Master of Science in X (Campus)" → (X, MS, Campus)
      2. Short prefix: "MS X (Campus)" → (X, MS, Campus)
      3. CIM format: "X, MS (Campus)" → (X, MS, Campus)
      4. Fallback: (full_name, '', campus_if_any)

    Campus extraction: from trailing parens OR trailing ", CampusName" suffix.
    """
    s = (name_raw or '').strip()

    # Extract campus from trailing parens first
    campus = ''
    m = re.search(r'\(([^)]+)\)\s*$', s)
    if m:
        paren_val = m.group(1).strip()
        # Check if it looks like a campus (not a degree annotation like "(DE)")
        if _norm_campus(paren_val) not in ('', paren_val.lower()) or paren_val in _CAMPUS_NAMES:
            campus = paren_val
            s = s[:m.start()].strip()
        elif re.match(r'^(Boston|Oakland|Portland|Toronto|Seattle|Miami|Arlington|'
                      r'Vancouver|Charlotte|London|Silicon Valley|Online|Primarily Online)$',
                      paren_val, re.I):
            campus = paren_val
            s = s[:m.start()].strip()

    # Extract campus from trailing ", CampusName" if not already found
    if not campus:
        campus_trail_re = re.compile(
            r',\s*(Boston|Oakland|Portland|Toronto|Seattle|Miami|Arlington|'
            r'Vancouver|Charlotte|London|Silicon Valley|Online|Primarily Online)\s*$',
            re.I)
        mt = campus_trail_re.search(s)
        if mt:
            campus = mt.group(1)
            s = s[:mt.start()].strip()

    # Strip "at Roux" suffix — "Bioengineering at Roux, MS" → "Bioengineering, MS" + campus=Portland
    roux_m = re.search(r'\s+at\s+Roux\b', s, re.I)
    if roux_m and not campus:
        s = s[:roux_m.start()] + s[roux_m.end():]
        campus = 'Portland'

    # Pre-normalize: remove dots from leading degree tokens.
    # Handles both "Ph.D" and "Ph.D." (trailing dot optional) so the
    # subsequent _SHORT_DEGREE_PREFIX_RE can recognise "Ph.D. in X".
    s_nodot = re.sub(r'^([A-Za-z]{1,6}(?:\.[A-Za-z]{1,3})+\.?)(\s)',
                     lambda m: re.sub(r'\.', '', m.group(1)) + m.group(2), s)
    if s_nodot != s:
        s = s_nodot

    # Try long-form degree prefix
    for pat, short_deg in _LONG_DEGREE_MAP:
        mm = pat.match(s)
        if mm:
            subj = s[mm.end():].strip().strip(',').strip()
            # Strip leading "- descriptor" (e.g. "- New Concentrations" → "")
            subj = re.sub(r'^[-–—]\s*.+$', '', subj).strip()
            # Use implicit subject for degrees that stand alone without a subject
            if not subj and short_deg in _DEGREE_IMPLICIT_SUBJECT:
                subj = _DEGREE_IMPLICIT_SUBJECT[short_deg]
            return subj, short_deg, campus

    # Try short degree prefix: "MS Computer Science"
    mm = _SHORT_DEGREE_PREFIX_RE.match(s)
    if mm:
        deg  = _norm_degree(mm.group(1))
        subj = mm.group(2).strip().strip(',').strip()
        # Move deployment suffix from subject to degree:
        # "Data Science - Align" + "MS" → subject="Data Science", degree="MS-Align"
        deploy_m = _DEPLOYMENT_SUFFIX_RE.search(subj)
        if deploy_m:
            dep = deploy_m.group(1).capitalize()
            subj = subj[:deploy_m.start()].strip()
            deg = f"{deg}-{dep}"
        return subj, deg, campus

    # CIM format: "Subject, Degree" (also handles "Degree, Subject" swap)
    idx = s.rfind(',')
    if idx >= 0:
        subj    = s[:idx].strip()
        deg_raw = s[idx+1:].strip()
        # Strip "- descriptor" suffix from degree field
        # e.g. "MS - new CAMD concentration" → "MS"
        deg_clean = re.sub(r'\s*[-–—]\s*.+$', '', deg_raw).strip()
        deg = _norm_degree(deg_clean)
        # Detect swapped format: "DEGREE, Subject" (e.g. "MS, Occupational Therapy")
        # If the "subject" part parses as a valid degree and the "degree" part does not, swap.
        if _is_valid_degree(subj) and not _is_valid_degree(deg_clean):
            subj, deg = deg_raw.strip(), _norm_degree(subj)
        # If the trailing degree position holds non-degree annotation
        # (e.g. "One Year MBA, STEM designated"), scan the subject for an
        # embedded degree code and use that.
        elif not _is_valid_degree(deg_clean):
            emb = re.search(r'\b(MBA|MS|MA|MFA|MPS|MPA|MPP|MPH|MEd|MArch|MDes|MSCS|MSIS|MSBA|MEng|MSW|LLM|BS|BA|BFA|BSN|PhD|EdD|DNP|DPT|JD|CAGS)\b', subj)
            if emb:
                # Move the embedded degree out of subject; the remainder is
                # the program qualifier (e.g. "One Year" for "One Year MBA")
                rest = (subj[:emb.start()] + subj[emb.end():]).strip().strip(',').strip()
                deg = _norm_degree(emb.group(1))
                subj = rest if rest else emb.group(1)
        return subj, deg, campus

    # "Subject Graduate Certificate" / "Subject Certificate" format (degree at end without a comma).
    # NU's "Graduate Certificate" credential is often referred to externally as just "Certificate".
    _gc_trail = re.search(r'\s+(Graduate\s+Certificate|Certificate)\s*$', s, re.I)
    if _gc_trail:
        subj = s[:_gc_trail.start()].strip()
        return subj, 'Graduate Certificate', campus

    # "Subject DEGREE" format — degree at end without comma (e.g. "Network Science PhD")
    _trail_deg = re.search(
        r'\s+(PhD|PharmD|EdD|DNP|DPT|DPS|DLP|JD|LLM|MD|MBA|MFA|MPH|MPS|MPA|'
        r'MEd|MArch|MDes|MSCS|MSIS|MSECE|MSCP|MS|MA|BS|BA|BFA|BArch)\s*$', s, re.I)
    if _trail_deg:
        deg  = _norm_degree(_trail_deg.group(1))
        subj = s[:_trail_deg.start()].strip()
        if subj:
            return subj, deg, campus

    return s, '', campus


def _cim_index_keys(subject, degree, campus):
    """Return the primary key tuple for the CIM index."""
    return (_norm_subject(subject), _norm_degree(degree).lower(), _norm_campus(campus))


def _subject_degree_keys(subject, degree):
    """Return the (subject, degree) key for name+degree-only lookup."""
    return (_norm_subject(subject), _norm_degree(degree).lower())


def _jaccard_subject(subj_a, subj_b):
    """Word-overlap Jaccard similarity between two subject strings."""
    stop = {'', 'and', 'the', 'of', 'in', 'for', 'a', 'an', 'at', 'to', 'with'}
    def words(s):
        return set(w for w in re.split(r'[\W_]+', (s or '').lower()) if w and w not in stop)
    wa, wb = words(subj_a), words(subj_b)
    if not wa and not wb:
        return 1.0
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / len(wa | wb)


def _best_guess(subject, degree, cim_entries, prefer_campus=''):
    """Find the best CIM candidate by word-overlap on subject. Returns name or ''."""
    norm_deg = _norm_degree(degree).lower()
    norm_pref = _norm_campus(prefer_campus) if prefer_campus else ''
    best_name, best_score = '', 0.0
    for entry in cim_entries:
        if entry['degree_norm'] != norm_deg and norm_deg:
            continue
        score = _jaccard_subject(subject, entry['subject'])
        if norm_pref and _norm_campus(entry.get('campus', '')) == norm_pref:
            score += 0.01  # prefer matching campus when tied
        if score > best_score and score >= 0.4:
            best_score = score
            best_name = entry['program_name']
    if not best_name:
        for entry in cim_entries:
            score = _jaccard_subject(subject, entry['subject'])
            if norm_pref and _norm_campus(entry.get('campus', '')) == norm_pref:
                score += 0.01
            if score > best_score and score >= 0.4:
                best_score = score
                best_name = entry['program_name']
    return best_name


# ---------------------------------------------------------------------------
# Main ingest function
# ---------------------------------------------------------------------------

def ingest(xlsx_path=XLSX_PATH, tsv_path=TSV_PATH, roster_path=ROSTER_PATH, gls_path=GLS_PATH):
    """Seed from CIM, overlay SVT/IPD/OTP/GLS/scoring, write portfolio_programs."""
    from database import replace_all_portfolio_programs, get_db

    if not os.path.exists(xlsx_path):
        raise FileNotFoundError(f"OTP Excel not found: {xlsx_path}")

    now = datetime.now().isoformat()

    _EMPTY_TRACKING = {
        'otp_status': '', 'otp_sub_status': '', 'otp_market_potential': '',
        'otp_market_signal': '', 'otp_internal_performance': '',
        'otp_q3_status': '', 'otp_effective_term': '',
        'ipd_status': '', 'ipd_proposal_type': '', 'ipd_additional_college': '',
        'svt_status': '', 'roster_sub_status': '', 'roster_proposal_type': '',
        'roster_launch_date': '',
        'gls_status': '',
        'concentration_of': '',
        'concentrations_json': '',
        'market_2025': '',
        'performance_2025': '',
        'market_score_2025': '',
        'performance_score_2025': '',
        'cim_change_type': '',
        'inactivation_admission': '',
        'proposal_stage': '',
        'last_refreshed': now,
    }

    def _make_row(pid, program_name, college, campus, cim_id=None,
                  cim_step='', cim_completion_date='', cim_change_type=''):
        return dict(_EMPTY_TRACKING, **{
            'id':                  pid,
            'program_name':        program_name,
            'college':             _normalize_college(college),
            'campus':              campus or 'Boston',
            'cim_program_id':      cim_id,
            'cim_step':            cim_step,
            'cim_completion_date': cim_completion_date,
            'cim_change_type':     cim_change_type,
            'last_refreshed':      now,
        })

    # ── Step 0: Build CIM program list (seed) ────────────────────────────────
    # Query all programs (active + completed), deduplicate by name,
    # prefer active proposal; otherwise take highest id.
    _STATUS_LABEL = {'Added': 'New', 'Edited': 'Change', 'Deactivated': 'Inactivation'}
    with get_db() as conn:
        raw_rows = conn.execute("""
            SELECT id, name, college, current_step, completion_date, status, eff_cat
            FROM programs
            WHERE (current_step IS NOT NULL AND current_step != '')
               OR (completion_date IS NOT NULL AND completion_date != '')
        """).fetchall()

    # Deduplicate by name: prefer active, then highest id.
    # Skip TEMPLATE entries — these are CIM scaffolding rows ("TEMPLATE: PhD Program …",
    # "Half Major Template: …") that are never real programs and have been removed from
    # the portfolio repeatedly. Filter them out at ingest so they can't re-seed.
    _TEMPLATE_RE = re.compile(r'^\s*(template\s*:|half\s+major\s+template\s*:)', re.I)
    by_name = {}  # name → row
    for r in raw_rows:
        name = (r['name'] or '').strip()
        if not name:
            continue
        if _TEMPLATE_RE.match(name):
            continue
        existing = by_name.get(name)
        if existing is None:
            by_name[name] = r
        else:
            # Prefer active (has current_step)
            existing_active = bool(existing['current_step'])
            this_active = bool(r['current_step'])
            if this_active and not existing_active:
                by_name[name] = r
            elif this_active == existing_active:
                # Both same activity state — take highest id
                if r['id'] > existing['id']:
                    by_name[name] = r

    # Build tracker entries from deduplicated CIM rows
    # tracker: id → row dict
    tracker = {}
    # CIM index: (norm_subject, norm_degree, norm_campus) → row dict
    cim_exact_index = {}   # full 3-tuple key
    cim_nameDeg_index = {} # (norm_subject, norm_degree) → list of row dicts
    cim_entries_list = []  # flat list for best-guess fallback

    for r in by_name.values():
        name = r['name'] or ''
        subject, degree, campus = _parse_cim_name(name)
        campus_resolved = _normalize_campus(campus) if campus else 'Boston'
        change_type = _STATUS_LABEL.get(r['status'] or '', r['status'] or '')

        pid = f"cim_{r['id']}"
        row = _make_row(
            pid=pid,
            program_name=name,
            college=_normalize_college(r['college'] or ''),
            campus=campus_resolved,
            cim_id=r['id'],
            cim_step=r['current_step'] or '',
            cim_completion_date=r['completion_date'] or '',
            cim_change_type=change_type,
        )
        # Inactivation of Admission: first semester (Fall YYYY) when the
        # program will no longer admit new students. Derived from the
        # inactivation proposal's catalog year (CIM XML <eff_cat>, the
        # completion date, or the catalog-setup step name).
        if change_type == 'Inactivation':
            row['inactivation_admission'] = _eff_cat_to_semester(
                _best_eff_cat(r['eff_cat'] or '', r['completion_date'] or '', r['current_step'] or '')
            )
        tracker[pid] = row

        # Index by (subj, deg, campus)
        key3 = _cim_index_keys(subject, degree, campus_resolved)
        if key3 not in cim_exact_index:
            cim_exact_index[key3] = row

        # Index by (subj, deg) only — allows campus-agnostic lookup
        key2 = _subject_degree_keys(subject, degree)
        cim_nameDeg_index.setdefault(key2, []).append(row)

        cim_entries_list.append({
            'pid': pid,
            'program_name': name,
            'subject': subject,
            'degree': degree,
            'degree_norm': _norm_degree(degree).lower(),
            'campus': campus_resolved,
            'row': row,
        })

    n_cim_seed = len(tracker)

    def _lookup_cim(subject, degree, campus):
        """Look up a CIM row by (subject, degree, campus).
        Returns (row, match_type) where match_type is 'exact', 'name_deg', or None.
        """
        campus_resolved = _normalize_campus(campus) if campus else 'Boston'

        def _try(norm_subj, norm_deg_lower, norm_campus_str):
            k3 = (norm_subj, norm_deg_lower, norm_campus_str)
            if k3 in cim_exact_index:
                return cim_exact_index[k3], 'exact'
            k2 = (norm_subj, norm_deg_lower)
            cands = cim_nameDeg_index.get(k2, [])
            # Single-candidate name+degree match: only return it when the
            # caller's campus matches the candidate's campus, or when no
            # campus was specified (defaults to Boston). Avoids cases like
            # "Ph.D. in Computer Engineering, Oakland" being misattributed
            # to the Boston PhD when no Oakland version exists in CIM —
            # caller should then add a new Oakland portfolio row instead.
            if len(cands) == 1:
                cand_camp = _norm_campus(cands[0].get('campus', ''))
                if cand_camp == norm_campus_str:
                    return cands[0], 'name_deg'
                if norm_campus_str == 'boston':
                    return cands[0], 'name_deg'
                return None, None
            if len(cands) > 1:
                for c in cands:
                    if _norm_campus(c['campus']) == norm_campus_str:
                        return c, 'exact'
                if norm_campus_str == 'boston':
                    for c in cands:
                        if _norm_campus(c.get('campus', '')) == 'boston':
                            return c, 'name_deg'
            return None, None

        norm_campus_str = _norm_campus(campus_resolved)
        norm_subj = _norm_subject(subject)
        norm_deg = _norm_degree(degree).lower()

        row, mt = _try(norm_subj, norm_deg, norm_campus_str)
        if row:
            return row, mt

        # Deployment-suffix fallback: if degree has a hyphen (e.g. 'MS-Align' from
        # "MS Data Science - Align"), try the base degree. Handles CIM programs that
        # store the deployment in the degree field differently or not at all.
        if '-' in norm_deg:
            base_deg = norm_deg.split('-')[0]
            if base_deg:
                row, mt = _try(norm_subj, base_deg, norm_campus_str)
                if row:
                    return row, mt

        # Generic-master fallback: "Masters in X" is normalized to MS in
        # _LONG_DEGREE_MAP but the CIM program may be MA/MEd. If MS lookup
        # fails, try other master's variants at the same campus before
        # giving up. Same idea for "Masters of X" without specific phrase.
        if norm_deg in ('ms', 'ma', 'med'):
            for alt in ('ms', 'ma', 'med', 'mpa', 'mpp', 'mfa', 'mps'):
                if alt == norm_deg:
                    continue
                row, mt = _try(norm_subj, alt, norm_campus_str)
                if row:
                    return row, mt

        return None, None

    # Mismatch accumulators
    svt_mismatches = []
    svt_added_log  = []
    ipd_mismatches = []
    ipd_added_log  = []
    otp_mismatches = []
    gls_mismatches = []
    non_programs   = []  # entries from SVT/IPD that are clearly not degree programs

    # ── Step 1: Overlay SVT Roster ────────────────────────────────────────────
    roster_rows_data = parse_roster(roster_path)
    n_svt_matched = 0
    n_svt_added   = 0
    n_svt_mismatch = 0
    n_svt_nonprog = 0
    for p in roster_rows_data:
        if _is_non_program(p['program_name']):
            n_svt_nonprog += 1
            if not _is_silent_non_program(p['program_name']):
                non_programs.append({
                    'source':      'SVT',
                    'source_name': p['program_name'],
                    'campus':      p['campus'],
                })
            continue

        # Expand multi-campus entries (e.g. "X, Boston and Oakland, GC") into one per campus
        _svt_expansions = _expand_multi_campus(p['program_name'], p.get('campus', ''))

        for _svt_name, _svt_campus_override in _svt_expansions:
            norm_campus = _normalize_campus(_svt_campus_override or p['campus'])
            subject, degree, campus_from_name = _parse_external_name(_svt_name)
            if not campus_from_name and norm_campus:
                campus_from_name = norm_campus

            row, match_type = _lookup_cim(subject, degree, campus_from_name)
            if row:
                n_svt_matched += 1
                if not row.get('svt_status'):
                    row['svt_status']           = p['svt_status']
                    row['roster_sub_status']    = p['roster_sub_status']
                    row['roster_proposal_type'] = p['roster_proposal_type']
                    row['roster_launch_date']   = p['roster_launch_date']
                _new_col = _normalize_college(p.get('college') or '')
                if not row.get('college') and _new_col:
                    row['college'] = _new_col
            else:
                if _is_valid_degree(degree):
                    # Add new tracker entry from SVT — store the program_name
                    # in CIM canonical format "Subject, Degree (Campus)" so
                    # the Portfolio's credential-extraction and display logic
                    # works the same on external-added rows as on CIM-seeded rows.
                    campus_store = campus_from_name or 'Boston'
                    cim_fmt = f"{subject.strip()}, {_norm_degree(degree)}"
                    cim_display = (cim_fmt if campus_store == 'Boston'
                                   else f"{cim_fmt} ({campus_store})")
                    pid = _make_id(cim_display, campus_store)
                    if pid not in tracker:
                        new_row = _make_row(pid, cim_display,
                                            p.get('college', ''), campus_store)
                        tracker[pid] = new_row
                        n_svt_added += 1
                        svt_added_log.append({
                            'original_name': p['program_name'],
                            'cim_format':    cim_fmt,
                            'campus':        campus_store,
                        })
                        # Also index the new row so later IPD step can find it
                        key3 = _cim_index_keys(subject, degree, campus_store)
                        if key3 not in cim_exact_index:
                            cim_exact_index[key3] = tracker[pid]
                        key2 = _subject_degree_keys(subject, degree)
                        cim_nameDeg_index.setdefault(key2, []).append(tracker[pid])
                        cim_entries_list.append({
                            'pid': pid,
                            'program_name': _svt_name,
                            'subject': subject,
                            'degree': degree,
                            'degree_norm': _norm_degree(degree).lower(),
                            'campus': campus_store,
                            'row': tracker[pid],
                        })
                    row = tracker[pid]
                    if not row.get('svt_status'):
                        row['svt_status']           = p['svt_status']
                        row['roster_sub_status']    = p['roster_sub_status']
                        row['roster_proposal_type'] = p['roster_proposal_type']
                        row['roster_launch_date']   = p['roster_launch_date']
                else:
                    n_svt_mismatch += 1
                    best = _best_guess(subject, degree, cim_entries_list,
                                       prefer_campus=campus_from_name or '')
                    svt_mismatches.append({
                        'source_name':   p['program_name'],
                        'source_campus': _svt_campus_override or p['campus'],
                        'reason':        'no CIM match' if not degree else 'no recognizable degree',
                        'best_guess':    best,
                    })

    print(f"  SVT Roster: {len(roster_rows_data)} entries, {n_svt_matched} matched, "
          f"{n_svt_added} added, {n_svt_mismatch} mismatches, {n_svt_nonprog} non-programs")

    # ── Step 2: Overlay IPD ───────────────────────────────────────────────────
    ipd_rows_data = parse_smartsheet(tsv_path)
    n_ipd_matched = 0
    n_ipd_added   = 0
    n_ipd_mismatch = 0
    n_ipd_nonprog  = 0
    _LAUNCH_DEPLOY_RE = re.compile(
        r'\b(launch|deploy|new\s+program|net\s+new|deploy\s+program)\b', re.I)

    # "X Concentration in the DEGREE in Y (Campus)" — these are concentrations
    # appended to an existing program (e.g. "AI Concentration in the MS in
    # Health Informatics, Charlotte"). They should NOT create a standalone
    # portfolio row; instead the IPD status overlays on the parent CIM program
    # ("Health Informatics, MS (Charlotte)").
    _CONC_IN_DEGREE_IN_RE = re.compile(
        r'^.+?\s+Concentration\s+in\s+the\s+(MS|MA|PhD|MBA|MPS|MFA|MEd|MArch|DNP|DPT|EdD|MPH|MPA|MPP)\s+in\s+(.+)$',
        re.I
    )

    for p in ipd_rows_data:
        if _is_non_program(p['program_name']):
            n_ipd_nonprog += 1
            if not _is_silent_non_program(p['program_name']):
                non_programs.append({
                    'source':      'IPD',
                    'source_name': p['program_name'],
                    'campus':      '',
                })
            continue

        # "X Concentration in the DEGREE in Y, Campus" → overlay IPD status on
        # the parent program ("Y, DEGREE (Campus)") instead of mismatching or
        # creating a standalone concentration row.
        conc_m = _CONC_IN_DEGREE_IN_RE.match(p['program_name'])
        if conc_m:
            parent_deg  = _norm_degree(conc_m.group(1))
            parent_rest = conc_m.group(2).strip()
            parent_camp = ''
            cm = re.search(r',\s*([A-Za-z][A-Za-z\s]+?)\s*$', parent_rest)
            if cm:
                cand = cm.group(1).strip()
                # A trailing ", Word" is the campus when the word resolves to a
                # known campus (either via _CAMPUS_NAMES code→name map values
                # or a direct case-insensitive match against full names).
                _known = {v.lower() for v in _CAMPUS_NAMES.values()} | {
                    'boston','oakland','portland','toronto','seattle','miami',
                    'arlington','vancouver','charlotte','london','silicon valley',
                    'new york','online','primarily online'}
                if cand.lower() in _known:
                    parent_camp = cand
                    parent_rest = parent_rest[:cm.start()].strip()
            row, _ = _lookup_cim(parent_rest, parent_deg, parent_camp)
            if row:
                n_ipd_matched += 1
                if not row.get('ipd_status'):
                    row['ipd_status']             = p['ipd_status']
                    row['ipd_proposal_type']      = p['ipd_proposal_type']
                    row['ipd_additional_college'] = p.get('ipd_additional_college', '')
                if not row.get('college'):
                    nc = _normalize_college(p.get('ipd_college') or '')
                    if nc:
                        row['college'] = nc
                continue
            # Parent not found; fall through to normal handling
        # Expand multi-campus entries (e.g. "X in Boston and Oakland") into one per campus.
        # For simplicity, process each expansion independently using the same matching logic.
        _ipd_expansions = _expand_multi_campus(p['program_name'], '')
        # If multi-campus, process the first expansion now and queue the rest for re-entry
        # by synthesizing pseudo-entries for later expansions.
        _ipd_name_to_parse = _ipd_expansions[0][0]
        _ipd_campus_hint   = _ipd_expansions[0][1]
        for _extra_name, _extra_campus in _ipd_expansions[1:]:
            _extra_subject, _extra_degree, _extra_campus_from = _parse_external_name(_extra_name)
            if _extra_campus and not _extra_campus_from:
                _extra_campus_from = _extra_campus
            _extra_row, _ = _lookup_cim(_extra_subject, _extra_degree, _extra_campus_from)
            if _extra_row and not _extra_row.get('ipd_status'):
                _extra_row['ipd_status']             = p['ipd_status']
                _extra_row['ipd_proposal_type']      = p.get('ipd_proposal_type', '')
                _extra_row['ipd_additional_college'] = p.get('ipd_additional_college', '')
        subject, degree, campus_from_name = _parse_external_name(_ipd_name_to_parse)
        if _ipd_campus_hint and not campus_from_name:
            campus_from_name = _ipd_campus_hint
        proposal_type = p.get('ipd_proposal_type', '')
        is_launch_deploy = bool(_LAUNCH_DEPLOY_RE.search(proposal_type))

        # Exact match: subject + degree + campus
        row, match_type = _lookup_cim(subject, degree, campus_from_name)
        if row:
            n_ipd_matched += 1
            if not row.get('ipd_status'):
                row['ipd_status']             = p['ipd_status']
                row['ipd_proposal_type']      = p['ipd_proposal_type']
                row['ipd_additional_college'] = p.get('ipd_additional_college', '')
            _new_col = _normalize_college(p.get('ipd_college') or '')
            if not row.get('college') and _new_col:
                row['college'] = _new_col
            continue

        # Name+degree match (campus differs or absent)
        key2 = _subject_degree_keys(subject, degree)
        candidates = cim_nameDeg_index.get(key2, [])
        if candidates:
            if campus_from_name:
                # IPD specifies a campus — look for that campus in tracker
                campus_norm = _norm_campus(campus_from_name)
                matched = [c for c in candidates if _norm_campus(c.get('campus', '')) == campus_norm]
                if matched:
                    n_ipd_matched += 1
                    r = matched[0]
                    if not r.get('ipd_status'):
                        r['ipd_status']             = p['ipd_status']
                        r['ipd_proposal_type']      = p['ipd_proposal_type']
                        r['ipd_additional_college'] = p.get('ipd_additional_college', '')
                    _new_col = _normalize_college(p.get('ipd_college') or '')
                    if not r.get('college') and _new_col:
                        r['college'] = _new_col
                    continue
                # Campus NOT in tracker
                if is_launch_deploy:
                    if not _is_valid_degree(degree):
                        n_ipd_mismatch += 1
                        ipd_mismatches.append({
                            'source_name':   p['program_name'],
                            'source_campus': campus_from_name or '',
                            'reason':        'no recognizable degree',
                            'best_guess':    _best_guess(subject, degree, cim_entries_list,
                                                        prefer_campus=campus_from_name or ''),
                        })
                        continue
                    # Add new tracker entry — use CIM canonical name format
                    campus_store = campus_from_name
                    cim_fmt = f"{subject.strip()}, {_norm_degree(degree)}"
                    cim_display = (cim_fmt if campus_store == 'Boston'
                                   else f"{cim_fmt} ({campus_store})")
                    pid = _make_id(cim_display, campus_store)
                    if pid not in tracker:
                        new_row = _make_row(pid, cim_display,
                                            p.get('ipd_college', ''), campus_store)
                        tracker[pid] = new_row
                        ipd_added_log.append({
                            'name':          cim_display,
                            'original_name': p['program_name'],
                            'cim_format':    cim_fmt,
                            'campus':        campus_store,
                            'proposal_type': proposal_type,
                        })
                        n_ipd_added += 1
                    row = tracker[pid]
                    if not row.get('ipd_status'):
                        row['ipd_status']             = p['ipd_status']
                        row['ipd_proposal_type']      = p['ipd_proposal_type']
                        row['ipd_additional_college'] = p.get('ipd_additional_college', '')
                    continue
                else:
                    n_ipd_mismatch += 1
                    best = _best_guess(subject, degree, cim_entries_list,
                                       prefer_campus=campus_from_name or '')
                    ipd_mismatches.append({
                        'source_name':   p['program_name'],
                        'source_campus': campus_from_name,
                        'reason':        f'campus "{campus_from_name}" not in CIM for this program',
                        'best_guess':    best,
                    })
                    continue
            else:
                # No campus specified — match to first candidate (usually Boston)
                n_ipd_matched += 1
                r = candidates[0]
                if not r.get('ipd_status'):
                    r['ipd_status']             = p['ipd_status']
                    r['ipd_proposal_type']      = p['ipd_proposal_type']
                    r['ipd_additional_college'] = p.get('ipd_additional_college', '')
                _new_col = _normalize_college(p.get('ipd_college') or '')
                if not r.get('college') and _new_col:
                    r['college'] = _new_col
                continue

        # No name+degree match at all
        if is_launch_deploy:
            if not _is_valid_degree(degree):
                n_ipd_mismatch += 1
                ipd_mismatches.append({
                    'source_name':   p['program_name'],
                    'source_campus': campus_from_name or '',
                    'reason':        'no recognizable degree',
                    'best_guess':    _best_guess(subject, degree, cim_entries_list,
                                                prefer_campus=campus_from_name or ''),
                })
            else:
                campus_store = campus_from_name or 'Boston'
                cim_fmt = f"{subject.strip()}, {_norm_degree(degree)}"
                cim_display = (cim_fmt if campus_store == 'Boston'
                               else f"{cim_fmt} ({campus_store})")
                pid = _make_id(cim_display, campus_store)
                if pid not in tracker:
                    new_row = _make_row(pid, cim_display,
                                        p.get('ipd_college', ''), campus_store)
                    tracker[pid] = new_row
                    ipd_added_log.append({
                        'name':          cim_display,
                        'original_name': p['program_name'],
                        'cim_format':    cim_fmt,
                        'campus':        campus_store,
                        'proposal_type': proposal_type,
                    })
                    n_ipd_added += 1
                row = tracker[pid]
                if not row.get('ipd_status'):
                    row['ipd_status']             = p['ipd_status']
                    row['ipd_proposal_type']      = p['ipd_proposal_type']
                    row['ipd_additional_college'] = p.get('ipd_additional_college', '')
        else:
            n_ipd_mismatch += 1
            best = _best_guess(subject, degree, cim_entries_list,
                               prefer_campus=campus_from_name or '')
            ipd_mismatches.append({
                'source_name':   p['program_name'],
                'source_campus': campus_from_name or '',
                'reason':        'no CIM match (not a launch/deploy proposal)',
                'best_guess':    best,
            })

    print(f"  IPD: {len(ipd_rows_data)} entries, {n_ipd_matched} matched, "
          f"{n_ipd_added} added, {n_ipd_mismatch} mismatches, {n_ipd_nonprog} non-programs")

    # ── Step 3: Overlay OTP (Boston-only) ────────────────────────────────────
    otp_rows_data = parse_otp(xlsx_path)
    n_otp_matched  = 0
    n_otp_mismatch = 0
    for p in otp_rows_data:
        # OTP is Boston-only; any campus field is ignored for matching.
        # Pre-process to expand OTP abbreviations (Mgmt, Comm, &, etc.) before parsing.
        otp_name = _preprocess_otp_name(p['program_name'])
        subject, degree, campus_from_name = _parse_external_name(otp_name)
        # OTP campus override: treat as Boston regardless
        campus_match = 'Boston'

        row, match_type = _lookup_cim(subject, degree, campus_match)
        if not row:
            # Try without pinning campus (name+degree)
            row, match_type = _lookup_cim(subject, degree, '')
        if row:
            n_otp_matched += 1
            if not row.get('otp_status'):
                row['otp_status']               = p['otp_status']
                row['otp_sub_status']           = p['otp_sub_status']
                row['otp_market_potential']     = p['otp_market_potential']
                row['otp_market_signal']        = p['otp_market_signal']
                row['otp_internal_performance'] = p['otp_internal_performance']
                row['otp_q3_status']            = p['otp_q3_status']
                row['otp_effective_term']       = p['otp_effective_term']
            if not row.get('college') and p.get('college'):
                row['college'] = p['college']
        else:
            n_otp_mismatch += 1
            best = _best_guess(subject, degree, cim_entries_list, prefer_campus='Boston')
            otp_mismatches.append({
                'source_name':   otp_name,
                'source_campus': 'Boston',
                'reason':        'no CIM match',
                'best_guess':    best,
            })

    print(f"  OTP: {len(otp_rows_data)} entries, {n_otp_matched} matched, {n_otp_mismatch} mismatches")

    # ── Step 4: Overlay GLS ───────────────────────────────────────────────────
    gls_data = parse_gls(gls_path)
    n_gls_matched  = 0
    n_gls_mismatch = 0
    if gls_data:
        gls_by_raw = {e['raw_name']: e for e in gls_data}
        # Build explicit override lookup: portfolio_name (from _GLS_NAME_MAP) → status
        gls_explicit_map = {}
        for gls_name, port_name in _GLS_NAME_MAP.items():
            if gls_name in gls_by_raw:
                gls_explicit_map[_norm(port_name)] = gls_by_raw[gls_name]['status']

        for row in tracker.values():
            name = row.get('program_name') or ''
            campus = row.get('campus') or 'Boston'
            # Explicit map first
            status = gls_explicit_map.get(_norm(name), '')
            if not status:
                # Parse the CIM name into (subject, degree) and match against GLS entries
                subject_r, degree_r, _ = _parse_cim_name(name)
                port_degree = _norm_degree(degree_r).upper()
                port_words  = _gls_key_words(subject_r)
                best_score, best_status = 0.0, ''
                for e in gls_data:
                    gls_campus = e['campus'] or 'Boston'
                    if _norm_campus(gls_campus) != _norm_campus(campus):
                        continue
                    if e['degree'] and port_degree and e['degree'] != port_degree:
                        continue
                    sw = e['subject_words']
                    if not sw or not port_words:
                        continue
                    jaccard = len(port_words & sw) / len(port_words | sw)
                    if jaccard > best_score:
                        best_score = jaccard
                        best_status = e['status']
                if best_score >= 0.45:
                    status = best_status
            if status:
                row['gls_status'] = status
                n_gls_matched += 1

        print(f"  GLS Tableau: {len(gls_data)} entries loaded, {n_gls_matched} matched")
    else:
        print(f"  GLS Tableau: file not found or empty, skipping ({gls_path})")

    # ── Step 5: Overlay 2025 scoring (Boston-only) ───────────────────────────
    scoring_entries = parse_scoring_2025()
    n_scoring_matched = 0
    if scoring_entries:
        for row in tracker.values():
            campus = (row.get('campus') or '').strip().lower()
            if campus not in ('', 'boston'):
                continue
            name = row.get('program_name') or ''
            # Strip campus parens for scoring lookup
            key = _norm(re.sub(r'\s*\([^)]*\)\s*$', '', name))
            entry = _match_scoring_2025(scoring_entries, key)
            if entry:
                row['market_2025']            = entry['market_2025']
                row['performance_2025']       = entry['performance_2025']
                row['market_score_2025']      = entry.get('market_score_2025', '')
                row['performance_score_2025'] = entry.get('performance_score_2025', '')
                n_scoring_matched += 1
        print(f"  2025 scoring: {len(scoring_entries)} entries, {n_scoring_matched} matched")
    else:
        print(f"  2025 scoring: file not found, skipping ({SCORING_2025_PATH})")

    # ── Step 5.9: Extract concentration names from each program's CIM
    # curriculum HTML and store them as a JSON-encoded list. The frontend
    # reads this and renders one expandable sub-row per named concentration
    # under the parent program (so a single MS in X with 6 tracks shows as
    # one Portfolio row that you can expand to see all 6).
    cim_ids_needed = [r['cim_program_id'] for r in tracker.values()
                      if r.get('cim_program_id')]
    if cim_ids_needed:
        with get_db() as conn:
            curriculum_map = {}
            for i in range(0, len(cim_ids_needed), 500):
                chunk = cim_ids_needed[i:i + 500]
                placeholders = ','.join('?' * len(chunk))
                db_rows = conn.execute(
                    f'SELECT id, curriculum_html FROM programs WHERE id IN ({placeholders})',
                    chunk
                ).fetchall()
                for r in db_rows:
                    if r['curriculum_html']:
                        curriculum_map[r['id']] = r['curriculum_html']
        n_with_concs = 0
        for row in tracker.values():
            cim_id = row.get('cim_program_id')
            if cim_id and cim_id in curriculum_map:
                concs = _extract_concentrations_from_html(curriculum_map[cim_id])
                if concs:
                    row['concentrations_json'] = json.dumps(concs)
                    n_with_concs += 1
        print(f"  Curriculum concentrations: {n_with_concs} programs have named concentrations")

    # ── Step 5.6: Portfolio data-quality overrides ───────────────────────────
    # REMOVE definitively-non-program entries; RENAME well-known canonical
    # mismatches; strip "at Roux" / "for Maine" suffixes (those indicate
    # Portland deployment). The REMOVE check ignores trailing (Campus).
    def _strip_paren(s):
        return re.sub(r'\s*\([^)]*\)\s*$', '', s or '').strip()
    for _pid_remove in [_p for _p, _r in tracker.items()
                        if _r.get('program_name') in _PORTFOLIO_REMOVE
                        or _strip_paren(_r.get('program_name','')) in _PORTFOLIO_REMOVE]:
        del tracker[_pid_remove]
    # Build an index of existing rows by (norm_name_without_campus, campus)
    # so renames can merge into an existing CIM row instead of creating a
    # duplicate. The "Artificial Intelligence, MS" rename target without a
    # campus parenthetical must still match "Artificial Intelligence, MS
    # (Boston)" stored under campus=Boston.
    def _name_no_paren(s):
        return _norm(re.sub(r'\s*\([^)]*\)\s*$', '', s or '').strip())
    _existing_by_key = {}
    for _pid, _row in tracker.items():
        _key = (_name_no_paren(_row.get('program_name','')),
                _norm_campus(_row.get('campus','')))
        _existing_by_key.setdefault(_key, _pid)

    def _merge_into(target_pid, source_row):
        """Overlay non-empty SVT/IPD/OTP/GLS fields from source into target."""
        t = tracker[target_pid]
        for fld in ('svt_status','roster_sub_status','roster_proposal_type',
                    'roster_launch_date','ipd_status','ipd_proposal_type',
                    'ipd_additional_college','otp_status','otp_sub_status',
                    'otp_market_potential','otp_market_signal',
                    'otp_internal_performance','otp_q3_status','otp_effective_term',
                    'gls_status'):
            if not t.get(fld) and source_row.get(fld):
                t[fld] = source_row[fld]

    for _pid in list(tracker):
        if _pid not in tracker:
            continue
        _row = tracker[_pid]
        _name = _row.get('program_name') or ''
        _changed = False
        if _name in _PORTFOLIO_RENAME:
            _new_name, _new_college, _new_campus = _PORTFOLIO_RENAME[_name]
            _row['program_name'] = _new_name
            if _new_college:
                _row['college'] = _normalize_college(_new_college)
            if _new_campus:
                _row['campus'] = _new_campus
            _changed = True
        elif _ROUX_RE.search(_name):
            _row['program_name'] = _ROUX_RE.sub('', _name).strip().rstrip(',').strip()
            if not _row.get('campus') or _row['campus'] in ('', 'Boston'):
                _row['campus'] = 'Portland'
            _changed = True
        # After rename, if the new (name, campus) collides with another row,
        # merge into that row and delete this one. Avoids creating duplicate
        # 'Artificial Intelligence, MS (Boston)'-style synth rows that
        # shadow the real CIM record.
        if _changed:
            new_key = (_name_no_paren(_row.get('program_name','')),
                       _norm_campus(_row.get('campus','')))
            target = _existing_by_key.get(new_key)
            if target and target != _pid:
                _merge_into(target, _row)
                del tracker[_pid]
            else:
                _existing_by_key[new_key] = _pid

    # ── Step 6: Link concentration rows to their parent program ──────────────
    # Concentrations must NEVER appear as standalone top-level rows. Algorithm:
    #   1. Explicit-parent overrides (_EXPLICIT_CONC_PARENTS) — for patterns
    #      whose parent isn't discoverable by regex extraction (Business
    #      Concentration in X, Political Science Concentration in X, etc.).
    #      Synthesize the parent if it doesn't exist.
    #   2. Regex extraction (_extract_parent_name) for "X with Concentration
    #      in Y, DEG" and "X - Y Concentration, DEG". Synthesize parent if
    #      missing in CIM.
    #   3. Em-dash convention: "Subject Concentration in Rest" → "Subject-Rest"
    #      (the Nursing—X, MS form).
    # Build name index using both _norm (campus-aware) and _degree_core
    # (campus-stripped, abbreviation-expanded) so concentration parent lookups
    # find the right row regardless of how the parent was registered.
    name_to_pid = {}
    for pid, row in tracker.items():
        for key in (_norm(row.get('program_name') or ''),
                    _degree_core(row.get('program_name') or '')):
            if key and key not in name_to_pid:
                name_to_pid[key] = pid

    # Stage 1: Explicit concentration parents (regex → known parent name).
    # If the parent row doesn't exist, create a synthetic parent so the
    # concentration never ends up orphaned.
    n_explicit = 0
    _synth_explicit = {}  # (parent_name|campus) → synth_pid
    for pid, row in list(tracker.items()):
        if row.get('concentration_of'):
            continue
        name = row.get('program_name') or ''
        for pattern, parent_name, campus_override in _EXPLICIT_CONC_PARENTS:
            if not pattern.search(name):
                continue
            lookup_campus = campus_override if campus_override else row.get('campus', '')
            found_pid = None
            if lookup_campus:
                key = _norm(f'{parent_name} ({lookup_campus})')
                if key in name_to_pid and name_to_pid[key] != pid:
                    found_pid = name_to_pid[key]
            if not found_pid and not campus_override:
                for key in (_norm(parent_name), _degree_core(parent_name)):
                    if key and key in name_to_pid and name_to_pid[key] != pid:
                        found_pid = name_to_pid[key]
                        break
            if not found_pid:
                synth_key = f'{parent_name}|{lookup_campus}'
                if synth_key not in _synth_explicit:
                    new_synth_pid = 'synth_' + re.sub(
                        r'[^a-z0-9]+', '_',
                        _norm(f'{parent_name} {lookup_campus}'))[:60]
                    conc_college = row.get('college', '')
                    tracker[new_synth_pid] = dict(_EMPTY_TRACKING, **{
                        'id': new_synth_pid,
                        'program_name': (parent_name + (f' ({lookup_campus})'
                                                        if lookup_campus else '')),
                        'college': _normalize_college(conc_college),
                        'campus': lookup_campus or row.get('campus', ''),
                        'cim_program_id': None,
                        'cim_step': '',
                        'cim_completion_date': '',
                    })
                    for key in (_norm(parent_name), _degree_core(parent_name)):
                        if key and key not in name_to_pid:
                            name_to_pid[key] = new_synth_pid
                    _synth_explicit[synth_key] = new_synth_pid
                found_pid = _synth_explicit[synth_key]
            row['concentration_of'] = found_pid
            n_explicit += 1
            break

    # Stage 2: Regex-extracted parent — collect concentrations whose extracted
    # parent doesn't exist as a row, then synthesize parents for them.
    n_synthetic = 0
    pending = []  # (pid, parent_raw)
    for pid, row in tracker.items():
        if 'concentration' not in (row.get('program_name') or '').lower():
            continue
        if row.get('concentration_of'):
            continue
        parent_raw = _extract_parent_name(row['program_name'])
        if not parent_raw:
            continue
        # Strip the LEGACY RECORD prefix when present (e.g. "LEGACY RECORD
        # Regulatory Affairs ... with Concentration in X, MS" → parent is the
        # base "Regulatory Affairs ..., MS").
        parent_clean = re.sub(r'^LEGACY\s+RECORD\s+', '', parent_raw, flags=re.I).strip()
        found = any(k in name_to_pid for k in
                    (_norm(parent_clean), _degree_core(parent_clean)))
        if found:
            continue
        pending.append((pid, parent_clean))

    # Create one synthetic parent per unique normalized parent name.
    synth_created = {}
    for pid, parent_raw in pending:
        norm_key = _norm(parent_raw)
        if norm_key in synth_created:
            continue
        synth_pid = 'synth_' + re.sub(r'[^a-z0-9]+', '_', norm_key)[:60]
        conc_row = tracker[pid]
        tracker[synth_pid] = dict(_EMPTY_TRACKING, **{
            'id':             synth_pid,
            'program_name':   parent_raw,
            'college':        conc_row.get('college', ''),
            'campus':         conc_row.get('campus', ''),
            'cim_program_id': None,
            'cim_step':       '',
            'cim_completion_date': '',
        })
        name_to_pid[norm_key] = synth_pid
        dk = _degree_core(parent_raw)
        if dk and dk not in name_to_pid:
            name_to_pid[dk] = synth_pid
        synth_created[norm_key] = synth_pid
        n_synthetic += 1

    # Stage 3: Link every concentration to its parent.
    n_regex_linked = 0
    for pid, row in tracker.items():
        if 'concentration' not in (row.get('program_name') or '').lower():
            continue
        if row.get('concentration_of'):
            continue
        parent_raw = _extract_parent_name(row['program_name'])
        if not parent_raw:
            continue
        parent_clean = re.sub(r'^LEGACY\s+RECORD\s+', '', parent_raw, flags=re.I).strip()
        for key in (_norm(parent_clean), _degree_core(parent_clean)):
            if key and key in name_to_pid and name_to_pid[key] != pid:
                row['concentration_of'] = name_to_pid[key]
                n_regex_linked += 1
                break

    # Stage 4: "Subject Concentration in Rest" → em-dash parent
    # (Nursing Concentration in X → Nursing—X, MS).
    _CONC_SUBJ_IN = re.compile(r'^([^,]+?)\s+Concentration\s+in\s+(.+)$', re.I)
    subj_idx = {}
    for pid, row in tracker.items():
        full = row.get('program_name') or ''
        subj, _deg, _cmp = _parse_cim_name(full)
        ns = _norm_subject(subj)
        if ns:
            subj_idx.setdefault(ns, []).append(pid)
    n_dash_linked = 0
    for pid, row in tracker.items():
        if 'concentration' not in (row.get('program_name') or '').lower():
            continue
        if row.get('concentration_of'):
            continue
        m = _CONC_SUBJ_IN.match(row.get('program_name') or '')
        if not m:
            continue
        base = m.group(1).strip()
        rest = m.group(2).strip()
        for cand_subj in (f"{base}-{rest}", f"{base}—{rest}"):
            cands = subj_idx.get(_norm_subject(cand_subj), [])
            hit = next((c for c in cands if c != pid), None)
            if hit:
                row['concentration_of'] = hit
                n_dash_linked += 1
                break
    n_linked = n_explicit + n_regex_linked + n_dash_linked
    if n_linked or n_synthetic:
        print(f"  Concentration linking: {n_explicit} explicit + {n_regex_linked} regex + "
              f"{n_dash_linked} em-dash = {n_linked} linked, "
              f"{n_synthetic} synthetic parents created")
    if n_linked:
        print(f"  Linked {n_linked} concentration rows to parents")

    # ── Write portfolio_programs ──────────────────────────────────────────────
    rows = list(tracker.values())
    replace_all_portfolio_programs(rows)

    # ── Print summary ─────────────────────────────────────────────────────────
    n_total = len(rows)
    n_active   = sum(1 for r in rows if r.get('cim_step'))
    n_completed = sum(1 for r in rows if r.get('cim_completion_date') and not r.get('cim_step'))
    n_inact = sum(1 for r in rows if r.get('cim_change_type') == 'Inactivation')
    n_non_cim = sum(1 for r in rows if not r.get('cim_program_id'))
    print(f"Portfolio ingest: {n_total} programs total")
    print(f"  CIM seed: {n_cim_seed} (active: {n_active}, completed: {n_completed}, "
          f"inactivations: {n_inact})")
    print(f"  IPD-only additions: {n_ipd_added}")
    print(f"  Total non-CIM rows: {n_non_cim}")

    # ── Write mismatches JSON ─────────────────────────────────────────────────
    def _dedup(lst, *key_fields):
        """Deduplicate a list of dicts by the given key fields, preserving order."""
        seen, out = set(), []
        for item in lst:
            k = tuple(item.get(f, '') for f in key_fields)
            if k not in seen:
                seen.add(k)
                out.append(item)
        return out

    _mismatch_file = os.path.join(os.path.dirname(_find_db_path()), 'portfolio_mismatches.json')
    try:
        _np   = _dedup(sorted(non_programs,   key=lambda x: (x['source'], x['source_name'])), 'source', 'source_name')
        _sa   = _dedup(sorted(svt_added_log,  key=lambda x: x['original_name']), 'original_name', 'campus')
        _sm   = _dedup(sorted(svt_mismatches, key=lambda x: x['source_name']), 'source_name')
        _im   = _dedup(sorted(ipd_mismatches, key=lambda x: x['source_name']), 'source_name')
        _ia   = _dedup(sorted(ipd_added_log,  key=lambda x: x['name']), 'name', 'campus')
        _om   = _dedup(sorted(otp_mismatches, key=lambda x: x['source_name']), 'source_name')
        _gm   = _dedup(sorted(gls_mismatches, key=lambda x: x.get('source_name', '')), 'source_name')
        _mismatch_data = {
            'updated_at':     now,
            'non_programs':   _np,
            'svt_added':      _sa,
            'svt_mismatches': _sm,
            'ipd_mismatches': _im,
            'ipd_added':      _ia,
            'otp_mismatches': _om,
            'gls_mismatches': _gm,
        }
        with open(_mismatch_file, 'w') as _f:
            json.dump(_mismatch_data, _f, indent=2)
        print(f"  Mismatches written to {_mismatch_file}")
        print(f"  Non-programs: {len(non_programs)} | "
              f"SVT: {len(svt_added_log)} added, {len(svt_mismatches)} mismatches | "
              f"IPD: {len(ipd_mismatches)} mismatches | "
              f"OTP: {len(otp_mismatches)} mismatches | GLS: {len(gls_mismatches)} mismatches")
    except Exception as e:
        print(f"  Warning: could not write portfolio_mismatches.json: {e}")

    return n_total


if __name__ == '__main__':
    ingest()
