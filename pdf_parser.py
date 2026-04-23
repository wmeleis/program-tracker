"""Parse curriculum content from a .pdf file.

Uses pdfplumber to extract tables + text from text-based PDFs. Output matches
the docx_parser format so the same rendering/diff pipeline works.

Text between tables with bold/larger font or standalone short lines is treated
as a section heading. Every 3+ column table is treated as a course list if its
first column has course-code-shaped entries.
"""

import io
import re
from html import escape

import pdfplumber

# Course code pattern: 2-5 uppercase letters, optional space/nbsp, 4 digits
COURSE_CODE_RE = re.compile(r'^([A-Z]{2,5})\s*(\d{4}[A-Z]?)\b')
OR_COURSE_CODE_RE = re.compile(r'^or\s+([A-Z]{2,5}\s*\d{4}[A-Z]?)\b(.*)$', re.I)


def _normalize(s):
    return (s or '').replace('\xa0', ' ').strip()


def _is_course_code(text):
    return bool(COURSE_CODE_RE.match(_normalize(text)))


def _looks_like_header_row(cells):
    if len(cells) == 1 and cells[0].lower() in ('course list', 'course lists'):
        return True
    if len(cells) >= 3:
        joined = ' '.join(c.lower() for c in cells[:3])
        if joined.startswith('code title hours') or joined.startswith('code course'):
            return True
    return False


def _parse_table(table):
    """Convert a pdfplumber table (list of rows; each row is list of cell strings) into
    our canonical row list. Same shape as docx_parser._parse_table output.
    """
    rows = []
    for raw_row in table:
        cells = [_normalize(c) for c in (raw_row or [])]
        if not any(cells):
            continue
        if _looks_like_header_row(cells):
            continue

        code_cell = cells[0] if cells else ''
        has_other_content = any(c for c in cells[1:])

        if _is_course_code(code_cell):
            title = cells[1] if len(cells) > 1 else ''
            hours = cells[2] if len(cells) > 2 else ''
            rows.append({
                'is_header': False,
                'code': code_cell,
                'title': title,
                'hours': hours.strip(),
            })
        elif (m := OR_COURSE_CODE_RE.match(code_cell)):
            code = _normalize(m.group(1))
            rest = m.group(2).strip()
            title = cells[1] if len(cells) > 1 and cells[1].strip() else rest
            hours = cells[2] if len(cells) > 2 else ''
            rows.append({
                'is_header': False,
                'code': f'or {code}',
                'title': title,
                'hours': hours.strip(),
            })
        elif code_cell and not has_other_content:
            rows.append({'is_header': True, 'text': code_cell})
        elif code_cell and has_other_content:
            hours = cells[-1].strip() if cells[-1].strip().isdigit() else ''
            text = code_cell
            if hours:
                text = f'{text} ({hours} hrs)'
            rows.append({'is_header': True, 'text': text})
    return rows


_HEADING_STOPWORDS = {'page', 'continued', 'printed on'}


def _looks_like_heading(line):
    """Best-effort heading detection from a single line of page text."""
    s = line.strip()
    if not s or len(s) > 120:
        return False
    if s.lower() in _HEADING_STOPWORDS:
        return False
    if any(s.lower().startswith(w) for w in _HEADING_STOPWORDS):
        return False
    # Course codes are not headings
    if _is_course_code(s):
        return False
    # Numbers, dates, credit-hour hints generally aren't headings
    if re.match(r'^[\d\s\W]+$', s):
        return False
    # Common curriculum headings
    heading_markers = [
        'core requirements', 'core courses', 'required courses', 'electives',
        'restricted electives', 'program requirements', 'concentration',
        'catalog presentation', 'optional co-op', 'program credit', 'gpa',
        'overview', 'sample plan', 'plan of study',
    ]
    lower = s.lower()
    if any(m in lower for m in heading_markers):
        return True
    # Short Title-Case lines (like "Biotechnology Operations Concentration")
    words = s.split()
    if 1 < len(words) <= 12 and all(w[:1].isupper() or not w[:1].isalpha() for w in words):
        return True
    return False


def _render_section_html(heading, rows):
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


def _flush_text_rows(sections, rows):
    """Append text-fallback course rows as a new section, grouping consecutive
    rows that share the same _section label."""
    if not rows:
        return
    current = None
    for r in rows:
        sec = r.pop('_section', '') or ''
        if current is None or current['heading'] != sec:
            current = {'heading': sec, 'courses': []}
            sections.append(current)
        current['courses'].append(r)


