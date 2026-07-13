#!/usr/bin/env python3
"""Registrar pre-check: flag likely Registrar's Office issues on a program proposal
BEFORE it moves through CIM workflow, using the rules in
data/reports/registrar_rules.json.

Three tiers:
  • auto / data rules  → evaluated deterministically here (real flags)
  • llm rules           → evaluated by Claude on demand (`precheck_llm`), when an
    Anthropic API key is configured; returns per-rule verdicts.
  • human rules         → NOT evaluated (need human / calendar context); returned
    as a "review manually" checklist, with the program's overview + requirement
    headings extracted so a reviewer can eyeball.

`precheck_program(pid)` returns the deterministic pass (consumed by
/api/program/<id>/precheck); `precheck_llm(pid)` runs the LLM pass (consumed by
/api/program/<id>/precheck_llm). Both feed the "Registrar Check" sub-tab.

API key: the LLM tier reads ANTHROPIC_API_KEY from the environment, or (if that's
unset) a gitignored `data/anthropic_api_key` file. The secret is supplied by the
operator and never committed; if neither is present the LLM tier reports
{available: False} and the deterministic pass is unaffected.
"""
import os
import re
import json
import html
import hashlib
import sqlite3

import cim_http
import uip_correlate

_DIR = os.path.dirname(os.path.abspath(__file__))
_DB = os.path.join(_DIR, 'data', 'tracker.db')
_RULES_PATH = os.path.join(_DIR, 'data', 'reports', 'registrar_rules.json')
_KEY_FILE = os.path.join(_DIR, 'data', 'anthropic_api_key')

# Starting with Haiku 4.5 (cheapest current model, ~1¢/review) to gauge quality;
# swap to claude-opus-4-8 here for higher-fidelity judgment reads if needed.
_LLM_MODEL = 'claude-haiku-4-5'

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


# ---------------------------------------------------------------------------
# LLM tier — judgment rules (check_method == 'llm')
# ---------------------------------------------------------------------------

def _api_key():
    """Operator-supplied key: env first, then a gitignored file. None if absent.
    The value is never logged and never leaves this process."""
    k = os.environ.get('ANTHROPIC_API_KEY')
    if k and k.strip():
        return k.strip()
    try:
        with open(_KEY_FILE) as f:
            k = f.read().strip()
            return k or None
    except Exception:
        return None


def _llm_rules(rules):
    return [r for r in rules.values() if r.get('check_method') == 'llm']


