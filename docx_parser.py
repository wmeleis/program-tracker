"""Parse curriculum content from a .docx file.

Produces HTML that matches CourseLeaf's `<table class="sc_courselist">` structure,
so the existing Compare tab diff algorithm works unchanged on custom references.

Input: .docx file bytes (or path).
Output: {
    'title': str,                        # detected program title if any
    'curriculum_html': str,              # ready-to-render HTML
    'sections': [                        # structured preview for UI
        {'heading': 'Core Requirements', 'courses': [
            {'code': 'BIOT 5120', 'title': 'Foundations in Biotechnology', 'hours': '3'},
            {'code': '', 'title': 'Required Core (subheader)', 'hours': '', 'is_header': True},
            ...
        ]},
        ...
    ],
    'warnings': [str, ...]               # issues worth surfacing in the UI
}

Supports `.docx` only. `.doc` must be converted upstream.
"""

import io
import re
import zipfile
from html import escape
from xml.etree import ElementTree as ET

NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
W = f'{{{NS["w"]}}}'

# Course code pattern: 2-5 uppercase letters, optional space or nbsp, 4 digits, optional suffix letter
COURSE_CODE_RE = re.compile(r'^([A-Z]{2,5})\s*(\d{4}[A-Z]?)\b')


def _paragraph_text_and_style(p):
    """Return (style_id, text) for a <w:p>."""
    style = ''
    ppr = p.find('w:pPr', NS)
    if ppr is not None:
        ps = ppr.find('w:pStyle', NS)
        if ps is not None:
            style = ps.get(f'{W}val', '')
    parts = []
    for t in p.iter(f'{W}t'):
        parts.append(t.text or '')
    return style, ''.join(parts).strip()


def _cell_text(cell):
    """Concatenate text of all paragraphs in a <w:tc>."""
    return ' '.join(_cell_paragraphs(cell)).strip()


def _cell_paragraphs(cell):
    """Return the list of non-empty paragraph texts in a <w:tc>."""
    lines = []
    for p in cell.findall('w:p', NS):
        _, t = _paragraph_text_and_style(p)
        if t:
            lines.append(t)
    return lines


def _normalize_code(text):
    """Normalize 'BIOT\xa05120' or 'BIOT 5120' to 'BIOT 5120' (with a regular space)."""
    return text.replace('\xa0', ' ').strip()


def _is_course_code(text):
    """Does this cell text look like a course code (e.g., 'BIOT 5120')?"""
    return bool(COURSE_CODE_RE.match(_normalize_code(text)))


def _looks_like_header_row(cells):
    """Caption/header row: ['Course List'] or ['Code', 'Title', 'Hours']."""
    if len(cells) == 1 and cells[0].lower() in ('course list', 'course lists'):
        return True
    if len(cells) >= 3:
        joined = ' '.join(c.lower() for c in cells[:3])
        if joined.startswith('code title hours') or joined.startswith('code course'):
            return True
    return False


def _parse_table(tbl):
    """Extract course rows from a single <w:tbl>.

    Returns a list of dicts, each either:
        {'is_header': True, 'text': 'Required Core'}
        {'is_header': False, 'code': 'BIOT 5120', 'title': '...', 'hours': '3'}
    """
    rows = []
    for tr in tbl.findall('w:tr', NS):
        tcs = tr.findall('w:tc', NS)
        if not tcs:
            continue
        cells = [_cell_text(tc) for tc in tcs]
        # Skip empty rows
        if not any(cells):
            continue
        # Skip caption/header rows
        if _looks_like_header_row(cells):
            continue

        # Special case: a single-cell row whose cell contains multiple distinct
        # paragraphs (e.g., a form row with "Pathway Options:", "Program Pathway",
        # campus list, etc.). Emit each paragraph as its own areaheader row so
        # labels like "Program Pathway" aren't buried in a run-on blob.
        has_other_content_raw = any(c.strip() for c in cells[1:])
        if not has_other_content_raw:
            paragraphs = _cell_paragraphs(tcs[0])
            if len(paragraphs) > 1:
                for para in paragraphs:
                    para_norm = _normalize_code(para)
                    if not para_norm:
                        continue
                    if _is_course_code(para_norm):
                        # Unlikely but defensible: a code split off onto its own
                        # paragraph would otherwise vanish
                        rows.append({
                            'is_header': False,
                            'code': para_norm,
                            'title': '',
                            'hours': '',
                        })
                    else:
                        rows.append({'is_header': True, 'text': para_norm})
                continue

        # Classify:
        # - Single non-empty cell (or first cell filled, rest empty): subheader
        # - First cell is a course code: course row with (code, title, hours)
        # - Otherwise: narrative text (treat as header/instruction row)
        code_cell = _normalize_code(cells[0]) if cells else ''
        has_other_content = any(c.strip() for c in cells[1:])

        if _is_course_code(code_cell):
            title = cells[1] if len(cells) > 1 else ''
            hours = cells[2] if len(cells) > 2 else ''
            rows.append({
                'is_header': False,
                'code': code_cell,
                'title': title,
                'hours': hours.strip(),
            })
        elif code_cell and not has_other_content:
            rows.append({'is_header': True, 'text': code_cell})
        elif code_cell and has_other_content:
            # Narrative text in first column with hours-total in last column:
            # e.g. ['Complete 2 semester hours from the Electives list below', '']
            # Treat as a header-row with the hours (if any) appended.
            hours = cells[-1].strip() if cells[-1].strip().isdigit() else ''
            text = code_cell
            if hours:
                text = f'{text} ({hours} hrs)'
            rows.append({'is_header': True, 'text': text})
    return rows


