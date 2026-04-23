"""Parser for SharePoint regulatory-approved-curriculum .xlsx workbooks.

Each workbook covers one regulatory campus (BC, FL, ME, NC, Ontario, VA, WA).
Each sheet in the workbook represents an approved program at that campus.

Output shape (per sheet):
    {
        'sheet_name': str,             # tab name (e.g. "VAN MSCS")
        'title': str,                  # row-0 col-A text (full program name when present)
        'edited_by': str,              # row-0 col-D "Edited by ... on ..."
        'unit_header': str,            # "SH" or "QH" (from row 1 col C) if detectable
        'courses': [                   # flat list, in document order
            {'code': 'CS 5010',
             'title': 'Programming Design Paradigm',
             'sh': '4',
             'section': 'Core Requirements',
             'note': ''}
        ],
        'sections': [                  # ordered list of section headers encountered
            'Core Requirements', 'Breadth Areas', ...
        ],
    }

Pure stdlib: `zipfile` + `xml.etree.ElementTree`. No openpyxl dependency.
"""

import re
import zipfile
import xml.etree.ElementTree as ET

_NS = {'a': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
       'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}

# Course-code pattern: 2-5 uppercase letters, optional space, 4 digits (+ optional letter).
COURSE_CODE_RE = re.compile(r'^\s*([A-Z]{2,5})\s*(\d{4}[A-Z]?)\s*$')

# "Master of Science", "Master of Professional Studies", "Doctor of Philosophy",
# "Graduate Certificate", "Bachelor of Science", "Certificate of Advanced Graduate Study",
# "Master of", "Bachelor of", "Doctor of"
_TITLE_RE = re.compile(
    r'(master|bachelor|doctor|graduate certificate|certificate of advanced|professional studies|phd)',
    re.IGNORECASE,
)


def _col_to_index(letters):
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch.upper()) - 64)
    return n - 1


def _read_shared_strings(z):
    try:
        root = ET.fromstring(z.read('xl/sharedStrings.xml'))
    except KeyError:
        return []
    out = []
    for si in root.findall('a:si', _NS):
        texts = [t.text or '' for t in si.findall('.//a:t', _NS)]
        out.append(''.join(texts))
    return out


def _read_sheet_rows(z, path, ss):
    root = ET.fromstring(z.read(path))
    rows = []
    for row in root.findall('.//a:row', _NS):
        cells = {}
        for c in row.findall('a:c', _NS):
            ref = c.attrib.get('r', '')
            m = re.match(r'([A-Z]+)(\d+)', ref)
            if not m:
                continue
            col = _col_to_index(m.group(1))
            t = c.attrib.get('t', '')
            v = c.find('a:v', _NS)
            is_el = c.find('a:is', _NS)
            val = ''
            if t == 's' and v is not None:
                try:
                    val = ss[int(v.text)]
                except (ValueError, IndexError):
                    val = ''
            elif t == 'inlineStr' and is_el is not None:
                val = ''.join((x.text or '') for x in is_el.findall('.//a:t', _NS))
            elif v is not None:
                val = v.text or ''
            cells[col] = val
        if cells:
            maxc = max(cells.keys())
            rows.append([cells.get(i, '') for i in range(maxc + 1)])
        else:
            rows.append([])
    return rows


def _list_sheets(z):
    """Return [(name, sheet_xml_path), ...] in workbook order."""
    wb = ET.fromstring(z.read('xl/workbook.xml'))
    rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
    rel_map = {r.attrib['Id']: r.attrib['Target']
               for r in rels.findall('{http://schemas.openxmlformats.org/package/2006/relationships}Relationship')}
    out = []
    for s in wb.findall('.//a:sheet', _NS):
        name = s.attrib.get('name', '')
        rid = s.attrib.get(f'{{{_NS["r"]}}}id', '')
        target = rel_map.get(rid, '')
        # targets like "worksheets/sheet1.xml" — resolve relative to xl/
        if target.startswith('/'):
            path = target.lstrip('/')
        else:
            path = 'xl/' + target
        out.append((name, path))
    return out