def _ensure_cache_table(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS precheck_llm_cache (
        program_id INTEGER PRIMARY KEY,
        content_hash TEXT, model TEXT, result_json TEXT, evaluated_at TEXT)""")


def _fingerprint(model, overview, headings, lists, rule_ids):
    """Content hash: re-run only when the program text, model, or rule set changes."""
    payload = json.dumps({
        'm': model, 'o': overview, 'h': headings, 'l': lists, 'r': sorted(rule_ids),
    }, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


def precheck_llm(pid, sess=None, force=False):
    """Evaluate the judgment (check_method='llm') rules against a program's
    overview + requirement structure using Claude. Cached per program+content;
    returns {available, ...}. Never raises for a missing key — reports it."""
    import datetime
    rules = _rules()
    llm_rules = _llm_rules(rules)
    conn = sqlite3.connect(_DB); conn.row_factory = sqlite3.Row
    _ensure_cache_table(conn)
    row = conn.execute("SELECT * FROM programs WHERE id=?", (pid,)).fetchone()
    if not row:
        return {'available': False, 'reason': f'program {pid} not found'}
    row = dict(row)
    name = row.get('name') or ''

    key = _api_key()
    if not key:
        return {'available': False, 'model': _LLM_MODEL,
                'reason': 'No Anthropic API key configured. Set ANTHROPIC_API_KEY '
                          'in the server environment, or place the key in '
                          'data/anthropic_api_key, then restart.'}

    sess = sess or cim_http.CIMSession()
    live = sess.get(f"/programadmin/{pid}/")
    body = live or row.get('curriculum_html') or ''
    if not body:
        return {'available': False, 'model': _LLM_MODEL,
                'reason': 'No curriculum content available for this program.'}
    overview = _overview(body)
    headings = _headings(body)
    lists = _course_lists(body)
    fp = _fingerprint(_LLM_MODEL, overview, headings, lists, [r['id'] for r in llm_rules])

    if not force:
        c = conn.execute("SELECT content_hash, model, result_json, evaluated_at "
                         "FROM precheck_llm_cache WHERE program_id=?", (pid,)).fetchone()
        if c and c['content_hash'] == fp and c['model'] == _LLM_MODEL:
            cached = json.loads(c['result_json'])
            cached.update({'available': True, 'cached': True,
                           'model': _LLM_MODEL, 'evaluated_at': c['evaluated_at']})
            return cached

    # Build the request. One compact instruction; the model returns a verdict per rule.
    rules_block = "\n".join(
        f"- {r['id']} ({r['severity']}, {r['theme']}): {r['rule']} — CHECK: {r.get('check','')}"
        for r in llm_rules)
    lists_txt = "\n".join(f"  list {i+1}: {', '.join(lst) or '(empty)'}"
                          for i, lst in enumerate(lists)) or "  (none)"
    user = (
        "You are a Northeastern University Registrar's Office reviewer checking a graduate "
        "program proposal against the Registrar's curriculum-review rules. For EACH rule, "
        "decide whether the proposal, as described below, appears to VIOLATE it.\n\n"
        f"PROGRAM: {name}\n"
        f"CAMPUS: {row.get('campus') or '(none)'}\n\n"
        f"OVERVIEW TEXT:\n{overview or '(none)'}\n\n"
        f"REQUIREMENT HEADINGS:\n{' | '.join(headings) or '(none)'}\n\n"
        f"COURSE LISTS (by requirement table):\n{lists_txt}\n\n"
        "RULES TO CHECK:\n" + rules_block + "\n\n"
        "For each rule id, return a verdict:\n"
        "  \"flag\"    — the proposal appears to violate the rule (explain what to fix)\n"
        "  \"ok\"      — the rule applies and appears satisfied\n"
        "  \"na\"      — the rule does not apply to this program\n"
        "  \"unclear\" — cannot tell from the text provided (say what's missing)\n"
        "Only the overview, headings, and course lists above are available to you — do not "
        "assume fields you cannot see. Be conservative: prefer \"unclear\"/\"na\" over a "
        "false \"flag\". Keep each reason to one sentence.")

    schema = {
        "type": "object",
        "properties": {
            "findings": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "verdict": {"type": "string", "enum": ["flag", "ok", "na", "unclear"]},
                        "reason": {"type": "string"},
                    },
                    "required": ["id", "verdict", "reason"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["findings"],
        "additionalProperties": False,
    }

    import anthropic
    client = anthropic.Anthropic(api_key=key)
    try:
        resp = client.messages.create(
            model=_LLM_MODEL, max_tokens=4096,
            output_config={"format": {"type": "json_schema", "schema": schema}},
            messages=[{"role": "user", "content": user}],
        )
        raw = next((b.text for b in resp.content if b.type == "text"), "{}")
    except Exception:
        # Fallback: no structured-output support — ask for JSON in the prompt.
        try:
            resp = client.messages.create(
                model=_LLM_MODEL, max_tokens=4096,
                messages=[{"role": "user", "content": user +
                           "\n\nReturn ONLY a JSON object: "
                           '{"findings":[{"id","verdict","reason"}, ...]}'}],
            )
            raw = next((b.text for b in resp.content if b.type == "text"), "{}")
            m = re.search(r'\{.*\}', raw, re.S)
            raw = m.group(0) if m else "{}"
        except Exception as e:
            return {'available': False, 'model': _LLM_MODEL,
                    'reason': f'LLM request failed: {e}'}

    try:
        parsed = json.loads(raw).get('findings', [])
    except Exception:
        parsed = []

    by_id = {p.get('id'): p for p in parsed if isinstance(p, dict)}
    out_findings = []
    for r in llm_rules:
        p = by_id.get(r['id'], {})
        out_findings.append({
            'id': r['id'], 'theme': r['theme'], 'severity': r['severity'],
            'rule': r['rule'],
            'verdict': p.get('verdict', 'unclear'),
            'reason': (p.get('reason') or '').strip(),
        })
    # Sort so flags surface first, then unclear, then ok/na.
    order = {'flag': 0, 'unclear': 1, 'ok': 2, 'na': 3}
    out_findings.sort(key=lambda f: (order.get(f['verdict'], 4), f['id']))

    result = {
        'program_id': pid, 'name': name,
        'findings': out_findings,
        'n_flag': sum(1 for f in out_findings if f['verdict'] == 'flag'),
        'source': 'live' if live else 'cache',
    }
    now = datetime.datetime.now().astimezone().isoformat()
    conn.execute("INSERT INTO precheck_llm_cache (program_id, content_hash, model, "
                 "result_json, evaluated_at) VALUES (?,?,?,?,?) "
                 "ON CONFLICT(program_id) DO UPDATE SET content_hash=excluded.content_hash, "
                 "model=excluded.model, result_json=excluded.result_json, "
                 "evaluated_at=excluded.evaluated_at",
                 (pid, fp, _LLM_MODEL, json.dumps(result), now))
    conn.commit(); conn.close()
    result.update({'available': True, 'cached': False, 'model': _LLM_MODEL, 'evaluated_at': now})
    return result


if __name__ == '__main__':
    import sys
    args = [a for a in sys.argv[1:] if a != '--llm']
    run_llm = '--llm' in sys.argv
    sess = cim_http.CIMSession()
    for pid in [int(x) for x in args]:
        r = precheck_program(pid, sess)
        print(f"\n=== {pid} {r.get('name','')} @ {r.get('current_step','')} ===")
        for f in r['findings']:
            print(f"  [{f['severity']:8} {f['id']:8}] {f['message']}  {('· '+f['evidence']) if f['evidence'] else ''}")
        if not r['findings']:
            print("  (no deterministic flags)")
        print(f"  + {len(r['review'])} rules to review manually")
        if run_llm:
            lr = precheck_llm(pid, sess, force=True)
            if not lr.get('available'):
                print(f"  LLM tier unavailable: {lr.get('reason')}")
            else:
                print(f"  --- AI review ({lr['model']}, {lr['n_flag']} flag) ---")
                for f in lr['findings']:
                    print(f"    [{f['verdict']:7} {f['id']:8}] {f['reason']}")
