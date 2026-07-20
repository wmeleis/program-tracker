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

# All feeds are read from the project's data/portfolio_feeds/ directory — the
# same location fetch_portfolio_data.py writes to. (Previously these pointed at
# ~/Downloads/, which the fetcher never updated, so OTP/IPD/Roster/GLS silently
# read months-stale manual copies while only SVT/GTM stayed current.)
_FEEDS_DIR  = os.path.join(_WORKTREE_DIR, 'data', 'portfolio_feeds')
XLSX_PATH   = os.path.join(_FEEDS_DIR, "portfolio_sharepoint.xlsx")
TSV_PATH    = os.path.join(_FEEDS_DIR, "portfolio_smartsheet.tsv")
ROSTER_PATH = os.path.join(_FEEDS_DIR, "portfolio_roster.tsv")
GLS_PATH    = os.path.join(_FEEDS_DIR, "portfolio_gls.csv")
ENROLLMENT_PATH = os.path.join(_FEEDS_DIR, "portfolio_enrollment.csv")
BANNER_PMC_PATH = os.path.join(_FEEDS_DIR, "banner_program_major_concentration.csv")
SCORING_2025_PATH = os.path.expanduser(
    "~/committees/nu-docs/Programs/Program review/Program review 2025/"
    "Graduate Program Scoring-Boston-for WM-9-16-25.xlsx"
)
OTP_SHEET   = "OTP Program Tracking"
GTM_PATH    = os.path.join(_WORKTREE_DIR, 'data', 'portfolio_feeds', 'gtm.json')


def _safe_parse(label, fn):
    """Run one feed parser; on any failure (missing file, corrupt/HTML download
    that slipped past validation, parse error) log it and return [] so the
    remaining overlays still apply and the prior portfolio values are kept for
    this feed — one bad feed never aborts the whole ingest."""
    try:
        return fn()
    except Exception as e:
        print(f"  ⚠ {label} feed unavailable ({e}); skipping its overlay (prior values kept)")
        return []

# Curated banner codes for the "Exit master's" flag (uppercase). Programs whose
# CIM banner_code is in this set get exit_masters='Yes'; all others 'No'.
EXIT_MASTERS_BANNERS = {
    'MS-POPU', 'MS-APNR', 'MS-BIOL', 'MS-MRES', 'MS-PSYC', 'MA-SOCI', 'MS-NETS',
    'MS-CDSC',   # Cross-Disciplinary Science, MS — exit-master's only
}

# Exit-master's programs that have NO banner code (or are campus-specific), so
# they can't be flagged via the banner set — matched by exact CIM program name.
EXIT_MASTERS_PROGRAM_NAMES = {
    'Bioengineering, MSBioE (Portland)',
    'Electrical and Computer Engineering with Concentration in Hardware and Software for Machine Intelligence, MSECE (Oakland)',
    'Electrical and Computer Engineering with Concentration in Microsystems, Materials, and Devices, MSECE (Oakland)',
}


# ---------------------------------------------------------------------------
# Catalog-year membership (derived from CIM, not from scraping the catalog)
# ---------------------------------------------------------------------------
# CIM is the ledger of every catalog change, so per-program membership in a
# given catalog year is derivable from its proposals' effective catalog +
# type. This is date-INDEPENDENT (no "active as of today" fragility): each
# catalog year is its own yes/no. We only populate the current catalog year +
# two forward — a single CIM snapshot can't reconstruct *past* years reliably
# (continuing programs carry a "current catalog" surrogate, and we don't retain
# full proposal history), so we don't claim them.
def _current_catalog_start_year(today=None):
    """START year of the catalog considered 'current' (e.g. 2026 → 2026-2027).
    NU catalog years run fall→fall; the next year's catalog becomes the active
    reference well before its fall, so we roll over in spring."""
    d = today or datetime.now().date()
    return d.year if d.month >= 5 else d.year - 1


def _catalog_window(today=None):
    """[current, current+1, current+2] START years."""
    cur = _current_catalog_start_year(today)
    return [cur, cur + 1, cur + 2]


def _catalog_year_from_str(s):
    """START year from a 'Catalog YYYY-YYYY' / 'YYYY-YYYY' string, or None."""
    m = re.search(r'(\d{4})\s*-\s*\d{4}', s or '')
    return int(m.group(1)) if m else None


def _cim_catalog_events(rows, cur=None):
    """Build [(start_year|None, kind, cim_id)] from a program's CIM records.
    kind ∈ {'add','remove','edit'}. Effective year comes from completion_date
    (the approved catalog) when set, else eff_cat (in-workflow proposals).
    A *pending* (in-workflow) removal hasn't taken effect — it can't remove the
    program from the already-open current catalog, so its effective year is
    clamped to no earlier than next year (present now, gone from the future
    effective year), per the planned-removal semantics."""
    if cur is None:
        cur = _current_catalog_start_year()
    events = []
    for r in rows:
        yr = _catalog_year_from_str(r['completion_date']) or _catalog_year_from_str(r['eff_cat'])
        status = (r['status'] or '')
        in_wf = bool(r['current_step'])
        kind = 'add' if status == 'Added' else 'remove' if status == 'Deactivated' else 'edit'
        if kind == 'remove' and in_wf:
            yr = yr if (yr and yr > cur) else cur + 1
        try:
            cid = int(r['id'])
        except (TypeError, ValueError):
            cid = 0
        events.append((yr, kind, cid))
    return events


def _in_catalog(events, C):
    """Is the program a member of catalog START-year C, given its CIM events?
    The state during catalog C is set by the most recent *decision* in effect by
    then — the event with the greatest effective year, tie-broken by the highest
    CIM id (the latest proposal). A removal → absent, add/edit → present. This
    lets a newer Change/re-add supersede an older Inactivation for the same year.
    With no event on/before C, the program is absent only if it has a *future*
    add (not yet created); otherwise it's pre-existing/continuing → present."""
    prior = [(y, k, i) for (y, k, i) in events if y is not None and y <= C]
    if prior:
        _, kind, _ = max(prior, key=lambda e: (e[0], e[2]))
        return kind != 'remove'
    if any(k == 'add' and (y is not None and y > C) for (y, k, i) in events):
        return False                          # future add → not created yet at C
    return True                               # continuing / pre-existing


def _catalog_years_label(events, window=None):
    """Comma-joined 'YYYY-YYYY' labels for the catalog years the program is in."""
    win = window if window is not None else _catalog_window()
    return ', '.join(f"{y}-{y + 1}" for y in win if _in_catalog(events, y))


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
            # Column M = "Notes" (col L = "Review Period", not captured).
            'otp_notes':                   row.get('M', '').strip(),
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

# Prefixes that SVT entries sometimes wrap around an actual program name —
# strip them before parsing so the underlying program is matchable.
# Examples handled:
#   "Launch of the MFA in Creative Practices and Technology"
#     → "MFA in Creative Practices and Technology"  (HCWHY classifies as
#        Network Deployment or New Program — the tracker row IS the program,
#        not a "launch announcement")
#   "Launch of DLP in Charlotte" → "DLP in Charlotte"
#   "Suspension of MPS Insurance Analytics and Management"
#     → "MPS Insurance Analytics and Management" (HCWHY="Inactivate…"
#        classifies this as Inactivation)
_SVT_NAME_PREFIX_RE = re.compile(
    r'^\s*(?:'
    r'Launch\s+of\s+the\s+'
    r'|Launch\s+of\s+'
    r'|Suspension\s+of\s+'
    r')',
    re.I,
)
# Infix status words: "Global Studies launch in Seattle" / "DLP suspension in
# Charlotte" embed a status verb between the subject and " in <campus>". Drop
# just the verb so the remainder ("Global Studies in Seattle") parses as a
# real program name + campus.
_SVT_NAME_INFIX_RE = re.compile(
    r'\s+(?:launch|suspension|inactivation|deactivation)\s+(?=in\s+\S)',
    re.I,
)


def _strip_svt_prefix(name):
    """Strip "Launch of (the) " / "Suspension of " status prefix (and the
    "… launch/suspension in <campus>" infix) so the remaining text parses as a
    real program name."""
    if not name:
        return name
    cleaned = _SVT_NAME_PREFIX_RE.sub('', name).strip()
    cleaned = _SVT_NAME_INFIX_RE.sub(' ', cleaned).strip()
    return cleaned


_SVT_NOISE_RES = [
    # "(post-bacc)" / "(post-baccalaureate)" qualifier
    re.compile(r'\s*\(\s*post[\s-]*bacc(?:alaureate)?\s*\)', re.I),
    # parenthetical concentration list: "(HSMI and MSMD Concentrations)"
    re.compile(r'\s*\([^)]*concentrations?\s*\)', re.I),
    # trailing "with <…> concentration(s)": "…with AI Concentration"
    re.compile(r'\s+with\s+[^,]*?\s+concentrations?\b', re.I),
    # deployment/pathway program suffix: "Connect (Bridge) Program", "(Bridge) Program",
    # "Connect Program", "Bridge Program"
    re.compile(r'\s+(?:connect\s+)?\(?bridge\)?\s+program\b', re.I),
    re.compile(r'\s+connect\s+program\b', re.I),
]


def _svt_strip_program_noise(name):
    """Strip concentration-list parentheticals, 'with X concentration' clauses,
    '(post-bacc)' qualifiers, and 'Connect (Bridge) Program' deployment suffixes
    from an SVT program name so the underlying program parses cleanly. Applied
    only at the Path B synthesis stage (after concentration/code matching), so it
    never suppresses genuine concentration-sub-row detection."""
    out = (name or '')
    for rx in _SVT_NOISE_RES:
        out = rx.sub(' ', out)
    # collapse whitespace and stray ", ," left behind
    out = re.sub(r'\s*,\s*,', ',', out)
    out = re.sub(r'\s{2,}', ' ', out).strip().strip(',').strip()
    return out


def _svt_courseleaf_id(courseleaf_key):
    """Extract the CIM program id embedded in an SVT 'Courseleaf Key' value,
    e.g. 'https://nextcatalog.northeastern.edu/programadmin/?key=1774' → 1774.
    Returns an int, or None when the field is empty / non-numeric ('see notes')."""
    if not courseleaf_key:
        return None
    # Airtable Courseleaf_URL uses mixed case (?key= and ?Key=) — match both.
    m = re.search(r'[?&]key=(\d+)', courseleaf_key, re.I)
    return int(m.group(1)) if m else None


# SVT "How Can We Help You" picklist value → portfolio cim_change_type style
# proposal classification. Values not in this map fall through to '' (Other).
# Source: distinct values observed in the SVT sheet 2026-05-20; extended
# 2026-07-20 for new Airtable `Request_Type` values (Sunset/Inactivate,
# Redeploy/New to Network) that the Smartsheet-era map lacked.
_SVT_HCWHY_TO_TYPE = {
    'New Program':                                'New',
    'Inactivate an existing or launching program': 'Inactivation',
    'Sunset/Inactivate an existing program':      'Inactivation',
    'Redesign an existing program':               'Change',
    'Revamp an Existing Program':                 'Change',
    'Term change request':                        'Change',
    'Launch term change request':                 'Change',
    'Deploy Program to Network':                  'Network Deployment',
    'Redeploy to International Network':          'Network Deployment',
    'New to Network':                             'Network Deployment',
}
# NOTE: SVT concentration proposals whose parent is ambiguous (and any other
# manual disposition) are no longer hardcoded here — they live in the durable,
# user-editable `svt_overrides` table (disposition='pending'|'concentration'|
# 'non_program'|'program'), edited in the local site's Console. The ingest reads
# that table at the top of the SVT loop; see ingest() Step 1.

# HCWHY values that indicate this is NOT a program proposal — skipped silently
# (they go into the non_programs bucket of portfolio_mismatches.json).
_SVT_HCWHY_NON_PROGRAM = {
    'Digital Badge Credential Proposal',
    'New Product (e.g. student experience program)',
    'Net New Product',
    'General market research',
    'General Market Research (for existing Global Network)',
    'Market Research',
    'International Opportunity',
    'Course development consultation',
}


def parse_svt(path=None):
    """Parse the SVT Source Data Airtable JSON produced by
    fetch_portfolio_data.fetch_svt_sheet() via the Airtable REST API
    ({"source":"airtable","records":[{"id","fields":{...}}, ...]}).

    Returns a list of dicts with normalized fields:
      {program_code, program_name, college, campus, program_level,
       degree_type, status, sub_status, speed_to_market, hcwhy,
       actual_launch_date, uip_program, courseleaf_key, initiative_type,
       phase, svt_key}
    """
    if path is None:
        # Default lives in data/portfolio_feeds/ alongside the other feeds.
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            'data', 'portfolio_feeds', 'svt.json')
    if not os.path.exists(path):
        return []
    try:
        with open(path) as f:
            data = json.load(f)
    except Exception:
        return []

    def _txt(v):
        """Airtable cells: multipleSelects → list, checkbox → bool, others str.
        Lists are SORTED so a stable, order-independent string results — Airtable
        returns multi-select values in an arbitrary order, and unsorted joins made
        the svt_seen fingerprint (which includes initiative_type) flip spuriously,
        which in turn reset user disposition overrides on 'changed' entries."""
        if v is None:
            return ''
        if isinstance(v, bool):
            return 'True' if v else ''
        if isinstance(v, list):
            return ', '.join(sorted(str(x).strip() for x in v if x not in (None, '')))
        return str(v).strip()

    out = []
    for rec in data.get('records', []):
        f = rec.get('fields', {})
        name = _txt(f.get('Program_Name'))
        if not name:
            continue

        # Normalize campus: drop placeholder values.
        camp = _txt(f.get('Campus'))
        if camp in ('Not Applicable', 'N/A'):
            camp = ''

        # Normalize college. UIP variants → "Office of the Provost" so the
        # College filter groups them under Provost (per Waleed's request).
        col = _txt(f.get('College'))
        if col in ('Not Applicable', 'All'):
            col = ''
        elif col.startswith('University Interdisciplinary Program'):
            col = 'Office of the Provost'

        out.append({
            'program_code':       _txt(f.get('Program_Code')),
            'program_name':       name,
            'college':            col,
            'campus':             camp,
            'program_level':      _txt(f.get('Program_Level')),
            'degree_type':        _txt(f.get('Degree_Type')),
            'status':             _txt(f.get('Status')),
            'sub_status':         _txt(f.get('Launch_Sub-Status')),
            'speed_to_market':    _txt(f.get('Speed_To_Market')),
            # Airtable 'Request_Type' carries what Smartsheet called "How Can We
            # Help You" — the same value set (_SVT_HCWHY_TO_TYPE / _NON_PROGRAM).
            'hcwhy':              _txt(f.get('Request_Type')),
            # 'GTM_Launch' is the launch date (Smartsheet's "Actual Launch Date").
            'actual_launch_date': _txt(f.get('GTM_Launch')),
            'uip_program':        _txt(f.get('UIP_Program')),
            # Courseleaf_URL embeds the CIM program id (?key=N) — an authoritative
            # direct link to the CIM record, far more robust than name matching.
            'courseleaf_key':     _txt(f.get('Courseleaf_URL')),
            # Initiative Type / Phase describe what the SVT entry IS (full degree/
            # certificate program vs a concentration/course/product) and how far
            # along it is — used to decide whether an unmatched row is a genuinely
            # new program worth synthesizing into the portfolio.
            'initiative_type':    _txt(f.get('Initiative_Type')),
            'phase':              _txt(f.get('Phase')),
            # Stable per-row key for durable, user-editable disposition overrides
            # (svt_overrides table). Airtable_ID (autoNumber) is the new key; it's
            # present on every record and stable across edits.
            'svt_key':            _txt(f.get('Airtable_ID')),
        })

    return out