def _cell(row, i):
    if i < len(row):
        return (row[i] or '').strip()
    return ''


def _is_course_code(text):
    return bool(COURSE_CODE_RE.match((text or '').strip()))


def _normalize_code(text):
    m = COURSE_CODE_RE.match((text or '').strip())
    if not m:
        return ''
    return f'{m.group(1)} {m.group(2)}'


def parse_sheet(rows, sheet_name):
    """Parse rows from one sheet into {sheet_name, title, courses, sections, unit_header, edited_by}."""
    title = ''
    edited_by = ''
    unit_header = ''
    courses = []
    sections = []
    current_section = ''

    # Row 0: title + "Edited by..."
    if rows:
        title = _cell(rows[0], 0)
        # "Edited by" text is typically in col C or D
        for ci in range(1, min(6, len(rows[0]))):
            cell = _cell(rows[0], ci)
            if 'edited by' in cell.lower() or 'as of' in cell.lower():
                edited_by = cell
                break

    # Find the header row (contains "Course #" / "Course Title") and the unit column.
    header_row_idx = None
    for i, r in enumerate(rows[:6]):
        txts = [_cell(r, j).lower() for j in range(min(5, len(r)))]
        if any('course #' in t or 'course number' in t or t == 'course' for t in txts):
            header_row_idx = i
            # unit header is typically the third column
            unit_header = _cell(r, 2).upper()
            break

    start = (header_row_idx + 1) if header_row_idx is not None else 1
    for r in rows[start:]:
        col_a = _cell(r, 0)
        col_b = _cell(r, 1)
        col_c = _cell(r, 2)
        col_d = _cell(r, 3) if len(r) > 3 else ''
        if not col_a and not col_b and not col_c:
            continue
        if _is_course_code(col_a):
            courses.append({
                'code': _normalize_code(col_a),
                'title': col_b,
                'sh': col_c,
                'section': current_section,
                'note': col_d,
            })
            continue
        # Non-course row: treat col_a as a section header when it has text
        # and cols B/C are empty-ish.
        if col_a and not _is_course_code(col_a):
            # Ignore title-looking rows (we already captured row 0).
            # A section header is typically a short label without course code.
            current_section = col_a
            if current_section not in sections:
                sections.append(current_section)

    return {
        'sheet_name': sheet_name,
        'title': title,
        'edited_by': edited_by,
        'unit_header': unit_header,
        'courses': courses,
        'sections': sections,
    }


def parse_workbook(path_or_bytes):
    """Parse a .xlsx file into a list of sheet dicts.

    Accepts a filesystem path (str) or a bytes object (in-memory content).
    """
    if isinstance(path_or_bytes, (bytes, bytearray)):
        import io
        z = zipfile.ZipFile(io.BytesIO(path_or_bytes))
    else:
        z = zipfile.ZipFile(path_or_bytes)
    ss = _read_shared_strings(z)
    sheets = []
    for name, spath in _list_sheets(z):
        rows = _read_sheet_rows(z, spath, ss)
        sheets.append(parse_sheet(rows, name))
    return sheets


# ---------------------------------------------------------------------------
# Sheet -> CIM program matching
# ---------------------------------------------------------------------------

