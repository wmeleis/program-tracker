#!/usr/bin/env python3
"""Registrar pre-check: flag likely Registrar's Office issues on a program proposal
BEFORE it moves through CIM workflow, using the rules in
data/reports/registrar_rules.json.

Two tiers:
  • auto / data rules  → evaluated deterministically here (real flags)
  • llm / human rules   → NOT evaluated (need a language-model read or human/
    calendar context); returned as a "review manually" checklist, with the
    program's overview + requirement headings extracted so a reviewer can eyeball.

`precheck_program(pid)` returns a dict consumed by /api/program/<id>/precheck and
the "Registrar Check" sub-tab.
"""
import os
import re
import json
import html
import sqlite3

import cim_http
import uip_correlate

_DIR = os.path.dirname(os.path.abspath(__file__))
_DB = os.path.join(_DIR, 'data', 'tracker.db')
_RULES_PATH = os.path.join(_DIR, 'data', 'reports', 'registrar_rules.json')

_VARIANT = re.compile(r'\b(align|bridge|connect)\b', re.I)  # allowed to exceed min hours


def _rules():
    try:
        with open(_RULES_PATH) as f:
            return {r['id']: r for r in json.load(f)['rules']}
    except Exception:
        return {}


def _strip(h):
    h = re.sub(r'<(script|style)[^>]*>.*?</\1>', ' ', h or '', flags=re.S | re.I)
    h = re.sub(r'<[^>]+>', ' ', h)
    return re.sub(r'\s+', ' ', html.unescape(h)).strip()


def _course_lists(html_body):
    """Return [[course_code, ...], ...] — one list per sc_courselist table."""
    out = []
    for block in re.split(r'<table[^>]*class="[^"]*sc_courselist', html_body)[1:]:
        block = block.split('</table>')[0]
        codes = re.findall(r'class="codecol[^"]*">(?:\s*<[^>]+>)*\s*([A-Z]{2,6}\s?\d{4}[A-Z]?)', block)
        out.append([c.strip() for c in codes])
    return out


def _overview(html_body):
    m = re.search(r'id="overviewcontentframediv4"[^>]*>(.*?)</div>\s*(?:<div|<h2|$)', html_body, re.S)
    if m:
        return _strip(m.group(1))[:1500]
    # fallback: prose before the first course list
    pre = re.split(r'<table[^>]*class="[^"]*sc_courselist', html_body)[0]
    m2 = re.search(r'>Overview<[^>]*>(.*)$', pre, re.S | re.I)
    return _strip(m2.group(1) if m2 else pre)[:1500]


def _headings(html_body):
    hs = re.findall(r'class="[^"]*areaheader[^"]*"[^>]*>(?:\s*<[^>]+>)*\s*([^<]{2,80})', html_body)
    hs += re.findall(r'<h[234][^>]*>\s*([^<]{2,80})</h[234]>', html_body)
    seen, out = set(), []
    for h in hs:
        t = re.sub(r'\s+', ' ', html.unescape(h)).strip()
        if t and t.lower() not in seen:
            seen.add(t.lower()); out.append(t)
    return out[:40]


def _term_expected_catalog(eff_term):
    """Only decide for FALL terms (unambiguous). Fall Y -> 'Y-(Y+1)'. Else None."""
    dec = uip_correlate._decode_term(eff_term or '')
    m = re.match(r'Fall (\d{4})', dec or '')
    if not m:
        return None
    y = int(m.group(1))
    return f"{y}-{y + 1}"