def parse_pdf(data):
    """Parse a .pdf into structured curriculum data.

    Args:
        data: bytes of the PDF file, or a filesystem path.

    Returns:
        dict with: title, curriculum_html, sections, warnings (same shape as docx_parser).
    """
    if isinstance(data, (bytes, bytearray)):
        pdf_input = io.BytesIO(data)
    else:
        pdf_input = data

    warnings = []
    sections = []
    title = ''

    with pdfplumber.open(pdf_input) as pdf:
        # Walk pages in order. For each page: extract tables, and extract text lines
        # that fall *between* tables to use as candidate section headings.
        for page_num, page in enumerate(pdf.pages):
            # Find tables and their bounding boxes so we can associate text between them
            try:
                table_objs = page.find_tables()
            except Exception as e:
                warnings.append(f'Page {page_num+1}: table extraction failed ({e})')
                continue

            # Extract page text as lines (each line is a dict with top/bottom y and text)
            try:
                words = page.extract_words() or []
            except Exception:
                words = []

            # Group words into lines by their 'top' y-coordinate (within ~2px tolerance)
            line_map = {}
            for w in words:
                top = round(w.get('top', 0) / 2) * 2
                line_map.setdefault(top, []).append(w)
            lines = []
            for top, ws in sorted(line_map.items()):
                ws_sorted = sorted(ws, key=lambda x: x.get('x0', 0))
                text = ' '.join(w.get('text', '') for w in ws_sorted).strip()
                if text:
                    lines.append({'top': top, 'bottom': top + 10, 'text': text})

            # Sort tables by vertical position
            table_objs_sorted = sorted(
                table_objs, key=lambda t: t.bbox[1] if t.bbox else 0
            )
            table_tops = [t.bbox[1] if t.bbox else 0 for t in table_objs_sorted]

            current_heading = sections[-1]['heading'] if sections else ''

            def find_heading_above(target_top, min_top=None):
                """Find the nearest heading-like line above `target_top` (and above min_top if given)."""
                candidates = [
                    l for l in lines
                    if l['bottom'] < target_top
                    and (min_top is None or l['top'] >= min_top)
                    and _looks_like_heading(l['text'])
                ]
                if candidates:
                    return candidates[-1]['text']
                return None

            # Detect a candidate title from the first page if we don't have one yet
            if page_num == 0 and not title:
                for l in lines[:5]:
                    t = l['text']
                    if ':' in t or re.search(r'\b[A-Z]{2,5}-[A-Z0-9]+\b', t):
                        title = t
                        break

            # Walk tables in order, binding each to its nearest heading above
            prev_bottom = 0
            table_bboxes = []
            for i, tbl in enumerate(table_objs_sorted):
                bbox_top = tbl.bbox[1] if tbl.bbox else 0
                heading = find_heading_above(bbox_top, min_top=prev_bottom) or current_heading

                try:
                    table_data = tbl.extract()
                except Exception as e:
                    warnings.append(f'Page {page_num+1} table {i+1}: extract failed ({e})')
                    continue

                rows = _parse_table(table_data or [])
                if not rows:
                    continue

                sections.append({
                    'heading': heading or '',
                    'courses': rows,
                })
                current_heading = heading or current_heading
                if tbl.bbox:
                    table_bboxes.append(tbl.bbox)
                    prev_bottom = tbl.bbox[3]

            # Text-line fallback: courses that aren't inside any detected table.
            # PDFs sometimes render elective lists as plain text ("BIOL 6131 CRISPR:
            # Gene Editing Fundamentals" one per line) which find_tables() misses.
            # Walk lines; track the most recent heading-like line as current section
            # for any course lines we find outside table bboxes.
            def line_in_any_table(l):
                for bb in table_bboxes:
                    if bb[1] <= l['top'] and l['bottom'] <= bb[3]:
                        return True
                return False

            line_course_re = re.compile(r'^([A-Z]{2,5})\s+(\d{4}[A-Z]?)\s+(.+)$')
            line_or_course_re = re.compile(r'^or\s+([A-Z]{2,5})\s+(\d{4}[A-Z]?)\s+(.+)$', re.I)

            text_section_heading = current_heading
            text_rows = []
            # Accumulate non-course lines as the pending heading; concatenate so
            # multi-line comments ("Complete a minimum of 5 semester hours from
            # the following to meet the 32 total / hours for the program:") end
            # up as one section label with the key elective-signaling phrases.
            pending_heading_parts = []

            def commit_pending():
                nonlocal text_section_heading, pending_heading_parts
                if pending_heading_parts:
                    text_section_heading = ' '.join(pending_heading_parts).strip()
                    pending_heading_parts = []

            for l in lines:
                if line_in_any_table(l):
                    continue
                txt = l['text'].strip()
                if not txt:
                    continue
                cm = line_course_re.match(txt) or line_or_course_re.match(txt)
                if cm:
                    commit_pending()
                    is_or = bool(line_or_course_re.match(txt))
                    code = f'{cm.group(1)} {cm.group(2)}'
                    if is_or:
                        code = f'or {code}'
                    title = cm.group(3).strip()
                    hrs_m = re.search(r'\s+(\d+(?:-\d+)?)\s*$', title)
                    hours = ''
                    if hrs_m:
                        hours = hrs_m.group(1)
                        title = title[:hrs_m.start()].strip()
                    text_rows.append({
                        'is_header': False, 'code': code, 'title': title, 'hours': hours,
                        '_section': text_section_heading,
                    })
                else:
                    # Flush any already-collected course rows so they stay with
                    # the previous heading, then start accumulating a new one.
                    if text_rows:
                        _flush_text_rows(sections, text_rows)
                        text_rows = []
                    if len(txt) > 3 and len(txt) < 250:
                        pending_heading_parts.append(txt)
            if text_rows:
                _flush_text_rows(sections, text_rows)

    html_parts = []
    for sec in sections:
        html_parts.append(_render_section_html(sec['heading'], sec['courses']))
    curriculum_html = '\n'.join(html_parts)

    if not sections:
        warnings.append('No course tables recognized. This may be a scanned or layout-heavy PDF.')
    else:
        total_courses = sum(1 for s in sections for r in s['courses'] if not r.get('is_header'))
        if total_courses == 0:
            warnings.append('Tables found but no course-code rows recognized.')

    return {
        'title': title,
        'curriculum_html': curriculum_html,
        'sections': sections,
        'warnings': warnings,
    }
