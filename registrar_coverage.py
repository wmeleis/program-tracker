#!/usr/bin/env python3
"""Measure what fraction of the Registrar's review COMMENTS the pre-check now
tracks. Classifies every Registrar comment in the corpus against the 74 rules
(via Claude), then buckets each by whether its rule is tracked (deterministic +
AI) or not.

  python3 registrar_coverage.py            # classify + report + write JSON
  python3 registrar_coverage.py --report   # re-report from the cached JSON only

Reads data/reports/registrar_comments_corpus.json (built by registrar_comments.py)
and data/reports/registrar_rules.json; writes data/reports/registrar_comment_coverage.json.
Needs an Anthropic API key (see precheck._api_key). Reports only aggregate counts.
"""
import os
import sys
import json
import collections

import precheck

_DIR = os.path.dirname(os.path.abspath(__file__))
_REPORTS = os.path.join(_DIR, 'data', 'reports')
_CORPUS = os.path.join(_REPORTS, 'registrar_comments_corpus.json')
_RULES = os.path.join(_REPORTS, 'registrar_rules.json')
_OUT = os.path.join(_REPORTS, 'registrar_comment_coverage.json')
_MODEL = 'claude-haiku-4-5'
_BATCH = 40


def _rule_sets():
    rules = {r['id']: r for r in json.load(open(_RULES))['rules']}
    ai = {r['id'] for r in precheck._ai_rules(rules)}
    tracked = set(precheck._AUTO_DONE) | ai
    return rules, tracked


def classify():
    import anthropic
    rules = {r['id']: r for r in json.load(open(_RULES))['rules']}
    corpus = json.load(open(_CORPUS))
    reg = [c for c in corpus['comments'] if c.get('registrar') is True]
    print(f'registrar comments to classify: {len(reg)}', flush=True)

    rules_block = "\n".join(f"{r['id']}: {r['rule']}" for r in rules.values())
    sysmsg = ("You label Northeastern Registrar's Office curriculum-review comments by which "
              "review RULE (if any) the comment is raising. Here are the rules:\n\n" + rules_block +
              "\n\nFor each comment, return the single best-matching rule ID, or \"NONE\" if the "
              "comment is procedural/administrative (an approval, a 'rolling forward', a thank-you, "
              "a routing note, a status update) or doesn't correspond to any rule. Be strict: only "
              "assign a rule when the comment is actually flagging that issue.")
    schema = {"type": "object", "properties": {"items": {"type": "array", "items": {
        "type": "object", "properties": {"i": {"type": "integer"}, "rule": {"type": "string"}},
        "required": ["i", "rule"], "additionalProperties": False}}},
        "required": ["items"], "additionalProperties": False}

    client = anthropic.Anthropic(api_key=precheck._api_key())
    labels = {}
    for start in range(0, len(reg), _BATCH):
        batch = reg[start:start + _BATCH]
        listing = "\n".join(f"[{start+j}] {(c.get('comment') or '')[:400]}"
                            for j, c in enumerate(batch))
        try:
            resp = client.messages.create(
                model=_MODEL, max_tokens=2000,
                system=[{"type": "text", "text": sysmsg, "cache_control": {"type": "ephemeral"}}],
                output_config={"format": {"type": "json_schema", "schema": schema}},
                messages=[{"role": "user", "content": "Classify these comments:\n" + listing}])
            raw = next((b.text for b in resp.content if b.type == "text"), '{}')
            for it in json.loads(raw).get('items', []):
                labels[it['i']] = it.get('rule', 'NONE')
        except Exception as e:
            print(f'batch {start} error: {e}', flush=True)
        print(f'  ...{min(start+_BATCH, len(reg))}/{len(reg)}', flush=True)

    counts = collections.Counter(labels.get(i, 'NONE') for i in range(len(reg)))
    json.dump({'n_registrar': len(reg), 'labels': labels, 'counts': dict(counts)},
              open(_OUT, 'w'), indent=0)
    return counts


def report(counts):
    rules, tracked = _rule_sets()
    total = sum(counts.values())
    subst = sum(v for k, v in counts.items() if k in rules)
    det = sum(v for k, v in counts.items() if k in precheck._AUTO_DONE)
    trk = sum(v for k, v in counts.items() if k in tracked)
    print('\n===== COVERAGE =====')
    print(f'total registrar comments: {total}')
    print(f'substantive (map to a rule): {subst} ({100*subst//max(1,total)}%)')
    print(f'  deterministic: {det}')
    print(f'  tracked (deterministic + AI): {trk} = {100*trk//max(1,subst)}% of substantive, '
          f'{100*trk//max(1,total)}% of all')
    print('\nTop rules by comment volume:')
    for rid, n in counts.most_common(20):
        if rid == 'NONE' or rid not in rules:
            continue
        tag = 'TRACKED' if rid in tracked else 'manual '
        print(f'  {n:4}  [{tag}] {rid:9} {rules[rid]["rule"][:66]}')


if __name__ == '__main__':
    if '--report' in sys.argv:
        counts = collections.Counter(json.load(open(_OUT))['counts'])
    else:
        counts = classify()
    report(counts)
