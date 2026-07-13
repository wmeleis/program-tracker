#!/usr/bin/env python3
"""Render the Registrar curriculum guide markdown into a simply-formatted PDF.

Usage: python3 guide_to_pdf.py [in.md] [out.pdf]
Defaults to data/reports/registrar_curriculum_guide.{md,pdf}. Handles the guide's
structure only: '# ' title, '## ' section headings, '**bold**'/'*italic*'/`code`
inline, '---' separators, and a leading italic blurb + trailing italic footer.
"""
import os, re, sys, html
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import SimpleDocTemplate, Paragraph, HRFlowable
from reportlab.lib.styles import ParagraphStyle

_DIR = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(_DIR, 'data/reports/registrar_curriculum_guide.md')
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(_DIR, 'data/reports/registrar_curriculum_guide.pdf')

# Glyphs absent from Helvetica/WinAnsi -> ASCII fallbacks.
_SAN = {'→': '->', '⟶': '->', '➔': '->'}


def _inline(t):
    for k, v in _SAN.items():
        t = t.replace(k, v)
    t = html.escape(t)
    t = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', t)
    t = re.sub(r'`(.+?)`', r'<font face="Courier">\1</font>', t)
    t = re.sub(r'(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)', r'<i>\1</i>', t)
    return t

_ACCENT, _INK, _MUTE, _TITLE = HexColor('#1d4ed8'), HexColor('#1f2937'), HexColor('#64748b'), HexColor('#0f172a')
_S = {
    'title': ParagraphStyle('t', fontName='Helvetica-Bold', fontSize=20, leading=24, textColor=_TITLE, spaceAfter=4),
    'muted': ParagraphStyle('m', fontName='Helvetica-Oblique', fontSize=9, leading=13, textColor=_MUTE, spaceAfter=8),
    'h2':    ParagraphStyle('h', fontName='Helvetica-Bold', fontSize=13, leading=16, textColor=_ACCENT, spaceBefore=15, spaceAfter=4, keepWithNext=True),
    'body':  ParagraphStyle('b', fontName='Helvetica', fontSize=10.5, leading=15, textColor=_INK, spaceAfter=7, alignment=TA_LEFT),
    'foot':  ParagraphStyle('f', fontName='Helvetica-Oblique', fontSize=8.5, leading=12, textColor=_MUTE, spaceBefore=6),
}


def build(src=SRC, out=OUT):
    flow, buf = [], []

    def flush():
        if not buf:
            return
        txt = ' '.join(buf).strip(); buf.clear()
        if not txt:
            return
        st = 'body'
        if txt.lstrip('*').startswith('Companion files'):
            st = 'foot'
        elif txt.startswith('*') and 'Derived' in txt:
            st = 'muted'
        flow.append(Paragraph(_inline(txt), _S[st]))

    for ln in open(src).read().split('\n'):
        s = ln.rstrip()
        if s.startswith('# '):
            flush(); flow.append(Paragraph(_inline(s[2:]), _S['title']))
        elif s.startswith('## '):
            flush(); flow.append(Paragraph(_inline(s[3:]), _S['h2']))
            flow.append(HRFlowable(width='100%', thickness=0.6, color=HexColor('#c7d2fe'), spaceBefore=1, spaceAfter=6))
        elif s.strip() in ('---', ''):
            flush()
        else:
            buf.append(s)
    flush()
    SimpleDocTemplate(out, pagesize=letter, leftMargin=0.85 * inch, rightMargin=0.85 * inch,
                      topMargin=0.8 * inch, bottomMargin=0.7 * inch,
                      title="Registrar's Office Curriculum Review Guide").build(flow)
    return out


if __name__ == '__main__':
    print('wrote', build(), os.path.getsize(OUT), 'bytes')
