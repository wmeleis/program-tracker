# Program Approval Tracker

## What This Is
A dashboard that tracks academic program approvals through Northeastern University's CourseLeaf CIM (Curriculum Information Management) system. It reads data from CourseLeaf over **direct authenticated HTTP** (reusing the CIM session that already lives in the user's Chrome cookie store — see "HTTP scan architecture" below), stores it in SQLite, and displays it on a web dashboard deployed to GitHub Pages.

> **Current scan path = HTTP, not AppleScript.** As of the HTTP rewrite, the regular scan (`do_scan`) and the "Update Now" button (`/api/heal`) both run `scraper.run_http_scan()` — plain `urllib` requests against CourseLeaf, no browser automation. The old AppleScript-driven-Chrome functions (`run_full_scan`, `run_course_scan`, `heal_stale_*`, `fetch_reference_curricula`, the `BROWSER_APP`/`run_js_in_tab` machinery) still exist but are **legacy/unused by the live scan**. Everything in this doc below that describes AppleScript scraping, role-iteration discovery (A1/A2/A3), quick-scan modes, and the five-times-inverted reconciliation policy is **historical context for the legacy path** — the HTTP path replaces all of it with one rule (see below). Regulatory (SharePoint) and Portfolio (Smartsheet/SharePoint) still use their own fetchers on their own cadence.

### HTTP scan architecture (current)
**One request, one rule, one code path.**