def parse_gtm(path=GTM_PATH):
    """Parse the "Go To Market Roster 2.0" Smartsheet JSON produced by
    fetch_portfolio_data.fetch_gtm_sheet().

    Returns a list of dicts, one per row:
      {cim_id (int|None), banner (str, upper), gtm_type, gtm_date,
       gtm_first_term, gtm_last_term, gtm_intake_terms}
    The CIM url ('.../programadmin/?key=N') yields cim_id (the primary join
    key); Banner Code is the fallback join.
    """
    if not os.path.exists(path):
        return []
    try:
        with open(path) as f:
            data = json.load(f)
    except Exception:
        return []

    col_by_id = {c['id']: c['title'] for c in data.get('columns', [])}
    KEEP = {
        'Type', 'GTM Launch or Inactivation Date', 'First Effective Intake Term',
        'Last Available Term', 'Available intake terms', 'CIM url', 'Banner Code',
    }
    out = []
    for row in data.get('rows', []):
        rec = {}
        for cell in row.get('cells', []):
            title = col_by_id.get(cell.get('columnId'))
            if title not in KEEP:
                continue
            v = cell.get('displayValue')
            if v is None:
                v = cell.get('value')
            rec[title] = '' if v is None else str(v).strip()
        # Extract CIM program id from the CIM url's ?key= parameter
        cim_id = None
        m = re.search(r'[?&]key=(\d+)', rec.get('CIM url', ''))
        if m:
            cim_id = int(m.group(1))
        banner = (rec.get('Banner Code', '') or '').strip().upper()
        if cim_id is None and not banner:
            continue   # nothing to join on
        out.append({
            'cim_id':           cim_id,
            'banner':           banner,
            'gtm_type':         rec.get('Type', ''),
            'gtm_date':         rec.get('GTM Launch or Inactivation Date', ''),
            'gtm_first_term':   rec.get('First Effective Intake Term', ''),
            'gtm_last_term':    rec.get('Last Available Term', ''),
            'gtm_intake_terms': rec.get('Available intake terms', ''),
        })
    return out


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


def parse_enrollment(path=ENROLLMENT_PATH):
    """Parse the Master's enrollment CSV (Tableau long format) into:
      by_cc          — {(program_code, campus_norm): {year: {'t':total,'n':new}}}
      code_campuses  — {program_code: set(campus_norm)}
    Keeps only the 'Total YYYY' and 'New YYYY' measures (averages / completed
    apps / plus-one are ignored). Enrollment is keyed by CIM banner code +
    campus; the overlay in ingest() joins it to portfolio rows by banner_code.
    """
    import csv as _csv
    by_cc = {}
    code_campuses = {}
    if not os.path.exists(path):
        return by_cc, code_campuses
    try:
        with open(path, encoding='utf-8-sig') as f:
            for r in _csv.DictReader(f):
                code = (r.get('Program Code') or '').strip()
                if not code:
                    continue
                m = re.match(r'^(Total|New)\s+(\d{4})$', (r.get('Measure Names') or '').strip())
                if not m:
                    continue
                metric, year = m.group(1), m.group(2)
                val = (r.get('Measure Values') or '').strip().replace(',', '')
                try:
                    num = int(float(val))
                except ValueError:
                    continue
                campus = _normalize_campus((r.get('Campus Name') or '').split(',')[0].strip())
                by_cc.setdefault((code, campus), {}).setdefault(year, {})[
                    't' if metric == 'Total' else 'n'] = num
                code_campuses.setdefault(code, set()).add(campus)
    except Exception as e:
        print(f"  Enrollment parse error: {e}")
    return by_cc, code_campuses


# --- Banner Program/Major/Concentration — authoritative concentration college ---
_CONC_STOP = {'for', 'and', 'the', 'of', 'in', 'a', 'an', 'to', 'with', '&'}


def _conc_tokens(name):
    """Significant lowercase tokens of a concentration name (stop-words dropped)."""
    return [t for t in re.split(r'[^a-z0-9]+', (name or '').lower())
            if t and t not in _CONC_STOP]


def _conc_sim(a_toks, b_toks):
    """Similarity of two concentration token lists, tolerant of Banner's
    truncation (Banner clips names, e.g. 'Sustainability Infrastruct Env').
    A token matches if one is a prefix of the other (≥3 chars)."""
    if not a_toks or not b_toks:
        return 0.0
    def tok_match(x, y):
        return x == y or (len(x) >= 3 and len(y) >= 3 and (x.startswith(y) or y.startswith(x)))
    matched = sum(1 for bt in b_toks if any(tok_match(bt, at) for at in a_toks))
    return matched / max(len(a_toks), len(b_toks))


def parse_banner_pmc(path=BANNER_PMC_PATH):
    """Parse the Banner Program/Major/Concentration CSV into two indexes for
    concentration-college lookup:
      by_code : Program Code            → [{conc, tokens, college}]
      by_sd   : (norm_subject, degree)  → [{conc, tokens, college}]  (fallback
                for the ~16 programs whose Banner code ≠ CIM banner_code)
    Only rows with a *recognized* canonical college and a real concentration
    (not blank / 'No Concentration') are kept."""
    import csv as _csv
    by_code, by_sd = {}, {}
    if not os.path.exists(path):
        return by_code, by_sd
    try:
        with open(path, encoding='utf-8-sig') as f:
            for r in _csv.DictReader(f):
                college = _canonical_college_only((r.get('College') or '').strip())
                if not college:
                    continue
                conc = (r.get('Concentration ') or r.get('Concentration') or '').strip()
                if not conc or conc.lower() in ('no concentration', 'none'):
                    continue
                entry = {'conc': conc, 'tokens': _conc_tokens(conc), 'college': college}
                code = (r.get('Program Code') or '').strip()
                if code:
                    by_code.setdefault(code, []).append(entry)
                subj = _norm(r.get('Major') or '')
                deg = _norm(_norm_degree(code.split('-')[0])) if code else ''
                if subj and deg:
                    by_sd.setdefault((subj, deg), []).append(entry)
    except Exception as e:
        print(f"  Banner PMC parse error: {e}")
    return by_code, by_sd


# Banner program names / codes that are NOT trackable academic programs — the
# same administrative buckets last week's manual reconciliation stripped:
# minors, non-degree, undeclared/provisional, exchange/NUin/scholars/pathway/
# special-student/transitional records, and general-studies catch-alls.
_BANNER_NONDEGREE_RE = re.compile(
    r'\bundeclar|\bundecid|\bprovisional\b|non-degree|\bindep|independent stud'
    r'|\bminor\b|\bgnrl studies\b|general studies|exchange students?\b|\bnd exchange\b|special exchange|\bnuin\b|\bscholars?\b'
    r'|\btransitional\b|global pathway|pre[-\s]?college|\bimmerse\b|special student'
    r'|special learning|performance-based admission|professional education'
    r'|double degree|medical school prep|teacher in context|\bfoundation\b'
    r'|\bspecial\b.*\b(gr|ug|student|prg|prof)\b', re.I)
# Banner codes to skip outright: CPS "P-" programs (ignored per decision),
# non-degree (ND…), special (SPEC…), and "-DE" distance-education duplicates.
_BANNER_SKIP_CODE_RE = re.compile(r'^P-|-DE$|^ND-|^ND$|^SPEC-', re.I)


def parse_banner_programs(path=BANNER_PMC_PATH):
    """Program-level view of the Banner PMC feed for reconciliation.
    Returns (progs, by_sd):
      progs : Program Code → {code, name, major, degree, statuses, campuses,
                              active_campuses}  (active = Active/Future Active)
      by_sd : (norm_subject, norm_degree) → set(Program Code)
    Excludes combined/dual majors (Combined Major Ind.=Y) and non-degree /
    undeclared / provisional records (per project decision)."""
    import csv as _csv
    progs, by_sd = {}, {}
    if not os.path.exists(path):
        return progs, by_sd
    try:
        with open(path, encoding='utf-8-sig') as f:
            for r in _csv.DictReader(f):
                if (r.get('Combined Major Ind.') or '').strip().upper() == 'Y':
                    continue
                code = (r.get('Program Code') or '').strip()
                if not code or code == 'All' or _BANNER_SKIP_CODE_RE.search(code):
                    continue
                pname = (r.get('Program') or '').strip()
                if _BANNER_NONDEGREE_RE.search(pname) or '/' in pname:
                    continue   # non-degree/pathway or dual-major ("A/B") shorthand
                status = (r.get('Status') or '').strip()
                campus = _normalize_campus((r.get('Campus') or '').split(',')[0].strip())
                major = _norm(r.get('Major') or '')
                deg = _norm(_norm_degree(code.split('-')[0]))
                p = progs.get(code)
                if not p:
                    p = progs[code] = {'code': code, 'name': pname, 'major': major,
                                       'degree': deg, 'statuses': set(),
                                       'campuses': set(), 'active_campuses': set()}
                p['statuses'].add(status)
                if campus:
                    p['campuses'].add(campus)
                    if status in ('Active', 'Future Active'):
                        p['active_campuses'].add(campus)
                if major and deg:
                    by_sd.setdefault((major, deg), set()).add(code)
    except Exception as e:
        print(f"  Banner programs parse error: {e}")
    return progs, by_sd


def _reconcile_banner_portfolio(tracker, cim_meta):
    """Program-level Banner ↔ portfolio reconciliation (data-quality queue).
    Banner and the portfolio are meant to be in sync; this surfaces every
    substantive difference. Returns four lists:
      missing_in_portfolio : Banner-active programs with no portfolio match
      missing_in_banner    : should-be-live portfolio programs absent from Banner
      code_mismatch        : CIM banner_code ≠ Banner Program Code
      campus_diff          : program's campus footprint differs
    Excludes (per project decisions): combined/dual majors, non-degree/
    undeclared/provisional, in-workflow proposals, and inactivations."""
    progs, by_sd = parse_banner_programs()
    if not progs:
        return {}

    # Portfolio program groups (CIM-seeded only), keyed by banner_code if present
    # else (subject, degree). Collect campuses + lifecycle flags.
    # **Compare only COMPLETED portfolio programs to Banner** (Waleed 2026-07-13):
    # in-workflow proposals aren't in Banner yet (Banner is set up when a proposal
    # finishes), so including them produces false discrepancies (e.g. an online
    # MS-ABA-O still in Program Editor flagged as a code mismatch). Skip any
    # deployment that is currently in workflow; a program group is built only from
    # its completed (workflow-finished) deployments.
    port = {}
    for row in tracker.values():
        cimid = row.get('cim_program_id')
        if not cimid:
            continue                      # external (SVT-added) rows are not Banner programs
        if row.get('cim_step'):
            continue                      # in workflow — not yet in Banner, out of scope
        meta = cim_meta.get(cimid, {})
        bcode = (meta.get('banner_code') or '').strip()
        # Skip CIM programs whose stored banner_code is a CPS "P-" quarter code
        # (and ND-/SPEC-/-DE), symmetric with the Banner-side skip. Per the
        # Registrar (2026-07): CPS dropped the "P-" when moving quarters→semesters,
        # so a CIM "P-" code is a stale/dying quarter program — quarters are going
        # away and out of scope, so don't flag them as mismatches.
        if bcode and _BANNER_SKIP_CODE_RE.search(bcode):
            continue
        subj = _norm(meta.get('subject') or '')
        deg = _norm(_norm_degree(meta.get('degree') or ''))
        # Skip minors and combined/dual majors on the CIM side too — Banner
        # excludes them, so they'd otherwise show as false "missing in Banner".
        nm = row.get('program_name', '')
        # Graduate-only discrepancy scan (Waleed 2026-07-17): undergrad programs
        # (BS/BA/BFA/BSBA/minors/undergrad certs) are out of scope — skip them.
        if is_undergrad_svt(nm):
            continue
        if deg == 'minor' or re.search(r'\bminor\b', nm, re.I):
            continue
        # Concentrations are not standalone Banner programs (Banner tracks them as
        # majors under a parent), so exclude CIM concentration records.
        if re.search(r'\bconcentration\b', nm, re.I):
            continue
        # Combined / dual-degree majors: Banner marks them Combined Major Ind.=Y
        # and we skip them on the Banner side, so skip them on the CIM side too.
        # Signals: an "X and Y, <BS/BA…>" combined-major name, or a dual code with
        # a "/" (e.g. "MBA-BSAD-F / MSF-FINA").
        if re.search(r'\S+\s+and\s+\S+.*,\s*(?:BA|BS)\w*\b', nm) or '/' in bcode:
            continue
        key = ('c', bcode) if bcode else ('s', subj, deg)
        g = port.get(key)
        if not g:
            g = port[key] = {'name': nm, 'bcode': bcode,
                             'subj': subj, 'deg': deg, 'campuses': set(),
                             'wf': False, 'inact': False, 'completed': False}
        if row.get('campus'):
            g['campuses'].add(_normalize_campus(row['campus']))
        if row.get('cim_step'):
            g['wf'] = True
        if row.get('cim_change_type') == 'Inactivation':
            g['inact'] = True
        if row.get('cim_completion_date') and not row.get('cim_step'):
            g['completed'] = True

    def banner_codes_for(g):
        if g['bcode'] and g['bcode'] in progs:
            return {g['bcode']}
        return set(by_sd.get((g['subj'], g['deg']), set()))

    matched_codes = set()
    missing_in_banner, code_mismatch, campus_diff = [], [], []
    for g in port.values():
        codes = banner_codes_for(g)
        matched_codes |= codes
        should_be_live = not g['wf'] and not g['inact']
        if not codes:
            # "Missing in Banner" = a COMPLETED program Banner should have but
            # doesn't. In-workflow programs are already excluded (skipped above);
            # inactivations are excluded here (they're being removed, so Banner
            # legitimately may not carry them).
            if not g['inact']:
                missing_in_banner.append({'program': g['name'], 'banner_code': g['bcode'] or '—'})
            continue
        if g['bcode'] and g['bcode'] not in progs and not g['inact']:   # code differs from Banner
            # Exclude inactivations (like campus_diff / missing_in_banner do): an
            # inactivated program (e.g. CERTG-CPRN-O, Corporate Renewal Online)
            # is being removed, so Banner correctly won't carry its code.
            code_mismatch.append({'program': g['name'], 'cim_code': g['bcode'],
                                  'banner_code': ', '.join(sorted(codes))})
        if should_be_live and g['bcode'] in progs:      # campus footprint (code-matched only)
            bcamp = set()
            for c in codes:
                bcamp |= progs[c]['active_campuses']
            # Skip when Banner has the code but NO Active/Future-Active campus —
            # the program is inactive in Banner, so campus differences aren't
            # real discrepancies (Waleed 2026-07-17). Covers e.g. Pharmacy PharmD,
            # Software Product Management Grad Cert.
            if not bcamp:
                continue
            only_p = sorted(g['campuses'] - bcamp)
            only_b = sorted(bcamp - g['campuses'])
            if only_p or only_b:
                campus_diff.append({'program': g['name'], 'banner_code': g['bcode'],
                                    'only_portfolio': only_p, 'only_banner': only_b,
                                    'banner_campuses': sorted(bcamp),
                                    'cim_campuses': sorted(g['campuses'])})

    # A program the portfolio already has under a *different* code is a code
    # variant (surfaced in code_mismatch), not truly missing — skip those here.
    port_sd = {(g['subj'], g['deg']) for g in port.values() if g['subj'] and g['deg']}
    missing_in_portfolio = []
    for code, p in progs.items():
        if is_undergrad_svt(p['name']):       # graduate-only scan (Waleed 2026-07-17)
            continue
        is_active = bool(p['active_campuses']) or (p['statuses'] & {'Active', 'Future Active'})
        if is_active and code not in matched_codes and (p['major'], p['degree']) not in port_sd:
            missing_in_portfolio.append({'banner_code': code, 'name': p['name']})

    return {
        'missing_in_portfolio': sorted(missing_in_portfolio, key=lambda x: x['name']),
        'missing_in_banner':    sorted(missing_in_banner, key=lambda x: x['program']),
        'code_mismatch':        sorted(code_mismatch, key=lambda x: x['program']),
        'campus_diff':          sorted(campus_diff, key=lambda x: x['program']),
    }


