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
                'roster_status':      status,
                'roster_sub_status':  sub_status,
                'roster_proposal_type': proposal,
                'roster_launch_date': launch_date,
            })

    return programs


# ---------------------------------------------------------------------------
# Link to CIM
# ---------------------------------------------------------------------------

_DEGREE_TOKENS = re.compile(
    r'\b(ms|ma|mps|mpa|mph|mba|mfa|med|mem|march|mdes|mscs|msis|msor|msfmba|msece|'
    r'msene|mssbs|dnp|dpt|dmsc|edd|phd|jd|llm|dlp|bs|ba|bfa|barch|bsn|bsba|bscf|'
    r'certg?|mat|mbe)\b', re.I)

# Degree tokens that appear as a prefix in OTP/IPD names ("MS Computer Science",
# "MS in Artificial Intelligence", "Master of Science in Data Science")
_DEGREE_PREFIX = re.compile(
    r'^(ms|ma|mps|mpa|mph|mba|mfa|med|mem|march|mdes|mscs|msis|msor|msfmba|msece|'
    r'msene|mssbs|dnp|dpt|dmsc|edd|phd|jd|llm|dlp|bs|ba|bfa|barch|bsn|bsba|bscf|'
    r'certg?|mat|mbe)\s+(?:in\s+|of\s+)?(.+)$', re.I)

_CAMPUS_NAMES = {
    'BOS': 'Boston', 'OAK': 'Oakland', 'TOR': 'Toronto', 'POR': 'Portland',
    'SV': 'Silicon Valley', 'SJ': 'Silicon Valley', 'SEA': 'Seattle',
    'MIA': 'Miami', 'ARL': 'Arlington', 'VAN': 'Vancouver',
    'CHA': 'Charlotte', 'LON': 'London',
    'Primarily Online - Vancouver Requirements': 'Primarily Online',
}

# Campus values that are clearly junk or overly verbose — discard them
_BAD_CAMPUSES = re.compile(
    r'copy this template|propose a new|combined health science', re.I)

# Canonical college names (maps abbreviations and variants → full name)
_COLLEGE_NAMES = {
    'bouve':                        'Bouve College of Hlth Sciences',
    'camd':                         'Coll of Arts, Media & Design',
    'coe':                          'College of Engineering',
    'cos':                          'College of Science',
    'cps':                          'Coll of Professional Studies',
    'cssh':                         'Coll of Soc Sci & Humanities',
    'dmsb':                         "D'Amore-McKim School Business",
    'khoury':                       'Khoury Coll of Comp Sciences',
    'mills college':                'Mills College at NU',
    'sol':                          'School of Law',
    # Values that are not colleges — blank them out
    'nch':                          '',
    'nu-london':                    '',
    'university interdisciplinary program (uip)': '',
}

_NOT_COLLEGES = {
    'not applicable', 'all', 'n/a', 'none',
    'new program', 'redesign an existing program', 'deploy program to network',
    'digital badge credential proposal', 'net new product', 'revamp an existing program',
    'launch term change request', 'course development consultation',
    'international opportunity', 'new product (e.g. student experience program)',
}


# Trailing campus suffix: strips from the first known campus name to the end.
# Handles single campus (",Oakland"), multi-campus (",Boston, Arlington and Oakland"),
# and slash-separated (",Oakland/Portland").
_CAMPUS_SUFFIX_RE = re.compile(
    r',\s*(Boston|Oakland|Portland|Toronto|Seattle|Miami|Arlington|Vancouver|'
    r'Charlotte|London|Silicon Valley|Online|Primarily Online).*$',
    re.I)

_ABBREV_MAP = [
    (r'\s*&\s*',      ' and '),
    (r'\bmgmt\b',     'management'),
    (r'\bsci\b',      'science'),
    (r'\bsciences\b', 'science'),    # plural→singular for matching
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
    (r'\bsystems\b',  'system'),      # plural→singular for matching
]
# Compiled once at module load
_ABBREV_RE = [(re.compile(pat, re.I), repl) for pat, repl in _ABBREV_MAP]

# Deployment-variant suffixes to strip before core comparison
# Matches: "—Align", ", Align", " - Align", ", Connect", etc.
_DEPLOY_SUFFIX = re.compile(
    r'[\s,]*[-—]?\s*(align|connect|bridge|accelerated|part.?time)\b.*$', re.I)

