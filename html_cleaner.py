"""Server-side mirror of static/app.js's cleanCurriculumHtml.

Applied to curriculum_html before sending to the client so the output is
already clean regardless of what JS runs in the browser. Handles:
 - Remove "Program Overview", "Milestone", "Research Areas" sections
   (heading + following content up to the next heading of any level).
 - Remove areaheader rows that end in "Focus / Track / Area / Group"
   (decorative grouping, not a curriculum choice). Keep rows that describe
   choices (Required, Core, Elective, Option, Pathway, Complete N, etc.).
 - Strip empty Course-Not-Found error elements and their rows.
 - Tag <h2>/<h3>/<h4> containing "Concentration" with class="ref-concentration".

Uses stdlib re — no lxml/bs4 dependency.
"""

import re

CHOICE_RE = re.compile(
    r'\b(required|core|elective|option|choose|complete\s*\d|\d+\s*semester|must|in consultation|any\s+\d|pathway)\b',
    re.I,
)
DECORATIVE_SUFFIX_RE = re.compile(r'\b(focus|track|area|group)s?\s*$', re.I)

LABELED_SECTIONS_TO_REMOVE = {
    'Program Overview',
    'Milestone',
    'Research Areas',
}

# Pattern-based section removal — any h2/h3 whose text matches one of these
# is a plan-of-study / schedule grid (visual calendar), not curriculum content.
PLAN_OF_STUDY_HEADING_RES = [
    re.compile(r'^\s*year\s+\d+\s*$', re.I),
    re.compile(r'^\s*concentration\s+in\s+', re.I),
    re.compile(r'^\s*(?:sample\s+)?plan\s+of\s+study\b', re.I),
    re.compile(r'^\s*\*', re.I),  # footnotes that h2-rendered from source
    # Proposal-form metadata that slips into PDF-parsed references
    re.compile(r'^\s*content\s*/\s*program\s+type\b', re.I),
    re.compile(r'^\s*department\s+(?:one|two|three)\b', re.I),
    re.compile(r'^\s*major\s+cip\s+code\b', re.I),
    re.compile(r'^\s*campus\s+and\s+modality\b', re.I),
]

# H2 headings that should be stripped (heading tag removed, following content
# preserved) — not full-section removal like PLAN_OF_STUDY_HEADING_RES.
STRIP_HEADING_ONLY_RES = [
    re.compile(r'^\s*code\s+title\s+hours\s*$', re.I),
]

# Proposal-form metadata lines (appear as areaheader spans or courselistcomment
# rows in PDF-parsed references). Match on text content of the row.
FORM_METADATA_RES = [
    re.compile(r"dean\(s\)\s+and\s+the\s+provost", re.I),
    re.compile(r'subject\s+code\s+associated\s+with\s+this\s+program', re.I),
    re.compile(r'should\s+this\s+program\s+be\s+published\s+in\s+the\s+catalog', re.I),
    re.compile(r'choose\s+one\s+campus', re.I),
    re.compile(r'where\s+will\s+this\s+program\s+be\s+offered', re.I),
    re.compile(r'^\s*modalities\s*:', re.I),
    re.compile(r'^\s*content\s*/\s*program\s+type\b', re.I),
    re.compile(r'^\s*campus\s+and\s+modality\s*$', re.I),
    re.compile(r'^\s*department\s+(?:one|two|three)\s*:', re.I),
    re.compile(r'^\s*major\s+cip\s+code\b', re.I),
]


def _strip_tags(s):
    return re.sub(r'<[^>]+>', '', s).strip()


def _remove_labeled_section(html, heading_text):
    """Remove <h[1-6]> whose trimmed text equals heading_text, plus everything
    after it up to the next heading of any level."""
    # Regex: capture the heading start, its content, and everything until the
    # next <hN> or end of string
    pattern = re.compile(
        r'<h([1-6])[^>]*>\s*' + re.escape(heading_text) + r'\s*</h\1>.*?(?=<h[1-6][\s>]|\Z)',
        re.I | re.DOTALL,
    )
    return pattern.sub('', html)


def _remove_plan_of_study_sections(html):
    """Remove h2/h3 sections whose heading matches a plan-of-study pattern,
    along with everything up to the next heading."""
    pattern = re.compile(
        r'<h([23])[^>]*>(.*?)</h\1>(.*?)(?=<h[1-6][\s>]|\Z)',
        re.I | re.DOTALL,
    )

    def sub_one(m):
        text = _strip_tags(m.group(2)).replace('\xa0', ' ').strip()
        for rx in PLAN_OF_STUDY_HEADING_RES:
            if rx.search(text):
                return ''
        return m.group(0)

    return pattern.sub(sub_one, html)


REDUNDANT_COURSE_INTRO_RE = re.compile(
    r'^complete\s+(?:the|a)\s+\d+\s+semester\s+hour.*?\bcourse\b',
    re.I,
)


def _remove_decorative_areaheader_rows(html):
    """Strip <tr class=\"...areaheader...\"> rows that are:
    - pure grouping labels ending in Focus/Track/Area/Group, OR
    - redundant preambles like "Complete the 3 Semester Hours Project Course"
      that are immediately followed by the course row anyway, OR
    - proposal-form metadata slurped in from a PDF source.
    """
    def should_remove(match):
        inner = match.group(0)
        text = _strip_tags(inner)
        if not text:
            return False
        for rx in FORM_METADATA_RES:
            if rx.search(text):
                return True
        if REDUNDANT_COURSE_INTRO_RE.match(text):
            return True
        if CHOICE_RE.search(text):
            return False
        return bool(DECORATIVE_SUFFIX_RE.search(text))

    # Match both areaheader and areasubheader rows. CourseLeaf uses
    # areasubheader for grouping labels like "Artificial Intelligence Focus".
    pattern = re.compile(
        r'<tr[^>]*\bareas?u?b?header\b[^>]*>.*?</tr>',
        re.DOTALL | re.I,
    )
    return pattern.sub(lambda m: '' if should_remove(m) else m.group(0), html)