def _detect_title(body):
    """Scan for a likely program title near the start: a Heading3 before the first table."""
    for child in body:
        tag = child.tag.split('}')[-1]
        if tag == 'tbl':
            break
        if tag == 'p':
            style, text = _paragraph_text_and_style(child)
            if style.startswith('Heading') and text:
                # Prefer one that looks like "CODE : Name" or has a banner-code pattern
                if ':' in text or re.search(r'\b[A-Z]{2,5}-[A-Z0-9]+\b', text):
                    return text
    return ''


def _render_section_html(heading, rows):
    """Render a single section (heading + rows) to CourseLeaf-compatible HTML."""
    parts = []
    if heading:
        parts.append(f'<h2>{escape(heading)}</h2>')
    parts.append('<table class="sc_courselist">')
    parts.append('<thead>')
    parts.append('<tr class="hidden noscript"><th scope="col">Code</th>'
                 '<th scope="col">Title</th><th scope="col" class="hourscol">Hours</th></tr>')
    parts.append('</thead><tbody>')
    first = True
    for i, r in enumerate(rows):
        row_cls = 'even' if i % 2 == 0 else 'odd'
        if first:
            row_cls += ' firstrow'
            first = False
        if r.get('is_header'):
            parts.append(
                f'<tr class="{row_cls} nochange areaheader">'
                f'<td colspan="2"><span class="courselistcomment areaheader">{escape(r["text"])}</span></td>'
                f'<td class="hourscol"></td></tr>'
            )
        else:
            parts.append(
                f'<tr class="{row_cls} nochange">'
                f'<td class="codecol">{escape(r["code"])}</td>'
                f'<td>{escape(r["title"])}</td>'
                f'<td class="hourscol">{escape(r["hours"])}</td></tr>'
            )
    parts.append('</tbody></table>')
    return ''.join(parts)


def parse_docx(data):
    """Parse a .docx into structured curriculum data.

    Args:
        data: either bytes of the .docx file, or a filesystem path.

    Returns:
        dict with keys: title, curriculum_html, sections, warnings.
    """
    if isinstance(data, (bytes, bytearray)):
        z = zipfile.ZipFile(io.BytesIO(data))
    else:
        z = zipfile.ZipFile(data)

    warnings = []
    try:
        with z.open('word/document.xml') as f:
            tree = ET.parse(f)
    finally:
        z.close()

    body = tree.getroot().find('w:body', NS)
    if body is None:
        return {'title': '', 'curriculum_html': '', 'sections': [], 'warnings': ['No document body found']}

    title = _detect_title(body)

    # Walk the body in order. Track the most recent Heading2/Heading3 text; when we
    # hit a table, bind it to that heading. Tables produce sections in the output.
    # Also: certain structurally-significant plain paragraphs (like "Project Pathway",
    # "Program Pathway") act as section boundaries even without a heading style —
    # some umbrella docs leave them unstyled but they separate meaningful curriculum
    # chunks.
    PROMOTED_HEADINGS_RE = re.compile(
        r'^(project pathway|program pathway|plan of study|sample plan of study)\b', re.I
    )
    sections = []
    current_heading = None
    for child in body:
        tag = child.tag.split('}')[-1]
        if tag == 'p':
            style, text = _paragraph_text_and_style(child)
            if style in ('Heading2', 'Heading3') and text:
                current_heading = text
            elif text and PROMOTED_HEADINGS_RE.match(text.strip()):
                current_heading = text.strip()
        elif tag == 'tbl':
            rows = _parse_table(child)
            # Skip tables that have no course-code rows AND no meaningful header rows
            has_courses = any(not r.get('is_header') for r in rows)
            if not rows:
                continue
            sections.append({
                'heading': current_heading or '',
                'courses': rows,
                'has_courses': has_courses,
            })

    # Generate combined HTML
    html_parts = []
    for sec in sections:
        html_parts.append(_render_section_html(sec['heading'], sec['courses']))
    curriculum_html = '\n'.join(html_parts)

    # Warnings
    if not sections:
        warnings.append('No course tables found in this document.')
    else:
        total_courses = sum(1 for s in sections for r in s['courses'] if not r.get('is_header'))
        if total_courses == 0:
            warnings.append('Tables found but no course rows recognized. Check formatting.')

    # Flatten sections for preview (without internal has_courses flag)
    preview_sections = [
        {'heading': s['heading'], 'courses': s['courses']}
        for s in sections
    ]

    return {
        'title': title,
        'curriculum_html': curriculum_html,
        'sections': preview_sections,
        'warnings': warnings,
    }
