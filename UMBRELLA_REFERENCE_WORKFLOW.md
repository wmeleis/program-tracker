# Umbrella Program Reference Workflow

How to turn a Bouvé "umbrella" program proposal PDF into a clean, standardized
custom reference in the CIM Program Tracker. Working directory:
`~/committees/nu-docs/Curriculum/CIM`.

## Source

- **PDFs:** `~/committees/nu-docs/Curriculum/Network academics/Umbrella programs/Bouve/<BANNER>_ <Name>.pdf`
  (e.g. `MS-NURS_ Nursing, MS.pdf`).
- Read the **whole** PDF (Read tool, `pages` param).
- The `custom_references` row already exists (uploaded earlier and parsed
  badly). Match it by `name` / `source_filename`.
- **Build from the PDF, not the garbled stored parse.**

## Standardization rules (Waleed's preferences)

Confirmed across CGT, Physician Assistant, Health Informatics, Healthcare
Leadership, and Nursing:

1. **Curriculum only** — drop everything before **"Catalog Presentation of
   This Program"** (Department Contact, CIP code, Campus/Modality, Concentration
   metadata).
2. **No campus / modality designations** — remove `(Boston)`, `Modality: Online`,
   `(Primarily Online Only)`, `(Boston and Primarily Online)`, etc.
   *Exception:* keep a campus-specific **course** note if asked (e.g. Health
   Informatics' "Vancouver-Online takes HINF 5106 in place of HINF 5105").
   CGT was the one program where pathway labels (On-ground / Online /
   Primarily-Online) were explicitly wanted.
3. **No grade requirements** — strip "a grade of B– or higher", "minimum 3.000 GPA".
4. **Credit total at the bottom** (bold). If each concentration has its own
   total (e.g. Nursing, 41–52), put each total inside its block **and** a range
   line at the bottom.
5. Concentrations / pathways become separate **blocks**.

## Process

1. Build a **review `.docx`** at `~/Downloads/<Name> - Unified Reference.docx`,
   then `open` it.
2. Let Waleed review/refine (common iterations: remove grades, drop the
   subtitle/description, fix wording, fix credit totals).
3. **Store only when he says "upload" / "y".**

Build with `python-docx` using a `code → title` map and a sequence of helpers
(block / area / instruction / course rows). Keep the `or ` prefix on
alternative courses (e.g. `or EMGT 5220`).

## Storage (the actual "upload")

Render the **same `rows`** into both formats and update the existing reference
row. Always include explicit `level` tags on header rows.

```python
import docx_parser as dp, json, sqlite3

# rows are either:
#   {'is_header': True,  'text': '...', 'level': 'block'|'area'|'inst'|'total'}
#   {'is_header': False, 'code': '...', 'title': '...', 'hours': '...'}
#        (+ 'is_or_continuation': True for "or <course>" alternative rows)

html = dp._render_section_html('', rows)
sections = [{'heading': '', 'courses': rows}]

conn = sqlite3.connect('data/tracker.db')
conn.execute(
    'UPDATE custom_references SET curriculum_html=?, sections_json=? WHERE id=?',
    (html, json.dumps(sections), ref_id))
conn.commit()
```

## Download = the shareable doc (one source of truth)

`GET /api/custom_references/<id>/download` regenerates the `.docx` via
`reference_docx.build_reference_docx`, styling by the `level` field:

| level   | rendered as            |
|---------|------------------------|
| `block` | Heading 1              |
| `area`  | bold line              |
| `inst`  | italic line            |
| `total` | bold line at bottom    |
| course  | 3-column table row     |

This is the same content that drives the dashboard **Compare / Reference**
tabs, so clicking **Download** yields the shareable document. Parser-made
references that lack `level` tags fall back to heuristics
(`_INST_RE` / `_BLOCK_RE` in `reference_docx.py`).

## After storing

```bash
python3 export_static.py
python3 -c "import app; app._publish_docs_pages('/Users/wmeleis/committees/nu-docs/Curriculum/CIM')"
```
(The `curriculum_html` change affects the Compare tab and the static site.)

## If you edit `reference_docx.py`

The download runs in the local Flask server, which imports the module — **restart
the server** so it picks up changes (check no scan is running first):

```bash
curl -s http://localhost:5001/api/scan/status          # ensure running:false
lsof -ti :5001 | xargs kill
PYTHONUNBUFFERED=1 nohup python3 app.py > /tmp/cim_server.log 2>&1 &
```

## Wiring to deployments (only when explicitly asked)

"Upload" means store the reference only. To make the campus deployments use it,
set `programs.custom_reference_id = <ref_id>` for those program ids — but do
this **only when Waleed asks**.

## Done so far (Bouvé umbrella set)

| Program | ref id |
|---|---|
| Cell & Gene Therapies, MS | 38 |
| Physician Assistant, MS | 34 |
| Health Informatics, MS | 32 |
| Healthcare Leadership, DMSc | 31 |
| Nursing, MS | 33 |