# Degree buckets — two programs only match if their degree buckets agree.
# MS/MSCS/MSIS/MSECE/MSN/MSEM/MS*/MPS are all the "MS family" (Master of Science variants).
# MA, MPA, MPP, MPH, MBA, MFA, MSW, MEd, MLS, etc. are their own buckets.
_DEGREE_BUCKETS = {
    # Master of Science family
    'mscs': 'ms', 'msis': 'ms', 'msece': 'ms', 'msn': 'ms',
    'msem': 'ms', 'msenes': 'ms', 'msenvs': 'ms', 'msbioe': 'ms',
    'mps': 'ms', 'ms': 'ms',
    # Other master's
    'ma': 'ma', 'mpa': 'mpa', 'mpp': 'mpp', 'mph': 'mph',
    'mba': 'mba', 'mfa': 'mfa', 'msw': 'msw', 'med': 'med',
    'mls': 'mls', 'mbe': 'mbe', 'mem': 'mem',
    # Doctoral
    'phd': 'phd', 'edd': 'edd', 'dnp': 'dnp', 'jd': 'jd',
    'dld': 'edd',  # doctor of law and policy — treat as edd-family? DLP
    'dlp': 'dlp',
    # Bachelor's
    'bs': 'bs', 'ba': 'ba', 'bfa': 'bfa', 'bsn': 'bsn', 'bba': 'bba',
    # Certificates
    'certg': 'cert', 'cags': 'cert', 'gradcert': 'cert', 'gc': 'cert',
    'certificate': 'cert',
}

_DEGREE_TOKENS = set(_DEGREE_BUCKETS.keys())

# Head phrases: (prefix_pattern, degree_bucket, trailing_subject)
# trailing_subject=True  -> the subject follows the phrase, so strip the whole phrase
# trailing_subject=False -> the phrase *is* the degree name and contains the subject
#                          (e.g. "Master of Public Administration"), strip only
#                          the leading "<Degree> of " (2 words + space) so the
#                          subject tokens remain.
_HEAD_STRIPS = [
    ('master of science in ',               'ms',   True),
    ('master of professional studies in ',  'ms',   True),
    ('master of arts in ',                  'ma',   True),
    ('master of professional studies ',     'ms',   True),
    ('master of science ',                  'ms',   True),
    ('master of public administration',     'mpa',  False),
    ('master of public policy',             'mpp',  False),
    ('master of public health',             'mph',  False),
    ('master of business administration',   'mba',  False),
    ('master of education',                 'med',  False),
    ('master of legal studies',             'mls',  False),
    ('master of sports leadership',         'mem',  False),
    ('master of ',                          '',     True),
    ('doctor of philosophy in ',            'phd',  True),
    ('doctor of nursing practice',          'dnp',  False),
    ('doctor of education',                 'edd',  False),
    ('doctor of law and policy',            'dlp',  False),
    ('doctor of ',                          '',     True),
    ('bachelor of science in ',             'bs',   True),
    ('bachelor of science ',                'bs',   True),
    ('bachelor of ',                        '',     True),
    ('graduate certificate in ',            'cert', True),
    ('graduate certificate ',               'cert', True),
    ('grad cert ',                          'cert', True),
    ('certificate of advanced graduate study in ', 'cert', True),
    ('certificate of advanced graduate study',     'cert', False),
    ('certificate ',                        'cert', True),
]

_STOP_TOKENS = {'with','major','in','a','an','the','of','for','and','&','to','as','on','or'}

# Campus abbreviation prefixes that appear in sheet names.
_SHEET_CAMPUS_PREFIXES = ('VAN ', 'TOR ', 'BC ', 'FL ', 'ME ', 'NC ', 'VA ', 'WA ')