def precheck_program(pid, sess=None):
    rules = _rules()
    conn = sqlite3.connect(_DB); conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM programs WHERE id=?", (pid,)).fetchone()
    if not row:
        return {'error': f'program {pid} not found'}
    row = dict(row)
    name = row.get('name') or ''
    sess = sess or cim_http.CIMSession()
    live = sess.get(f"/programadmin/{pid}/")
    body = live or row.get('curriculum_html') or ''
    text = _strip(body)
    lists = _course_lists(body)
    all_codes = [c for lst in lists for c in lst]
    findings = []

    def flag(rid, msg, evidence=''):
        r = rules.get(rid, {})
        findings.append({'id': rid, 'theme': r.get('theme', ''), 'severity': r.get('severity', ''),
                         'method': r.get('check_method', ''), 'message': msg, 'evidence': evidence[:200]})

    # CAT-1 — catalog edition vs (Fall) effective term
    exp = _term_expected_catalog(row.get('eff_term'))
    eff_cat = (row.get('eff_cat') or '').strip()
    if exp and eff_cat and eff_cat != exp:
        flag('CAT-1', f"Effective catalog edition is {eff_cat} but the effective term "
             f"({uip_correlate._decode_term(row['eff_term'])}) implies {exp}.")

    # SH-4 — quarter hours
    if re.search(r'quarter hour|\bQH\b', text):
        m = re.search(r'.{0,40}(quarter hour|\bQH\b).{0,40}', text)
        flag('SH-4', "Curriculum references quarter hours (should be semester hours / SH).",
             m.group(0) if m else '')

    # SH-3 — "maximum of N (semester hours|SH|credits)"
    m = re.search(r'maximum of\s+\d+\s*(?:semester hours?|SH|credits?)', text, re.I)
    if m:
        flag('SH-3', "States a maximum number of hours (catalog publishes only the minimum).", m.group(0))

    # SH-1 / SH-7 — a credit RANGE in a program-total / requirement context (not Align/Bridge/Connect)
    if not _VARIANT.search(name):
        rng = None
        for pat in (r'Overall credits[^.]{0,80}?(\d+\s*[–-]\s*\d+)',
                    r'(\d+\s*[–-]\s*\d+)\s*(?:SH|semester hours?)\b(?![^<]*course)',
                    r'Complete\s+(\d+\s*[–-]\s*\d+)\s*(?:SH|semester hours?)'):
            mm = re.search(pat, text, re.I)
            if mm:
                rng = mm.group(0); break
        if rng:
            flag('SH-1', "A credit-hour range appears where the catalog expects a single minimum.", rng)

    # STRUCT-5 — core subtotal
    if re.search(r'\bsubtotal\b', text, re.I):
        flag('STRUCT-5', "A subtotal appears in the requirements (removed per current catalog practice).")

    # HYG-2 / ROUTE-3 — inactive / not-yet-approved courses
    n_err = len(re.findall(r'Course Not Found', body)) + len(re.findall(r'structuredcontenterror', body))
    if n_err:
        flag('HYG-2', f"{n_err} course(s) show a 'Course Not Found' / inactive (red-box) error — "
             f"resolve, or (if pending) they clear once approved by UGCC.")

    # HYG-1 — a course appearing more than once in one list. Note: repeatable
    # "Special Topics" courses legitimately recur, so this is a verify-flag, not
    # a hard duplicate.
    for lst in lists:
        dupes = sorted({c for c in lst if lst.count(c) > 1})
        if dupes:
            flag('HYG-1', f"Course(s) appear more than once in one requirement list: "
                 f"{', '.join(dupes)} — confirm intended (e.g., repeatable Special Topics) "
                 f"or remove the accidental duplicate.")
            break

    # SETUP-1 — single-course certificate
    if re.search(r'certificate', name, re.I) and len(set(all_codes)) <= 1:
        flag('SETUP-1', f"This certificate lists {len(set(all_codes))} distinct course(s) — "
             f"certificates normally comprise multiple courses/modules.")

    # TITLE-2 — minor with a campus parenthetical
    paren = re.search(r'\(([^)]+)\)\s*$', name)
    CAMPI = {'boston', 'oakland', 'portland', 'toronto', 'seattle', 'miami', 'arlington',
             'vancouver', 'charlotte', 'london', 'silicon valley', 'new york'}
    if re.search(r'\bminor\b', name, re.I) and paren and paren.group(1).strip().lower() in CAMPI:
        flag('TITLE-2', f"Minor carries a campus parenthetical \"({paren.group(1)})\" — minors don't.")

    # TITLE-1 — specific PHYSICAL non-Boston campus but no campus in the title.
    # Online/virtual (VTL/ONL/Online) is governed by the online-naming rules, not
    # the campus-parenthetical rule, so don't flag it here.
    camp = (row.get('campus') or '').strip()
    if (camp and camp.lower() not in ('', 'boston', 'bos', 'vtl', 'onl', 'online')
            and not paren):
        flag('TITLE-1', f"Campus-specific record (campus={camp}) has no \"(Campus)\" in the full title.")

    # ---- review checklist: llm / human / not-auto-implemented rules ----
    AUTO_DONE = {'CAT-1', 'SH-4', 'SH-3', 'SH-1', 'SH-7', 'STRUCT-5', 'HYG-2', 'ROUTE-3',
                 'HYG-1', 'SETUP-1', 'TITLE-2', 'TITLE-1'}
    review = [{'id': r['id'], 'theme': r['theme'], 'severity': r['severity'],
               'method': r.get('check_method', ''), 'rule': r['rule']}
              for r in rules.values()
              if r['id'] not in AUTO_DONE and r.get('check_method') in ('llm', 'data', 'human')]
    review.sort(key=lambda r: (r['method'], r['id']))

    return {
        'program_id': pid, 'name': name, 'current_step': row.get('current_step') or '',
        'campus': camp, 'eff_term': row.get('eff_term') or '', 'eff_cat': eff_cat,
        'findings': findings,
        'n_findings': len(findings),
        'review': review,
        'extracts': {'overview': _overview(body), 'headings': _headings(body)},
        'source': 'live' if live else ('cache' if body else 'none'),
    }


if __name__ == '__main__':
    import sys
    sess = cim_http.CIMSession()
    for pid in [int(x) for x in sys.argv[1:]]:
        r = precheck_program(pid, sess)
        print(f"\n=== {pid} {r.get('name','')} @ {r.get('current_step','')} ===")
        for f in r['findings']:
            print(f"  [{f['severity']:8} {f['id']:8}] {f['message']}  {('· '+f['evidence']) if f['evidence'] else ''}")
        if not r['findings']:
            print("  (no deterministic flags)")
        print(f"  + {len(r['review'])} rules to review manually")