# Concentration patterns for parent-name extraction:
#   Pattern A: "BASE with Concentration in CONC, DEGREE (Campus)"
_CONC_WITH = re.compile(
    r'^(.+?)\s+with\s+Concentration\s+in\s+[^,]+,\s+([A-Z][^\s(,]+(?:\s*\([^)]+\))?)\s*$',
    re.I)
#   Pattern B: "BASE - CONC Concentration, DEGREE (Campus)"
_CONC_DASH = re.compile(
    r'^(.+?)\s*[-—]\s*[^-—,]+?\s+Concentration,?\s+([A-Z][^\s(,]+(?:\s*\([^)]+\))?)\s*$',
    re.I)

# ── Portfolio data-quality overrides ─────────────────────────────────────────

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
    # Badges / non-degree
    'Cybersecurity Microcredential Badges (non-credit levels 1-3)',
    'Future You: Leveraging AI for Success - EM EDGE Badge',
    'Entrepreneurship Boot Camp',
    # Not programs / duplicates
    'Global Pathways in Portland (Khoury, CPS)',
    'Pre-College Online Program',
    'SummerIn Portland: Innovating to Address Complex Health Challenges',
    'University of Philippines Global Campus partnership',
    'AI CERT in SV',  # duplicate of AI Applications, Graduate Certificate (Silicon Valley)
})

# Exact name → (corrected_name, college_override, campus_override).
# Empty string '' means keep the existing value.
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
    # Fix missing degree suffix
    'Applied Quantum Information Science and Engineering':
        ('Applied Quantum Information Science and Engineering, MS', '', ''),
    # Clean up concentration names before parent-linking
    'Artificial Intelligence - Omics Concentration (COS), MS':
        ('Omics', 'College of Science', 'Boston'),
    'AI (new concentration) Bouve, MS':
        ('Bouve Health AI', 'Bouve College of Hlth Sciences', 'Boston'),
}

# Strip "at Roux" / "for Maine" from program names; these indicate Portland campus.
_ROUX_RE = re.compile(r'\s+at\s+Roux\b|\s*,?\s*\(for\s+Maine\)\s*', re.I)

# Explicit concentration-of parent mappings by regex.
# Each entry: (pattern, parent_program_name, campus_override_or_None).
# campus_override=None means use the concentration row's own campus.
_EXPLICIT_CONC_PARENTS = [
    (re.compile(r'^Business Concentration in ', re.I),
     'Business Administration, BSBA', 'Boston'),
    (re.compile(r'^Electrical and Computer Engineering with Concentration in .+MSECE', re.I),
     'Electrical and Computer Engineering, MSECE', None),
    (re.compile(r'^Mechanical Engineering with Concentration in .+MSME', re.I),
     'Mechanical Engineering, MSME', None),
    (re.compile(r'^Electrical Engineering and Music with Concentration in .+BSEE', re.I),
     'Electrical Engineering and Music, BSEE', 'Boston'),
    (re.compile(r'^Master of Science in Bioengineering,?\s+concentration in ', re.I),
     'Bioengineering, MS', None),
    (re.compile(r'^UG Concentration in ', re.I),
     'Regulatory Affairs, BS', 'Boston'),
    # "Omics" (renamed from AI Omics Concentration) → AI, MS (Boston, COS)
    (re.compile(r'^Omics$', re.I),
     'Artificial Intelligence, MS', 'Boston'),
    # "Bouve Health AI" (renamed from AI new concentration Bouve) → AI, MS (Boston)
    (re.compile(r'^Bouve Health AI$', re.I),
     'Artificial Intelligence, MS', 'Boston'),
]


def _extract_parent_name(name):
    """Try to extract a parent program name from a concentration name.
    Returns a candidate name string or None if no pattern matched."""
    m = _CONC_WITH.match(name)
    if m:
        return f"{m.group(1).strip()}, {m.group(2).strip()}"
    m = _CONC_DASH.match(name)
    if m:
        return f"{m.group(1).strip()}, {m.group(2).strip()}"
    return None