def _normalize_stem(text):
    """Return (stem_string, degree_bucket). Degree bucket '' when unknown."""
    if not text:
        return '', ''
    s = text.lower()
    # Strip trailing campus parenthetical like "(Vancouver)" and any other parentheticals
    s = re.sub(r'\([^)]*\)', ' ', s)
    # Collapse em/en-dashes to space
    s = s.replace('—', ' ').replace('–', ' ')
    # "as of: ..." placeholder text
    s = re.sub(r'\bas of\b.*', ' ', s)
    # Normalize apostrophes/quotes/slashes/punct to spaces (but keep commas for splitting)
    s = re.sub(r"[’'`\"/]", ' ', s)
    # Collapse whitespace
    s_norm = re.sub(r'\s+', ' ', s).strip()

    # Detect degree from head phrase and strip minimally.
    degree = ''
    for phrase, bucket, trailing in _HEAD_STRIPS:
        if s_norm.startswith(phrase):
            if trailing:
                s_norm = s_norm[len(phrase):].strip()
            else:
                # Strip only the leading "<Degree> of " so the subject in the
                # phrase remains visible to token-matching.
                parts = phrase.split(None, 2)
                if len(parts) >= 2:
                    prefix = parts[0] + ' ' + parts[1] + ' '
                    if s_norm.startswith(prefix):
                        s_norm = s_norm[len(prefix):].strip()
            if bucket:
                degree = bucket
            break

    # Extract degree acronym token anywhere (after the subject, typical CIM style: "Subject, MS")
    # Walk tokens, remove any degree-acronym token, and record the first degree bucket seen.
    tokens = re.split(r'[,_\-\s\.]+', s_norm)
    clean = []
    for t in tokens:
        t = re.sub(r'[^a-z0-9]', '', t)
        if not t:
            continue
        if t in _DEGREE_TOKENS:
            if not degree:
                degree = _DEGREE_BUCKETS[t]
            continue
        if t in _STOP_TOKENS:
            continue
        # Drop pure-numeric credit hints like "32sh" "45qh"
        if re.match(r'^\d+(sh|qh)?$', t):
            continue
        clean.append(t)

    stem = ' '.join(clean)
    return stem, degree


_SUFFIX_TOKENS = {'align', 'connect', 'bridge', 'advanced', 'entry'}


def _split_base_and_suffix(stem):
    """Return (base_tokens, suffix_tokens_set).

    Suffix tokens are 'align', 'connect', 'bridge', etc. — they must match
    for programs like "Computer Science, MS—Align" to not collide with
    "Computer Science, MS".
    """
    tokens = stem.split()
    base = [t for t in tokens if t not in _SUFFIX_TOKENS]
    suffix = {t for t in tokens if t in _SUFFIX_TOKENS}
    return base, suffix


def _sheet_identity(sheet):
    """Derive the program identity string for a parsed sheet.

    Prefers row-0 title when it looks like a program name; falls back to sheet name.
    """
    title = (sheet.get('title') or '').strip()
    if title and _TITLE_RE.search(title):
        return title
    # Fallback to sheet tab name, stripping known campus prefixes
    name = sheet.get('sheet_name', '')
    for p in _SHEET_CAMPUS_PREFIXES:
        if name.startswith(p):
            name = name[len(p):]
            break
    return name


def _score_match(cim_stem, cim_degree, sheet_stem, sheet_degree):
    """Return (score, reason). Higher = better. 0 = no match.

    Degrees must match if both are known. An unknown degree on either side
    is permissive (doesn't block the match).
    """
    cb, cs = _split_base_and_suffix(cim_stem)
    sb, ss = _split_base_and_suffix(sheet_stem)
    if not cb or not sb:
        return 0, 'empty'
    # Suffix (—Align / —Connect / —Bridge) must match
    if cs != ss:
        return 0, 'suffix mismatch'
    # Degree bucket must match when both known
    if cim_degree and sheet_degree and cim_degree != sheet_degree:
        return 0, f'degree mismatch {cim_degree}/{sheet_degree}'

    cbs = ' '.join(cb)
    sbs = ' '.join(sb)
    if cbs == sbs:
        return 1.0, 'exact'
    cset = set(cb)
    sset = set(sb)
    if not cset or not sset:
        return 0, 'empty set'
    inter = cset & sset
    jacc = len(inter) / len(cset | sset)
    if jacc >= 0.8:
        return jacc, f'jaccard {jacc:.2f}'
    if cset.issubset(sset) or sset.issubset(cset):
        # Only allow subset when the smaller side is "content-rich" (more than one token)
        # to avoid e.g. single-token "management" matching anything with "management" in it.
        smaller = cset if len(cset) <= len(sset) else sset
        if len(smaller) >= 2:
            return 0.75, 'subset'
        # Single-token subject: require exact equality unless degree also matches
        if cim_degree and cim_degree == sheet_degree:
            return 0.70, 'subset single-token degree-matched'
        return 0, 'subset single-token, ambiguous'
    return 0, f'jaccard {jacc:.2f}'


