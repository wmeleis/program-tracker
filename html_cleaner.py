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


def _remove_decorative_areaheader_rows(html):
    """Strip <tr class=\"...areaheader...\"> rows whose text ends in
    Focus/Track/Area/Group and isn't a choice-marker row."""
    def is_decorative(match):
        inner = match.group(0)
        text = _strip_tags(inner)
        if not text:
            return False
        if CHOICE_RE.search(text):
            return False
        return bool(DECORATIVE_SUFFIX_RE.search(text))

    # Match both areaheader and areasubheader rows. CourseLeaf uses
    # areasubheader for grouping labels like "Artificial Intelligence Focus".
    pattern = re.compile(
        r'<tr[^>]*\bareas?u?b?header\b[^>]*>.*?</tr>',
        re.DOTALL | re.I,
    )
    return pattern.sub(lambda m: '' if is_decorative(m) else m.group(0), html)


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


def clean_curriculum_html(html):
    """Apply all cleanup steps. Safe to call on already-clean or empty input."""
    if not html:
        return html
    out = html
    # Labeled section removal
    for label in LABELED_SECTIONS_TO_REMOVE:
        out = _remove_labeled_section(out, label)
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