def _banner_concs_for(meta, by_code, by_sd):
    """Return Banner concentration entries for a program, matched by banner_code
    first, then by (subject, degree). `meta` = {banner_code, subject, degree}."""
    code = (meta.get('banner_code') or '').strip()
    if code and code in by_code:
        return by_code[code]
    subj = _norm(meta.get('subject') or '')
    deg = _norm(_norm_degree(meta.get('degree') or ''))
    return by_sd.get((subj, deg), [])


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
    # CIM's XML <campus> field uses these 3-letter codes (the 2-letter forms
    # above are legacy/external-feed aliases that don't appear in CIM XML).
    # VTL ("virtual") and PVL ("primarily virtual") both mean Online.
    'CHL': 'Charlotte', 'LDN': 'London', 'NYC': 'New York', 'PTL': 'Portland',
    'SJO': 'Silicon Valley', 'VTL': 'Online', 'PVL': 'Online',
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
    # Connector after the degree phrase is normally "in" but SVT free-text
    # sometimes writes "Master of Science of X" — accept "of" too so the
    # subject isn't left with a stray leading "of ".
    (re.compile(r'^masters?\s+of\s+science\s*(?:\([^)]*\))?\s*(?:(?:in|of)\s+)?', re.I), 'MS'),
    (re.compile(r'^masters?\s+of\s+arts\s+(?:(?:in|of)\s+)?', re.I), 'MA'),
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
    (re.compile(r'^bachelor\s+of\s+science\s*(?:(?:in|of)\s+)?', re.I), 'BS'),
    (re.compile(r'^bachelor\s+of\s+arts\s*(?:(?:in|of)\s+)?', re.I), 'BA'),
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
    # Variant attached via dash, comma, "+", OR plain whitespace.
    # Whitespace-only and "+" separators are accepted because SVT names often
    # write the variant unseparated (e.g. "Speech-Language Pathology Connect",
    # "Information Systems + Bridge"). "Online" is excluded from the bare-
    # whitespace branch because the word appears in legitimate program names;
    # it must be preceded by a dash, comma, or "+".
    r'\s*(?:\+\s*|[-–—]|,)?\s+(align|connect|bridge|accelerated|part[\s\-]?time|full[\s\-]?time)'
    r'(?:\s+Program)?\s*$|'
    r'\s*(?:\+\s*|[-–—]|,)\s*(online)(?:\s+Program)?\s*$',
    re.I
)
_DEPLOYMENT_GROUP_ANY = lambda m: m.group(1) or m.group(2)

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
    r'|\bdeactivation\b'                     # "Global Health and Nutrition Cert deactivation"
    r'|\bworkforce\s+development\b'          # "Energy workforce development"
    r'|\bsummer[\s-]?in\b'                   # "SummerIn Portland"
    r'|\bproficiency\s+course\b'             # "Online English Proficiency Course"
    r'|\bcourses\s*\('                       # "Security Ops Center Courses (AAI 0500-0509)"
    r'|\bpre[\s-]?college\b'                 # "Pre-College" / "Pre-CollEDGE"
    r'|\bsurvey\b'                           # "Doctor of Law & Policy Survey"
    r'|\bplacing\s+(phd|graduate)\s+students?\b'  # "Placing PhD students in the network..."
    r'|\btreks?\b'                           # "Entrepreneurship Treks"
    r'|^semester\s+in\s*:'                   # "Semester In: Rural Health Immersion"
    r'|\brural\s+health\s+immersion\b'       # safety net for the same entry
    r'|\bexecutive\s+credential\b'           # "Executive Credential in X"
    r'|\bname\s+evaluation\b'                # "MS in XR - Name Evaluation" (name TBD, not a program)
    r'|\bprior\s+learning\s+assessment\b'    # "Prior Learning Assessment- New Pathway to COE MS" (product offering)
    r'|\bgraduate\s+certificates\b'          # "Online Graduate Certificates with EDGE"
                                             # — plural form is always a meta
                                             # category/bundle, not a single
                                             # program. Real CIM credentials
                                             # use singular "Graduate Certificate".
    # NOTE: "Launch of the …" and "Suspension of …" are NOT filtered — they
    # represent real proposals (new deployment / inactivation). The "Launch
    # of " / "Suspension of " prefix is stripped before name parsing via
    # _strip_svt_prefix() so the underlying program can be matched.
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


# SVT mapping is graduate-only. An entry is undergraduate when its degree token is
# a bachelor's/minor/undergrad-certificate, or the name says "Bachelor of…" /
# "Pre-…" / "Minor" / "Undergraduate Certificate". Ambiguous → graduate (kept).
# Definition confirmed with Waleed 2026-07-13.
_UNDERGRAD_RE = re.compile(
    r'bachelor of|bachelor\'s|'
    r'\b(BS|BA|BFA|BSc|BSN|BSBA|BSCS|BArch|BSE|BSChE|BSEnvE|B\.S\.|B\.A\.)\b|'
    r'\bpre-|\bminor\b|undergraduate certificate', re.I)


def is_undergrad_svt(name):
    """True if an SVT entry is an undergraduate program (out of scope for the
    graduate-only SVT→CIM mapping)."""
    return bool(_UNDERGRAD_RE.search(name or ''))


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
    r'|\bexit[\s-]?only\s+degree\b'    # "Exit-Only Degree Program"
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
    'all',
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

# The set of *canonical* college names (the alias map's target values). Used to
# validate a per-concentration college attribution: we only accept it when it
# maps to one of these, otherwise it's noise (a fragment, a track label, a
# "(available only as a second concentration)" note, etc.).
_CANONICAL_COLLEGES = set(_COLLEGE_ALIASES.values())


def _canonical_college_only(raw):
    """Return the canonical college name for `raw` ONLY if it's a recognized
    college; otherwise ''. Prevents stray heading/menu text from being stored
    as a bogus concentration college."""
    nc = _normalize_college(raw)
    return nc if nc in _CANONICAL_COLLEGES else ''