# Concentration headings to skip — purely structural / generic
_CONC_SKIP = re.compile(
    r'^concentrations?$'
    r'|^concentrations?\s+(or|and|for\s+all|options?|courses?|list)\b'
    r'|\bconcentration\s+(courses?|list|options?|requirements?)\b'
    r'|\bconcentration\s+or\s+'           # "Concentration or Electives Option"
    r'|\b(without|no)\s+concentration\b'
    r'|\(without\s+concentration\)'
    r'|^excluded\s+courses'
    r'|^coursework\s+option\b',           # "Coursework Option\nConcentration or ..."
    re.I
)


def _extract_concentrations_from_html(html):
    """Return sorted list of named concentration names from CIM curriculum HTML."""
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
        # Strip college attribution: "—College of X" or "— Khoury College"
        h = re.sub(r'\s*[—]\s*\S.*College.*$', '', h).strip()
        # Strip trailing "(Optional)" / "(Required)" before further normalization
        h = re.sub(r'\s*\([Oo]ptional\)$', '', h).strip()
        h = re.sub(r'\s*\([Rr]equired\)$', '', h).strip()
        # Strip trailing asterisks / footnote markers
        h = h.rstrip('*† ').strip()
        # "Optional Concentration in X" / "Concentration in X" → X
        # "X with a Concentration in Y" / "X with Concentration in Y" → Y
        m = re.match(r'^(?:optional\s+)?concentration\s+in\s+(.+)$', h, re.I)
        if m:
            h = m.group(1).strip()
        elif re.search(r'\bwith\s+a?\s*concentration\s+in\s+', h, re.I):
            h = re.sub(r'^.*\bwith\s+a?\s*concentration\s+in\s+', '', h, flags=re.I).strip()
        # "X Concentration(s)" → X
        elif re.search(r'\bconcentrations?$', h, re.I):
            h = re.sub(r'\s*\bconcentrations?\s*$', '', h, flags=re.I).strip()
        else:
            # e.g. "Concentration Artificial Intelligence" — skip (weird non-standard)
            if re.match(r'^concentration\s', h, re.I):
                continue
        if h and h.lower() not in seen:
            seen.add(h.lower())
            results.append(h)
    return results


def _expand_abbrevs(s):
    """Apply abbreviation expansions and & → and."""
    for pat, repl in _ABBREV_RE:
        s = pat.sub(repl, s)
    return s


def _cim_core(name):
    """Degree-agnostic core: strip campus, degree tokens, deployment suffixes,
    expand abbreviations.  Used as a last-resort fuzzy fallback only."""
    s = _norm(name).replace('—', '-').replace('–', '-')
    s = re.sub(r'\([^)]*\)', '', s)
    s = _DEPLOY_SUFFIX.sub('', s)
    s = re.sub(r'\bgraduate\s+certificate\b', '', s, re.I)
    s = re.sub(r'\bmaster\s+of\s+\w+(\s+(in|of))?\b', '', s, re.I)
    s = _DEGREE_TOKENS.sub('', s)
    s = _expand_abbrevs(s)
    s = re.sub(r'[\s,/\-]+$', '', s.strip())
    s = re.sub(r'^[\s,/\-]+', '', s)
    return re.sub(r'\s+', ' ', s).strip()


def _degree_core(name):
    """Degree-aware normalized key: keeps the degree token but strips campus and
    deployment suffixes, expands abbreviations, and moves a leading degree prefix
    to suffix so 'MS Computer Science' and 'Computer Science, MS (Boston)' share
    the same key 'computer science, ms'."""
    s = _norm(name).replace('—', '-').replace('–', '-')
    s = re.sub(r'\([^)]*\)', '', s)    # strip (Campus)
    s = _DEPLOY_SUFFIX.sub('', s)      # strip deployment suffix
    s = re.sub(r'\bgraduate\s+certificate\b', 'certg', s, flags=re.I)
    s = re.sub(r'\bmaster\s+of\s+\w+(\s+(in|of))?\s*', 'ms ', s, flags=re.I)
    s = _expand_abbrevs(s)
    # Move degree prefix to suffix: "ms computer science" → "computer science, ms"
    m = _DEGREE_PREFIX.match(s.strip())
    if m:
        degree = m.group(1).lower()
        rest   = m.group(2).strip().rstrip(',')
        s = f'{rest}, {degree}'
    s = re.sub(r'[\s,/\-]+$', '', s.strip())
    s = re.sub(r'^[\s,/\-]+', '', s)
    return re.sub(r'\s+', ' ', s).strip()


