# Program Approval Tracker

## What This Is
A dashboard that tracks academic program approvals through Northeastern University's CourseLeaf CIM (Curriculum Information Management) system. It scrapes data from the CourseLeaf web interface via Chrome/AppleScript, stores it in SQLite, and displays it on a web dashboard deployed to GitHub Pages.

**Owner:** Waleed Meleis, Graduate Dean at Northeastern University
**Live site:** https://wmeleis.github.io/program-tracker
**Repo:** https://github.com/wmeleis/program-tracker (public)

## Architecture

```
Chrome (CourseLeaf session) <-- AppleScript/JS --> scraper.py
                                                      |
                                                      v
                                                  database.py (SQLite)
                                                      |
                                                      v
                                                   app.py (Flask :5001)
                                                      |
                                                      v
                                               export_static.py
                                                      |
                                                      v
                                               docs/ (GitHub Pages)
```

### Key Files

| File | Purpose |
|------|---------|
| `scraper.py` | Scrapes CourseLeaf via AppleScript executing JS in Chrome tabs. Two data sources: Approve Pages (role dropdown, matched by URL `courseleaf/approve`) for program discovery, and per-program XHR fetches (HTML + XML API) for workflow/metadata. |
| `database.py` | SQLite layer. Tables: `programs`, `workflow_steps`, `scan_history`, `scans`. Uses WAL mode. |
| `app.py` | Flask server on port 5001. REST API + background scanner thread (30 min). After each scan, auto-exports static site and pushes to GitHub. |
| `export_static.py` | Generates `docs/` directory: `data.json`, `index.html`, `app.js`, `style.css`. The static `app.js` overrides API calls to read from `data.json`. |
| `static/app.js` | Frontend: pipeline bar, filters (type/proposal/smart views/college/campus/approver/step/search), sortable table with expandable workflow detail rows. |
| `static/style.css` | Dashboard styling. Colored left borders: green=new, blue=change, red=inactivation. |
| `templates/dashboard.html` | HTML template used by both Flask and static export. |
| `update.sh` | Launched by launchd. Checks Chrome + session validity, starts Flask if needed, triggers scan, waits for completion. Sends macOS notifications. |

### Scheduled Execution
- **launchd agent:** `~/Library/LaunchAgents/com.programtracker.update.plist`
- **Schedule:** `StartCalendarInterval` at 2am, 7am, 11am, 3pm, 7pm ET (5 scans/day covering MA+CA working hours)
- **Runs:** `update.sh` which triggers scan via Flask API
- **Requirement:** Chrome must be open with valid CourseLeaf session

### How the Scraper Works

**Step 1 - Program Discovery (~3 min):** Iterates through 46 roles (14 tracked pipeline + 32 college) on the Approve Pages tab. For each role, selects it in the dropdown via `showPendingList()`, waits 2s, extracts program IDs and names from page text matching `/programadmin/(\d+):\s*(.+)/`.

**Step 2 - Batch Detail Fetch (~2-7 min):** Uses synchronous XHR (batches of 25) executed via AppleScript in the `programadmin` tab:
- Fetches each program's HTML page (`/programadmin/{id}/`) and parses the `#workflow` div for steps (name, status, approver emails)
- Fetches each program's XML API (`/programadmin/{id}/index.xml`) for metadata (college, department, degree, banner code, campus, proposal type)
- ~200ms per program vs ~5s with the old page-navigation approach

**Step 3 - Database Update:** Processes results, maps college codes to full names, detects changes (step transitions), preserves `step_entered_date` when step hasn't changed (to not reset the "days at step" timer), records scan.

**Validation:** After processing, re-checks the 14 tracked pipeline roles (not college roles) against live Approve Pages to verify counts match. Small deltas are expected if approvals happen during the scan.

### Tab Matching
- **Approve Pages tab:** Matched by URL containing `courseleaf/approve` (NOT by title - the title changes dynamically)
- **Program Management tab:** Matched by URL containing `programadmin`
- Both tabs must be open in Chrome window 1

### The 14 Pipeline Roles (in order)
1. PR Graduate Dean's Office
2. Provost Initial Review
3. Review 2
4. UIP College Approval
5. Graduate Provost Review
6. Graduate Curriculum Committee
7. Undergraduate Curriculum Committee - Tabled Proposals
8. Provost Administrative and Budgetary Review
9. Provost Approval
10. Faculty Senate
11. University Board of Trustees
12. Banner Setup
13. Editor
14. Catalog Setup