def _split_conc_college(text):
    """Split a concentration heading/anchor into (clean_name, college).

    UIP interdisciplinary programs attribute each concentration to a managing
    college after an em/en-dash or a spaced hyphen, e.g.
      "Human-AI Collaboration Systems - College of Engineering"
      "Marketing—D'Amore-McKim School of Business"
    We split on the LAST such separator whose trailing text is a *recognized*
    college (so internal hyphens like "Human-AI" and non-college trailers are
    left alone), returning the college and the name with the attribution
    stripped. College names need not contain the word "College" (handles
    D'Amore-McKim, School of Law, Office of the Provost)."""
    college = ''
    cut = None
    for m in re.finditer(r'\s*[—–]\s*|\s+-\s+', text):
        col = _canonical_college_only(text[m.end():].strip())
        if col:
            college = col
            cut = m.start()
    if cut is not None:
        text = text[:cut]
    text = text.rstrip(' *†—–-').strip()
    return text, college


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
    # NOTE: the IPD entries below used to be hardcoded here:
    #   'AI (New COE Concentration in Human-AI Collaboration), MS'
    #   'AI (New COE Concentration in High Performance and Edge AI), MS'
    #   'Computational Creativity Concentration for UIP Masters in AI'
    #   'AI (new concentration) Bouve, MS'
    #   'Artificial Intelligence - Omics Concentration (COS), MS'
    # They are now handled GENERICALLY by the IPD preprocessor's three
    # concentration patterns (_CONC_NEW_RE, _CONC_NEW_NAMED_RE, _CONC_FOR_RE)
    # which extract the concentration name (either explicit in the entry or
    # looked up by college in the parent's CIM curriculum HTML).
    'Doctor of Professional Studies at Roux':
        ('Professional Studies, DPS', 'Coll of Professional Studies', 'Portland'),
    'at Roux, EDD':
        ('Education, EdD', '', 'Portland'),
    'and MSIS Bridge In Miami, MSIS':
        ('Information Systems, MSIS (Bridge)', '', 'Miami'),
    # NOTE: 'Artificial Intelligence - Omics Concentration (COS), MS' and
    # 'AI (new concentration) Bouve, MS' used to be hardcoded here. They're
    # now handled GENERICALLY by the IPD preprocessor patterns:
    #   _CONC_DASH_PAREN_RE    catches 'PARENT - X Concentration (CC), DEG'
    #   _CONC_NEW_RE           catches 'DEG in PARENT (new concentration) COLLEGE'
    #                          and looks up the canonical name in the parent's
    #                          CIM curriculum HTML by college name.
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
    # in X" forms (also "Bioengineering X Concentration Bridge Program"). The
    # real program's degree is MSBioE (not a bare MS), so the parent must be
    # "Bioengineering, MSBioE" — otherwise no CIM match is found and a duplicate
    # synthetic "Bioengineering, MS" parent gets fabricated.
    (re.compile(r'^(?:Master of Science in\s+)?Bioengineering[,\s]+concentration in ', re.I),
     'Bioengineering, MSBioE', None),
    (re.compile(r'^Bioengineering\s+.+?\s+Concentration\b', re.I),
     'Bioengineering, MSBioE', None),
    # Civil Engineering MSCivE concentrations whose concentration phrase has
    # internal commas (regex extraction fails on these).
    (re.compile(r'^Civil Engineering with Concentration in .+,\s*MSCivE\b', re.I),
     'Civil Engineering, MSCivE', None),
    (re.compile(r'^UG Concentration in ', re.I),
     'Regulatory Affairs, BS', 'Boston'),
    # "AI - X Concentration, MS" → AI MS (the canonical Boston program;
    # synonym 'AI' for 'Artificial Intelligence').
    (re.compile(r'^AI\s*[-—,]\s*.+?\s+Concentration\b', re.I),
     'Artificial Intelligence, MS', 'Boston'),
    # NOTE: '^Omics$', '^Health Data$', '^Human-AI Collaboration$',
    # '^High Performance and Edge AI$', '^Computational Creativity$' used to
    # live here as explicit ^pattern$ → 'Artificial Intelligence, MS'
    # mappings. They are no longer needed — the IPD preprocessor's
    # _CONC_NEW_RE / _CONC_NEW_NAMED_RE / _CONC_FOR_RE create the sub-rows
    # already linked to the right parent at ingest time.
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
        # Capture the trailing attribution "—…College…" or " - …College…"
        # (em-dash OR hyphen with surrounding whitespace) so we can surface
        # the college in the row's College column, then strip the suffix
        # from the heading so the displayed name is just the concentration
        # topic. CIM authors are inconsistent: some use em-dashes, some use
        # plain hyphens.
        h, conc_college = _split_conc_college(h)
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
        # Reject structural markers that survived normalization. These
        # CIM headings end up reducing to a single generic word like
        # 'Optional' or 'Required' once the trailing 'Concentration' is
        # stripped — they are NOT real concentration names.
        _STRUCTURAL_BLOCKLIST = {
            'optional', 'required', 'elective', 'electives',
            'core', 'core requirements', 'requirements',
            'general electives', 'restricted electives',
            'professional electives', 'free electives',
        }
        h_clean = re.sub(r'\s*[/]\s*', '/', h).strip()
        if h_clean.lower() in _STRUCTURAL_BLOCKLIST:
            continue
        # Also reject if the result starts with a structural prefix
        # ("Elective Courses / Optional", "Professional Electives/Optional",
        # "Optional Political Science", etc.) — these are pure curriculum
        # plumbing language, not real concentrations.
        _STRUCTURAL_PREFIX_RE = re.compile(
            r'^(elective\s+courses?|professional\s+electives?|optional|required|core)\b',
            re.I)
        if _STRUCTURAL_PREFIX_RE.match(h):
            continue
        if h and h.lower() not in seen:
            seen.add(h.lower())
            results.append({'name': h, 'college': conc_college})

    # Some programs list concentrations as a "Concentration Options" link menu —
    # <li><a href="#…">Name</a> — College of Y</li> — rather than as h2/h3/h4
    # section headings (which the walk above misses entirely). Parse each <li>
    # in the menu: the visible <a> text is the concentration name, the trailing
    # text after the link is the college. (Hrefs are inconsistent — some include
    # "Concentration", some don't — so we use the visible text, not the href.)
    _anchor_skip = {
        'optional', 'required', 'elective', 'electives', 'core',
        'core requirements', 'requirements', 'general electives',
        'restricted electives', 'professional electives', 'free electives',
    }
    # The menu can sit under literal "Concentration Options" text OR under a
    # plain "<h2>Concentrations</h2>" heading (CIM authors are inconsistent).
    # Matching both also rescues concentrations whose individual section heading
    # omits the word "Concentration" — e.g. AI MS's "Human-AI Collaboration
    # Systems - College of Engineering" — since the menu still lists them.
    _conc_menus = re.findall(
        r'(?:Concentration\s+Options'
        r'|<h[1-6][^>]*>[^<]*\bConcentrations?\b[^<]*</h[1-6]>)'
        r'.*?(<ul\b.*?</ul>)',
        html, re.I | re.S)
    for ul in _conc_menus:
        for li in re.findall(r'<li\b[^>]*>(.*?)</li>', ul, re.S):
            am = re.search(r'<a\b[^>]*>(.*?)</a>(.*)$', li, re.S)
            if not am:
                continue
            name = re.sub(r'<[^>]+>', '', am.group(1)).replace('\xa0', ' ')
            name = re.sub(r'\s+', ' ', name).strip().rstrip('*† ').strip()
            trailing = re.sub(r'<[^>]+>', '', am.group(2)).replace('\xa0', ' ')
            trailing = re.sub(r'\s+', ' ', trailing).strip()
            trailing = re.sub(r'^[\s—–-]+', '', trailing).strip()  # drop leading dash/em-dash
            # College may sit in the trailing text (after </a>) or be embedded in
            # the anchor text itself ("Marketing—D'Amore-McKim School of Business").
            name, name_college = _split_conc_college(name)
            college = _canonical_college_only(trailing) or name_college
            if not name or name.lower() in seen or name.lower() in _anchor_skip:
                continue
            if re.search(r'\boptions?$', name, re.I):   # "Electives Option(s)", etc.
                continue
            seen.add(name.lower())
            results.append({'name': name, 'college': college})
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
    import unicodedata
    c = (college or '').strip()
    if not c:
        return ''
    # Strip diacritics for both blocklist and alias lookup ("Bouvé" → "Bouve",
    # "Mills (at Roux)" etc. — CIM HTML occasionally has accented spellings).
    def _no_diacritics(s):
        return ''.join(ch for ch in unicodedata.normalize('NFD', s)
                       if unicodedata.category(ch) != 'Mn')
    key = _no_diacritics(c).lower()
    # Normalize curly apostrophes/quotes to straight so CIM's "D’Amore-McKim"
    # (U+2019) matches the straight-apostrophe alias keys.
    key = key.replace('’', "'").replace('‘', "'")
    if key in _COLLEGE_BLOCKLIST:
        return ''
    # Try direct match first, then a punctuation-stripped variant so
    # CIM HTML spellings like "College of Arts, Media, and Design" or
    # "Khoury College of Computer Science" match the (no-comma) keys
    # in _COLLEGE_ALIASES.
    if key in _COLLEGE_ALIASES:
        return _COLLEGE_ALIASES[key]
    stripped = re.sub(r'[,\.]', '', key)
    stripped = re.sub(r'\s+', ' ', stripped).strip()
    if stripped in _COLLEGE_ALIASES:
        return _COLLEGE_ALIASES[stripped]
    # Handle singular/plural variants ("Computer Science" vs "Computer Sciences")
    stripped2 = re.sub(r'\bscience\b', 'sciences', stripped)
    if stripped2 in _COLLEGE_ALIASES:
        return _COLLEGE_ALIASES[stripped2]
    # Handle "Health Sciences" vs "Hlth Sciences" (CIM's canonical short form).
    stripped3 = stripped.replace('health sciences', 'hlth sciences')
    if stripped3 in _COLLEGE_ALIASES:
        return _COLLEGE_ALIASES[stripped3]
    return c


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
    # Hyphenated deployment degree: keep the prefix uppercase but capitalize
    # the deployment word so the display reads "MS-Align" not "MS-ALIGN".
    # (CIM's canonical form is em-dash; for the dedup key we still produce
    # the hyphen variant — the em-dash → hyphen normalization at the top of
    # this function ensures both store under the same key.)
    if '-' in upper:
        base, sep, suffix = upper.partition('-')
        base_cased = _CASE_MAP.get(base, base)
        return f"{base_cased}-{suffix.capitalize()}"
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

    # No parenthetical campus, but a trailing "—Online" em-dash deployment
    # suffix (e.g. "Business Analytics, MS—Online", "Information Systems,
    # MSIS—Bridge—Online") means the online deployment — CIM's XML <campus>
    # tags these VTL/Online. Without this they fall through to the Boston
    # default and mis-report as Boston in the Banner campus reconciliation.
    # Only "—Online" maps to a campus; other deployment suffixes (—Align,
    # —Bridge, —Accelerated, —Part-Time) are not campuses and are left on the
    # degree for the variant-lookup path.
    if not campus:
        mo = re.search(r'[-–—]\s*online\s*$', name, re.I)
        if mo:
            campus = 'Online'
            name = name[:mo.start()].strip()

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
    subj, deg, campus = _parse_external_name_inner(name_raw)
    subj = _strip_conc_descriptor(subj)
    # Promote a leading-"Online" marker (stashed via global below) onto the
    # degree as an "—Online" variant suffix so it routes through the same
    # variant-in-subject lookup as native CIM —Online programs.
    if _PARSE_LEADING_ONLINE.get('flag'):
        _PARSE_LEADING_ONLINE['flag'] = False
        if deg and 'online' not in deg.lower():
            deg = f"{deg}-Online"
    return subj, deg, campus

_PARSE_LEADING_ONLINE = {'flag': False}

def _strip_conc_descriptor(subj):
    """Strip a trailing '- new [...] concentration' / '- new ...' annotation that
    SVT appends to a program name (e.g. 'Master of Science in Applied Sustainability
    - new concentration' → subject 'Applied Sustainability'). These are descriptive
    noise, not part of the CIM subject, and caused name-match misses against the
    real CIM program (which had no banner code to fall back on). Deployment em-dash
    suffixes (—Align/—Online/etc.) never contain 'new'/'concentration', so they're
    untouched."""
    if not subj:
        return subj
    s = re.sub(r'\s*[-–—]\s*new\b.*$', '', subj, flags=re.I).strip()          # "- new ..."
    s = re.sub(r'\s*[-–—][^-–—]*concentrations?\s*$', '', s, flags=re.I).strip()  # "- ... concentration(s)"
    return s or subj

def _parse_external_name_inner(name_raw):
    s = (name_raw or '').strip()

    # Strip administrative "(UIP)" / "(University Interdisciplinary Program)"
    # tags before campus extraction. These are not campuses — they're a
    # college/owner annotation appended by the SVT roster export. Leaving
    # them in blocks the trailing "(Campus)" or ", Campus" detection below.
    # The owning-college info is preserved separately on the row.
    s = re.sub(
        r'\s*\(\s*(?:UIP|University\s+Interdisciplinary\s+Program(?:\s*\(UIP\))?)\s*\)\s*$',
        '', s, flags=re.I).strip()

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

    # Extract campus from trailing " in CampusName" — covers SVT-style names
    # like "DLP in Charlotte" or "Masters of Security and Intelligence Studies
    # in Arlington" where the campus follows "in" with no comma.
    if not campus:
        campus_in_re = re.compile(
            r'\s+in\s+(Boston|Oakland|Portland|Toronto|Seattle|Miami|Arlington|'
            r'Vancouver|Charlotte|London|Silicon Valley)\s*$',
            re.I)
        mi = campus_in_re.search(s)
        if mi:
            campus = mi.group(1)
            s = s[:mi.start()].strip()

    # Strip leading "Online" — names like "Online MS Business Analytics" or
    # "Online Graduate Certificate in Data Analytics Engineering" are
    # —Online deployment variants. Promote the variant onto a flag so the
    # short-prefix / long-form parse below produces the bare degree, then
    # the variant gets re-attached at the end.
    online_m = re.match(r'^Online\s+(?=(?:Master|Bachelor|Graduate|Undergraduate|MS|MA|MBA|MFA|MEd|MPS|MPA|MPP|MPH|MAT|MArch|MDes|MEM|MSCS|MSIS|MSECE|MSME|MSBA|MSF|PhD|EdD|DNP|DPT|JD|LLM|CERTG?)\b)', s, re.I)
    if online_m:
        s = s[online_m.end():].strip()
        _PARSE_LEADING_ONLINE['flag'] = True

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

    # Bare degree token (no subject) — e.g. "DLP" left after stripping
    # "Launch of " prefix and " in Charlotte" campus suffix. Use the degree's
    # implicit subject when one is defined. Restricted to single-token
    # short codes so multi-word phrases like "Masters of X" still flow to
    # the long-form prefix matcher below.
    if re.match(r'^[A-Za-z]{1,10}$', s) and _is_valid_degree(s):
        deg = _norm_degree(s)
        subj = _DEGREE_IMPLICIT_SUBJECT.get(deg, '')
        return subj, deg, campus

    # "Master of <Field> (<Abbrev>) in <Subject>" — explicit parenthetical
    # degree abbreviation overrides the long-form prefix. Catches names like
    # "Master of Design (MDes) in Sustainable Urban Environments (SUEN)".
    abbrev_in_m = re.match(
        r'^Master(?:s|\s+of)?\s+[A-Za-z]+\s+\(([A-Z][A-Za-z0-9]{1,9})\)\s+in\s+(.+)$',
        s, re.I)
    if abbrev_in_m and _is_valid_degree(abbrev_in_m.group(1)):
        deg_abbrev = _norm_degree(abbrev_in_m.group(1))
        rest = abbrev_in_m.group(2).strip()
        # Strip trailing "(CODE)" program-code abbreviation like " (SUEN)"
        rest = re.sub(r'\s*\([A-Z]{2,8}\)\s*$', '', rest).strip()
        deploy_m = _DEPLOYMENT_SUFFIX_RE.search(rest)
        if deploy_m:
            dep = _DEPLOYMENT_GROUP_ANY(deploy_m).capitalize()
            rest = rest[:deploy_m.start()].strip()
            deg_abbrev = f"{deg_abbrev}-{dep}"
        return rest, deg_abbrev, campus

    # Try long-form degree prefix
    for pat, short_deg in _LONG_DEGREE_MAP:
        mm = pat.match(s)
        if mm:
            subj = s[mm.end():].strip().strip(',').strip()
            # Strip leading "- descriptor" (e.g. "- New Concentrations" → "")
            subj = re.sub(r'^[-–—]\s*.+$', '', subj).strip()
            # Move deployment suffix from subject to degree, same as the
            # short-prefix path. Catches "Master of Science in X - Align" /
            # "Master of Science in X - Align Program" / etc.
            deploy_m = _DEPLOYMENT_SUFFIX_RE.search(subj)
            if deploy_m:
                dep = _DEPLOYMENT_GROUP_ANY(deploy_m).capitalize()
                subj = subj[:deploy_m.start()].strip()
                short_deg = f"{short_deg}-{dep}"
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
            dep = _DEPLOYMENT_GROUP_ANY(deploy_m).capitalize()
            subj = subj[:deploy_m.start()].strip()
            deg = f"{deg}-{dep}"
        # Use implicit subject for degrees that stand alone without a subject
        if not subj and deg in _DEGREE_IMPLICIT_SUBJECT:
            subj = _DEGREE_IMPLICIT_SUBJECT[deg]
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
# GTM (go-to-market) readiness — ported from the EM perspective in static/app.js.
# Grad-only. A new offering is "ready for GTM" once its governance gate clears:
# a new concentration/cert past the Graduate Curriculum Committee, a new degree
# past the Board of Trustees, or a completed proposal effective in the current /
# upcoming catalog (>= EM_GTM_MIN_CATALOG_YEAR). Inactivations are tracked
# separately (gtm_inactivation) over the same current/upcoming window.
# ---------------------------------------------------------------------------
EM_GTM_MIN_CATALOG_YEAR = 2025
_EM_STAGE_ORD = {
    "Program PR Graduate Dean's Office": 1,
    "Provost Initial Review": 2,
    "Program Review 2": 3,
    "Program Graduate Provost Review": 4,
    "Program GRA Regulatory": 5,
    "Program Graduate Curriculum Committee": 6,                        # UGCC gate (grad)
    "Program Undergraduate Curriculum Committee - Tabled Proposals": 7,
    "Program Provost Administrative and Budgetary Review": 8,
    "Program Provost Approval": 9,
    "Program Faculty Senate": 10,
    "Program University Board of Trustees": 11,                        # BOT gate
    "Program Setup": 12,                                               # Registrar
    "Program Teach-Out": 13,
}
_EM_UGCC_ORD, _EM_BOT_ORD = 6, 11
_EM_PIPELINE_STEPS = set(_EM_STAGE_ORD)

def _em_canonical_step(step):
    if not step:
        return step
    if step.startswith("Program GRA Regulatory"):
        return "Program GRA Regulatory"
    if (step in ("Program Banner Setup", "Program Editor",
                 "Program Workflow Setup", "Program CIP Code Committee")
            or step.startswith("Program Catalog Setup")
            or "Degree Audit" in step):
        return "Program Setup"
    return step

def _em_is_college_step(step):
    if not step:
        return False
    if _em_canonical_step(step) in _EM_PIPELINE_STEPS:
        return False
    if step == "Program UIP College Approval":
        return True
    if "Chair" in step:
        return True
    return bool(re.match(
        r'^Program (AFCS|AM |AMSL|ARCH|ASNS|BA |CS |EDU|EECE|EN |ENGL|HIST|HUSV|MSCI|PPUA|PS |SC |SH )',
        step))