def _normalize_campus(campus):
    """Resolve campus code abbreviations to full names."""
    return _CAMPUS_NAMES.get((campus or '').strip(), (campus or '').strip())


def _campus_from_cim_name(name):
    """Extract campus from CIM parenthetical: 'Name, Degree (Boston)' → 'Boston'."""
    m = re.search(r'\(([^)]+)\)\s*$', (name or '').strip())
    return m.group(1).strip() if m else ''


def _normalize_degree_prefix(name):
    """Convert OTP-style 'DEGREE Name' → 'Name, DEGREE'.

    Examples: 'MS Computer Science' → 'Computer Science, MS'
              'DNP Nursing' → 'Nursing, DNP'
    Names already in CIM format are returned unchanged.
    """
    m = _DEGREE_PREFIX.match(name.strip())
    if m:
        degree = m.group(1).upper()
        rest   = m.group(2).strip().rstrip(',')
        return f'{rest}, {degree}'
    return name


def _strip_trailing_campus(name):
    """Remove a trailing ', CampusName' from a program name string."""
    return _CAMPUS_SUFFIX_RE.sub('', name.strip()).strip().rstrip(',').strip()


def _extract_embedded_campus(name):
    """Return the campus name embedded as a trailing suffix, or empty string."""
    m = _CAMPUS_SUFFIX_RE.search(name)
    return m.group(1) if m else ''


def _normalize_non_cim_name(name):
    """Normalize IPD/Roster program names toward CIM canonical format.

    Handles:
      'CERTG Product Management, Silicon Valley' → 'Product Management, Graduate Certificate'
      'CERT AI Applications, Arlington'          → 'AI Applications, Graduate Certificate'
      'Graduate Certificate in X, Oakland'       → 'X, Graduate Certificate'
      'Certificate in X'                         → 'X, Graduate Certificate'
      'Certificate, X'                           → 'X, Graduate Certificate'
      'CERTG-CODE : X, Graduate Certificate (Y)' → 'X, Graduate Certificate (Y)'
    Campus suffix is stripped in all cases (it belongs in the campus field).
    """
    s = name.strip()
    # Strip leading "CODE-CODE : " prefix (e.g. "CERTG-ENGM : ")
    s = re.sub(r'^[A-Z]+-[A-Z]+\s*:\s*', '', s)
    # "Graduate Certificate in X" with optional trailing campus
    m = re.match(r'^Graduate\s+Certificate\s+in\s+(.+)$', s, re.I)
    if m:
        rest = _strip_trailing_campus(m.group(1).strip())
        return rest + ', Graduate Certificate'
    # "Certificate in X" or "Certificate, X" or "Certificate X" (no "Graduate" prefix)
    m = re.match(r'^Certificate(?:\s+in|,)?\s+(.+)$', s, re.I)
    if m:
        rest = _strip_trailing_campus(m.group(1).strip())
        return rest + ', Graduate Certificate'
    # "CERTG X" or "CERT X" with optional trailing campus
    m = re.match(r'^CERTG?\s+(.+)$', s, re.I)
    if m:
        rest = _strip_trailing_campus(m.group(1).strip())
        return rest + ', Graduate Certificate'
    # Normalize "MS in X" / "MS X" / "BS in X" → "X, MS" / "X, BS" etc.
    s = _normalize_degree_prefix(_strip_trailing_campus(s))
    return s


def _load_all_cim_programs():
    """Return list of all active CIM programs as dicts with canonical names."""
    from database import get_db
    with get_db() as conn:
        rows = conn.execute("""
            SELECT id, name, college, current_step, completion_date
            FROM programs
            WHERE current_step IS NOT NULL AND current_step != ''
        """).fetchall()
    result = []
    for r in rows:
        campus = _campus_from_cim_name(r['name'] or '')
        result.append({
            'cim_id':              r['id'],
            'cim_name':            r['name'] or '',
            'college':             r['college'] or '',
            'campus':              campus,
            'cim_step':            r['current_step'] or '',
            'cim_completion_date': r['completion_date'] or '',
        })
    return result


