"""Generate a clean, standardized Word (.docx) document from a parsed
reference curriculum.

The custom_references table stores each uploaded reference as `sections_json`
(produced by docx_parser / pdf_parser) — a list of:

    {"heading": "<section name>",
     "courses": [
        {"is_header": true,  "text": "<sub-header>"},
        {"is_header": false, "code": "BINF 6200", "title": "...", "hours": "4"},
        ...
     ]}

This module renders that structure into a consistently formatted .docx:
a document title, each section as a Heading, and a 3-column course table
(Course / Title / Hours) with sub-headers shown as bold full-width rows.
The output is intentionally uniform across references regardless of how
messy the original upload was — that's the "standard, organized format".
"""

import re
from io import BytesIO

from docx import Document
from docx.shared import Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH

# CourseLeaf wrapper headings that carry no real meaning — they label the whole
# curriculum block, not a distinct section, and the source docs repeat them.
# Dropped from the output (the courses underneath still render).
_BOILERPLATE_HEADINGS = {
    'catalog presentation of this program',
}


def _norm_heading(h):
    return re.sub(r'\s+', ' ', (h or '').replace('\xa0', ' ')).strip()


def _course_sig(courses):
    """Signature of a section's course rows (code+title), for de-duplication."""
    return tuple(
        ((c.get('code') or '').strip().lower(), (c.get('title') or '').strip().lower())
        for c in (courses or []) if not c.get('is_header')
    )


def _set_cell_text(cell, text, bold=False):
    cell.text = ''
    para = cell.paragraphs[0]
    run = para.add_run(text or '')
    run.bold = bold
    run.font.size = Pt(10)


def build_reference_docx(name, sections, notes='', title=''):
    """Return .docx bytes for a parsed reference curriculum.

    `sections` is the decoded sections_json list. `name`/`title` head the
    document; `notes` (if any) appear under the title.
    """
    doc = Document()

    # Document title
    heading_text = (title or name or 'Reference Curriculum').strip()
    h = doc.add_heading(heading_text, level=0)
    h.alignment = WD_ALIGN_PARAGRAPH.LEFT

    if notes:
        p = doc.add_paragraph()
        run = p.add_run(notes.strip())
        run.italic = True
        run.font.size = Pt(10)
        run.font.color.rgb = RGBColor(0x55, 0x55, 0x55)

    seen_sigs = set()        # (heading_lower, course_sig) already rendered → drop exact dups
    prev_heading_lower = None  # suppress a heading that just repeats the one above
    for section in (sections or []):
        sec_heading = _norm_heading(section.get('heading'))
        courses = section.get('courses') or []
        heading_lower = sec_heading.lower()
        sig = _course_sig(courses)

        # Drop a section that exactly repeats an earlier one (same heading +
        # identical course list) — e.g. CGT's duplicated "Program Credit/GPA
        # Requirements" modality tables.
        if (heading_lower, sig) in seen_sigs and sig:
            continue
        seen_sigs.add((heading_lower, sig))

        # Show the heading unless it's boilerplate or it just repeats the
        # heading immediately above (a near-duplicate variant of the same
        # section). The courses still render either way.
        show_heading = bool(sec_heading) \
            and heading_lower not in _BOILERPLATE_HEADINGS \
            and heading_lower != prev_heading_lower
        prev_heading_lower = heading_lower
        if show_heading:
            doc.add_heading(sec_heading, level=2)
        if not courses:
            continue

        table = doc.add_table(rows=1, cols=3)
        table.style = 'Table Grid'
        hdr = table.rows[0].cells
        _set_cell_text(hdr[0], 'Course', bold=True)
        _set_cell_text(hdr[1], 'Title', bold=True)
        _set_cell_text(hdr[2], 'Hours', bold=True)

        for c in courses:
            if c.get('is_header'):
                row = table.add_row().cells
                # Sub-header: merge the three cells into one bold full-width row.
                merged = row[0].merge(row[1]).merge(row[2])
                _set_cell_text(merged, (c.get('text') or '').strip(), bold=True)
            else:
                row = table.add_row().cells
                _set_cell_text(row[0], (c.get('code') or '').strip())
                _set_cell_text(row[1], (c.get('title') or '').strip())
                _set_cell_text(row[2], (c.get('hours') or '').strip())

    buf = BytesIO()
    doc.save(buf)
    return buf.getvalue()