def _em_stage_ord(step):
    if not step:
        return -1
    if _em_is_college_step(step):
        return 0
    return _EM_STAGE_ORD.get(_em_canonical_step(step), -1)

def _em_catalog_start_year(completion_date):
    m = re.search(r'Catalog\s+(\d{4})-\d{4}', completion_date or '')
    return int(m.group(1)) if m else None

def _em_current_or_upcoming(completion_date):
    """True for a completed proposal effective in the current/upcoming catalog."""
    yr = _em_catalog_start_year(completion_date)
    return yr is not None and yr >= EM_GTM_MIN_CATALOG_YEAR

def compute_ready_for_gtm(new_offering, current_step, completion_date):
    """'Yes' if a grad new offering has cleared its governance gate."""
    if not new_offering:
        return ''
    if completion_date and not current_step:           # approved / historical
        return 'Yes' if _em_current_or_upcoming(completion_date) else ''
    if not current_step:
        return ''
    gate = _EM_BOT_ORD if 'new_degree' in new_offering else _EM_UGCC_ORD
    return 'Yes' if _em_stage_ord(current_step) > gate else ''

def _to_iso_date(s):
    """Normalize a CIM date (RFC-822 GMT or ISO) to 'YYYY-MM-DD'. '' on failure."""
    if not s:
        return ''
    s = s.strip()
    try:
        return datetime.fromisoformat(s).date().isoformat()
    except Exception:
        pass
    try:
        from email.utils import parsedate_to_datetime
        dt = parsedate_to_datetime(s)
        if dt is not None:
            return dt.date().isoformat()
    except Exception:
        pass
    return ''

def compute_gtm_inactivation(inactivates, current_step, completion_date):
    """'Yes' for a grad inactivation that is in workflow or completed
    in the current/upcoming catalog (mirrors the GTM current/upcoming window)."""
    if inactivates != 'Yes':
        return ''
    if current_step:
        return 'Yes'
    return 'Yes' if _em_current_or_upcoming(completion_date) else ''


# ---------------------------------------------------------------------------
# Main ingest function
# ---------------------------------------------------------------------------