def _build_cim_index(cim_programs):
    """Return {match_key: cim_entry} indexed under two keys per program:
      1. Exact normalized name (full, with campus)
      2. Degree-aware core: abbreviations expanded, campus stripped, prefix→suffix
    Degree-agnostic core (_cim_core) is NOT indexed here because it causes
    false-positive collisions when _degree_core produces the same root string.
    """
    index = {}
    for entry in cim_programs:
        for key in (
            _norm(entry['cim_name']),
            _degree_core(entry['cim_name']),
        ):
            if key and key not in index:
                index[key] = entry
    return index


def _find_cim(name, campus, cim_index):
    """Find a CIM entry for a given name+campus.

    Priority (most to least specific):
      1. Exact norm with campus appended
      2. Exact norm of name alone
      3. Degree-aware core with campus
      4. Degree-aware core of name alone
    Degree-agnostic core is intentionally NOT used as a fallback because it
    strips degree tokens and causes false matches (e.g. 'MS Biology' → 'Biology, BS').
    """
    campus_norm = _normalize_campus(campus)
    name_with_campus = f'{name} ({campus_norm})' if campus_norm else name
    for key in (
        _norm(name_with_campus),
        _norm(name),
        _degree_core(name_with_campus),
        _degree_core(name),
    ):
        if key and key in cim_index:
            return cim_index[key]
    return None


# ---------------------------------------------------------------------------
# Merge and ingest
# ---------------------------------------------------------------------------