def _remove_course_not_found(html):
    """Replace <span class="structuredcontenterror"...>TEXT</span> with plain TEXT
    (or em-dash if the text is "Course XXX Not Found")."""
    def sub_one(m):
        attrs, inner = m.group(1), m.group(2)
        text = _strip_tags(inner).replace('\u00a0', ' ').strip()
        if re.match(r'^Course\s+.+\s+Not Found$', text):
            return '&mdash;'
        return text

    pattern = re.compile(
        r'<span([^>]*\bstructuredcontenterror\b[^>]*)>(.*?)</span>',
        re.DOTALL | re.I,
    )
    return pattern.sub(sub_one, html)


def _tag_concentration_headings(html):
    """Add class="ref-concentration" to h2/h3/h4 whose text contains
    the word "concentration"."""
    def annotate(m):
        opening, text, closing = m.group(1), m.group(2), m.group(3)
        if not re.search(r'\bconcentration\b', _strip_tags(text), re.I):
            return m.group(0)
        # Add ref-concentration to the class attribute (preserving existing)
        if re.search(r'\bclass="[^"]*"', opening):
            opening = re.sub(
                r'class="([^"]*)"',
                lambda mm: f'class="{mm.group(1)} ref-concentration"',
                opening,
                count=1,
            )
        else:
            # Insert class attribute before the closing >
            opening = re.sub(r'>$', ' class="ref-concentration">', opening, count=1)
        return f'<{opening[1:]}{text}{closing}'

    pattern = re.compile(
        r'(<h[234][^>]*>)(.*?)(</h[234]>)',
        re.DOTALL | re.I,
    )
    return pattern.sub(annotate, html)


_TR_RE = re.compile(r'<tr\b[^>]*>.*?</tr>', re.DOTALL | re.I)
_CODECOL_RE = re.compile(
    r'<td[^>]*\bcodecol\b[^>]*>(?:<[^>]+>|\s)*(?:or\s+)?(?:<[^>]+>)*([A-Z]{2,5}\s*\d{4}[A-Z]?)',
    re.I,
)


def _sort_rows_within_sections(html):
    """Within each <tbody> of a course list, sort consecutive non-areaheader
    course rows alphabetically by their first codecol code. Areaheader rows act
    as group boundaries; sort runs reset on each header."""
    def sort_tbody(match):
        body = match.group(2)
        rows = _TR_RE.findall(body)
        if len(rows) < 2:
            return match.group(0)

        def sort_key(tr):
            # No key → treat as boundary (shouldn't happen because we filter first)
            m = _CODECOL_RE.search(tr)
            if not m:
                return ''
            code = re.sub(r'\s+', ' ', m.group(1).replace('\xa0', ' ')).strip().upper()
            return code

        out = []
        buffer = []

        def flush():
            if buffer:
                buffer.sort(key=sort_key)
                out.extend(buffer)
                buffer.clear()

        for tr in rows:
            is_areaheader = bool(re.search(r'\bareas?u?b?header\b', tr, re.I))
            has_code = bool(_CODECOL_RE.search(tr))
            if is_areaheader or not has_code:
                flush()
                out.append(tr)
            else:
                buffer.append(tr)
        flush()
        return f'{match.group(1)}{"".join(out)}{match.group(3)}'

    return re.sub(
        r'(<tbody\b[^>]*>)(.*?)(</tbody>)',
        sort_tbody,
        html,
        flags=re.DOTALL | re.I,
    )


def clean_curriculum_html(html):
    """Apply all cleanup steps. Safe to call on already-clean or empty input."""
    if not html:
        return html
    out = html
    # Labeled section removal
    for label in LABELED_SECTIONS_TO_REMOVE:
        out = _remove_labeled_section(out, label)
    # Plan-of-study section removal (Year N, Concentration in X, Plan of Study, footnotes)
    out = _remove_plan_of_study_sections(out)
    # Strip noise h2 headings (keep following content) — e.g., PDF column-header bleed
    def _strip_one(m):
        text = _strip_tags(m.group(3)).strip()
        for rx in STRIP_HEADING_ONLY_RES:
            if rx.search(text):
                return ''
        return m.group(0)
    out = re.sub(r'(<h([1-6])[^>]*>)(.*?)(</h\2>)', _strip_one, out, flags=re.DOTALL | re.I)
    # Sort course rows alphabetically within each areaheader-delimited group
    out = _sort_rows_within_sections(out)
    # Decorative areaheader row removal
    out = _remove_decorative_areaheader_rows(out)
    # Course-Not-Found cleanup
    out = _remove_course_not_found(out)
    # Concentration heading tagging
    out = _tag_concentration_headings(out)
    # Strip hidden / noscript / caption elements (mirror client behavior)
    out = re.sub(
        r'<(?:caption)[^>]*>.*?</(?:caption)>',
        '', out, flags=re.DOTALL | re.I,
    )
    out = re.sub(
        r'<tr[^>]*\b(?:hidden|noscript)\b[^>]*>.*?</tr>',
        '', out, flags=re.DOTALL | re.I,
    )
    return out