Plus "College" as a virtual first step in the pipeline bar (aggregates all 32 college-level roles).

### College Roles (32 total)
Department chairs, college deans, program directors. Identified by regex pattern: `^Program (AFCS|AM |AMSL|ARCH|ASNS|BA |CS |EDU|EECE|EN |ENGL|HIST|HUSV|MSCI|PPUA|PS |SC |SH )`.

### College Code Mapping
The XML API returns 2-letter college codes. The scraper maps these to full names via `COLLEGE_NAMES` dict:

| Code | Full Name |
|------|-----------|
| AM | Coll of Arts, Media & Design |
| BA | D'Amore-McKim School Business |
| BV | Bouve College of Hlth Sciences |
| CS | Khoury Coll of Comp Sciences |
| EN | College of Engineering |
| LW | School of Law |
| MI | Mills College at NU |
| PR | Office of the Provost |
| PS | Coll of Professional Studies |
| SC | College of Science |
| SH | Coll of Soc Sci & Humanities |

### Program Classification
- **Proposal type**: Determined from HTML page text AND XML. "New Program Proposal" -> "Added", "Inactivation Proposal" -> "Deactivated", else "Edited". XML `deletejustification` field non-empty forces "Inactivation Proposal" regardless of HTML.
- **Program title**: XML `programtitle` field overrides the name scraped from Approve Pages when available.
- **Academic level** (from name patterns): degree suffixes like MS/MA/PhD/MEd = Graduate, BS/BA/BFA/Minor = Undergraduate, else from workflow step names, else Other

### Dashboard UI
- **Pipeline bar:** College + 14 tracked roles with counts. Clickable to filter. Counts update dynamically based on active filters.
- **Button rows:** Type (All/Undergrad/Grad/Other) | Proposal (All/New/Changes/Inactivations) | Smart views (All/Recent Changes/Potentially Stuck/New Submissions)
- **Cross-filtering:** Each button group's counts exclude its own filter. E.g., when "Graduate" is active, proposal buttons show counts for all graduate programs (not further filtered by the current proposal selection). This lets you see what's available if you change that filter.
- **Filters:** College (dynamic, shows only colleges with matching programs + counts), Campus, Approver, Step, Search (searches name and banner code)
- **Table:** Program name, college (abbreviated via `COLLEGE_ABBREVS`), current step, progress bar, days at step. Sortable by all columns.
- **Expandable rows:** Click to see full workflow with approver emails (semicolon-separated, rendered as mailto links)
- **Colors:** Green left border = new program (Added), blue = change (Edited), red = inactivation (Deactivated)
- **Progress bar:** Red <33%, yellow 33-66%, green >66%
- **Days indicator:** Green <14d, yellow 14-30d, red ≥30d ("stuck")
- **Smart views:** Recent Changes = step_entered_date within 14 days; Potentially Stuck = 30+ days at step; New Submissions = date_submitted within 30 days

### Static Site (GitHub Pages)
`export_static.py` generates a password-gated static site in `docs/` using client-side AES-256-GCM encryption. All JSON data is encrypted; a password gate decrypts on the client via WebCrypto.

**Files in `docs/`:**
- `index.html` — dashboard markup (template-wrapped in `<div id="app-root" style="display:none">`), preceded by an inline password gate + gate script
- `app.js` — dashboard JS with static-mode overrides (built from `static/app.js`). Loaded dynamically by the gate after unlock, not referenced directly by `<script>` in the HTML
- `style.css` — copied from `static/style.css`
- `crypto.json` — `{salt, iterations, algorithm, kdf}`; public by design (salt is not a secret)
- `data.json.enc` — programs, courses, workflows, colleges, approvers, course pipeline (curriculum_html stripped out); decrypted on unlock
- `campus_groups.json.enc` — Boston↔deployment mappings; decrypted lazily on Compare tab expand
- `curriculum.json.enc` — current curriculum HTML per program; lazy
- `reference.json.enc` — last-approved reference curricula; lazy

**Crypto scheme:**
- Password → PBKDF2-SHA256 (200,000 iterations, 16-byte salt) → 32-byte AES key
- The salt persists across builds (reused from the previous `docs/crypto.json`) so that the client's remember-me — a derived key cached in `localStorage` for 30 days — survives each scan's rebuild. Salts are public by design; stable salt only gives up rainbow-table resistance, which 200k PBKDF2 iterations already defeats.
- Per-file layout: `IV(12 bytes) || AES-256-GCM(plaintext, key, IV)` (the 16-byte GCM auth tag is appended by the cipher)
- Wrong-password detection relies on AES-GCM's auth tag: `decrypt()` throws → gate shows "Wrong password."
- Password lives in `SITE_PASSWORD` constant at the top of `export_static.py` (default `'husky26'`)