def _has_placeholder_title(sheet):
    t = (sheet.get('title') or '').lower()
    if not t:
        # An empty title *might* still match via sheet name fallback; not a placeholder by itself.
        return False
    if re.match(r'^\s*(as of|tbd|course\s*#)\b', t):
        return True
    return False


def _extract_course_codes(courses):
    return {c['code'] for c in courses if c.get('code')}


def match_sheets_to_programs(sheets, cim_programs, campus):
    """Match workbook sheets to CIM programs.

    Args:
        sheets: list of parsed sheet dicts (from parse_workbook).
        cim_programs: list of dicts with keys {id, name, curriculum_codes (set)}.
                      'name' is the CIM program name; curriculum_codes is the
                      set of course codes present in the current proposal
                      curriculum (used to disambiguate SH vs QH twins).
        campus: display campus name (e.g. 'Toronto') — used only for logging.

    Returns:
        list of {program_id, sheet_index, confidence, reason} -- one per
        matched CIM program (programs with no match are omitted).
    """
    # Pre-compute sheet stems + degrees + codes
    prepped = []
    for idx, s in enumerate(sheets):
        if _has_placeholder_title(s):
            continue
        ident = _sheet_identity(s)
        if not ident:
            continue
        stem, deg = _normalize_stem(ident)
        # Also compute stem/degree from the sheet tab name as a fallback
        name = s.get('sheet_name', '')
        for p in _SHEET_CAMPUS_PREFIXES:
            if name.startswith(p):
                name = name[len(p):]
                break
        alt_stem, alt_deg = _normalize_stem(name)
        if not stem and not alt_stem:
            continue
        # Prefer title-derived, but if title stem is empty or degree unknown
        # while the sheet-name version is non-empty / degree-known, prefer that.
        if not stem:
            stem, deg = alt_stem, alt_deg
        elif not deg and alt_deg:
            # Enhance missing degree from sheet name
            deg = alt_deg
        # Skip obvious summary tabs
        if stem in ('all courses', 'all programs', 'count', 'all', 'courses'):
            continue
        if stem.startswith('all ') and 'course' in stem:
            continue
        codes = _extract_course_codes(s.get('courses', []))
        prepped.append((idx, stem, deg, codes, s.get('unit_header', '').upper()))

    results = []
    for p in cim_programs:
        cim_stem, cim_deg = _normalize_stem(p['name'])
        # Gather candidates
        cands = []
        for idx, sstem, sdeg, codes, unit in prepped:
            score, reason = _score_match(cim_stem, cim_deg, sstem, sdeg)
            if score > 0:
                cands.append((idx, score, reason, codes, unit))
        if not cands:
            continue
        if len(cands) == 1:
            idx, score, reason, _, _ = cands[0]
            results.append({
                'program_id': p['id'],
                'sheet_index': idx,
                'confidence': score,
                'reason': reason,
            })
            continue
        # Multiple candidates: tie-break by course-code overlap with CIM proposal.
        cim_codes = p.get('curriculum_codes') or set()
        if cim_codes:
            best = max(cands, key=lambda c: (len(c[3] & cim_codes), c[1]))
            idx, score, reason, codes, unit = best
            reason = f'{reason}; overlap={len(codes & cim_codes)} (among {len(cands)} cands)'
            results.append({
                'program_id': p['id'],
                'sheet_index': idx,
                'confidence': score,
                'reason': reason,
            })
        else:
            # No CIM curriculum to compare — take highest-scoring.
            cands.sort(key=lambda c: c[1], reverse=True)
            idx, score, reason, _, _ = cands[0]
            results.append({
                'program_id': p['id'],
                'sheet_index': idx,
                'confidence': score,
                'reason': f'{reason}; ambiguous ({len(cands)} cands, no CIM codes to disambiguate)',
            })
    return results