def ingest(xlsx_path=XLSX_PATH, tsv_path=TSV_PATH, roster_path=ROSTER_PATH, gls_path=GLS_PATH):
    """Seed from CIM, overlay SVT/IPD/OTP/GLS/scoring, write portfolio_programs."""
    from database import replace_all_portfolio_programs, get_db

    if not os.path.exists(xlsx_path):
        raise FileNotFoundError(f"OTP Excel not found: {xlsx_path}")

    now = datetime.now().isoformat()
    today = datetime.now().date().isoformat()

    # Prior GTM-entry state, so we can preserve / stamp `gtm_entered_date` across
    # the full-table rebuild. id → (gtm_entered_date, was_gtm_relevant).
    prior_gtm = {}
    try:
        with get_db() as _c:
            for _r in _c.execute(
                "SELECT id, gtm_entered_date, ready_for_gtm, gtm_inactivation "
                "FROM portfolio_programs"):
                rel = (_r['ready_for_gtm'] == 'Yes') or (_r['gtm_inactivation'] == 'Yes')
                prior_gtm[_r['id']] = (_r['gtm_entered_date'] or '', rel)
    except Exception:
        prior_gtm = {}

    _EMPTY_TRACKING = {
        'otp_status': '', 'otp_sub_status': '', 'otp_market_potential': '',
        'otp_market_signal': '', 'otp_internal_performance': '',
        'otp_q3_status': '', 'otp_effective_term': '', 'otp_notes': '',
        'ipd_status': '', 'ipd_proposal_type': '', 'ipd_additional_college': '',
        'svt_status': '', 'roster_sub_status': '', 'roster_proposal_type': '',
        'roster_launch_date': '',
        'speed_to_market': '',
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
        'new_offering': '',
        'ready_for_gtm': '',
        'gtm_inactivation': '',
        'gtm_entered_date': '',
        'cim_eff_term': '',
        'catalog_years': '',
        'enrollment_json': '',
        'last_refreshed': now,
    }

    # Master's enrollment (Tableau) — keyed by CIM banner code + campus.
    enr_by_cc, enr_code_campuses = parse_enrollment()

    # Banner Program/Major/Concentration (Tableau) — authoritative source for
    # each concentration's managing college. Indexed by Program Code and by
    # (subject, degree). cim_meta below records each seed program's banner_code +
    # subject + degree so the concentration block can look these up.
    banner_pmc_by_code, banner_pmc_by_sd = parse_banner_pmc()
    cim_meta = {}   # cim_id → {banner_code, subject, degree}
    conc_college_discrepancies = []   # Banner-vs-CIM concentration diffs (report)

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
            SELECT id, name, college, current_step, completion_date, status, eff_cat, eff_term,
                   banner_code, program_type, new_offering, inactivates, step_entered_date
            FROM programs
            WHERE (current_step IS NOT NULL AND current_step != '')
               OR (completion_date IS NOT NULL AND completion_date != '')
        """).fetchall()

    # Deduplicate: prefer active, then highest id.
    # Skip TEMPLATE entries — these are CIM scaffolding rows ("TEMPLATE: PhD Program …",
    # "Half Major Template: …") that are never real programs and have been removed from
    # the portfolio repeatedly. Filter them out at ingest so they can't re-seed.
    _TEMPLATE_RE = re.compile(r'^\s*(template\s*:|half\s+major\s+template\s*:)', re.I)
    # PlusOne (4+1) combined BS/MS pathways are no longer tracked in the catalog,
    # so they're dropped from the portfolio entirely. Matches "PlusOne", "Plus One",
    # "PlusOne:", "Plus One …", etc. at the start of the name.
    _PLUSONE_RE = re.compile(r'^\s*plus\s?one\b', re.I)

    def _seed_dedup_key(name):
        # A bare "Subject, Degree" name (no campus parenthetical, no em-dash
        # deployment suffix) is, by the portfolio's own campus default, the
        # Boston deployment — so it must collapse onto its explicit "…(Boston)"
        # twin instead of showing as a second row. (CIM sometimes carries both a
        # bare and a "(Boston)" record for the same program, e.g. Cell and Gene
        # Therapies, MS ids 1292/1940/1943.) Everything else keeps its raw name
        # as the key, so campus/em-dash deployment variants (Online, Primarily
        # Online, —Online, Vancouver, …) stay as distinct rows.
        subj, deg, camp = _parse_cim_name(name)
        camp_r = _normalize_campus(camp) if camp else 'Boston'
        if camp_r == 'Boston' and '—' not in name and '–' not in name:
            return ('BOS',) + _cim_index_keys(subj, deg, 'Boston')
        return ('RAW', name)

    by_name = {}       # dedup key → winning row
    raw_by_key = {}    # dedup key → ALL raw rows (for catalog-year computation,
                       # which must see every proposal for a program, not just
                       # the deduped winner — an inactivation + a re-add can
                       # live in separate CIM records)
    _CATALOG_WINDOW = _catalog_window()
    for r in raw_rows:
        name = (r['name'] or '').strip()
        if not name:
            continue
        if _TEMPLATE_RE.match(name):
            continue
        if _PLUSONE_RE.match(name):
            continue
        key = _seed_dedup_key(name)
        raw_by_key.setdefault(key, []).append(r)
        existing = by_name.get(key)
        if existing is None:
            by_name[key] = r
        else:
            # Prefer active (has current_step)
            existing_active = bool(existing['current_step'])
            this_active = bool(r['current_step'])
            if this_active and not existing_active:
                by_name[key] = r
            elif this_active == existing_active:
                # Both same activity state — take highest id
                if r['id'] > existing['id']:
                    by_name[key] = r

    # Build tracker entries from deduplicated CIM rows
    # tracker: id → row dict
    tracker = {}
    # CIM index: (norm_subject, norm_degree, norm_campus) → row dict
    cim_exact_index = {}   # full 3-tuple key
    cim_nameDeg_index = {} # (norm_subject, norm_degree) → list of row dicts
    cim_entries_list = []  # flat list for best-guess fallback
    # SVT match index: banner_code (uppercase, normalized) → list of row dicts.
    # SVT's "Program Code" field equals CIM's banner_code (e.g. "MS-PRHL").
    # Multiple campuses can share the same banner_code, so we resolve campus
    # ambiguity by also matching SVT's Campus field against the row's campus.
    cim_banner_index = {}
    # CIM program id → surviving (deduped) tracker row. Maps EVERY id in each
    # dedup group (not just the winner) so an SVT Courseleaf Key pointing at a
    # collapsed duplicate still resolves to the row we kept.
    cim_id_index = {}

    for r in by_name.values():
        name = r['name'] or ''
        subject, degree, campus = _parse_cim_name(name)
        campus_resolved = _normalize_campus(campus) if campus else 'Boston'
        change_type = _STATUS_LABEL.get(r['status'] or '', r['status'] or '')
        # banner_code for downstream joins (enrollment, Banner concentration/
        # reconciliation): the deduped winner may lack a banner_code (e.g. a bare
        # "…, MS" record) while a merged sibling carries it (…(Boston) = MS-CGTH).
        # Take the winner's code, else any non-empty code from the dedup group.
        _grp_bcode = (r['banner_code'] or '').strip()
        if not _grp_bcode:
            for _gr in raw_by_key.get(_seed_dedup_key(name), [r]):
                if (_gr['banner_code'] or '').strip():
                    _grp_bcode = _gr['banner_code'].strip()
                    break
        cim_meta[r['id']] = {'banner_code': _grp_bcode,
                             'subject': subject, 'degree': degree}

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
        # CIM effective term (Banner code, e.g. "202710") — raw, for display/comparison.
        row['cim_eff_term'] = r['eff_term'] or ''
        # Catalog-year membership (current + 2 forward), from ALL of this
        # program's CIM records so an inactivation and a re-add both register.
        row['catalog_years'] = _catalog_years_label(
            _cim_catalog_events(raw_by_key.get(_seed_dedup_key(name), [r])), _CATALOG_WINDOW)
        # Master's enrollment overlay: join by banner code + campus. Exact
        # (code, campus) only — a single banner code is shared across campus
        # deployments in CIM, so a per-campus feed row must not bleed onto a
        # sibling deployment (e.g. Bioengineering MSBioE Boston vs Toronto).
        # Uses the dedup-group banner_code so a bare winner still joins.
        _bcode = _grp_bcode
        _enr = enr_by_cc.get((_bcode, campus_resolved)) if _bcode else None
        if _enr:
            row['enrollment_json'] = json.dumps(_enr, separators=(',', ':'))
        # GTM (enrollment-management) signals — graduate programs only.
        if (r['program_type'] or '') == 'Graduate':
            new_off = r['new_offering'] or ''
            cur_step = r['current_step'] or ''
            comp_date = r['completion_date'] or ''
            row['new_offering']     = new_off
            row['ready_for_gtm']    = compute_ready_for_gtm(new_off, cur_step, comp_date)
            row['gtm_inactivation'] = compute_gtm_inactivation(r['inactivates'] or '', cur_step, comp_date)
            # Stamp the date the record entered the GTM stage (first became
            # GTM-relevant), preserved across rebuilds. Going forward a brand-new
            # transition is stamped with the scan date. On the first run (no prior
            # date) we seed in-pipeline records from their CIM step-entered date as
            # the best available approximation; completed records seed empty.
            relevant = (row['ready_for_gtm'] == 'Yes') or (row['gtm_inactivation'] == 'Yes')
            if relevant:
                prev_date, prev_rel = prior_gtm.get(pid, ('', False))
                if prev_date:
                    row['gtm_entered_date'] = prev_date            # already stamped → preserve
                elif prev_rel:
                    row['gtm_entered_date'] = _to_iso_date(r['step_entered_date'] or '') if cur_step else ''
                else:
                    row['gtm_entered_date'] = today                # new transition into GTM
        tracker[pid] = row

        # Map every dedup-group member id → this surviving row (Courseleaf-key
        # lookups can point at a collapsed duplicate).
        for _gr in raw_by_key.get(_seed_dedup_key(name), [r]):
            cim_id_index[_gr['id']] = row
        cim_id_index[r['id']] = row

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

        # SVT Program Code → CIM banner_code lookup. Index uppercase + stripped
        # so "ms-prhl", "MS-PRHL", " MS-PRHL " all collide cleanly.
        bc = (r['banner_code'] or '').strip().upper()
        if bc:
            cim_banner_index.setdefault(bc, []).append({
                'row': row, 'campus': campus_resolved, 'pid': pid,
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
            base_deg, variant = norm_deg.split('-', 1)
            if base_deg:
                # Variant-in-subject FIRST: some CIM programs store the
                # deployment variant inside the subject name (e.g. "Applied
                # AI—Connect, MPS"), not the degree. Try (subject+"-variant",
                # base_degree) before bare base_degree, otherwise a
                # "MS-Connect at SV" lookup falls through to the base "MS at
                # SV" program instead of the Connect variant.
                if variant:
                    subj_with_var = f'{norm_subj}-{variant}'
                    row, mt = _try(subj_with_var, base_deg, norm_campus_str)
                    if row:
                        return row, mt
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
    svt_pending    = []  # SVT concentration proposals awaiting parent identification
    svt_undergrad  = []  # SVT undergraduate entries — mapping is graduate-only (skipped)


    # ─── Concentration-proposal preprocessor helpers ───────────────────────
    # Defined here (before the SVT and IPD loops) so both can call
    # _try_concentration_preprocess() against the same shared logic.
    # "X Concentration in the DEGREE in Y (Campus)" — these are concentrations
    # appended to an existing program (e.g. "AI Concentration in the MS in
    # Health Informatics, Charlotte"). They should NOT create a standalone
    # portfolio row; instead the IPD status overlays on the parent CIM program
    # ("Health Informatics, MS (Charlotte)").
    # "X Concentration in the DEGREE in Y, Campus" (and variants)
    _CONC_IN_DEGREE_IN_RE = re.compile(
        r'^(.+?)\s+Concentration\s+in\s+the\s+(MS|MA|PhD|MBA|MPS|MFA|MEd|MArch|DNP|DPT|EdD|MPH|MPA|MPP)\s+in\s+(.+)$',
        re.I
    )
    # "X Concentration for ... Masters in Y" — e.g. "Computational Creativity
    # Concentration for UIP Masters in AI"
    _CONC_FOR_RE = re.compile(
        r'^(.+?)\s+Concentration\s+for\s+.+?\s+Masters?\s+in\s+(.+)$',
        re.I
    )
    # "DEG in PARENT (new concentration) COLLEGE" — e.g.
    # "MS in AI (new concentration) Bouve". No explicit concentration name;
    # we look up the parent's CIM curriculum HTML for a concentration heading
    # whose text contains the COLLEGE name, then use that canonical name.
    _CONC_NEW_RE = re.compile(
        r'^(.+?)\s*\(\s*new\s+concentration\s*\)\s+(\S[\w\s\-\']*?)\s*$',
        re.I
    )
    # "[DEG in ]PARENT (new concentration in CONC_NAME)[, DEG]" — explicit name.
    # e.g. "Software Engineering Systems (new concentration in Medical Software Engineering), MS"
    _CONC_NEW_IN_RE = re.compile(
        r'^(?:([A-Z]{2,7})\s+in\s+)?(.+?)\s*\(\s*new\s+concentration\s+in\s+(.+?)\s*\)\s*(?:,\s*([A-Z]{2,7}))?\s*$',
        re.I
    )
    # "[DEG ]PARENT - New Concentration[, DEG]" — concentration name
    # unspecified. e.g. "MPS Informatics - New Concentration" or
    # "Informatics - New Concentration, MPS".
    _CONC_DASH_NEW_RE = re.compile(
        r'^(?:([A-Z]{2,7})\s+)?(.+?)\s*[-—]\s*New\s+Concentration(?:,?\s+([A-Z]{2,7}))?\s*$',
        re.I
    )
    # "DEG in PARENT (New CC Concentration in CONC_NAME)" — e.g.
    # "MS in AI (New COE Concentration in High Performance and Edge AI)".
    # CC is a college code (1-5 uppercase letters). The CONC_NAME is the
    # canonical concentration name as proposed; no curriculum lookup needed.
    _CONC_NEW_NAMED_RE = re.compile(
        r'^(.+?)\s*\(\s*New\s+([A-Z]{2,5})\s+Concentration\s+in\s+(.+?)\s*\)\s*(?:,\s*MS)?\s*$',
        re.I
    )
    # "[DEG in ]PARENT - CONC_NAME Concentration (CC)[, DEG]" — e.g.
    # "MS in Artificial Intelligence - Omics Concentration (COS)" or
    # "Artificial Intelligence - Omics Concentration (COS), MS".
    # Captures: leading-degree (optional), parent, concentration name,
    # college code, trailing-degree (optional). Either leading- or
    # trailing-degree must be present.
    _CONC_DASH_PAREN_RE = re.compile(
        r'^(?:([A-Z]{2,7})\s+in\s+)?(.+?)\s*[-—]\s*(.+?)\s+Concentration\s*\(\s*([A-Z]{2,5})\s*\)\s*(?:,\s*([A-Z]{1,7}))?\s*$',
        re.I
    )

    def _strip_diacritics(s):
        import unicodedata
        return ''.join(c for c in unicodedata.normalize('NFD', s or '')
                       if unicodedata.category(c) != 'Mn')

    def _find_concentration_by_college(parent_row, college_hint):
        """Search the parent CIM program's curriculum_html for a concentration
        heading containing the given college hint (case-insensitive, diacritic-
        insensitive). Returns the normalized concentration name, or None."""
        if not parent_row or not college_hint:
            return None
        cim_id = parent_row.get('cim_program_id')
        if not cim_id:
            return None
        with get_db() as conn:
            row = conn.execute(
                'SELECT curriculum_html FROM programs WHERE id = ?',
                (cim_id,)).fetchone()
        if not row or not row['curriculum_html']:
            return None
        # Walk concentration headings (same logic as _extract_concentrations_from_html)
        target = _strip_diacritics(college_hint).lower()
        for raw in re.findall(r'<h[234][^>]*>(.*?)</h[234]>',
                              row['curriculum_html'], re.I | re.S):
            h = re.sub(r'<[^>]+>', '', raw).replace('\xa0', ' ').strip()
            if 'concentration' not in h.lower():
                continue
            if _strip_diacritics(h).lower().find(target) < 0:
                continue
            # Found a match — normalize via the existing extractor's rules
            extracted = _extract_concentrations_from_html(f'<h2>{h}</h2>')
            if extracted:
                # Extractor now returns dicts {name, college}; callers here
                # expect just the concentration name.
                first = extracted[0]
                return first['name'] if isinstance(first, dict) else first
        return None

    def _parse_deg_in_subj(s):
        """Parse 'DEG in SUBJECT' / 'Master of X in SUBJECT' → (subject, degree).
        Returns (None, None) if can't parse. Expands AI/CS/DS acronyms."""
        subj, deg, _ = _parse_external_name(s.strip())
        _SUBJ_ALIAS = {'ai': 'Artificial Intelligence',
                       'cs': 'Computer Science',
                       'ds': 'Data Science'}
        if subj.lower() in _SUBJ_ALIAS:
            subj = _SUBJ_ALIAS[subj.lower()]
        return subj, deg

    def _try_concentration_preprocess(p):
        """Try every concentration-proposal pattern in turn; if one matches,
        create the sub-row and return True. Used by BOTH the SVT roster and
        the IPD smartsheet loops so the same entry appearing in both feeds
        results in one sub-row (the second call merges status on the same
        sub-row via _create_conc_subrow's pid dedup) instead of one sub-row
        plus a duplicate top-level row.
        """
        name = p.get('program_name') or ''
        _SUBJ_ALIAS_LOCAL = {'ai': 'Artificial Intelligence',
                             'cs': 'Computer Science',
                             'ds': 'Data Science'}
        _known_campus = {v.lower() for v in _CAMPUS_NAMES.values()} | {
            'boston','oakland','portland','toronto','seattle','miami',
            'arlington','vancouver','charlotte','london','silicon valley',
            'new york','online','primarily online'}
        # 1) "X Concentration in the DEG in Y, Campus"
        m = _CONC_IN_DEGREE_IN_RE.match(name)
        if m:
            conc_name   = m.group(1).strip()
            parent_deg  = _norm_degree(m.group(2))
            parent_rest = m.group(3).strip()
            parent_camp = ''
            cm = re.search(r',\s*([A-Za-z][A-Za-z\s]+?)\s*$', parent_rest)
            if cm:
                cand = cm.group(1).strip()
                if cand.lower() in _known_campus:
                    parent_camp = cand
                    parent_rest = parent_rest[:cm.start()].strip()
            if _create_conc_subrow(conc_name, parent_rest, parent_deg, parent_camp, p):
                return True
        # 2) "X Concentration for ... Masters in Y"
        m = _CONC_FOR_RE.match(name)
        if m:
            conc_name   = m.group(1).strip()
            parent_rest = m.group(2).strip()
            if parent_rest.lower() in _SUBJ_ALIAS_LOCAL:
                parent_rest = _SUBJ_ALIAS_LOCAL[parent_rest.lower()]
            if _create_conc_subrow(conc_name, parent_rest, 'MS', '', p):
                return True
        # 3) "DEG in PARENT (new concentration) COLLEGE" — curriculum lookup
        m = _CONC_NEW_RE.match(name)
        if m:
            parent_str = m.group(1).strip()
            college    = m.group(2).strip()
            parent_subj, parent_deg = _parse_deg_in_subj(parent_str)
            if parent_subj and parent_deg:
                parent_row, _ = _lookup_cim(parent_subj, parent_deg, '')
                conc_name = _find_concentration_by_college(parent_row, college)
                if conc_name and _create_conc_subrow(
                        conc_name, parent_subj, parent_deg, '', p):
                    return True
        # 4) "DEG in PARENT (New CC Concentration in CONC_NAME)" — explicit
        m = _CONC_NEW_NAMED_RE.match(name)
        if m:
            parent_str = m.group(1).strip()
            conc_name  = m.group(3).strip()
            parent_subj, parent_deg = _parse_deg_in_subj(parent_str)
            if parent_subj and parent_deg:
                if _create_conc_subrow(conc_name, parent_subj, parent_deg, '', p):
                    return True
        # 5) "[DEG in ]PARENT - CONC_NAME Concentration (CC)[, DEG]"
        m = _CONC_DASH_PAREN_RE.match(name)
        if m:
            lead_deg    = m.group(1)
            parent_subj = m.group(2).strip()
            conc_name   = m.group(3).strip()
            trail_deg   = m.group(5)
            parent_deg  = _norm_degree(lead_deg or trail_deg or 'MS')
            if parent_subj.lower() in _SUBJ_ALIAS_LOCAL:
                parent_subj = _SUBJ_ALIAS_LOCAL[parent_subj.lower()]
            if _create_conc_subrow(conc_name, parent_subj, parent_deg, '', p):
                return True
        # 6) "[DEG in ]PARENT (new concentration in CONC_NAME)[, DEG]"
        m = _CONC_NEW_IN_RE.match(name)
        if m:
            lead_deg    = m.group(1)
            parent_subj = m.group(2).strip()
            conc_name   = m.group(3).strip()
            trail_deg   = m.group(4)
            parent_deg  = _norm_degree(lead_deg or trail_deg or 'MS')
            if parent_subj.lower() in _SUBJ_ALIAS_LOCAL:
                parent_subj = _SUBJ_ALIAS_LOCAL[parent_subj.lower()]
            if _create_conc_subrow(conc_name, parent_subj, parent_deg, '', p):
                return True
        # 7) "[DEG ]PARENT - New Concentration[, DEG]" — name unspecified
        m = _CONC_DASH_NEW_RE.match(name)
        if m:
            lead_deg = m.group(1)
            parent_subj = m.group(2).strip()
            trail_deg = m.group(3)
            parent_deg = _norm_degree(lead_deg or trail_deg or 'MS')
            if parent_subj.lower() in _SUBJ_ALIAS_LOCAL:
                parent_subj = _SUBJ_ALIAS_LOCAL[parent_subj.lower()]
            if _create_conc_subrow('New Concentration', parent_subj, parent_deg, '', p):
                return True
        return False

    def _create_conc_subrow(conc_name, parent_subj, parent_deg, parent_camp, src_row):
        """Create (or update) a tracker sub-row for a feed-proposed
        concentration, linked under its parent CIM program. Takes a src_row
        from EITHER the SVT roster or the IPD smartsheet; overlays whichever
        status fields are present. Subsequent calls with the same conc/parent
        merge fields onto the existing sub-row (so the same entry appearing
        in both feeds doesn't create duplicates). Returns True if a
        sub-row was created or updated."""
        parent, _ = _lookup_cim(parent_subj, parent_deg, parent_camp)
        if not parent:
            return False
        camp = parent.get('campus') or parent_camp or 'Boston'
        sub_pid = _make_id(f"conc_{conc_name}_{parent.get('id', '')}", camp)
        if sub_pid not in tracker:
            tracker[sub_pid] = _make_row(
                sub_pid, conc_name.strip(),
                src_row.get('ipd_college', '') or src_row.get('college', '')
                    or parent.get('college', ''),
                camp)
            tracker[sub_pid]['concentration_of'] = parent.get('id', '')
        # Overlay each status field if currently empty on the sub-row and
        # set on the incoming src_row. Works for both SVT and IPD sources.
        existing = tracker[sub_pid]
        for fld in ('ipd_status', 'ipd_proposal_type', 'ipd_additional_college',
                    'svt_status', 'roster_sub_status', 'roster_proposal_type',
                    'roster_launch_date'):
            if not existing.get(fld) and src_row.get(fld):
                existing[fld] = src_row[fld]
        return True

    # ── Step 1: Overlay SVT Source Data ───────────────────────────────────────
    # SVT pipeline rewritten 2026-05-20 to use the new "SVT Source Data"
    # Smartsheet (via REST API, sheet id 3889012330680196). Match key is
    # Program Code → CIM banner_code, with Campus disambiguation. Falls
    # back to name parsing (Program Level + Degree Type + Program Name)
    # for rows with no Program Code.
    svt_rows_data = _safe_parse('SVT', parse_svt)

    # Change tracking: fingerprint each entry's mapping-relevant fields (name,
    # code, campus, courseleaf key, initiative type — NOT status/phase, which
    # churn constantly) and reconcile against svt_seen so the editor can surface
    # only entries that are new or whose mapping changed since last reviewed.
    def _svt_fingerprint(p):
        snap = {
            'name':            re.sub(r'\s+', ' ', (p.get('program_name') or '')).strip(),
            'code':            (p.get('program_code') or '').strip(),
            'campus':          (p.get('campus') or '').strip(),
            'courseleaf_key':  (p.get('courseleaf_key') or '').strip(),
            'initiative_type': (p.get('initiative_type') or '').strip(),
        }
        fp = '␟'.join(snap[k] for k in ('name', 'code', 'campus', 'courseleaf_key', 'initiative_type'))
        return fp, snap
    try:
        _recon = _db_module.reconcile_svt_seen([
            dict(svt_key=p.get('svt_key', ''), fingerprint=_svt_fingerprint(p)[0],
                 snapshot=_svt_fingerprint(p)[1])
            for p in svt_rows_data if p.get('svt_key')
        ]) or {}
        # D: an entry whose mapping fields changed is re-evaluated FROM SCRATCH.
        # Delete any manual disposition entirely so the heuristics below re-run on
        # the new content and the row re-surfaces (flagged CHANGED) for a fresh
        # decision — a prior override never silently rides along on changed data.
        _changed = _recon.get('changed', [])
        if _changed:
            _ovs = _db_module.get_all_svt_overrides()
            for _ck in _changed:
                _o = _ovs.get(_ck)
                if _o and (_o.get('disposition') or 'auto') != 'auto':
                    _db_module.delete_svt_override(_ck)
                    print(f"    reset override for changed SVT entry {_ck} (was {_o.get('disposition')})")
    except Exception as _e:
        print(f"  svt_seen reconcile error (non-fatal): {_e}")

    n_svt_matched = 0
    n_svt_added   = 0
    n_svt_mismatch = 0
    n_svt_nonprog = 0

    # Durable, user-editable disposition overrides (svt_overrides table, edited
    # in the local site's Console). Keyed by svt_key. Takes precedence over every
    # heuristic below. Replaces the old hardcoded SVT_PENDING_ANALYSIS constant.
    try:
        svt_overrides = _db_module.get_all_svt_overrides()
    except Exception:
        svt_overrides = {}
    # Per-row outcome for the editor UI: svt_key → {outcome, detail}. Written to
    # portfolio_mismatches.json so the Console can show what each row resolved to.
    svt_resolution = {}

    def _svt_resolve(key, outcome, detail=''):
        if key:
            svt_resolution[key] = {'outcome': outcome, 'detail': detail}

    def _attach_conc_to_parent(conc_name, parent_cim_id, src_row):
        """Override path: attach a concentration sub-row directly under an
        explicit CIM parent id (chosen by the user in the editor)."""
        parent = cim_id_index.get(int(parent_cim_id)) if str(parent_cim_id).isdigit() else None
        if not parent:
            return None
        camp = parent.get('campus') or 'Boston'
        sub_pid = _make_id(f"conc_{conc_name}_{parent.get('id', '')}", camp)
        if sub_pid not in tracker:
            tracker[sub_pid] = _make_row(sub_pid, conc_name.strip(),
                                         parent.get('college', ''), camp)
            tracker[sub_pid]['concentration_of'] = parent.get('id', '')
        _apply_svt_fields(tracker[sub_pid], src_row)
        return parent

    def _apply_svt_fields(row, p):
        """Overlay SVT fields onto a tracker row (only if currently empty)."""
        if not row.get('svt_status') and p.get('status'):
            row['svt_status'] = p['status']
        if not row.get('roster_sub_status') and p.get('sub_status'):
            row['roster_sub_status'] = p['sub_status']
        # roster_proposal_type now holds the HCWHY-derived classification
        # (was the raw "Proposal Type" column in the old roster).
        if not row.get('roster_proposal_type') and p.get('hcwhy'):
            classified = _SVT_HCWHY_TO_TYPE.get(p['hcwhy'], p['hcwhy'])
            row['roster_proposal_type'] = classified
        if not row.get('roster_launch_date') and p.get('actual_launch_date'):
            row['roster_launch_date'] = p['actual_launch_date']
        if not row.get('speed_to_market') and p.get('speed_to_market'):
            row['speed_to_market'] = p['speed_to_market']

    for p in svt_rows_data:
        # Strip "Launch of (the) " / "Suspension of " status prefix so the
        # underlying program is matchable. The original name is preserved in
        # mismatch logs via p['program_name']; the stripped form is used for
        # CIM lookup + parsing only.
        original_name = p.get('program_name', '')
        cleaned_name  = _strip_svt_prefix(original_name)

        code = (p.get('program_code') or '').strip().upper()
        svt_key = p.get('svt_key', '')

        # ── Graduate-only gate (highest precedence) ───────────────────────────
        # SVT mapping applies only to graduate programs. Undergraduate entries
        # are skipped entirely (not matched / added / held) and logged to an
        # auditable bucket. Confirmed with Waleed 2026-07-13.
        # Airtable carries an explicit Program_Level field — trust it when
        # definitive ('Graduate' / 'Undergraduate'); otherwise fall back to the
        # name-based heuristic (is_undergrad_svt).
        _lvl = (p.get('program_level') or '').strip().lower()
        if _lvl.startswith('undergrad'):
            _is_ug = True
        elif _lvl.startswith('grad'):
            _is_ug = False
        else:
            _is_ug = is_undergrad_svt(original_name)
        if _is_ug:
            svt_undergrad.append({'source_name': original_name,
                                  'campus': p.get('campus', ''), 'svt_key': svt_key})
            _svt_resolve(svt_key, 'undergrad', 'undergraduate — mapping is graduate-only')
            continue

        # ── Manual disposition override (highest precedence) ──────────────────
        # A user-set row in svt_overrides wins over every heuristic below.
        ov = svt_overrides.get(svt_key)
        force_program = False
        if ov:
            disp = ov.get('disposition', 'auto')
            if disp == 'non_program':
                n_svt_nonprog += 1
                non_programs.append({'source': 'SVT', 'source_name': original_name,
                                     'campus': p.get('campus', ''), 'svt_key': svt_key,
                                     'reason': 'Manual: non-program'})
                _svt_resolve(svt_key, 'non_program', 'manual')
                continue
            if disp == 'pending':
                svt_pending.append({'source_name': original_name, 'campus': p.get('campus', ''),
                                    'svt_key': svt_key,
                                    'reason': (ov.get('note') or 'Held for analysis (manual)')})
                _svt_resolve(svt_key, 'pending', 'manual')
                continue
            if disp == 'match' and ov.get('parent_cim_id'):
                # Link this SVT entry to an existing CIM program chosen by the
                # user (by id) — same effect as an auto match, applied manually.
                _pid = ov['parent_cim_id']
                _row = cim_id_index.get(int(_pid)) if str(_pid).isdigit() else None
                if _row is not None:
                    n_svt_matched += 1
                    _apply_svt_fields(_row, p)
                    _new_col = _normalize_college(p.get('college') or '')
                    if not _row.get('college') and _new_col:
                        _row['college'] = _new_col
                    _svt_resolve(svt_key, 'matched', f"{_row.get('program_name', '')} (manual)")
                    continue
                svt_pending.append({'source_name': original_name, 'campus': p.get('campus', ''),
                                    'svt_key': svt_key,
                                    'reason': 'Manual map-to-program, but CIM id not found'})
                _svt_resolve(svt_key, 'pending', 'target not found')
                continue
            if disp == 'concentration' and ov.get('parent_cim_id'):
                _par = _attach_conc_to_parent(original_name, ov['parent_cim_id'], p)
                if _par is not None:
                    n_svt_matched += 1
                    _svt_resolve(svt_key, 'concentration', f"under {_par.get('program_name', '')}")
                    continue
                svt_pending.append({'source_name': original_name, 'campus': p.get('campus', ''),
                                    'svt_key': svt_key,
                                    'reason': 'Manual concentration, but parent CIM id not found'})
                _svt_resolve(svt_key, 'pending', 'parent not found')
                continue
            if disp == 'program':
                # Force a real program row, bypassing the drop heuristics below.
                # Apply any corrected fields the user supplied.
                force_program = True
                if ov.get('override_name'):
                    cleaned_name = ov['override_name']

        if not force_program:
            # Market-research inquiries are exploratory ("should we deploy X to the
            # network?"), not proposals moving through a pipeline. They must NEVER
            # be matched to a program — even when they carry a Program Code — because
            # overlaying their early-stage status onto a completed CIM program
            # manufactures false "SVT still early-stage" discrepancies (e.g.
            # Psychology, PhD (Boston)). Drop them regardless of code.
            if 'market research' in (p.get('hcwhy') or '').lower():
                n_svt_nonprog += 1
                non_programs.append({
                    'source':      'SVT',
                    'source_name': original_name,
                    'campus':      p.get('campus', ''),
                    'svt_key':     svt_key,
                    'reason':      f"Market research (HCWHY={p.get('hcwhy', '')})",
                })
                _svt_resolve(svt_key, 'non_program', 'market research')
                continue

            # HCWHY non-program filter — but bypass it when a Program Code is
            # present (Program Code in SVT == CIM banner_code, so the row IS a
            # real program record even if the HCWHY value is something like
            # "General Market Research"). Without this override, e.g. CERTG AI
            # Applications (SV) was being dropped despite having code CERTG-AIAP.
            if p.get('hcwhy') in _SVT_HCWHY_NON_PROGRAM and not code:
                n_svt_nonprog += 1
                non_programs.append({
                    'source':      'SVT',
                    'source_name': original_name,
                    'campus':      p.get('campus', ''),
                    'svt_key':     svt_key,
                    'reason':      f"HCWHY={p.get('hcwhy', '')}",
                })
                _svt_resolve(svt_key, 'non_program', f"HCWHY={p.get('hcwhy', '')}")
                continue
            # Existing non-program filters (multi-program bundles, course-code-as-name, …)
            if _is_non_program(cleaned_name):
                n_svt_nonprog += 1
                if not _is_silent_non_program(cleaned_name):
                    non_programs.append({
                        'source':      'SVT',
                        'source_name': original_name,
                        'campus':      p.get('campus', ''),
                        'svt_key':     svt_key,
                    })
                _svt_resolve(svt_key, 'non_program', 'auto-detected non-program')
                continue

            # Concentration-proposal entries (e.g. "MS in AI (New COE Concentration
            # in Human-AI Collaboration)") become a sub-row UNDER the parent program
            # rather than overwriting the parent's status. This must run BEFORE the
            # banner-code match, because a proposed concentration carries its
            # parent's Program Code (so the banner match would otherwise absorb it
            # into the parent and discard the concentration).
            _conc_src = dict(p)
            _conc_src['svt_status']           = p.get('status', '')
            _conc_src['roster_sub_status']    = p.get('sub_status', '')
            _conc_src['roster_proposal_type'] = (_SVT_HCWHY_TO_TYPE.get(p.get('hcwhy', ''), p.get('hcwhy', '')) if p.get('hcwhy') else '')
            _conc_src['roster_launch_date']   = p.get('actual_launch_date', '')
            if _try_concentration_preprocess(_conc_src):
                n_svt_matched += 1
                _svt_resolve(svt_key, 'concentration', 'auto')
                continue

        camp_norm = _normalize_campus(p.get('campus', '')) if p.get('campus') else ''

        # Path 0: authoritative match via SVT's Courseleaf Key (?key=N → CIM id).
        # This is a direct structured link to the exact CIM record, immune to the
        # name/banner-code parsing fragility that Paths A/B fight. Runs AFTER the
        # non-program / market-research / concentration gates (a concentration
        # proposal's key points at its PARENT program, so it must stay a sub-row)
        # but BEFORE the fuzzy code/name paths.
        _cl_id = _svt_courseleaf_id(p.get('courseleaf_key', ''))
        if _cl_id is not None and _cl_id in cim_id_index:
            _row0 = cim_id_index[_cl_id]
            n_svt_matched += 1
            _apply_svt_fields(_row0, p)
            _new_col = _normalize_college(p.get('college') or '')
            if not _row0.get('college') and _new_col:
                _row0['college'] = _new_col
            _svt_resolve(svt_key, 'matched', f"{_row0.get('program_name', '')} (Courseleaf Key)")
            continue

        # Path A: match by Program Code → CIM banner_code.
        matched = None
        if code and code in cim_banner_index:
            candidates = cim_banner_index[code]
            # A lone banner-code candidate is matched only when the SVT row's
            # campus is compatible (unspecified, or equal to the candidate's
            # campus). A single candidate at a DIFFERENT campus than the SVT row
            # names is NOT a match — e.g. DNP-NUAN exists only for Boston, but
            # the SVT row is the Seattle deployment. Fall through to name-rescue
            # / leave unmatched for coordination instead of borrowing Boston.
            # A lone banner-code candidate matches when the SVT campus is
            # unspecified/equal, OR when the candidate's program NAME already
            # names that campus. The banner code is authoritative and often
            # deployment-specific (e.g. MSIS-INSY-O = the MSIS—Online program,
            # whose campus field is stored as Boston because the "—Online"
            # deployment lives in the name, not the campus field). Confirming via
            # the name lets the exact code match without borrowing a genuinely
            # different-campus program (DNP-NUAN Boston vs an SVT Seattle row,
            # whose name would NOT contain "Seattle").
            _cand_name = (candidates[0]['row'].get('program_name') or '').lower()
            if len(candidates) == 1 and (camp_norm in ('', candidates[0]['campus'])
                    or (camp_norm and camp_norm.lower() in _cand_name)):
                matched = candidates[0]['row']
            else:
                # Multiple campuses share the banner_code — pick the one whose
                # campus matches SVT's Campus field.
                for c in candidates:
                    if c['campus'] == camp_norm:
                        matched = c['row']
                        break
                # No banner-code candidate at this campus — try a name-based
                # rescue before falling back to Boston. Handles the common
                # case where CIM has the campus deployment but its banner_code
                # field is empty (so it's not in cim_banner_index even though
                # the row exists). e.g. SVT "MPS in Applied AI, Silicon Valley"
                # → CIM 1797 "Applied AI, MPS (Silicon Valley)" with no banner.
                if not matched and camp_norm and camp_norm != 'Boston':
                    rescue_subj, rescue_deg, rescue_camp = _parse_external_name(cleaned_name)
                    if rescue_subj and not rescue_camp:
                        rescue_camp = camp_norm
                    if rescue_subj and rescue_camp:
                        rescue_row, _ = _lookup_cim(rescue_subj, rescue_deg, rescue_camp)
                        if rescue_row and rescue_row not in (c['row'] for c in candidates):
                            matched = rescue_row
                # Boston fallback ONLY when the SVT row's campus is unspecified
                # (or Boston itself). If the SVT row names a SPECIFIC non-Boston
                # campus that has no CIM record, DO NOT borrow the Boston record —
                # leave it unmatched so it surfaces as a coordination item under
                # its real campus. Borrowing Boston here was the root cause of
                # phantom "Boston" discrepancies (Bioinformatics/Health
                # Informatics/Nurse Anesthesia/etc. — SVT rows for Toronto/Miami/
                # Seattle deployments wrongly stamped onto the Boston program).
                if not matched and camp_norm in ('', 'Boston'):
                    for c in candidates:
                        if c['campus'] == 'Boston':
                            matched = c['row']
                            break
                    if not matched:
                        matched = candidates[0]['row']

        if matched:
            n_svt_matched += 1
            _apply_svt_fields(matched, p)
            _new_col = _normalize_college(p.get('college') or '')
            if not matched.get('college') and _new_col:
                matched['college'] = _new_col
            _svt_resolve(svt_key, 'matched', f"{matched.get('program_name', '')} (Program Code)")
            continue

        # Path B: no Program Code or banner_code didn't match — fall back to
        # name parsing (uses the existing _parse_external_name + _lookup_cim
        # flow). If still no match, synthesize a row from Program Level +
        # Degree Type + Program Name. Use cleaned_name (with "Launch of"/
        # "Suspension of" prefix removed), with concentration-list parentheticals
        # and "Connect (Bridge) Program" deployment suffixes stripped so the base
        # program parses cleanly (e.g. "MS Health Informatics with AI
        # Concentration" → "Health Informatics, MS"). Safe here: real
        # concentration sub-rows were already handled above.
        subject, degree, campus_from_name = _parse_external_name(
            _svt_strip_program_noise(cleaned_name))
        if not campus_from_name and camp_norm:
            campus_from_name = camp_norm
        # Manual 'program' override: apply the user's corrected degree/campus.
        if force_program and ov:
            if ov.get('override_degree'):
                degree = ov['override_degree']
            if ov.get('override_campus'):
                campus_from_name = ov['override_campus']

        # If _parse_external_name couldn't extract a degree, fall back to
        # SVT's Degree Type field.
        if not degree and p.get('degree_type'):
            _DEG_TYPE_MAP = {
                'Masters':                  'MS',
                'Bachelors':                'BS',
                'PhD':                      'PhD',
                'Professional Doctorate':   'ProfDoc',
                'Graduate Certificate':     'Graduate Certificate',
                'Undergraduate Certificate': 'Undergraduate Certificate',
            }
            degree = _DEG_TYPE_MAP.get(p['degree_type'], '')

        row, _ = _lookup_cim(subject, degree, campus_from_name) if subject else (None, None)
        if row:
            n_svt_matched += 1
            _apply_svt_fields(row, p)
            _new_col = _normalize_college(p.get('college') or '')
            if not row.get('college') and _new_col:
                row['college'] = _new_col
            _svt_resolve(svt_key, 'matched', f"{row.get('program_name', '')} (name)")
            continue

        if subject and _is_valid_degree(degree):
            # Normalize the campus parsed from the name so casing/variants are
            # canonical (e.g. a name ending "(online)" → campus "Online", not
            # the lowercase "online" the parser preserves from the source text).
            campus_store = _normalize_campus(campus_from_name) if campus_from_name else 'Boston'
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
                    'original_name': p.get('program_name', ''),
                    'cim_format':    cim_fmt,
                    'campus':        campus_store,
                    'svt_key':       svt_key,
                })
                key3 = _cim_index_keys(subject, degree, campus_store)
                if key3 not in cim_exact_index:
                    cim_exact_index[key3] = tracker[pid]
                key2 = _subject_degree_keys(subject, degree)
                cim_nameDeg_index.setdefault(key2, []).append(tracker[pid])
                cim_entries_list.append({
                    'pid': pid,
                    'program_name': cim_display,
                    'subject': subject,
                    'degree': degree,
                    'degree_norm': _norm_degree(degree).lower(),
                    'campus': campus_store,
                    'row': tracker[pid],
                })
            _svt_resolve(svt_key, 'added', cim_display)
            _apply_svt_fields(tracker[pid], p)
        else:
            n_svt_mismatch += 1
            best = _best_guess(subject, degree, cim_entries_list,
                               prefer_campus=campus_from_name or '')
            svt_mismatches.append({
                'source_name':   p.get('program_name', ''),
                'source_code':   code,
                'source_campus': p.get('campus', ''),
                'svt_key':       svt_key,
                'reason':        'no banner_code match and no recognizable subject+degree',
                'best_guess':    best,
            })
            _svt_resolve(svt_key, 'mismatch', best or '')
            # Also surface unparseable SVT entries as orphan rows so they appear in
            # the "Needs SVT coordination" view (not just the Console log). These
            # have already passed the non_program gate above.
            disp_name = (p.get('program_name') or '').strip()
            if disp_name:
                camp = _normalize_campus(p.get('campus') or '') or 'Boston'
                pid = _make_id(disp_name, camp)
                if pid not in tracker:
                    tracker[pid] = _make_row(pid, disp_name, p.get('college', ''), camp)
                _apply_svt_fields(tracker[pid], p)

    print(f"  SVT: {len(svt_rows_data)} entries, {n_svt_matched} matched, "
          f"{n_svt_added} added, {n_svt_mismatch} mismatches, {n_svt_nonprog} non-programs")

    # ── Step 2: Overlay IPD ── DISABLED (per project direction 2026-05-22) ───
    # The IPD Smartsheet is no longer authoritative for portfolio status; SVT
    # is the single source of program-status truth. Keeping the parser import
    # so the overlay can be re-enabled by flipping the flag without other
    # code changes, but skipping the entire reconciliation loop.
    IPD_OVERLAY_ENABLED = False
    ipd_rows_data = _safe_parse('IPD', lambda: parse_smartsheet(tsv_path)) if IPD_OVERLAY_ENABLED else []
    n_ipd_matched = 0
    n_ipd_added   = 0
    n_ipd_mismatch = 0
    n_ipd_nonprog  = 0
    _LAUNCH_DEPLOY_RE = re.compile(
        r'\b(launch|deploy|new\s+program|net\s+new|deploy\s+program)\b', re.I)


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

        # Concentration-proposal patterns: try the shared preprocessor.
        if _try_concentration_preprocess(p):
            n_ipd_matched += 1
            continue
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
    otp_rows_data = _safe_parse('OTP', lambda: parse_otp(xlsx_path))
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
                row['otp_notes']                = p['otp_notes']
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
    gls_data = _safe_parse('GLS', lambda: parse_gls(gls_path))
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
            reference_map = {}
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
                ref_rows = conn.execute(
                    f'SELECT program_id, curriculum_html FROM reference_curriculum '
                    f'WHERE program_id IN ({placeholders})',
                    chunk
                ).fetchall()
                for r in ref_rows:
                    if r['curriculum_html']:
                        reference_map[r['program_id']] = r['curriculum_html']

        def _conc_norm(s):
            # Loose key for matching the same concentration across the current
            # curriculum, the last-approved reference, and the SVT roster.
            s = re.sub(r'\bconcentrations?\b', '', (s or '').lower())
            s = re.sub(r'\bsystems?\b', '', s)        # "Human-AI Collaboration" ↔ "… Systems"
            return re.sub(r'[^a-z0-9]+', ' ', s).strip()

        # SVT/IPD development sub-rows keyed by parent → {conc_key: status}. Used
        # to overlay a development status onto the matching curriculum concentration
        # and (in the frontend) suppress the duplicate standalone sub-row.
        svt_by_parent = {}
        for sub in tracker.values():
            pid = sub.get('concentration_of')
            if not pid:
                continue
            status = (sub.get('svt_status') or sub.get('ipd_status') or '').strip()
            svt_by_parent.setdefault(pid, {})[_conc_norm(sub.get('program_name', ''))] = status

        n_with_concs = 0
        for row in tracker.values():
            cim_id = row.get('cim_program_id')
            if not (cim_id and cim_id in curriculum_map):
                continue
            concs = _extract_concentrations_from_html(curriculum_map[cim_id])
            if not concs:
                continue
            # Classify each concentration: present in the last-approved
            # reference curriculum ⇒ "existing"; only in the current proposed
            # curriculum ⇒ "new" (going through the workflow). With no reference
            # on file, fall back to the parent's own workflow state.
            ref_html = reference_map.get(cim_id)
            if ref_html:
                ref_keys = {_conc_norm(c['name'])
                            for c in _extract_concentrations_from_html(ref_html)}
            else:
                ref_keys = None
            parent_complete = bool(row.get('cim_completion_date')) or not row.get('cim_step')
            svt_map = svt_by_parent.get(row.get('id'), {})
            # Banner is authoritative for each concentration's managing college.
            # Match this program's Banner concentrations (by code, else subject+
            # degree) and, per concentration, take the college of the best
            # token-similarity Banner match. Fall back to the CIM-extracted
            # college when Banner has no match (e.g. brand-new proposals not yet
            # live in Banner).
            banner_concs = _banner_concs_for(cim_meta.get(cim_id, {}),
                                             banner_pmc_by_code, banner_pmc_by_sd)
            matched_banner = set()
            for c in concs:
                key = _conc_norm(c['name'])
                if ref_keys is not None:
                    c['status'] = 'existing' if key in ref_keys else 'new'
                else:
                    c['status'] = 'existing' if parent_complete else 'new'
                if key in svt_map and svt_map[key]:
                    c['svt_status'] = svt_map[key]
                if banner_concs:
                    ctoks = _conc_tokens(c['name'])
                    best, best_sim = None, 0.0
                    for b in banner_concs:
                        sim = _conc_sim(ctoks, b['tokens'])
                        if sim > best_sim:
                            best, best_sim = b, sim
                    if best and best_sim >= 0.6:
                        c['college'] = best['college']   # authoritative override
                        matched_banner.add(best['conc'])
            row['concentrations_json'] = json.dumps(concs)
            n_with_concs += 1
            # Discrepancy report (Banner ↔ CIM concentrations) for matched programs.
            if banner_concs:
                cim_names = [c['name'] for c in concs]
                banner_only = [b['conc'] for b in banner_concs if b['conc'] not in matched_banner]
                # de-dup banner_only preserving order
                seen_bo = set(); banner_only = [x for x in banner_only if not (x in seen_bo or seen_bo.add(x))]
                cim_only = []
                for c in concs:
                    ctoks = _conc_tokens(c['name'])
                    if not any(_conc_sim(ctoks, b['tokens']) >= 0.6 for b in banner_concs):
                        cim_only.append(c['name'])
                if cim_only or banner_only:
                    conc_college_discrepancies.append({
                        'program': row.get('program_name', ''),
                        'banner_code': cim_meta.get(cim_id, {}).get('banner_code', ''),
                        'cim_only': cim_only,
                        'banner_only': banner_only,
                    })
        print(f"  Curriculum concentrations: {n_with_concs} programs have named concentrations")
        print(f"  Banner concentration-college: {len(conc_college_discrepancies)} programs with CIM↔Banner concentration diffs")

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
                    'otp_notes',
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
            row_has_campus = bool(row.get('campus', ''))
            found_pid = None
            if lookup_campus:
                key = _norm(f'{parent_name} ({lookup_campus})')
                if key in name_to_pid and name_to_pid[key] != pid:
                    found_pid = name_to_pid[key]
                # Also try _degree_core which strips campus — but ONLY if
                # the candidate parent's actual campus matches. Prevents a
                # Charlotte concentration row from matching a Portland parent
                # just because their degree_core strings happen to match.
                if not found_pid:
                    for key in (_norm(parent_name), _degree_core(parent_name)):
                        if key and key in name_to_pid and name_to_pid[key] != pid:
                            cand = tracker.get(name_to_pid[key], {})
                            if (cand.get('campus','') or '').lower() == lookup_campus.lower():
                                found_pid = name_to_pid[key]
                                break
            elif not row_has_campus and not campus_override:
                # Row has no campus AND no override — fall through to any match.
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

    # NOTE: deployment variants (MS—Align, MS—Connect, MS—Bridge, MS—Online,
    # etc.) are SEPARATE PROGRAMS in CIM, not concentrations or sub-entries
    # of their base degree. They get their own top-level Portfolio row and
    # their own concentrations expand independently. Do NOT nest them under
    # the base degree, and do NOT synthesize a base-degree placeholder when
    # only a deployment variant exists at a campus.

    # Do NOT inherit concentrations across campus deployments. IPD does not
    # supply a concentration column — whatever IPD knows is embedded in the
    # program name. If a deployment row has no concentrations_json of its
    # own (because there's no CIM curriculum yet), leave it blank rather
    # than borrowing from another campus's deployment.

    # ── GTM overlay (Go To Market Roster 2.0) ─────────────────────────────────
    # Join by CIM program id (from the sheet's CIM url ?key=), with Banner Code
    # as a fallback (resolved to a CIM id via the programs table). Sets gtm_*
    # fields on matching tracker rows; every row gets blank gtm_* defaults so
    # the DB insert's named params are always satisfied.
    _GTM_KEYS = ('gtm_type', 'gtm_date', 'gtm_first_term', 'gtm_last_term', 'gtm_intake_terms')
    gtm_entries = parse_gtm()
    gtm_by_cimid = {}
    if gtm_entries:
        # banner → cim id map (uppercase) for the fallback join
        banner_to_pid = {}
        try:
            with get_db() as conn:
                for r in conn.execute("SELECT id, banner_code FROM programs WHERE banner_code != ''"):
                    bc = (r['banner_code'] or '').strip().upper()
                    if bc:
                        banner_to_pid.setdefault(bc, r['id'])
        except Exception:
            pass
        for e in gtm_entries:
            pid = e['cim_id'] if e['cim_id'] is not None else banner_to_pid.get(e['banner'])
            if pid is None:
                continue
            gtm_by_cimid[pid] = {k: e[k] for k in _GTM_KEYS}
    n_gtm_matched = 0
    for r in tracker.values():
        vals = gtm_by_cimid.get(r.get('cim_program_id'))
        for k in _GTM_KEYS:
            r[k] = (vals or {}).get(k, '') if vals else r.get(k, '')
        if vals:
            n_gtm_matched += 1
    if gtm_entries:
        print(f"  GTM overlay: {len(gtm_entries)} roster rows → {n_gtm_matched} matched to portfolio")

    # ── Exit master's overlay ─────────────────────────────────────────────────
    # A curated set of banner codes flags "exit master's" programs. Resolve the
    # codes to CIM program ids via the programs table, then mark matching rows
    # 'Yes' and everything else 'No'.
    exit_pids = set()
    try:
        with get_db() as conn:
            ph = ','.join('?' for _ in EXIT_MASTERS_BANNERS)
            for r in conn.execute(
                    f"SELECT id FROM programs WHERE UPPER(banner_code) IN ({ph})",
                    tuple(EXIT_MASTERS_BANNERS)):
                exit_pids.add(r['id'])
    except Exception:
        pass
    n_exit = 0
    for r in tracker.values():
        is_exit = (r.get('cim_program_id') in exit_pids
                   or r.get('program_name') in EXIT_MASTERS_PROGRAM_NAMES)
        r['exit_masters'] = 'Yes' if is_exit else 'No'
        if is_exit:
            n_exit += 1
    print(f"  Exit master's: {n_exit} programs flagged Yes "
          f"({len(EXIT_MASTERS_BANNERS)} banner codes + {len(EXIT_MASTERS_PROGRAM_NAMES)} names, "
          f"{len(exit_pids)} matched in CIM)")

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
        _sp   = _dedup(sorted(svt_pending,    key=lambda x: x['source_name']), 'source_name', 'campus')
        _su   = _dedup(sorted(svt_undergrad,  key=lambda x: x['source_name']), 'source_name', 'campus')
        _mismatch_data = {
            'updated_at':     now,
            'non_programs':   _np,
            'svt_added':      _sa,
            'svt_pending_analysis': _sp,
            'svt_undergrad_skipped': _su,
            'svt_resolution': svt_resolution,
            'svt_mismatches': _sm,
            'ipd_mismatches': _im,
            'ipd_added':      _ia,
            'otp_mismatches': _om,
            'gls_mismatches': _gm,
            'concentration_college_discrepancies':
                sorted(conc_college_discrepancies, key=lambda x: x['program']),
            'banner_reconciliation': _reconcile_banner_portfolio(tracker, cim_meta),
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