**Client flow (in the inline gate script):**
1. On page load, try to re-import a stored key from `localStorage['cim-tracker-key-v1']` (30-day remember-me). If present and decryption of `data.json.enc` succeeds, skip the form.
2. Otherwise show the gate form. On submit: fetch `crypto.json`, derive a key via WebCrypto PBKDF2, attempt to decrypt `data.json.enc` to verify the password, stash the decrypted JSON in a cache, (optionally) save the JWK-exported key to localStorage.
3. Monkey-patch `window.fetch` so that requests to `data.json` / `curriculum.json` / `reference.json` / `campus_groups.json` transparently go to the `.enc` sibling, decrypt via WebCrypto, and return a synthesized `Response` with the plaintext JSON. This means the downstream `static/app.js` code (which calls `fetch('curriculum.json')` etc.) works unchanged.
4. Inject `<script src="app.js">` to boot the dashboard.

**`build_static_js()` bootstrap:** the static-mode overrides used to be wrapped in `document.addEventListener('DOMContentLoaded', ...)`. Since `app.js` is injected by the gate *after* DOMContentLoaded has already fired, the wrapper is now readyState-aware (runs immediately if the document is already loaded, otherwise waits for the event). If you ever load `app.js` via a normal `<script>` tag, both paths still work.

**Other static-site notes:**
- "Update Now" button reaches `localhost:5001` to trigger a local scan (shows "Cannot reach local server" if Flask isn't running)
- Auto-refresh interval is disabled on static site (data doesn't change between scans)
- Timestamps displayed in Eastern Time (America/New_York) with "ET" suffix

**Dependency:** `pip install cryptography` for the Python-side AES-GCM + PBKDF2. No JS libraries needed — WebCrypto is built into every modern browser.

**What this protection is and isn't:** it's client-side encryption with a shared password. Anyone with the password can decrypt any of the `.enc` files they download; anyone *without* the password sees only ciphertext at the `.enc` URLs. It keeps casual visitors, crawlers, and archive bots out. It is NOT real access control — a motivated attacker who knows or obtains the password (or guesses it offline against the PBKDF2 verifier) gets everything. If that matters, move to real auth (e.g. Cloudflare Pages behind Cloudflare Access).

**Historical note:** The site was originally StatiCrypt-encrypted with everything inlined into a single ~97MB `index.html`. That approach became unloadable at current data sizes and was removed, replaced briefly by a plain (unencrypted) build, then by the current per-file scheme.

## Known Issues / Gotchas

1. **Chrome session expires** - CourseLeaf sessions time out. `update.sh` checks for this and sends a macOS notification. User must manually re-login.
2. **Tab title changes** - The Approve Pages tab title is dynamic (shows "BULK:URL0:..." etc). Always match by URL, never by title.
3. **AppleScript requires permission** - Chrome > View > Developer > Allow JavaScript from Apple Events must be enabled.
4. **Sleep affects scheduling** - Using `StartCalendarInterval` so macOS fires missed scans after wake.
5. **Server must run with PYTHONUNBUFFERED=1** - Otherwise scan progress logs are buffered and don't appear in real time.
6. **`update.sh` must be executable** - `chmod +x update.sh` or launchd gets "Operation not permitted".
7. **Port 5001 conflicts** - If old server process is lingering, new one can't start. Check with `lsof -i :5001`.
8. **Programs not in workflow** - Some program IDs from Approve Pages may have 0 workflow steps (e.g., archived programs). These are stored but filtered out in display (WHERE current_step IS NOT NULL AND current_step != '').

### Auto-Deploy After Scan
After each scan completes, `app.py` automatically runs `export_static.py`, then `git add docs/ && git commit && git push`. This requires the working directory to resolve correctly (uses `os.path.abspath(__file__)`).

## Dependencies
- Python 3.9+ (macOS system Python works)
- Flask, flask-cors, cryptography (`pip install flask flask-cors cryptography`)
- Google Chrome with CourseLeaf session
- macOS (AppleScript)
- Git configured with push access to the repo

## Common Operations

```bash
# Start server
PYTHONUNBUFFERED=1 python3 app.py > /tmp/cim_server.log 2>&1 &

# Trigger scan manually
curl -X POST http://localhost:5001/api/scan/trigger

# Check scan status
curl http://localhost:5001/api/scan/status

# Export and deploy manually
python3 export_static.py
git add docs/ && git commit -m "Manual update" && git push

# Reset database
rm data/tracker.db && python3 -c "from database import init_db; init_db()"

# Reload launchd agent
launchctl unload ~/Library/LaunchAgents/com.programtracker.update.plist
launchctl load ~/Library/LaunchAgents/com.programtracker.update.plist

# Check launchd logs
cat data/launchd.log
```

## Recent Features (added after initial build)

### Reference Curriculum
Captures the last-approved version of each program's curriculum from CourseLeaf's history API, enabling before/after comparison.

**Boston vs non-Boston logic:**
- **Boston programs** (campus = "Boston" or no campus parenthetical): Uses the program's own CIM history — fetches the most recently approved version.
- **Non-Boston programs** (Oakland, Charlotte, etc.): Uses the **Boston counterpart's** most recently approved CIM history version as the reference. The version_date is annotated with "(Boston version)" to indicate the source. This is because non-Boston programs are typically based on the Boston curriculum.
- **Counterpart matching (two-tier):**
  1. **By name** — strips the campus parenthetical from the name (e.g., "Management, MS (Oakland)" → matches "Management, MS" or "Management, MS (Boston)" in the database).
  2. **By banner code via CIM search** — for programs not matched by name (Boston version already completed the workflow and isn't in the pipeline DB), searches CIM program IDs 1–2100 via XHR for matching banner code + Boston campus. This finds programs like "Analytics, MPS (Boston)" (ID 158) that are no longer in the active workflow.
- **Fallback**: Non-Boston programs with no Boston counterpart found anywhere use their own CIM history.
- Helper functions: `_parse_campus_from_name(name)` extracts campus, `_build_boston_counterpart_map(program_ids)` builds the mapping (DB + CIM search), `_search_cim_for_boston_ids(banner_codes)` searches CIM by banner code in chunks of 200 IDs.

- **`scraper.py`:** `fetch_reference_curricula()` — fetches historical version IDs from the history UI, retrieves that version's XML, parses CDATA-wrapped HTML for curriculum content. For non-Boston programs, fetches the Boston counterpart's history instead. Called automatically after each scan.
- **`database.py`:** `reference_curriculum` table (`program_id`, `version_id`, `version_date`, `curriculum_html`, `fetched_at`). Functions: `upsert_reference_curriculum()`, `get_reference_curriculum()`, `get_all_reference_curriculum()`.
- **`app.py`:** `GET /api/program/<id>/reference` endpoint. Auto-fetches reference data after each scan completes.
- **`export_static.py`:** Exports `reference.json` alongside `data.json` for the static site.
- **`static/app.js`:** Adds a "Reference" tab in expandable program rows (alongside "Workflow" and "Curriculum"). `loadReferenceDetail()` displays the version date and cleaned curriculum HTML. `cleanCurriculumHtml()` strips errors and unnecessary sections.

### Curriculum Display
Programs now store their full curriculum HTML (`programs.curriculum_html`). Expandable rows have a "Curriculum" tab showing the current proposal's curriculum content.

### Cross-Filtering
Button counts (type, proposal, smart views) dynamically update to reflect what's available given other active filters, excluding their own filter type from the count calculation.

### Compare Tab (Curriculum Diff)
Side-by-side comparison of curriculum content. Uses LCS-based diff algorithm.

- **Boston programs**: Compare current curriculum against each non-Boston deployment (Oakland, Portland, etc.)
- **Non-Boston programs**: Compare current curriculum against the Boston reference version
- **Standalone programs** (no campus group): Compare against last approved version

**Layout**: The current program/proposal is always on the **left**, the reference (Boston reference, Boston itself, or last approved version) is always on the **right**.

**Key functions in `static/app.js`:**
- `extractCourseLines(html)` — parses cleaned HTML into structured course objects `{key, code, title, hours, isHeader, section}`. Walks `h2`, `h3`, `h4`, and `tr` elements in document order to capture both HTML headings (used by many CIM programs) and `areaheader` table rows. The `key` uses only code+title (hours excluded) to prevent false diffs when hours differ.
- `standardizeHeader(text)` — normalizes common CIM heading variations to consistent labels: "Core Requirements"/"Required Courses"/"Program Requirement" → "Required Courses"; "Electives"/"General Electives" → "Elective Courses"; "Restricted Electives" → "Restricted Electives"; option headers and other specific headings preserved as-is.
- `diffLines(oldLines, newLines)` — LCS diff using `normForCompare()` (case-insensitive) on the `.key` property.
- `renderCourseCell(item, cls)` — renders a course into 3 table cells (code, title, hours) or a header spanning all 3.
- `renderSideBySide(diff, leftLabel, rightLabel)` — 7-column table layout (3 left + divider + 3 right).
- `compareCurricula(currHtml, refHtml)` — orchestrates extraction, diff, and identical check. First arg is current (left), second is reference (right).
- `updateCompareButton(programId, identical)` — colors the Compare tab button green (identical) or red (different).
- `cleanCurriculumHtml(html)` — sanitizes CIM HTML: removes hidden/noscript/caption elements in JS (CSS display:none doesn't work in detached DOM), replaces `<br>` with spaces, strips all inline styles (removes CIM's red borders on `.structuredcontenterror`), replaces `<a>` tags with space-preserving text, preserves `.blockindent` via CSS `!important`.
- `normText(s)` — normalizes whitespace, fixes digit+"and"/"or" concatenation.
- `normForCompare(s)` — lowercases `normText()` output for case-insensitive diffing.

**Static site override** in `export_static.py`: `loadCompareDetail` is overridden to read from `curriculum.json`, `reference.json`, and `campus_groups.json` instead of API calls. The rendering functions (`extractCourseLines`, `diffLines`, `renderSideBySide`, etc.) come from the base `app.js`.

### Cache Busting
`export_static.py` appends `?v={timestamp}` to CSS and JS URLs in the exported `index.html` to prevent browsers from serving stale cached assets after deployments.

### Timezone Handling
All timestamps displayed in Eastern Time (America/New_York) with "ET" suffix. Applied in both the Flask-served and static GitHub Pages versions.

### Courses View
Parallel dashboard view for `/courseadmin/` proposals, alongside programs. Toggled via the Courses/Programs buttons in the header (Courses is now first).

- **Scraper:** `discover_all_courses()` iterates course-related roles on the Approve Pages tab. `batch_fetch_course_details()` issues synchronous XHRs to `/courseadmin/{id}/` (HTML) and `/courseadmin/{id}/index.xml` in batches of 25.
- **Raw-HTML extraction (critical):** `parseFromString('text/html')` produces a DOM without layout, so `doc.body.textContent` loses whitespace boundaries. The course scraper regexes run against `xhr1.responseText` directly for:
  - `Date Submitted:` — matches a nearby GMT-formatted date (RFC 822)
  - Proposal type — "New Course Proposal" → Added; "Inactivation" → Deactivated; else Edited
  - Approval history — all `([Weekday], DD Mon YYYY HH:MM:SS GMT) ... Approved for (step)` pairs; the last one becomes `last_approval_date` (when current step was entered)
- **step_entered_date priority:** `last_approval_date` → `date_submitted` → `now`. `upsert_course` overwrites an existing stale value when the scraper provides a historical date, so first-scan "now" defaults get corrected on subsequent scans.
- **Database:** `courses`, `course_workflow_steps`, `course_changes` tables. `courses` includes `credits`, `description`, `academic_level` (UG/GR/CP/GR-UG codes from XML).
- **Pipeline bucketing (display only):** `static/app.js` defines `COURSE_BUCKETS` that collapse many discrete role names into a handful of pipeline columns — `OTP` (any step starting with "Provost"), `Registrar` (any "REGISTRAR"), `Course Review` (Course Review 2 + 3), `Course Review Group` (anything starting with "Course Review Group", including "Complete - Hold"), `Data Entry`, `Banner`. Everything else (department chairs, college committees, program directors) aggregates into `College`. `isCourseCollegeStep()` excludes these prefixes from the College bucket.
- **Course-level type filter:** `classifyCourseLevel()` maps `acad_level` codes to Undergraduate/Graduate, with a course-number fallback (1000–4999 UG, 5000+ GR).
- **Approver filter isolation:** separate `/api/course_approvers` + `/api/course_approver/<email>` endpoints. The programs version was keyed by `program.id`, which collided numerically with course IDs, causing false-positive matches across views.
- **Row coloring:** same CSS classes (`row-added`, `row-edited`, `row-deactivated`) drive the colored left border for courses as for programs.
- **Static site:** `export_static.py` includes `courses`, `course_workflows`, `course_approvers` in `data.json`. `loadCoursesDashboard` and the approver filter are overridden to read from embedded data.