def ingest(xlsx_path=XLSX_PATH, tsv_path=TSV_PATH, roster_path=ROSTER_PATH):
    """Seed from CIM active programs, overlay OTP/IPD/Roster tracking data."""
    from database import replace_all_portfolio_programs

    if not os.path.exists(xlsx_path):
        raise FileNotFoundError(f"OTP Excel not found: {xlsx_path}")

    cim_programs = _load_all_cim_programs()
    otp_rows     = parse_otp(xlsx_path)
    ipd_rows     = parse_smartsheet(tsv_path)
    roster_rows  = parse_roster(roster_path)
    cim_index    = _build_cim_index(cim_programs)

    now = datetime.now().isoformat()

    _EMPTY_TRACKING = {
        'otp_status': '', 'otp_sub_status': '', 'otp_market_potential': '',
        'otp_market_signal': '', 'otp_internal_performance': '',
        'otp_q3_status': '', 'otp_effective_term': '',
        'ipd_status': '', 'ipd_proposal_type': '', 'ipd_additional_college': '',
        'roster_status': '', 'roster_sub_status': '', 'roster_proposal_type': '',
        'roster_launch_date': '',
        'concentration_of': '',
        'concentrations_json': '',
        'last_refreshed': now,
    }

    # unified dict keyed by stable id
    unified = {}

    # ── Step 1: Seed from CIM (canonical names and workflow status) ──────────
    for c in cim_programs:
        campus = c['campus'] or 'Boston'
        pid = f"cim_{c['cim_id']}"
        unified[pid] = dict(_EMPTY_TRACKING, **{
            'id':                  pid,
            'program_name':        c['cim_name'],
            'college':             c['college'],
            'campus':              campus,
            'cim_program_id':      c['cim_id'],
            'cim_step':            c['cim_step'],
            'cim_completion_date': c['cim_completion_date'],
        })

    # ── Step 2: Overlay OTP data ─────────────────────────────────────────────
    # Normalize OTP campus codes and degree-prefix names before matching.
    for p in otp_rows:
        p['campus'] = _normalize_campus(p['campus']) or 'Boston'
        p['_norm_name'] = _normalize_degree_prefix(p['program_name'])

    for p in otp_rows:
        cim = _find_cim(p['_norm_name'], p['campus'], cim_index)
        if cim:
            pid = f"cim_{cim['cim_id']}"
            row = unified[pid]
        else:
            # OTP-only: add with normalized name
            norm_name = p['_norm_name']
            pid = _make_id(norm_name, p['campus'])
            if pid not in unified:
                unified[pid] = dict(_EMPTY_TRACKING, **{
                    'id':             pid,
                    'program_name':   norm_name,
                    'college':        p['college'],
                    'campus':         p['campus'],
                    'cim_program_id': None,
                    'cim_step':       '',
                    'cim_completion_date': '',
                })
            row = unified[pid]
        row['otp_status']              = p['otp_status']
        row['otp_sub_status']          = p['otp_sub_status']
        row['otp_market_potential']    = p['otp_market_potential']
        row['otp_market_signal']       = p['otp_market_signal']
        row['otp_internal_performance']= p['otp_internal_performance']
        row['otp_q3_status']           = p['otp_q3_status']
        row['otp_effective_term']      = p['otp_effective_term']
        # Fill college from OTP when CIM didn't have one
        if not row.get('college') and p['college']:
            row['college'] = p['college']

    # ── Step 3: Overlay IPD data ─────────────────────────────────────────────
    for p in ipd_rows:
        # Extract embedded campus and normalize name (CERT/Graduate Certificate format)
        embedded_campus = _extract_embedded_campus(p['program_name'])
        norm_name = _normalize_non_cim_name(p['program_name'])

        # Try CIM match: original name first, then normalized+embedded campus
        cim = _find_cim(p['program_name'], '', cim_index)
        if not cim and (embedded_campus or norm_name != p['program_name']):
            cim = _find_cim(norm_name, embedded_campus, cim_index)

        if cim:
            pid = f"cim_{cim['cim_id']}"
            row = unified[pid]
        else:
            store_campus = embedded_campus or 'Boston'
            pid = _make_id(norm_name, store_campus)
            if pid not in unified:
                unified[pid] = dict(_EMPTY_TRACKING, **{
                    'id':             pid,
                    'program_name':   norm_name,
                    'college':        p['ipd_college'],
                    'campus':         store_campus,
                    'cim_program_id': None,
                    'cim_step':       '',
                    'cim_completion_date': '',
                })
            row = unified[pid]
        if not row.get('ipd_status'):
            row['ipd_status']             = p['ipd_status']
            row['ipd_proposal_type']      = p['ipd_proposal_type']
            row['ipd_additional_college'] = p['ipd_additional_college']
        if not row.get('college') and p['ipd_college']:
            row['college'] = p['ipd_college']

    # Build a name-only index over all non-CIM rows added so far (OTP/IPD-only).
    # Used in Step 4 so Roster entries merge into the existing IPD row rather
    # than creating a duplicate.
    non_cim_name_index = {}  # _norm(program_name) → pid
    for pid, row in unified.items():
        if not pid.startswith('cim_'):
            key = _norm(row['program_name'])
            if key and key not in non_cim_name_index:
                non_cim_name_index[key] = pid

    # ── Step 4: Overlay Roster data ──────────────────────────────────────────
    for p in roster_rows:
        p['campus'] = _normalize_campus(p['campus'])
        norm_name = _normalize_non_cim_name(p['program_name'])

        # Try CIM match with normalized name
        cim = _find_cim(norm_name, p['campus'], cim_index)
        if not cim and norm_name != p['program_name']:
            cim = _find_cim(p['program_name'], p['campus'], cim_index)

        if cim:
            pid = f"cim_{cim['cim_id']}"
            row = unified[pid]
        else:
            pid = _make_id(norm_name, p['campus'])
            if pid not in unified:
                # Try name-only match against existing non-CIM rows (merges IPD+Roster)
                existing_pid = non_cim_name_index.get(_norm(norm_name))
                if not existing_pid:
                    existing_pid = non_cim_name_index.get(_norm(p['program_name']))
                if existing_pid and existing_pid in unified:
                    pid = existing_pid
                else:
                    unified[pid] = dict(_EMPTY_TRACKING, **{
                        'id':             pid,
                        'program_name':   norm_name,
                        'college':        p['college'],
                        'campus':         p['campus'] or 'Boston',
                        'cim_program_id': None,
                        'cim_step':       '',
                        'cim_completion_date': '',
                    })
            row = unified[pid]
        if not row.get('roster_status'):
            row['roster_status']        = p['roster_status']
            row['roster_sub_status']    = p['roster_sub_status']
            row['roster_proposal_type'] = p['roster_proposal_type']
            row['roster_launch_date']   = p['roster_launch_date']
        if not row.get('college') and p['college']:
            row['college'] = p['college']
        if not row.get('campus') and p['campus']:
            row['campus'] = p['campus']

    # ── Step 5: Clean up college and campus values ───────────────────────────
    for row in unified.values():
        college = (row.get('college') or '').strip()
        college_low = college.lower()
        if college_low in _NOT_COLLEGES:
            row['college'] = ''
        elif college_low in _COLLEGE_NAMES:
            row['college'] = _COLLEGE_NAMES[college_low]

        campus = (row.get('campus') or '').strip()
        if _BAD_CAMPUSES.search(campus):
            row['campus'] = 'Boston'
        else:
            row['campus'] = _CAMPUS_NAMES.get(campus, campus)

    # ── Step 5.5: Extract concentrations from CIM curriculum HTML ────────────
    cim_ids_needed = [row['cim_program_id'] for row in unified.values()
                      if row.get('cim_program_id')]
    if cim_ids_needed:
        import json as _json
        from database import get_db
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
        for row in unified.values():
            cim_id = row.get('cim_program_id')
            if cim_id and cim_id in curriculum_map:
                concs = _extract_concentrations_from_html(curriculum_map[cim_id])
                if concs:
                    row['concentrations_json'] = _json.dumps(concs)
                    n_with_concs += 1
        print(f"  Curriculum concentrations: {n_with_concs} programs have named concentrations")

    # ── Step 5.6: Data-quality overrides (remove, rename, strip Roux) ──────────
    # Remove excluded rows first.
    for pid in [p for p, r in unified.items() if r.get('program_name') in _PORTFOLIO_REMOVE]:
        del unified[pid]

    # Rename and fix college/campus. For non-CIM rows, also re-key by new name.
    for pid in list(unified):
        if pid not in unified:
            continue
        row = unified[pid]
        name = row.get('program_name') or ''
        if name in _PORTFOLIO_RENAME:
            new_name, new_college, new_campus = _PORTFOLIO_RENAME[name]
            row['program_name'] = new_name
            if new_college:
                row['college'] = new_college
            if new_campus:
                row['campus'] = new_campus
        elif _ROUX_RE.search(name):
            row['program_name'] = _ROUX_RE.sub('', name).strip().rstrip(',').strip()
            if not row.get('campus') or row['campus'] in ('', 'Boston'):
                row['campus'] = 'Portland'
        else:
            continue  # nothing changed, skip re-key
        # Re-key non-CIM/synth rows so IDs stay consistent with their new name.
        if not pid.startswith('cim_') and not pid.startswith('synth_'):
            new_pid = _make_id(row['program_name'], row['campus'])
            row['id'] = new_pid
            del unified[pid]
            unified[new_pid] = row

    # ── Step 6: Link concentrations to parent programs ───────────────────────
    # Build a name→id index over all unified rows for parent lookup.
    name_to_pid = {}
    for pid, row in unified.items():
        for key in (_norm(row['program_name']), _degree_core(row['program_name'])):
            if key and key not in name_to_pid:
                name_to_pid[key] = pid

    # Apply explicit concentration-of overrides before regex-based detection.
    n_explicit = 0
    _synth_explicit = {}  # parent_name+campus → synthetic pid, created on demand
    for pid, row in list(unified.items()):
        if row.get('concentration_of'):
            continue  # already linked
        name = row.get('program_name') or ''
        for pattern, parent_name, campus_override in _EXPLICIT_CONC_PARENTS:
            if not pattern.search(name):
                continue
            lookup_campus = campus_override if campus_override else row.get('campus', '')
            # Try campus-qualified _norm first (exact campus match),
            # then bare name/degree_core only when no campus constraint.
            found_pid = None
            if lookup_campus:
                # _norm only here — _degree_core strips the campus and would match wrong campus
                key = _norm(f'{parent_name} ({lookup_campus})')
                if key in name_to_pid and name_to_pid[key] != pid:
                    found_pid = name_to_pid[key]
            if not found_pid and not campus_override:
                for key in (_norm(parent_name), _degree_core(parent_name)):
                    if key and key in name_to_pid and name_to_pid[key] != pid:
                        found_pid = name_to_pid[key]
                        break
            if not found_pid:
                # Create a synthetic parent so concentrations aren't orphaned.
                synth_key = f'{parent_name}|{lookup_campus}'
                if synth_key not in _synth_explicit:
                    new_synth_pid = 'synth_' + re.sub(r'[^a-z0-9]+', '_', _norm(f'{parent_name} {lookup_campus}'))[:60]
                    conc_college = next(
                        (r.get('college', '') for r in unified.values()
                         if pattern.search(r.get('program_name', ''))), '')
                    unified[new_synth_pid] = dict(_EMPTY_TRACKING, **{
                        'id': new_synth_pid, 'program_name': parent_name,
                        'college': conc_college, 'campus': lookup_campus or row.get('campus', ''),
                        'cim_program_id': None, 'cim_step': '', 'cim_completion_date': '',
                    })
                    for key in (_norm(parent_name), _degree_core(parent_name)):
                        if key and key not in name_to_pid:
                            name_to_pid[key] = new_synth_pid
                    _synth_explicit[synth_key] = new_synth_pid
                found_pid = _synth_explicit[synth_key]
            row['concentration_of'] = found_pid
            n_explicit += 1
            break  # only apply first matching pattern

    # First pass: collect concentrations with extractable parent names that
    # don't already have a matching row, then create synthetic parent entries.
    n_synthetic = 0
    pending_concs = []  # (pid, parent_raw, conc_row)
    for pid, row in unified.items():
        if 'concentration' not in (row['program_name'] or '').lower():
            continue
        parent_raw = _extract_parent_name(row['program_name'])
        if not parent_raw:
            continue
        found = any(k in name_to_pid for k in (_norm(parent_raw), _degree_core(parent_raw)))
        if not found:
            pending_concs.append((pid, parent_raw, row))

    # Create one synthetic parent per unique normalized parent name.
    synth_created = {}  # norm_key → synthetic pid
    for pid, parent_raw, conc_row in pending_concs:
        norm_key = _norm(parent_raw)
        if norm_key in synth_created:
            continue
        synth_pid = 'synth_' + re.sub(r'[^a-z0-9]+', '_', norm_key)[:60]
        unified[synth_pid] = dict(_EMPTY_TRACKING, **{
            'id':             synth_pid,
            'program_name':   parent_raw,
            'college':        conc_row.get('college', ''),
            'campus':         conc_row.get('campus', ''),
            'cim_program_id': None,
            'cim_step':       '',
            'cim_completion_date': '',
        })
        # Add to index so concentrations can find it
        name_to_pid[norm_key] = synth_pid
        dk = _degree_core(parent_raw)
        if dk and dk not in name_to_pid:
            name_to_pid[dk] = synth_pid
        synth_created[norm_key] = synth_pid
        n_synthetic += 1

    # Second pass: link all concentrations to their parent.
    n_linked = 0
    for pid, row in unified.items():
        if 'concentration' not in (row['program_name'] or '').lower():
            continue
        parent_raw = _extract_parent_name(row['program_name'])
        if not parent_raw:
            continue
        for key in (_norm(parent_raw), _degree_core(parent_raw)):
            if key and key in name_to_pid and name_to_pid[key] != pid:
                row['concentration_of'] = name_to_pid[key]
                n_linked += 1
                break

    rows = list(unified.values())
    replace_all_portfolio_programs(rows)

    n_cim    = len(cim_programs)
    n_otp    = len(otp_rows)
    n_ipd    = len(ipd_rows)
    n_roster = len(roster_rows)
    n_otp_matched    = sum(1 for p in otp_rows    if _find_cim(p['_norm_name'], p['campus'], cim_index))
    n_ipd_matched    = sum(1 for p in ipd_rows    if _find_cim(p['program_name'], '', cim_index))
    n_roster_matched = sum(1 for p in roster_rows if _find_cim(p['program_name'], p['campus'], cim_index))
    n_conc_total = sum(1 for r in rows if 'concentration' in (r['program_name'] or '').lower())
    print(f"Portfolio ingest: {len(rows)} programs total")
    print(f"  CIM active: {n_cim}")
    print(f"  OTP: {n_otp} ({n_otp_matched} matched to CIM, {n_otp - n_otp_matched} unmatched)")
    print(f"  IPD: {n_ipd} ({n_ipd_matched} matched to CIM, {n_ipd - n_ipd_matched} unmatched)")
    print(f"  Roster: {n_roster} ({n_roster_matched} matched to CIM, {n_roster - n_roster_matched} unmatched)")
    print(f"  Concentrations: {n_conc_total} detected, {n_explicit} explicit + {n_linked} regex-linked to parent ({n_synthetic} synthetic parents created)")
    return len(rows)


if __name__ == '__main__':
    ingest()