- **`cim_http.py`** — the HTTP foundation. Reads + decrypts the CIM session cookie from Chrome's cookie store (`CIMSession`, macOS Keychain "Chrome Safe Storage"), then issues plain HTTP GETs to the same `/programadmin/{id}/`, `/courseadmin/{id}/`, XML, and history URLs the old in-page JS hit. Key methods: `fetch_dump()` (the ~5MB Approve Pages pending XML, one request), `fetch_all_pending()` (parses that dump into `{programs, courses, catalog}` in one pass), `fetch_program`/`fetch_program_xml`, `fetch_course`/`fetch_course_xml`, `fetch_reference_version` (CIM history API → last-approved curriculum), `check()` (session probe — login detected by an **off-host redirect**, not body keywords). Cookie reads are WAL-aware (`_copy_cookie_db` copies `Cookies` + `-wal` + `-shm`, or a just-after-login session cookie is missed). A `CookieJar`-backed opener captures session-refresh `Set-Cookie` so our session stays alive like the browser's.
- **The Approve Pages dump is the entire pending state.** `courseleaf.cgi?page=/courseleaf/approve/index.html&step=load&output=xml&role=any` returns every pending program (~655), course (~632), and catalog page (~430 tracked) in one ~3s request. `current_step` = the first non-`fyi`/`fyiall` `<mustsignoff>` role (the actionable step the reviewer sees; resolves CIM's parallel branches exactly as Approve Pages does). This is the single source of truth for workflow state — there is **no** "Approve Pages vs workflow-div vs approval-log" reconciliation anymore.
- **The single rule** (implemented identically for programs and courses in `run_http_program_scan` / `run_http_course_scan`): an item **in** the dump → `current_step` = its first mustsignoff; an item **in the DB at a step but absent** from the dump → fetch its page and verify: no workflow div (or all-approved, no current marker) ⇒ completed (clear step, set `completion_date`); a terminal processing step's `class="current"` marker (Editor/Banner/Catalog Setup) ⇒ use it; page fetch failed ⇒ preserve existing (positive-evidence; never clear on a failed fetch). Every in-workflow item's page+XML is fetched in parallel (`ThreadPoolExecutor`) for workflow steps, approver emails, metadata, and curriculum — "fetch all in_wf" is deliberate (simple + correct, no incremental-gating bugs).
- **Catalog** (`run_http_catalog_scan`): the dump *is* the whole catalog workflow state (catalog pages have no per-page admin URL). Keep only pages whose role ∈ `CATALOG_TRACKED_ROLES`; `current_step` = role, `user` = `<modby>`; clear pages no longer pending. The dump appends `/index.html`, stripped to match the bare-path convention in `catalog_pages`.
- **References** (`fetch_reference_curricula_http`): same C3 targeted-fetch semantics (only round-trip programs that are missing a ref or just completed), now via `fetch_reference_version` over HTTP. A reference is a program's *last-approved* version, which can only change on a completion — and every completion path (real-time `completed_in_scan`, the HTTP scan's gone-path detection, Boston-counterpart completions, and the weekly sweep's `new_completion_ids`) feeds the targeted set, so targeting completions is exact, not lossy. **Weekly safety net:** when the weekly sweep runs (`weekly_ref_refresh` flag in `do_scan`), `targeted_ids` is widened to *all* programs for one full re-fetch; the `version_id` comparison means only genuinely-advanced refs get written, so it's cheap. Uploaded/custom references (`programs.custom_reference_id` → `custom_references` table) are a separate override that `upsert_program` never touches and that always wins over the auto reference. Curriculum body extracted in pure Python (`_extract_div_inner` balances nested `<div>`s for `bodycontentframediv3` + `concentrations` + `overviewcontentframediv4`).
- **Weekly sweeps** (`sweep_program_ids_http` / `sweep_course_ids_http`): HTTP ports of `sweep_all_*_ids` — walk every CIM id, ingest active + completed/historical, same sentinel rows (`scans.programs_scanned = -1`, `course_scans.changes_detected = -1`) and `new_completion_ids` contract.
- **`run_http_scan(scope='all'|'programs'|'courses'|'catalog')`** — the orchestrator: fetches the dump once, shares one `CIMSession` across all three scans (and `do_scan` reuses it for sweeps + references). `do_scan` is now a clean linear sequence: HTTP scan → publish workflow update → weekly sweeps (gated) → references (targeted) → regulatory (SharePoint, 24h-gated) → portfolio (Smartsheet/SharePoint/Tableau, **1h-gated** via `data/last_portfolio_fetch`) → fingerprint-gated export + push.
- **Timing:** ~3s dump + ~55s programs page/XML + ~55s courses page/XML + catalog (instant) ≈ **~2 min** per full scan, **zero fetch failures** (vs the legacy ~50 min with 57–131 AppleScript failures/scan). The old quick/full scan-mode split is gone — every trigger runs the same complete scan.
- **What you need to be logged into:** just **CIM in Chrome** (a valid `nextcatalog.northeastern.edu` SSO session). No tabs need to be open, Chrome needn't be foreground. Regulatory/Portfolio need SharePoint/Tableau only on their own (rare) refresh cycles.

### Workflow actions — approve / send-back / comment (WRITE path)
The tracker can perform governance actions in CIM on the user's behalf, reproducing the Approve Pages "Approve" button over the same authenticated HTTP session. **This is the only write path; everything else is read-only.**

- **Mechanics (reverse-engineered from Approve Pages JS, `approveCurrent`):** a comment is POSTed first to `…&step=wfrejectcomments&output=xml` (`attr_newrejectcomments`, `command=nosave`), then the action to `…&step=approvelist&output=xml` with `approvelist = "{action}:{path}|{revisionid}|{role}|{rejectto}|{why}"`. `action`=`Approved` (advance) or `Rejected` (send back, with `rejectto`=target step). `role` comes from the dump (first mustsignoff). `revisionid` is read live from the program's `step=tcadiff` preview page (`pageleaf_revisionid`).
- **cim_http.py:** `post()` (the single write primitive), `fetch_revision_id(path)`, `approve_item(path, role, action, rejectto, comment, revision_id)`. `approve_item` parses CIM's `<warning>` response — a "page has changed during approval" warning means the action did **not** apply (CIM's built-in stale-version guard → a wrong/stale revision fails safe, never approves the wrong thing).
- **app.py:** `POST /api/program/<id>/action` body `{action: approve|sendback|comment, comment, rejectto, expected_role, confirm:true}`. Guardrails: single program only (no bulk), `confirm:true` required, and a **live re-check** — it re-fetches the dump and refuses (HTTP 409) if the program is no longer pending or has moved off `expected_role`. Every attempt (success or not) is appended to `data/action_audit.jsonl` and is viewable in the **Console modal** ("My Actions" section at the top — `/api/console` returns `action_audit`, most-recent-first, capped at 200). On success it calls `scraper.refresh_program_http(pid)` (one-program targeted re-fetch, ~1-3s) then `_publish_if_changed`, so the dashboard reflects the move in seconds.
- **scraper.py:** `refresh_program_http(pid, sess)` — single-program targeted update using the same single rule as `run_http_program_scan`.
- **Frontend (`static/app.js`):** `buildProgramActionPanel(programId, steps)` renders an Approve / Send-back / Comment panel inside the program row's Workflow tab (programs only, only when there's a current step). `submitProgramAction()` shows a `confirm()` with exactly what will happen, posts, surfaces the result, and reloads. **Local-only by design:** the panel returns `''` when `window._staticMode` is set, so it renders ONLY on the Flask-served `localhost:5001` dashboard, never on the public GitHub Pages site. Approvals are therefore confined to the owner's own machine + CIM session; other people viewing the shared static site never see the controls. CIM still enforces *who* may approve.
- **CIM session indicator + Authenticate button (local dashboard only):** the header shows a live `● CIM session OK` / `● CIM login needed` badge (`refreshCimAuthStatus()` → `GET /api/auth/status` → `CIMSession.check()`), and an **Authenticate** button (`cimAuthenticate()` → `POST /api/auth/login`) that runs `open -a "Google Chrome" {CIM_BASE}/courseleaf/approve/` to bring up Northeastern SSO; after login the next cookie read picks up the refreshed session. Both controls are stripped from the static build by `export_static.py` (they open Chrome on the *server* machine, so they're meaningless on GitHub Pages).
- **Scope/limits (v1):** single user, local machine — there is no multi-user/multi-approver path (a web page can't read a remote visitor's CIM cookie; per-user would require a Northeastern Shibboleth SSO service-provider integration). Programs only (courses go through CIM's approval too but aren't wired yet); the panel shows on any in-workflow program and relies on CIM's permission enforcement rather than pre-filtering to roles the user owns; standalone "comment" posts the comment step only (best-effort — a comment normally rides with an approve/send-back).

---

_Legacy AppleScript architecture (no longer the live scan path) follows:_

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
| `scraper.py` | Scrapes CourseLeaf via AppleScript executing JS in browser tabs. The target browser is configurable via `BROWSER_APP` env var (defaults to "Google Chrome" everywhere; see "Browser selection"). Two data sources: Approve Pages (role dropdown, matched by URL `courseleaf/approve`) for program discovery, and per-program XHR fetches (HTML + XML API) for workflow/metadata. |
| `database.py` | SQLite layer. Tables: `programs`, `workflow_steps`, `scan_history`, `scans`. Uses WAL mode. |
| `app.py` | Flask server on port 5001. REST API. Scans are driven externally by `update.sh` (launched by launchd), not on a Flask-side timer. After each triggered scan, auto-exports static site and pushes to GitHub. |
| `export_static.py` | Generates `docs/` directory: `data.json`, `index.html`, `app.js`, `style.css`. The static `app.js` overrides API calls to read from `data.json`. |
| `static/app.js` | Frontend: pipeline bar, filters (type/proposal/smart views/college/campus/approver/step/search), sortable table with expandable workflow detail rows. |
| `static/style.css` | Dashboard styling. Colored left borders: green=new, blue=change, red=inactivation. |
| `templates/dashboard.html` | HTML template used by both Flask and static export. |
| `update.sh` | Launched by launchd every 5 min, 24/7. Checks browser + session + scan-not-already-running, triggers `/api/scan/trigger` if all clear. Each scan force-fetches every active program/course's workflow div for 100% accuracy per scan (~50 min). |

### Scheduled Execution
**Single cadence: continuous back-to-back scans, 100% accurate per scan.**

- **Agent:** `~/Library/LaunchAgents/com.programtracker.update.plist`
- **Schedule:** `StartInterval` 300 sec (5 min). launchd fires `update.sh` every 5 minutes, 24/7.
- **What `update.sh` does:** preflight — inside the 6am–9pm PT window (exclusive on 9pm); on weekends, at least 3 hours since last scan; no scan currently in progress. (No Chrome/tab/AppleScript preflight anymore — the HTTP scan doesn't need it; `/api/scan/trigger` does its own HTTP CIM session check.) If all checks pass, triggers `/api/scan/trigger`; otherwise exits silently. It also (re)starts Flask if the server is down.
- **Heartbeat watchdog (in `update.sh`):** weekdays only, if no scan has *completed* in >30 min (server down, expired CIM session, or any regression) it pops a macOS notification ("No successful scan in N min — check the CIM login…"). Skipped while a scan is running, and rate-limited to once / 30 min via `data/last_heartbeat_alert`. Pure watchdog — never changes scan behavior. Added after a silent ~15h stall went unnoticed (the trigger preflight had been rejecting every scheduled scan).
- **Effective cadence:**
  - **Mon–Fri**: continuous back-to-back scans during 6am–9pm PT (~one completed scan per hour given ~50 min scan duration).
  - **Sat–Sun**: every 3 hours during 6am–9pm PT (5 firings/day max: 6am, 9am, 12pm, 3pm, 6pm).
- **What each scan does:** force-fetches the workflow div for every active program and course, regardless of whether Approve Pages says they moved. The workflow div is the authoritative source, so this guarantees zero missed step transitions per scan. ~50 min per scan during normal operation.
- **Update Now button:** the dashboard's "Update Now" button calls the same `/api/scan/trigger` endpoint, so it does exactly what the scheduled scans do. Useful only when you want to force the very next scan to start sooner than the next 5-min launchd firing.
- **No weekday/weekend distinction, no separate heal cadence.** Daily 6am–9pm PT window only. If Chrome+session are valid, scans run. If not, they don't. macOS sleep is naturally handled — scans pause while the laptop sleeps and resume on wake.

**Interleaved quick role updates.** Within each thorough scan, `do_quick_role_update()` (in `app.py`) is called multiple times — after `run_full_scan`, between groups of ~15 course roles, between groups of ~10 catalog roles, and after each major phase. Each call:
1. Force-fetches every DB-active program's workflow div via `run_full_scan(force_fetch_only=True)` (~2 min).
2. Force-fetches every DB-active course's workflow div via `process_course_scans([], force_fetch_only=True)` (~1.5 min).
3. Computes the C1 fingerprint; if changed, runs `export_static.py` + `git push`. If unchanged, skips silently.

This publishes role transitions to the dashboard mid-scan instead of only at the end. Net effect: role-update lag drops from ~42 min (end-of-scan) to **roughly every 5–7 min throughout the scan**. Total scan time grows from ~42 min to ~55–65 min depending on how many quick updates fire (each is ~3 min, most don't push anything because nothing changed). The `force_fetch_only` flag on `run_full_scan` and `process_course_scans` skips A1/A2/A3 discovery and exit verification — just force-fetch + reconcile, the fast portion of the full scan.

### How the Scraper Works

**Step 1 - Program Discovery (Option C — hybrid, ~4 min):** Discovery has three sources, designed to be both fast and complete:
- **A1**: Iterate `ALL_ROLES` (46 hardcoded common pipeline + college roles) via `scrape_approve_pages_role()` — fast (~4 min) because empty roles short-circuit after 5 stable empty polls + ≥3s elapsed; 15s hard ceiling.
- **A2**: Programs already in the DB whose `current_step` is at an *obscure* role (one of the ~169 narrow roles like `Program MI Graduate Curriculum Committee Chair` not in `ALL_ROLES`) — these are added to the active fetch set unconditionally and re-verified via Phase B's workflow-div fetch.
- **A3**: ID probe `(max_db_id, max_db_id + 50)` — catches brand-new programs at any role. CIM assigns sequential IDs, so probing 50 IDs above the highest known catches anything created since last scan.

Why not just iterate the live ~215-role dropdown? It works but costs ~87 min of active scan time because ~165 of those roles are empty most of the time, and each takes 5-15s of JS poll-until-stable plus AppleScript round-trips. The hybrid (A1+A2+A3) gives the same coverage at <1/10 the cost.

`scrape_approve_pages_role()` selects each role in the dropdown via `showPendingList()`, then runs an async poll-until-stable loop (extracts every 500ms, returns when count is non-zero AND stable across 3 polls). Extracts program IDs and names from page text matching `/programadmin/(\d+):\s*(.+)/`. The same pattern is in `scrape_courses_from_role()` for `/courseadmin/`.

**Step 1.5 - Diff vs DB (incremental gating, Phase A+B):** Step 1's role membership is the cheap change-detector. Each discovered program is classified into one of three buckets by comparing its live Approve Pages role to the DB's stored `current_step`:
- `new_ids`: not in DB
- `moved_ids`: in DB, but DB's `current_step` ≠ live role
- `unchanged_ids`: in DB, DB's `current_step` == live role

Step 2 then fetches details only for `active_ids = new_ids ∪ moved_ids`. Unchanged programs are *not* re-fetched and their DB rows stay as-is. On a typical day this drops Step 2 from ~7 min to a few seconds.

**Step 2 - Batch Detail Fetch (active programs only):** Uses synchronous XHR (batches of 25) executed via AppleScript in the `programadmin` tab:
- Fetches each program's HTML page (`/programadmin/{id}/`) and parses the `#workflow` div for steps (name, status, approver emails)
- Fetches each program's XML API (`/programadmin/{id}/index.xml`) for metadata (college, department, degree, banner code, campus, proposal type)
- ~200ms per program

**Step 3 - Database Update:** Processes results for `active_ids` only, maps college codes to full names, detects changes (step transitions), preserves `step_entered_date` when step hasn't changed (to not reset the "days at step" timer). Then runs an exit-verification pass over `existing_in_pipeline` (in DB at a step but not discovered) using the positive-evidence policy — workflow div must confirm before any `current_step` is cleared.

**Per-phase timing logs:** `run_full_scan()` returns a `phase_times` dict (`1_discovery`, `2_diff`, `3_detail_fetch`, `4_processing`, `5_exit_verification`) and prints a percentage breakdown at scan end so we can see where time is actually spent.

**Course scan parity (Option F):** `scrape_courses()` and `process_course_scans()` mirror Option C's hybrid approach:
- **A1**: `scrape_courses()` iterates `get_course_common_roles()` (DB-derived list of roles where DB courses currently sit, ~80 entries) instead of the full ~215-role live dropdown. Drops course discovery from ~25 min to ~10 min. Falls back to the full dropdown on cold-start (empty DB).
- **A2**: `process_course_scans()` finds DB courses whose `current_step` ∉ `iterated_roles` and force-fetches them — same logic as program A2.
- **A3**: ID probe `(max_course_id, max_course_id + 50)` — catches brand-new courses regardless of role.
- **Exit verification**: courses in DB at a step but not discovered (and not in A2/A3) get cross-checked via workflow div before any destructive change. Closes the pre-existing course-completion gap where a course completing mid-workflow disappeared from Approve Pages but lingered in DB at its old step.

The course common-roles cache self-heals: when a course lands at a never-before-seen role, A3 ingests it via ID probe with the new role; from the next scan onward that role is iterated by A1.

Same `1_diff` / `2_detail_fetch` / `3_processing` / `4_exit_verification` timing logs, printed indented under the course-scan output.

**Removed: trailing `heal_stale_program_steps` validation call.** Heal had two phases: a 215-role discovery pass and a 73-min cross-check loop that fetched the workflow div for every live program. The cross-check was empirically redundant (made in-memory corrections but 0 DB changes — the main scan's workflow-div reconciliation already covered every "moved" case). The 215-role discovery, on its own, was tried as a replacement but cost ~87 min of active scan time. We replaced it with Option C's hybrid (A1 + A2 + A3) which gives equivalent coverage at ~4 min. The function `heal_stale_program_steps` still exists for on-demand `/api/heal` (the "Update Now" dashboard button), where its full discovery + cross-check behavior is appropriate.

**C2 — Boston-in-workflow HTML refresh.** Boston programs in workflow whose Approve Pages role didn't change are still re-fetched every scan, just to keep `programs.curriculum_html` current. The reference-curriculum sentinel block (in `fetch_reference_curricula`) reads that field to update non-Boston deployments' references in `version_id=0` mode — if the field is stale, the sentinel propagates stale data to every dependent deployment until Boston's step changes. ~50 Boston programs per scan, ~10s extra; cheap insurance. Detection: a program is Boston when its `campus` field is empty, "Boston", or its name has no campus parenthetical (the convention for the canonical program).

**C3 — Targeted reference fetch.** `fetch_reference_curricula(program_ids, targeted_ids=None)` now takes an optional set of program IDs to actually round-trip via the JS-history fetch loop. Pre-C3 the function did one HTML round-trip per program every scan to compare version_ids — costing ~16 min on a no-change scan ("0 fetched, 1669 skipped"). Now `do_scan` computes `targeted_ids` from positive change signals:
- programs with no existing `reference_curriculum` row (initial fetch)
- programs that just transitioned from in-workflow to complete in this scan (`run_full_scan` returns `completed_in_scan`; the exit-verification block contributes too)
- programs newly completed by the weekly `sweep_all_program_ids` (sweep returns `new_completion_ids`)
- non-Boston deployments whose Boston counterpart is in `completed_in_scan` (their ref now points at Boston's NEW last-approved version, not the `version_id=0` sentinel)

Boston-in-workflow non-Boston refs (sentinel mode) are propagated by the function's sentinel block, which always runs over the full set — those don't need to be in `targeted_ids`. Same for the self-reference synth fallback.

On a typical no-change scan this drops the JS-history loop from 1669 fetches to 0, cutting reference phase from ~16 min to ~30 sec.

**Known limitations of incremental gating (accepted, see "Reconciliation: which source wins"):**
- Course curriculum_html edits at unchanged steps are not detected by Phase A+B. (Programs are covered by C2; courses don't have curriculum HTML the way programs do, so this is moot.)
- Approve Pages stale-cache that happens to match a stale DB `current_step` is silently missed by this scan. The weekly `sweep_all_program_ids` (and `sweep_all_course_ids`) is the safety net — it iterates every CIM ID directly via the XML API, no Approve Pages dependency.

### Browser selection
- **`BROWSER_APP` env var** controls which Chromium-family browser AppleScript drives. **Default everywhere is `"Google Chrome"`** (in `scraper.py`, in `update.sh`, and the launchd plist has no override). Override per-shell: `BROWSER_APP="Microsoft Edge" python3 app.py` to use Edge.
- **Why Chrome and not Edge:** we tried Edge as the default; Edge throttles JS execution on backgrounded tabs aggressively, which causes the long-running batch fetches inside `batch_fetch_program_details` / `batch_fetch_course_details` to stall and time out. Chrome's AppleScript bridge is reliable for these multi-minute scrapes; Edge's is not (as of 2026-04). If you do want Edge as the daily browser, no problem — keep Chrome installed and open in a back-of-screen window with the CourseLeaf tabs; Edge can be your foreground app independently.
- **Why Edge:** the user runs Edge as their daily driver and prefers a single browser handling SSO, CourseLeaf session, SharePoint regulatory downloads, and dashboard preview.
- **Edge requirements:** install Edge (Chromium-based, supports the same AppleScript verbs); enable Edge → View → Developer → Allow JavaScript from Apple Events; log into CourseLeaf in Edge window 1; keep Approve Pages + Program Management tabs open.
- **Single point of control in code:** every browser interaction in `scraper.py` funnels through `run_js_in_tab()`, which reads `BROWSER_APP` once at module import. `update.sh` reads `BROWSER_APP` for both its `pgrep` liveness check and its session-validity AppleScript probe.
- **Chrome fallback:** unset `BROWSER_APP` (or set to `"Google Chrome"`) — same code path, just a different `tell application "..."` target. No other code changes needed.

### Tab Matching
- **Approve Pages tab:** Matched by URL containing `courseleaf/approve` (NOT by title - the title changes dynamically)
- **Program Management tab:** Matched by URL containing `programadmin`
- Both tabs must be open in window 1 of whichever browser `BROWSER_APP` points at

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
- **Proposal type**: Determined from HTML page text AND XML `<statustype>`. "New Program Proposal" → "Added", "Inactivation Proposal" → "Deactivated", else "Edited" (Program Revision). XML `<deletejustification>` is captured as data only (`delete_justification`) and never overrides the proposal type — CIM uses that field for any proposal that removes the original program record from the catalog (true inactivations AND splits/merges/major restructures), so it conflates "going away" with "inactivation." Trust HTML/`statustype` as the source of truth (those are what CIM uses to *display* the proposal type to reviewers). Historical note: an earlier override that flipped proposal_type to "Inactivation Proposal" whenever `<deletejustification>` was non-empty mis-flagged splits (e.g. program 819, Robotics MS Boston, being split into three banner codes) as inactivations; removed.
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
- "Update Now" button (in `build_static_js()` `window.triggerScan` override) reaches `http://localhost:5001/api/heal` cross-origin (CORS enabled on `/api/*`) and POSTs `{scope: "both", active_only: true, deploy: true}`. Polls `/api/scan/status` every 10s for completion. Shows "Cannot reach local server" only when the fetch itself throws (Flask down or unreachable).
- Auto-refresh interval is disabled on static site (data doesn't change between scans)
- Timestamps displayed in Eastern Time (America/New_York) with "ET" suffix. The server stores `scan_time` as a naive local-time ISO string; `/api/scan/status` and `export_static.py` attach the local TZ offset before emitting (`datetime.fromisoformat(s).astimezone().isoformat()`) so browsers in any timezone parse it as the correct absolute instant.

**Dependency:** `pip install cryptography` for the Python-side AES-GCM + PBKDF2. No JS libraries needed — WebCrypto is built into every modern browser.

**What this protection is and isn't:** it's client-side encryption with a shared password. Anyone with the password can decrypt any of the `.enc` files they download; anyone *without* the password sees only ciphertext at the `.enc` URLs. It keeps casual visitors, crawlers, and archive bots out. It is NOT real access control — a motivated attacker who knows or obtains the password (or guesses it offline against the PBKDF2 verifier) gets everything. If that matters, move to real auth (e.g. Cloudflare Pages behind Cloudflare Access).

**Historical note:** The site was originally StatiCrypt-encrypted with everything inlined into a single ~97MB `index.html`. That approach became unloadable at current data sizes and was removed, replaced briefly by a plain (unencrypted) build, then by the current per-file scheme.

## Known Issues / Gotchas

1. **CourseLeaf session expires** - CourseLeaf sessions time out in the browser (Edge or Chrome). `update.sh` checks for this and sends a macOS notification. User must manually re-login.
2. **Tab title changes** - The Approve Pages tab title is dynamic (shows "BULK:URL0:..." etc). Always match by URL, never by title.
3. **AppleScript requires permission** - In whichever browser `BROWSER_APP` points at: View → Developer → Allow JavaScript from Apple Events must be enabled. (For Edge: same menu path; the toggle is per-browser, so enabling it in Chrome doesn't help Edge.)
4. **Sleep affects scheduling** - Using `StartCalendarInterval` so macOS fires missed scans after wake.
5. **Server must run with PYTHONUNBUFFERED=1** - Otherwise scan progress logs are buffered and don't appear in real time.
6. **`update.sh` must be executable** - `chmod +x update.sh` or launchd gets "Operation not permitted".
7. **Port 5001 conflicts** - If old server process is lingering, new one can't start. Check with `lsof -i :5001`.
8. **Programs not in workflow** - Some program IDs from Approve Pages may have 0 workflow steps (e.g., archived programs). These are stored but filtered out in display (WHERE current_step IS NOT NULL AND current_step != '').

### Auto-Deploy After Scan
After a full scan completes (`do_scan` in `app.py`) AND after every "Update Now" heal (`api_heal` background thread), the system automatically runs `export_static.py` then `git add docs/ && git commit && git push`. The heal commits with message `"Quick update YYYY-MM-DD HH:MM"`; the full scan commits with `"Auto-update YYYY-MM-DD HH:MM"`. Both rely on `os.path.abspath(__file__)` to resolve cwd.

**Skip when nothing changed (full scan only):** `do_scan` calls `compute_db_fingerprint()` from `scraper.py` — a SHA-256 over the user-visible fields of the source tables (programs, workflow_steps, courses, course_workflow_steps, reference_curriculum, regulatory_approved_courses, custom_references, catalog_pages), explicitly excluding metadata like `fetched_at` so an idempotent re-fetch (same content, new timestamp) doesn't trigger a false-positive change signal. The fingerprint is compared to `data/last_export_fingerprint`; on match, the export + commit + push are skipped entirely. On mismatch, the new fingerprint is written only after a successful export. The heal endpoint (`/api/heal`) does NOT use this gate — its purpose is to force a refresh, so it always exports.

**Regulatory fetch cadence:** SharePoint workbooks rarely change, so `fetch_regulatory_approved` is rate-limited to once per 24h per scan. `data/last_regulatory_fetch` is touched on each successful run; subsequent scans within 24h skip the fetch with a log line. A failed fetch leaves the timestamp unchanged so the next scan retries. To force a refresh sooner, delete the timestamp file.

## Dependencies
- Python 3.9+ (macOS system Python works)
- Flask, flask-cors, cryptography (`pip install flask flask-cors cryptography`)
- Microsoft Edge or Google Chrome with CourseLeaf session (selected by `BROWSER_APP`; launchd default Edge)
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

# Reload the launchd agent (single, continuous mode)
launchctl unload ~/Library/LaunchAgents/com.programtracker.update.plist
launchctl load ~/Library/LaunchAgents/com.programtracker.update.plist

# Check launchd logs
cat data/launchd.log    # raw launchd stderr/stdout
cat data/update.log     # what update.sh did each firing
```

## Recent Features (added after initial build)

### Reference Curriculum
Captures the last-approved version of each program's curriculum from CourseLeaf's history API, enabling before/after comparison.

**Boston vs non-Boston logic:**
- **Boston programs** (campus = "Boston" or no campus parenthetical): Uses the program's own CIM history — fetches the most recently approved version.
- **Non-Boston programs** (Oakland, Charlotte, etc.): Uses the **Boston counterpart's** most recently approved CIM history version as the reference. The version_date is annotated with "(Boston version)" to indicate the source. This is because non-Boston programs are typically based on the Boston curriculum.
- **Counterpart matching (two-tier):**
  1. **By name** — strips the campus parenthetical from the name (e.g., "Management, MS (Oakland)" → matches "Management, MS" or "Management, MS (Boston)" in the database). Also handles em-dash deployment suffixes: `"Business Analytics, MS—Online"` → base `"Business Analytics, MS"`, campus `"Online"` → matches Boston counterpart. Only `—Online`, `—Accelerated`, `—Part-Time` are treated as deployments; `—Align`, `—Connect`, `—Science` are distinct program names and left intact in the base.
  2. **By banner code via CIM search** — for programs not matched by name (Boston version already completed the workflow and isn't in the pipeline DB), searches CIM program IDs 1–2100 via XHR for matching banner code + Boston campus. This finds programs like "Analytics, MPS (Boston)" (ID 158) that are no longer in the active workflow.
- **Special case — Boston counterpart in active workflow:** If the matched Boston counterpart is itself being revised in the current pipeline, the sentinel `version_id=0` reference (annotated `"current proposal (Boston, in workflow)"`) stores Boston's in-workflow curriculum instead of its last-approved history. Later scans always replace this sentinel so it tracks Boston's edits.
- **Fallback**: Non-Boston programs with no Boston counterpart found anywhere use their own CIM history.
- Helper functions: `_parse_campus_from_name(name)` extracts campus, `_build_boston_counterpart_map(program_ids, sess=None)` builds the mapping (DB + CIM search), `_search_cim_for_boston_ids(banner_codes, sess=None)` searches CIM by banner code in chunks of 200 IDs **over direct HTTP** (`CIMSession.fetch_program_xml`, parallel) — ported from the old AppleScript/Chrome-tab path so it no longer needs a `programadmin` tab open (it was spamming "Tab not found" and falling back to name-only matching on every scan with completions).

- **`scraper.py`:** `fetch_reference_curricula()` — fetches historical version IDs from the history UI, retrieves that version's XML, parses CDATA-wrapped HTML for curriculum content, extracting only the `bodycontentframediv3` (curriculum body), `concentrations` section, and `overviewcontentframediv4` (overview). For non-Boston programs, fetches the Boston counterpart's history instead. Called automatically after each scan.
  - **Parallelized (batch_size=25, ~0.5s/program):** Each batch kicks off an async `Promise.all` of `fetch()` calls; the JS writes results into a hidden `__refbatch_N` div; Python polls for completion, then retrieves the JSON in 200KB chunks to avoid AppleScript return-value limits. ~6 min for 615 programs vs ~10+ min before.
  - **History API endpoint:** `/courseleaf/courseleaf.cgi?page=/programadmin/{id}/index.html&output=xml&step=showtcf&view=history&diffversion={versionId}` returns the full historical page HTML wrapped in `<showdata><![CDATA[ ... ]]></showdata>`. This endpoint is the only way to access historical content — the `?history=` URL parameter and the XML API both ignore version and return current.
- **`database.py`:** `reference_curriculum` table (`program_id`, `version_id`, `version_date`, `curriculum_html`, `fetched_at`). Functions: `upsert_reference_curriculum()`, `get_reference_curriculum()`, `get_all_reference_curriculum()`.
- **`app.py`:** `GET /api/program/<id>/reference` endpoint. Auto-fetches reference data after each scan completes.
- **`export_static.py`:** Exports `reference.json` alongside `data.json` for the static site.
- **`static/app.js`:** Adds "Reference" and "Compare" tabs in expandable program rows (alongside "Workflow" and "Curriculum"). `loadReferenceDetail()` displays the version date and cleaned curriculum HTML. `cleanCurriculumHtml()` strips "Course Not Found" red error boxes, "Program Overview" / "Milestone" / "Research Areas" sections, and empty rows left after course removal.

### Curriculum Display
Programs now store their full curriculum HTML (`programs.curriculum_html`). Expandable rows have a "Curriculum" tab showing the current proposal's curriculum content.

### Cross-Filtering
Button counts (type, proposal, smart views) dynamically update to reflect what's available given other active filters, excluding their own filter type from the count calculation.

### Compare Tab (Curriculum Diff)
Side-by-side comparison of curriculum content. Uses LCS-based diff algorithm.

- **Boston programs**: Compare current curriculum against each non-Boston deployment (Oakland, Portland, etc.)
- **Non-Boston programs**: Compare current curriculum against the Boston reference version
- **Standalone programs** (no campus group): Compare against last approved version

**Layout**: The current program/proposal is always on the **left** (labeled "Proposed Curriculum"), the reference (Boston reference, Boston itself, or last approved version) is always on the **right** (labeled "Reference Curriculum"). Labels are identical across all three comparison paths (non-Boston deployment, Boston with deployments, standalone).

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

### Custom Reference Curricula (uploaded .docx)
Programs may override the auto-derived reference with a user-uploaded document.

- **DB:** `custom_references` table (`id`, `name`, `source_type`, `source_filename`, `title`, `curriculum_html`, `sections_json`, `notes`, `created_at`). `programs.custom_reference_id` (nullable FK) — when set, overrides the auto reference.
- **Parser (`docx_parser.py`):** Pure stdlib (`zipfile` + `xml.etree`). Walks `<w:body>` in order; `Heading2` / `Heading3` paragraphs mark section boundaries; each `<w:tbl>` produces a section. Course rows are detected via regex `^[A-Z]{2,5}\s*\d{4}` on the first cell. Output HTML matches CourseLeaf's `<table class="sc_courselist">` structure so the Compare diff works unchanged.
- **PDF parser (`pdf_parser.py`):** Uses `pdfplumber`. Extracts tables per page, pairs each with the nearest heading-like text line above it (between tables), applies the same course-code regex as the docx parser. Produces identical output shape so both formats flow through the same rendering/diff pipeline. Works well for text-based PDFs exported from Word/LibreOffice; falls back with a warning on scanned/image-only PDFs.
- **Supported formats:** `.docx` and `.pdf`. Legacy `.doc` uploads are rejected with a message asking the user to re-save as `.docx`.
- **API:**
  - `GET /api/custom_references` — list
  - `POST /api/custom_references` — multipart upload (`file`, optional `name`, `notes`) → parses → stores → returns preview (sections + course counts + warnings)
  - `GET /api/custom_references/<id>` — full record incl. HTML
  - `DELETE /api/custom_references/<id>` — removes; automatically clears any program overrides pointing to it
  - `POST /api/program/<id>/reference_override` body `{custom_reference_id: N|null}` — set or clear a program's override
  - `GET /api/program/<id>/reference` — now returns `{source: 'custom', custom_reference_id, name, ...}` when overridden, else the auto reference with `source: 'auto'`
- **UI:** "References" button in the header opens a modal for upload/list/delete. On each program's Reference tab, a **Reference source** dropdown picks `Auto (Boston / CIM history)` or any custom ref. Changes POST the override and immediately reload the tab. The Compare tab works against whichever source is active.
- **Static site:** `export_static.py` bakes overrides into `reference.json` (the override's HTML replaces the auto-derived ref for that program_id). The References button + modal are stripped from the exported HTML since the static site has no upload backend. `window._staticMode = true` is set in the static override bundle so the override-source dropdown also doesn't render.

### Metadata Preservation (prevents transient-failure data loss)
`upsert_program` and `upsert_course` now preserve existing metadata (`college`, `department`, `degree`, `banner_code`, `curriculum_html`, `date_submitted`, `program_type` / `code`, `title`, `credits`, `description`, `academic_level`) when the scraper returns an empty value. Rationale: a scan that runs during a transient CourseLeaf session expiration previously wrote empty strings over hundreds of programs' good data. Empty values are now treated as "no new info" rather than "clear existing." Core fields (`status`, `current_step`, workflow steps) are still always overwritten since those drive correctness.

### Single-Open Row Behavior
Expanding one program/course row automatically collapses any other open row (`toggleRow` clears `expandedRows` before adding the new ID). Clicking the same row still collapses it normally. This prevents a cluttered view when browsing many programs.

### Approver Count Consistency
`get_current_approvers` and `get_course_current_approvers` require the program/course's `current_step` to be non-empty. Without this, the dropdown count could exceed the actual filter result count when stale `workflow_steps` rows lingered from programs whose `current_step` was wiped by a past session-expiration scan. A one-off SQL cleanup also cleared 65 stale `step_status='current'` flags.

### Subject Code Filter (Courses view)
Additional dropdown between College and Campus on the Courses view. Populates with the letter prefix of each course code (e.g., `CAEP 6326` → `CAEP`). Hidden on Programs view; cleared when switching views. `populateCourseSubjectFilter()` builds the dropdown from `allCourses`.

### Unified Button Styling
Type filter (`.type-btn`), Smart View (`.smart-view-btn`), Programs/Courses toggle (`.toggle-btn`), and the proposal "All" (`active-all`) buttons now share the pipeline-style active state: light-blue fill (`#eff6ff`), blue border (`var(--accent)`), blue text. The Proposal buttons retain their semantic colors for New (green), Edited (blue), and Inactivated (red) since those convey meaningful status. This was a consistency fix — previously type/smart-view used solid black and courses/programs used a segmented-control pill.

### Regulatory Tab (approved-courses check)
Fourth tab on each program's expandable row (shown only for programs at the seven regulatory campuses with a matching SharePoint workbook on file). Flags each course in the current proposal against a per-campus "Approved Courses" workbook maintained by Global Regulatory Affairs.

- **Source files:** SharePoint folder `GlobalRegulatoryAffairs/Shared Documents/Resources/Master Portfolio/CURRENT APPROVED CURRICULUM`. Seven `.xlsx` workbooks — one per regulatory campus:
  - `BC Approved Courses.xlsx` → Vancouver
  - `FL Approved Courses.xlsx` → Miami
  - `ME Approved Courses.xlsx` → Portland
  - `NC Approved Courses.xlsx` → Charlotte
  - `Ontario Approved Courses.xlsx` → Toronto
  - `VA Approved Courses.xlsx` → Arlington
  - `WA Approved Courses.xlsx` → Seattle
- **Workbook shape:** one sheet per program. Row-0 col-A is the full program title; row-0 col-D is an "Edited by … on …" provenance string. Row 1 has the column headers (`Course #`, `Course Title`, `SH` or `QH`, optional `Notes`). Section rows appear as text-only rows in col A ("Core Requirements", "Electives", "Theory and Security", etc.). Each course row has `code`, `title`, `credit hours`, `note`.
- **Download:** The scraper uses the logged-in Chrome session on the SharePoint site (match substring `sharepoint.com/sites/GlobalRegulatoryAffairs`). SharePoint's REST endpoint `/_api/web/GetFileByServerRelativeUrl('<path>')/$value` returns the `.xlsx` bytes; Python pulls them in base64 chunks via AppleScript (same pattern as `fetch_reference_curricula`). All 7 files download in parallel per scan (~1.3 MB total).
- **Parser (`xlsx_parser.py`):** Pure stdlib (`zipfile` + `xml.etree`). `parse_workbook(bytes_or_path)` returns a list of `{sheet_name, title, edited_by, unit_header, courses, sections}`. Section tracking: rows with text only in col A and no course-code pattern become the `current_section`; subsequent course rows inherit that section.
- **Sheet → CIM program matching (`match_sheets_to_programs`):**
  - Scope is per workbook (one workbook ↔ one campus).
  - For each sheet, build a "stem" + degree bucket from the row-0 title if it looks like a program name (contains "Master"/"Bachelor"/"Doctor"/"Certificate"); else fall back to the sheet tab name (stripping `VAN `/`TOR ` etc. campus prefix).
  - Normalize: lowercase → strip head phrases (`master of science in`, `doctor of philosophy in`, `master of public administration`, …; longest-match wins; bare `master of` / `doctor of` / `bachelor of` kept as generic prefixes so the subject remains) → drop degree-acronym tokens (`MS`, `MSCS`, `MSIS`, `MSECE`, `MPS`, `MPA`, `MPP`, `MPH`, `MBA`, `PhD`, `EdD`, `CERTG`, `CAGS`, …) → drop stop words (`with`, `major`, `in`, `of`, `for`, `and`, `the`, …) → drop numeric credit hints (`32sh`, `45qh`).
  - Degree buckets keep `MS`/`MSCS`/`MSIS`/`MSECE`/`MPS` together (all Master of Science family) while separating `MPA`, `MPP`, `MPH`, `MBA`, `PhD`, `EdD`, `BS`, `CERT`. Mismatched buckets never match — this prevents "Computer Science, MSCS" from matching a "PhD Computer Science" sheet.
  - Suffix tokens (`align`, `connect`, `bridge`, `advanced`, `entry`) must match exactly so program variants (`MS—Align`, `MPS—Connect`, `MSIS—Bridge`) stay distinct.
  - Scoring: exact stem → 1.0; Jaccard ≥ 0.8 → that score; subset with ≥2 tokens → 0.75; single-token subset with matching degree bucket → 0.70; else 0. Confidence under 100% is surfaced on the tab header so the user can audit fuzzy matches.
  - **SH vs QH tiebreak** (Ontario Project Management has both): when multiple sheets score equally, the one whose course codes overlap most with the CIM proposal's `curriculum_html` wins. The Toronto PM program is switching quarters → semesters, so Semesters (SH) and Quarters (QH) workbooks each fit a different cohort's proposal and course-code overlap picks the right one automatically.
  - **Placeholder sheets are skipped** (A1 starts with `"As of"`, `"TBD"`, or `"Course #"`) per explicit project preference.
  - **Unmatched programs hide the tab** (no "missing" state is shown to the user).
- **Database:** `regulatory_approved_courses` table (`program_id` PK, `campus`, `source_file`, `sheet_name`, `sheet_title`, `edited_by`, `unit_header`, `confidence`, `match_reason`, `courses_json`, `sections_json`, `fetched_at`). Functions: `upsert_regulatory_approved()`, `delete_regulatory_approved()`, `get_regulatory_approved()`, `get_all_regulatory_approved()`. Programs that lose their match on a subsequent scan have their row deleted.
- **Scraper integration:** `fetch_regulatory_approved(program_ids)` in `scraper.py` runs after `fetch_reference_curricula()` during every scan (`app.py` `do_scan`). Pulls all 7 workbooks in parallel, parses each, scopes CIM programs by campus-in-name parenthetical, and upserts matches. Any failure (SharePoint tab closed, session expired) logs a warning and skips the step — it never blocks programs/courses/reference. `REGULATORY_CAMPUS_FILES` (campus → filename dict) and `_REGULATORY_FOLDER_URL` at the top of `scraper.py` are the single points of control if the files move.
- **API:** `GET /api/program/<id>/regulatory` returns `{available, campus, source_file, sheet_name, sheet_title, edited_by, unit_header, confidence, match_reason, fetched_at, courses, sections}` or `404` with `{available: false}`. `/api/programs` now includes a `has_regulatory` boolean on each program so the frontend can show/hide the tab without a probe.
- **Frontend (`static/app.js`):**
  - `loadRegulatoryDetail(programId)` loads the current proposal curriculum + regulatory data, extracts proposal courses via `extractCourseLines()` (shared with Compare tab), then flags each:
    - **Plain**: code is on the approved list and, if a semantic section is given, in a matching section.
    - **Amber** (`regflag-moved`): code is on the approved list but in a different semantic section than the proposal places it.
    - **Red** (`regflag-missing`): code is not in the approved list at all.
  - Approved-list sections may list the same course under multiple sections (range summaries etc.); the matcher therefore tracks `code -> Set(normalizedSection)` and accepts a proposal section that matches any one of them.
  - `normalizeSection()` uses `standardizeHeader()` (the Compare tab's helper) to map "Core Requirements"/"Required Courses"/"Program Requirement" → "Required Courses" etc., and returns `''` for range-style labels like `CS 5100-CS 7880` so they don't trigger false "moved" flags.
  - Header summary at the top: `<source file> · <sheet name> · Edited by …` then three badges (`N approved`, `N in different section`, `N not on approved list`) plus the total size of the approved list. Match-confidence below 100% is shown as a small pill so the user can see when the sheet-to-program match was fuzzy.
  - Tab button rendered only when `program.has_regulatory === true`.
- **Static site:** `export_static.py` writes `regulatory.json.enc` alongside the other encrypted data files (lazy-loaded on first tab expand; registered in the gate's `ENC_FILES` set). The override `window.loadRegulatoryDetail = …` in `build_static_js()` reads from `regulatory.json` instead of hitting the API. The `has_regulatory` flag is baked into `data.json` by `export_data()` so the tab button's visibility matches Flask mode.
- **Failure modes (graceful):**
  - SharePoint tab not open in Chrome → download step logs a warning and skips the campus; existing `regulatory_approved_courses` rows stay untouched (scan before/after behavior the same).
  - SharePoint session expired → 401 response → same as above.
  - Workbook file removed from SharePoint → the campus's download returns an error, any existing rows for that campus stay. (If the workbook *is present* but empty/new-shaped, unmatched CIM programs' rows get cleared, so the tab cleanly disappears.)

### Historical programs & courses + Complete button
Both Programs and Courses views have a **Complete** button at the right end of the proposal-type row (All / New / Changes / Inactivations / **Complete**). Clicking it filters the table to programs (or courses) that have fully completed the CIM workflow. The Complete button is a workflow-state toggle that lives alongside the proposal-type filters but is a separate dimension — it doesn't replace the active proposal-type filter. Active state uses the green `.active-complete` style.

- **DB:** `programs.completion_date` and `courses.completion_date` (both TEXT, nullable). `programs.campus` captures the XML `<campus>` code so we don't have to re-parse the name. `get_all_programs()` and `get_all_courses()` both return rows that have either a non-empty `current_step` OR a non-empty `completion_date` — the frontend hides completed items by default and shows them only when the Complete button is active.
- **Scraper completion detection:** in `run_full_scan` (programs) and `process_course_scans` (courses), an item is flagged complete when `total_steps > 0` AND `completed_steps == total_steps` AND the workflow HTML has no `current` step. The regular discovery path rarely catches completions (completed items drop off the Approve Pages queue), so the **historical sweep** is the authoritative ingester of completed items.
- **Reconciliation: which source wins.** CIM has two views of a program's workflow state. Both can be wrong; both can disagree. We've burned hours flip-flopping which to trust, so this section is now the single decision record. **Don't re-derive this from scratch — read it, then update it if you need to change the policy.**

  **Sources:**
  1. **Per-program workflow div** — at `/programadmin/{id}/`, look for `<div id="workflow">`. Its `<li class="current">` marker. Can lag (the marker stays on the previous step for hours after a reviewer approves) and CIM can have it stale.
  2. **Approve Pages role queue** — at `/courseleaf/approve/?role=X`, the live pending list. What reviewers actually see and act on.

  **Policy (as of 2026-05-20): Approve Pages is the authoritative source. Period.** The workflow div is informational only — used for metadata extraction (step names, approver emails, dates), never to override `current_step`.

  | Signal | Action |
  |---|---|
  | Program appears in live Approve Pages queue for role Y | Set `current_step = Y`. |
  | Program is in DB at role Y but Approve Pages no longer surfaces it anywhere | Clear `current_step` (program moved off all visible queues — completed, withdrawn, or at a non-iterated obscure role). |
  | New program in Approve Pages but not in DB | Batch-fetch full metadata, insert with `current_step = Y`. |

  **No more workflow-div fallback.** Earlier policies cross-checked Approve Pages results against the per-program workflow div, "correcting" Approve Pages when the workflow div disagreed. That hid CIM's actual state from the dashboard: the workflow div is often stale relative to Approve Pages, and reviewers' authoritative view IS Approve Pages.

  **Safety net retained.** Heal aborts the wipe if the live scrape returns implausibly few programs (<25% AND <50 absolute, gated on db_active ≥ 200) — protects against transient AppleScript / tab-throttle failures.

  **Why this policy** (we've flip-flopped on this; here's the history):
  - **First inversion** — trusted Approve Pages over the workflow div. Hit the stale-cache bug where `showPendingList()` doesn't clear the previous role's content; programs got reassigned to wrong roles.
  - **Second inversion** — trusted the workflow div's `class="current"` marker. Hit the marker-lag bug: after a user approves a program, CIM updates its approval log immediately but the marker can stay on the previous step for hours.
  - **Third inversion** — trusted the approval-log walk. Worked for linear workflows but missed parallel branches.
  - **Fourth inversion** — Approve Pages with workflow-div override for "stale role queue" cases. Caused the symmetric bug: programs that genuinely moved on still showed at their old role because the workflow div was stale.
  - **Current (correct, 2026-05-20)** — Approve Pages, full stop. Workflow div is data, not arbiter. The showPendingList stale-cache bug is mitigated by **navigation-per-role** in `scrape_approve_pages_role()` (see below) — each role query now navigates the tab to `?role=X` for a fresh server-rendered page rather than mutating the existing DOM in-place. No more cross-role DOM contamination.

  **`scrape_approve_pages_role(role_name)` implementation:**
  - Navigates the Approve Pages tab to `/courseleaf/approve/?role=<encoded_role>` (full page reload).
  - Waits 2s for the page to start loading.
  - Polls `document.body.innerText` for `^/programadmin/(\d+):` lines on the freshly-loaded page.
  - Bails on empty after 12 stable polls + ≥7s elapsed; hard ceiling 20s.
  - Cost: ~2–3s per role query (page reload + poll wait). For a full heal iterating ~215 live-dropdown roles, that's ~7–10 min added vs the old in-place mutation approach.
  - Trade-off: previously the in-place showPendingList approach could leave the DOM in a partially-rendered state that persisted across queries, causing some role lookups to return stale data even after the polling timeout was already extended. Navigation eliminates that class of bugs entirely.

  **Quick-update preservation (force_fetch_only mode):** quick role updates run between full scans for fast role-transition publishing but skip A1 Approve Pages discovery. They reach the workflow-div-walk branch of Step 3 reconciliation with `from_approve_pages=False`, which historically clobbered Approve Pages-set `current_step` values when the walk's linear-branch result disagreed. The dashboard saw 9 programs at Program Graduate Provost Review become 1 within a few quick updates: 8 were Vancouver / regulated-campus programs whose linear branch sits at GRA Regulatory steps while CIM simultaneously pends them at Graduate Provost Review (parallel branch). The walk locked onto the linear branch and overwrote the parallel-branch role.

  Fix (in `run_full_scan` Step 3, inside the `force_fetch_only` block): when the walk's `current_step` differs from the existing DB `current_step`, two preservation cases trigger:
  - **Case A — existing step not in workflow div at all:** parallel-branch / obscure-role assignment that the linear walk can't see. Preserve existing.
  - **Case B — walk's step is *earlier* in workflow order than existing step:** the walk is regressing the program; in quick updates we never regress. Genuine rollbacks get picked up by the next full discovery scan within 50 min. Preserve existing.

  Forward advancement (walk's step at same or later order than existing step) flows through unchanged so legitimate transitions ("Provost Approval → Faculty Senate") still publish to the dashboard between full scans.

  **Code locations:** policy implemented in:
  - `scraper.py` `scrape_approve_pages_role()` — navigation-per-role extraction
  - `scraper.py` `heal_stale_program_steps()` — Approve Pages is truth; no workflow-div override; clear `current_step` unconditionally for DB programs not in any live queue (subject to the 25% safety net)
  - `scraper.py` `run_full_scan()` Step 3 — same policy in regular scans

- **Source of truth for `current_step`** (TL;DR of above): Approve Pages role discovery when available; walk the approval log as fallback for programs Approve Pages didn't surface.
- **Heal: mirror DB to live Approve Pages — `heal_stale_program_steps()` / `heal_stale_course_steps()`:** both iterate the **live** dropdown via `get_all_approve_roles()` (~215 entries; falls back to `ALL_ROLES` / `COURSE_TRACKED_ROLES` if the live fetch fails), query each role's pending list via `scrape_approve_pages_role()` / `scrape_courses_from_role()`, build a `pid → role` map, then:
  1. For each `(pid, role)` in the live map: ensure the DB row's `current_step = role`. Brand-new programs (in live, not in DB) are batch-fetched once for full metadata.
  2. For DB rows with a non-empty `current_step` whose ID is NOT in the live map: clear `current_step` (the program has moved off every queue — gone from CIM's reviewer view).
  Each role query uses an async poll-until-stable loop (CourseLeaf populates the list via XHR). The empty-list short-circuit (5 stable polls + ≥3s elapsed) is essential because most of the 215 roles are empty most of the time — without it, total runtime balloons to 30+ min. With it, ~6 min per heal.
  - **Why the live dropdown, not a hardcoded list:** the program heal originally iterated only the hardcoded `ALL_ROLES` (46 entries: 14 tracked pipeline + 32 college roles). That missed ~169 narrow roles like `Program MI Graduate Curriculum Committee Chair`, `Program Workflow Setup`, `Program Catalog Setup 2`, `Program Graduate LW Degree Audit`, etc. — programs sitting at any of those got their `current_step` cleared on every heal because the heal couldn't observe them, then the next full scan would re-set it from the workflow HTML, then the next heal would clear it again. A user noticed `Educational Leadership, MA (Oakland)` (id 1350) at `Program MI Graduate Curriculum Committee Chair` was invisible in the dashboard despite being in workflow. Fixed by switching to the live `get_all_approve_roles()` list. ~70 programs were affected.
  - **Safety net:** if the live scrape returns implausibly few items relative to the DB's known-active count (default <25% and <50 absolute, gated on db_active ≥ 200), the heal aborts with a warning instead of wiping `current_step` for hundreds of programs. Catches transient AppleScript timeouts that would otherwise produce empty-`live_assignments` and a catastrophic data wipe.
- **On-demand heal endpoint:** `POST /api/heal` runs `heal_stale_program_steps` then `heal_stale_course_steps`. Body: `{"scope": "programs"|"courses"|"both", "deploy": true|false}`. The "Update Now" dashboard button posts `{scope: "both", deploy: true}` so it re-syncs and re-deploys in one click. Status is exposed via `/api/scan/status` (sets `running: true` while heal is in flight).
- **Historical sweep — `sweep_all_program_ids()` / `sweep_all_course_ids()`:** walk every CIM ID in a range (default programs 1..2100, courses 1..25000), fetch each via `batch_fetch_program_details` / `batch_fetch_course_details`, and upsert both active and completed items. Treats any item without a workflow div as completed/historical (CIM only renders the workflow during an active proposal). Surrogate completion dates:
  - Programs: `"Catalog 2025-2026"` from XML `<eff_cat>`
  - Courses: `"Term 202630"` from XML `<eff_term>` (CIM course XML doesn't expose `<eff_cat>`)
  - Falls back to `"Approved"` when neither is present.
- **Bootstrap CLI (`bootstrap_history.py`):** one-shot wrapper around the sweep functions.
  - `python3 bootstrap_history.py` — programs (1..2100), ~7 min
  - `python3 bootstrap_history.py --courses` — courses (1..25000), ~30–45 min
  - `python3 bootstrap_history.py 1 500` or `--courses 1 500` — subset
- **Weekly auto-refresh:** `run_full_scan` (via `app.py` `do_scan`) checks both sweep sentinels and re-runs either sweep when its last run was ≥ 7 days ago. Sentinel for programs: `scans.programs_scanned = -1`. For courses: `course_scans.changes_detected = -1`.
- **Async fetch everywhere:** Chrome 147+ silently blocks synchronous XHR in main-thread documents. `batch_fetch_program_details`, `batch_fetch_course_details`, `_search_cim_for_boston_ids`, and `check_courseleaf_session` all use the `fetch` + Promise.all + holder-div + poll pattern that `fetch_reference_curricula` already used.
- **Frontend:**
  - Complete button rendered in `templates/dashboard.html` as the 5th `.proposal-btn` (id `btn-proposal-complete`); click handler is `togglePipelineFilter('__complete__')`. `updateProposalCounts` special-cases it so it shows `Complete (N)` without going through the proposal-status label map.
  - `pipelineFilter === '__complete__'` filters the table to rows where `completion_date` is set. The default view (no pipeline filter) explicitly hides completed rows so they don't bleed into the active pipeline.
  - Row rendering for completed items: 100% green progress bar (`.progress-fill.complete`), Current-step cell shows "Approved" muted, Days cell shows the formatted completion date in a green pill (`.days-at-step.complete`). Row keeps its New/Edited/Inactivated left border.
  - `formatCompletionDate(s)` helper handles ISO / CIM GMT format / `"Catalog YYYY-YYYY"` / `"Term YYYYTT"` / `"Approved"` verbatim.
  - Regulatory tab flows through unchanged — completed programs at regulatory campuses still get their approved-courses flagging.
  - Courses view: completed courses show up in the Complete filter but don't get Reference / Compare / Regulatory tabs (those are program-only; courses only have Workflow).

### Catalog Pages View
A third entity type alongside programs and courses. Catalog pages are individual catalog sections (academic policies, department overviews, shared content blocks, etc.) that flow through the **UCAT** (undergraduate catalog) and **GCAT** (graduate catalog) approval roles in CourseLeaf.

- **Identifier:** unlike programs/courses (numeric IDs), catalog pages are identified by **path** — e.g. `/graduate/mills`, `/shared/course-credit-sharing`. The path is the primary key in the `catalog_pages` table (`id TEXT PRIMARY KEY`).
- **No per-page admin URL.** CourseLeaf has no `/pageadmin/{id}/`-style endpoint for catalog pages, so we don't fetch a workflow div per page. The Approve Pages pending list IS the entire workflow state we track: path + title + role + approver name. (Probed all the obvious step= variants on `courseleaf.cgi` — they return `Couldn't open step file: /owners`.)
- **DB tables:** `catalog_pages` (id, title, current_step, current_approver_emails, user, first_seen, last_updated) and `catalog_scans` (sentinel rows for "Updated" label).
- **Tracked roles (`scraper.CATALOG_TRACKED_ROLES`):** the 30 UCAT* and GCAT* roles in CourseLeaf's dropdown (UCAT BA Editor, UCAT Provost Approval, GCAT CS Editor, …, GCAT Provost Approval, etc.).
- **Scraper:** `scrape_catalog_pages_from_role(role)` selects a UCAT/GCAT role on the Approve Pages tab and parses pending-list lines like `/graduate/mills: Mills College at Northeastern\tHeather Daly`. Same poll-until-stable async pattern as the program/course scrapers; explicitly excludes `/programadmin/` and `/courseadmin/` lines so it doesn't pick up the wrong entity.
- **Heal:** `heal_stale_catalog_pages()` mirrors live UCAT/GCAT pending lists into `catalog_pages`. For each role, builds `path → role` map, upserts rows, clears `current_step` for paths no longer in any list. ~3 min for 30 roles.
- **API:** `GET /api/catalog` (all pages), `GET /api/catalog_pipeline` (per-role counts).
- **Update Now / scheduled scan:** `/api/heal` accepts `scope: 'catalog' | 'all'` (default `'all'` covers programs + courses + catalog). `do_scan` runs `heal_stale_catalog_pages` after the course scan.
- **Frontend:**
  - Header has a third toggle button — **Catalog** — alongside Courses and Programs (`switchView('catalog')` in `static/app.js`).
  - When active, type / proposal / campus / subject / step filter sections are hidden (none of those concepts apply to catalog pages, and Step is redundant with the pipeline tile row).
  - College and Approver dropdowns ARE shown and DO work:
    - **College** (`populateCatalogCollegeFilter`): derived from the second URL path segment via `CATALOG_COLLEGE_MAP` — e.g. `/graduate/social-sciences-humanities/...` → CSSH; `/professional-studies/...` → CPS; `/shared/...` → "Shared Content"; non-college paths (`academic-policies-procedures`, `university-academics`, `gordon-institute`, etc.) → "University-wide". Counts shown in the dropdown options.
    - **Approver** (`populateCatalogApproverFilter`): unique values from the catalog rows' `user` field (the approver name CIM shows in Approve Pages). Heather Daly handles most of the load.
  - Both dropdowns flow through `getCatalogBaseFiltered()` and `renderCatalogTable()` so they cross-filter with the pipeline tiles.
  - **Pipeline bar** shows two virtual buckets and one tile per CATALOG_BUCKETS entry. The first tile is "College" — collapses every pre-Provost editor role (UCAT BA Editor, GCAT CS Editor, etc.) into one bucket. Then `GCAT Provost`, `UCAT Provost`, `Records Review`, `Deputy Reg`, `Reg Approval`, `Shared Reg`, `Editor`, `Final Review` (the post-Provost workflow stages from `CATALOG_BUCKETS`).
  - Table columns: Title (link to the live catalog URL embedded), Current Role, Approver. No expandable rows yet (catalog pages don't have Workflow / Curriculum / Reference / Compare tabs).
  - The "Complete" button is hidden on catalog view (no completion concept).
- **Static export:** `data.json` includes `catalog_pages` and `catalog_pipeline`. The static-mode `loadCatalogDashboard` override calls both `populateCatalogCollegeFilter` and `populateCatalogApproverFilter` so the GitHub Pages site behaves identically to the Flask version.

### Portfolio View
Fourth tab alongside CIM Programs / Courses / Catalog. A cross-system program portfolio that merges four data sources and surfaces tracking status, market scoring, and CIM workflow state for every program in the university's portfolio.

**Data sources (merged by `portfolio_ingest.py`):**
1. **CIM programs table** — ALL programs (active + completed history); the authoritative seed
2. **SVT Roster TSV** — GLS/SVT Roster of Record statuses; fetched live from Smartsheet via Chrome
3. **IPD Smartsheet TSV** — IPD development status; fetched live from Smartsheet via Chrome
4. **OTP Excel** (sheet "OTP Program Tracking") — market/approval status; Boston-only; will be deprecated
5. **GLS Tableau CSV** — GLS per-campus status data; fetched live from Smartsheet via Chrome
6. **2025 Scoring Excel** — market/performance scoring; Boston-only; supplementary

All feed files are saved to `data/portfolio_feeds/` inside the project directory (never `~/Downloads/`).

**Automatic update, rate-limited to once per hour:** `fetch_portfolio_data.py` runs first (re-downloads all feeds via Chrome), then `portfolio_ingest()` is called inside `do_scan()` after the scraper completes, *before* the fingerprint check. The whole portfolio step is gated by a `data/last_portfolio_fetch` timestamp (skip if < 1h old; the timestamp only advances on a successful feed download, so a failed pull retries next scan). `portfolio_programs` is included in `compute_db_fingerprint()` so portfolio changes trigger a static re-export + git push. (Previously this ran on every scan — changed to hourly on 2026-05-31 to shave ~30-60s off the typical 5-min scan; delete `data/last_portfolio_fetch` to force a refresh sooner.)

**Ingest algorithm (CIM-seed approach):**
1. **Step 0 — CIM seed**: Query all programs WHERE `current_step IS NOT NULL` OR `completion_date IS NOT NULL`. Deduplicate by name (prefer active proposal, then highest id). Build `cim_exact_index` keyed by (norm_subject, norm_degree, norm_campus) and `cim_nameDeg_index` keyed by (norm_subject, norm_degree). This is the complete portfolio — external sources only update existing entries or add genuinely new programs.
2. **Step 1 — SVT overlay**: For each SVT entry, look up CIM by (subject, degree, campus). Match → update `svt_status`/`roster_*` fields. No match AND valid degree → add new tracker entry. No match AND no valid degree → mismatch. Multi-campus entries (e.g. "X, Boston and Oakland, GC") are expanded into one virtual entry per campus via `_expand_multi_campus` before matching.
3. **Step 2 — IPD overlay**: Exact match → update `ipd_status`. Name+degree match with campus in tracker → update. Name+degree match with campus NOT in tracker + proposal is Launch/Deploy → add new entry. Otherwise → mismatch. Multi-campus names are expanded similarly.
4. **Step 3 — OTP overlay (Boston-only)**: Match → update `otp_*` fields. No match → mismatch. OTP names are pre-processed by `_preprocess_otp_name()` to expand abbreviations (Mgmt→management, &→and, Quant→quantitative, etc.) before matching.
5. **Step 4 — GLS overlay**: Campus-aware Jaccard word-overlap matching against tracker rows.
6. **Step 5 — 2025 scoring**: Boston-only; supplementary; no mismatch logging.

**Campus normalization — all online variants are one campus.** `_normalize_campus()` collapses every online deployment to the single campus name `Online`. That includes `Online`, `Primarily Online`, `Online - Vancouver Requirements`, `Primarily Online - Vancouver Requirements`, `Online - deactivated duplicate record`, and any future `Online - <anything>` / `Primarily Online - <anything>` variant (handled by a lowercase-prefix fallback in `_normalize_campus()`). Do not split these back out into separate campuses — they are one campus in the Portfolio. The lowercase-prefix fallback is the guardrail: even if a new suffixed variant appears in a feed, it stays merged.

**College normalization (single source of truth):** `_normalize_college(name)` is the **only** function that should ever write to a portfolio row's `college` field. External feeds (SVT Roster, IPD Smartsheet, OTP, GLS) supply the college as an abbreviation ("CPS", "CSSH", "Bouve", "Khoury", "DMSB"), as the wrong column entirely (IPD proposal-type leaks like "Deploy Program to Network" and "Launch term change request"), or as a campus name. Without canonicalization the Portfolio College filter accumulates duplicate options ("Bouve" + "Bouve College of Hlth Sciences" → two separate dropdown rows that both render as "BVE" once the frontend abbreviates them) and bogus options ("Deploy Program to Network"). `_normalize_college()` runs every value through `_COLLEGE_ALIASES` (acronym → canonical full name) and `_COLLEGE_BLOCKLIST` (non-college junk → empty string), and it's called from `_make_row()` (covers all SVT-added and IPD-added new rows) plus every per-overlay assignment site (SVT loop, IPD loop, OTP loop). If you add a new feed or a new assignment site, route it through `_normalize_college()` — *do not* assign `row['college'] = p['some_field']` directly.

**Non-program detection:** `_is_non_program(name)` checks entries from SVT and IPD before matching. Entries matching `_NON_PROGRAM_RE` (boot camps, badges, non-credit, chaplaincy, pilot AI coaches, apprenticeships, workforce re-entry, etc.) or `_COURSE_CODE_RE` (e.g. "ALY 6040") or containing semicolons or matching `_MULTI_PROG_DEGREE_RE` (two degree tokens around "and", e.g. "MSIS and MSIS Bridge In Miami", "MS CEE and MS BIOE in TOR") are routed to a separate `non_programs` list in `portfolio_mismatches.json`.

**Key columns in `portfolio_programs` table:** `id` (TEXT PK, either `cim_{id}` or a name-based slug for SVT/IPD-added entries), `program_name`, `college`, `campus`, `cim_program_id` (FK into `programs.id`), `cim_step`, `cim_change_type` (New/Change/Inactivation), `cim_completion_date`, `otp_status`, `ipd_status`, `roster_status`, `roster_launch_date`, `market_2025`, `performance_2025`, `market_score_2025`, `performance_score_2025`.

**Matching logic:**
- CIM names are in `"Subject, Degree (Campus)"` format. Both exact (3-tuple subject/degree/campus) and name+degree-only (2-tuple) indexes are built.
- `_norm_subject()` normalizes dashes, converts `&` → `and`, collapses whitespace.
- `_norm_degree()` handles long-form ("Master of Science" → "MS"), removes dots ("M.S." → "MS"), normalizes em-dash/en-dash to hyphen (so "MS—Align" and "MS-Align" produce the same key "ms-align"), and preserves specific codes (MSCS ≠ MS).
- External source names are parsed by `_parse_external_name()` which tries in order: long-form prefix ("Master of Science in X" → MS + X), short prefix ("MS X"), CIM format ("X, MS"), trailing Graduate Certificate, trailing short degree, fallback. Additional normalizations: strips `"at Roux"` suffix and sets campus=Portland; strips leading `"Online"` prefix before degree (e.g. "Online MS Business Analytics" → degree="MS-Online", "Online Graduate Certificate in X" → degree="Graduate Certificate-Online"); recognizes `"Master of <Field> (<Abbrev>) in <Subject>"` (e.g. "Master of Design (MDes) in Sustainable Urban Environments (SUEN)" → degree="MDes", subject="Sustainable Urban Environments"); strips leading `"- descriptor"` from subject after long-form match (e.g. "Doctor of Professional Studies - New Concentrations" → subject="" → implicit "Professional Studies"); strips `"- descriptor"` from degree in CIM-format path (e.g. "MS - new CAMD concentration" → "MS"); detects "DEGREE, Subject" swap (e.g. "MS, Occupational Therapy" → subject="Occupational Therapy", degree="MS"). `_DEPLOYMENT_SUFFIX_RE` detects deployment variants separated by dash, comma, "+", or plain whitespace for the named variants Connect/Bridge/Align/Accelerated/Part-Time/Full-Time (e.g. "Speech-Language Pathology Connect" → "Speech-Language Pathology" + Connect, "Information Systems + Bridge" → "Information Systems" + Bridge). "Online" requires a dash/comma/"+" separator (not plain whitespace) because the word appears in legitimate subject names.
- `_LONG_DEGREE_MAP` includes DPS (Doctor of Professional Studies) and DLP (Doctor of Law and Policy). `_DEGREE_IMPLICIT_SUBJECT` maps degree codes to implicit subjects when the source name has no subject (DPS → "Professional Studies", DLP → "Law and Policy").
- `_is_valid_degree()` rejects campus names (Boston, Oakland, etc.) via `_DEGREE_BLOCKLIST` even if they're all-caps. Allows hyphenated deployment degrees like "MS-ALIGN", "MPS-CONNECT" via regex `^[A-Z][A-Z0-9]{1,9}(-[A-Za-z][A-Za-z0-9-]*)?$`.
- `_lookup_cim()` has a deployment-suffix fallback: if degree has a hyphen (e.g., "MS-Align") and the exact key lookup fails, it retries with the variant moved into the subject first (`subject+"-variant"`, base_degree) — because some CIM programs store the deployment in the subject (e.g., `"Applied AI—Connect, MPS"`) rather than the degree — and only if that fails too, retries with just the base degree (no variant). Try order: variant-in-degree → variant-in-subject → base-degree-only. The variant-in-subject path must come before bare base-degree, otherwise a "MS-Connect at SV" lookup falls through to the unrelated base "MS at SV" program.
- **SVT name-rescue when banner-code campus mismatch:** the SVT loop's Path A (Program Code → CIM banner_code) used to fall straight back to Boston when no banner-code candidate matched the SVT row's campus. Now, before the Boston fallback, it attempts a `_lookup_cim(subject, degree, campus)` call using the parsed name. Catches the common case where CIM has the right campus deployment but its `banner_code` field is empty — so the row exists but isn't in `cim_banner_index`. Example: SVT "MPS in Applied AI, Silicon Valley" (code MPS-APAI) → no SV row in the banner index → rescue parses the name → finds CIM 1797 "Applied AI, MPS (Silicon Valley)" by (subject, degree, campus). Combined with the variant-in-subject fallback above, this also rescues SVT "MPS in Applied AI - Connect, Silicon Valley" → CIM 1804 "Applied AI—Connect, MPS (Silicon Valley)".
- `_is_non_program()` also flags multi-program bundles via `_MULTI_PROG_DEGREE_RE` — entries where two distinct degree tokens appear around "and".
- `_expand_multi_campus(name, source_campus)` splits entries with multiple campus names into one `(skeleton_name, campus)` pair per campus. E.g. "Urban Analytics, Boston, Arlington and Oakland, Graduate Certificate" → 3 entries, one per campus.
- `_best_guess()` uses Jaccard word-overlap (≥0.4 threshold) on the subject to find the closest CIM match for mismatch reporting.

**`portfolio_mismatches.json` output:** `{updated_at, non_programs, svt_mismatches, svt_added, ipd_mismatches, ipd_added, otp_mismatches, gls_mismatches}`. Read by `/api/console` and rendered in the Console modal's Portfolio Ingest Report section.

**Frontend badge logic:** `cim_program_id` set + `cim_change_type = 'Inactivation'` → red "Inactive" badge; `cim_program_id` set + other type → green "Active" badge; no `cim_program_id` → blank.

**Name normalization for display:** `normalizePortfolioName()` in `static/app.js` converts "Bachelor of Science in X" → "X, BS" etc.

**View persistence:** The active view (CIM Programs / Courses / Catalog / Portfolio) is saved to `localStorage['cim-active-view']` and restored on page load, so navigating away and back keeps the user's context.

**Concentration sub-rows (inheritance rules):** Concentrations under a parent program follow a strict inheritance + override pattern when their row is rendered (both for curriculum-extracted concentrations and for IPD-driven linked concentration sub-rows):

| Field | Source |
|---|---|
| **Credential (Degree column)** | Always **"Concentration"** — never the parent's degree |
| **College** | The concentration's own college if set (typical for Provost-owned programs whose concentrations live in subject-specific colleges like Khoury, CAMD, COE — see Bouvé AI MS concentration in CIM HTML, which sets its own college). Otherwise, **inherit the parent program's college**. |
| **Campus** | **Always inherit from the parent program** — concentrations are bound to the parent's deployment; they don't have an independent campus. |
| Everything else (OTP, IPD, SVT, GLS, CIM step, dates, etc.) | Rendered as `—` for curriculum-extracted concentrations; pulled from the linked portfolio row for IPD-driven sub-rows. |

Curriculum-extracted concentrations are stored in `concentrations_json` as `[{name, college}]` objects. The college is captured during extraction in `_extract_concentrations_from_html()` from headings like `"Foo Concentration — Coll of X"` or `"Foo Concentration - Coll of X"` (em-dash OR hyphen+space), normalized via `_normalize_college()` (which strips diacritics, handles `Health Sciences` ↔ `Hlth Sciences` and `Science` ↔ `Sciences` variants, and runs lookup through `_COLLEGE_ALIASES`). If the heading carries no college attribution, the field is left blank and the renderer falls back to the parent's college at display time.

The renderer that applies these rules:
- `renderPortfolioConcRow(name, search, college, parentCollege, parentCampus)` — curriculum-extracted concentrations. Effective college = `college || parentCollege`; campus = `parentCampus` always; degree cell = `'Concentration'`; other cells = `—`.
- `renderPortfolioRow(p, {isPortfolioConc: true, parent})` — IPD-driven linked sub-rows. Same college fallback (`p.college || parent.college`); campus override (`parent.campus`); degree cell forced to `'Concentration'`; other cells use the sub-row's own data.

This means a Provost-owned program like "Artificial Intelligence, MS (Boston)" — college "Office of the Provost" — expands to concentration sub-rows whose College column shows the *concentration's* college (Khoury, CAMD, BVE, COE, etc.), not "Provost". A program whose concentrations have no attribution simply shows the parent's college.

### Courses View
Parallel dashboard view for `/courseadmin/` proposals, alongside programs. Toggled via the Courses/Programs buttons in the header (Courses is now first).

- **Scraper:** `discover_all_courses()` iterates course-related roles on the Approve Pages tab. `batch_fetch_course_details()` issues synchronous XHRs to `/courseadmin/{id}/` (HTML) and `/courseadmin/{id}/index.xml` in batches of 25.
- **Raw-HTML extraction (critical):** `parseFromString('text/html')` produces a DOM without layout, so `doc.body.textContent` loses whitespace boundaries. The course scraper regexes run against `xhr1.responseText` directly for:
  - `Date Submitted:` — matches a nearby GMT-formatted date (RFC 822)
  - Proposal type — "New Course Proposal" → Added; "Inactivation" → Deactivated; else Edited
  - Approval history — all `([Weekday], DD Mon YYYY HH:MM:SS GMT) ... Approved for (step)` pairs; the last one becomes `last_approval_date` (when current step was entered)
- **step_entered_date priority:** `last_approval_date` → `date_submitted` → `now`. `upsert_course` overwrites an existing stale value when the scraper provides a historical date, so first-scan "now" defaults get corrected on subsequent scans.
- **Database:** `courses`, `course_workflow_steps`, `course_changes` tables. `courses` includes `credits`, `description`, `academic_level` (UG/GR/CP/GR-UG codes from XML).
- **Pipeline bucketing (display only):** `static/app.js` defines `COURSE_BUCKETS` that collapse many discrete role names into a handful of pipeline columns — `Checkpoint`, `Course Review` (Course Review 2/3 + PS Course Review), `Course Review Group` (anything starting with "Course Review Group", incl. "Complete - Hold"), `OTP` (any step starting with "Provost" or "Program Provost"), `Subcommittees` (Graduate Council Subcommittee One/Two + UUCC Subcommittee One/Two), `Grad Curric` (Graduate Curriculum Committee Chair + Undergraduate Curriculum Committee Chair), `GRA Regulatory` (Course GRA Regulatory Validation), `Data Entry` (any "Data Entry *"), `Registrar` (any "REGISTRAR *" + "Degree Audit Courses"), `Banner` (any "Banner *"), `Editor` (any "Editor *"). Everything else (department chairs, individual reviewers like "Tammy Dow", etc.) aggregates into `College` — `isCourseCollegeStep()` is a catch-all that returns true for any step not matched by an explicit bucket above. `collapseCoursePipeline()` also drops unbucketed server-side roles from rendering so they don't get noisy stand-alone tiles.
- **Course-level type filter:** `classifyCourseLevel()` maps `acad_level` codes to Undergraduate/Graduate/Continuing (CP), with a course-number fallback (1000–4999 UG, 5000+ GR). `GR-UG` / `UG-GR` → Graduate. A "Continuing" button appears on Courses view only.
- **Course table columns:** both programs and courses share the same 5-column table (Title / College / Current Step / Progress / Days). Column 2 header is always "College"; for courses, `classifyCourseLevel` is used for filtering but the displayed value is the abbreviated college name.
- **Approver filter isolation:** separate `/api/course_approvers` + `/api/course_approver/<email>` endpoints. The programs version was keyed by `program.id`, which collided numerically with course IDs, causing false-positive matches across views.
- **Row coloring:** same CSS classes (`row-added`, `row-edited`, `row-deactivated`) drive the colored left border for courses as for programs.
- **Static site:** `export_static.py` includes `courses`, `course_workflows`, `course_approvers` in `data.json`. `loadCoursesDashboard` and the approver filter are overridden to read from embedded data.
