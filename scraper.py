"""AppleScript-based Chrome scraper for CourseLeaf CIM data."""

import subprocess
import json
import re
import time
import os
import tempfile
from datetime import datetime

# Which browser AppleScript should drive. Defaults to Google Chrome:
# Chrome's AppleScript bridge is reliable for the long-running async JS
# fetches the scraper does (Edge throttles background-tab JS aggressively
# and stalls long batch operations). Override with
# BROWSER_APP="Microsoft Edge" if you want Edge anyway. Whichever browser
# is selected must be open with a logged-in CourseLeaf session in
# window 1, with the programadmin and courseleaf/approve tabs open.
BROWSER_APP = os.environ.get("BROWSER_APP", "Google Chrome")

from database import (
    init_db, upsert_program, upsert_workflow_steps,
    record_change, record_scan, get_all_programs,
    upsert_course, upsert_course_workflow_steps,
    record_course_change, record_course_scan, get_all_courses
)

# The 14 tracked workflow roles (from user's bookmarks)
TRACKED_ROLES = [
    "Program PR Graduate Dean's Office",
    "Provost Initial Review",
    "Program Review 2",
    "Program UIP College Approval",
    "Program Graduate Provost Review",
    "Program Graduate Curriculum Committee",
    "Program Undergraduate Curriculum Committee - Tabled Proposals",
    "Program Provost Administrative and Budgetary Review",
    "Program Provost Approval",
    "Program Faculty Senate",
    "Program University Board of Trustees",
    "Program Banner Setup",
    "Program Editor",
    "Program Catalog Setup",
]

# College-level roles (department chairs, college deans, program directors)
COLLEGE_ROLES = [
    "Program AFCS Program Director",
    "Program AM Graduate Dean's Office",
    "Program AM Graduate Program Review",
    "Program AM Undergraduate Curriculum Committee Chair",
    "Program AM Undergraduate Dean's Office",
    "Program AM Undergraduate Program Review",
    "Program AMSL Chair",
    "Program ARCH Chair",
    "Program ASNS Program Director",
    "Program BA Graduate Dean's Office",
    "Program CS Undergraduate Dean's Office",
    "Program EDU Program Director",
    "Program EECE Chair",
    "Program EN Graduate CHME Curriculum Committee Chair",
    "Program EN Graduate Dean's Office",
    "Program EN Undergraduate CHME Curriculum Committee Chair",
    "Program EN Undergraduate Dean's Office",
    "Program EN Undergraduate MEIE Curriculum Committee Chair",
    "Program ENGL Chair",
    "Program HIST Chair",
    "Program HUSV Program Director",
    "Program MSCI Accreditor Approval",
    "Program PPUA Program Director",
    "Program PS Graduate Dean's Office",
    "Program SC Graduate BIOL Curriculum Committee Chair",
    "Program SC Graduate Dean's Office",
    "Program SC Undergraduate Dean's Office",
    "Program SH Graduate CRIM Curriculum Committee Chair",
    "Program SH Graduate POLS Curriculum Committee Chair",
    "Program SH Graduate PPUA Curriculum Committee Chair",
    "Program SH Undergraduate POLS Curriculum Committee Chair",
    "Program SH Undergraduate SOCL Curriculum Committee Chair",
]

# All roles to scan
ALL_ROLES = TRACKED_ROLES + COLLEGE_ROLES

# Map CourseLeaf 2-letter college codes to full names (used by programs and courses).
COLLEGE_NAMES = {
    'AM': "Coll of Arts, Media & Design",
    'BA': "D'Amore-McKim School Business",
    'BV': "Bouve College of Hlth Sciences",
    'CS': "Khoury Coll of Comp Sciences",
    'EN': "College of Engineering",
    'LW': "School of Law",
    'MI': "Mills College at NU",
    'PR': "Office of the Provost",
    'PS': "Coll of Professional Studies",
    'SC': "College of Science",
    'SH': "Coll of Soc Sci & Humanities",
}

# Course pipeline: centralized workflow roles for courses (not college/department level)
# Everything not in this list is considered a college-level course role
COURSE_TRACKED_ROLES = [
    "Checkpoint",
    "Course Review 2",
    "Course Review 3",
    "Editor",
    "Course Review Group",
    "Course Review Group Complete - Hold",
    "Provost Initial Review",
    "Provost Committee Assignment",
    "Provost Continuing Education Module Oversight Group",
    "Provost Continuing Education Module Oversight Group Hold",
    "Graduate Council Subcommittee One",
    "Graduate Council Subcommittee Two",
    "Graduate Curriculum Committee Chair",
    "Course GRA Regulatory Validation",
    "PS Course Review",
    "Data Entry 1",
    "Data Entry 3",
    "Data Entry 3 - Awaiting Course Approval",
    "Data Entry 5 - Awaiting Program Approval",
    "Data Entry 8 - Hold PA courses",
    "Data Entry 9",
    "REGISTRAR Continuing Education Level Discussion",
    "REGISTRAR Digital Badge Setup",
    "REGISTRAR Digital Badge Setup Hold",
    "REGISTRAR Scheduling Office",
    "Banner - Prereq 2 Letter Course Number",
    "Banner",
]

COURSE_ROLE_SHORT_NAMES = {
    "Checkpoint": "Checkpoint",
    "Provost Initial Review": "Provost Init",
    "Provost Committee Assignment": "Provost Committee",
    "Provost Continuing Education Module Oversight Group": "Provost CE",
    "Provost Continuing Education Module Oversight Group Hold": "Provost CE Hold",
    "Course Review 2": "Review 2",
    "Course Review 3": "Review 3",
    "Course Review Group": "Review Grp",
    "Course Review Group Complete - Hold": "Review Grp Hold",
    "Course GRA Regulatory Validation": "GRA Reg",
    "PS Course Review": "PS Review",
    "Graduate Curriculum Committee Chair": "UGCC Chair",
    "Graduate Council Subcommittee One": "Grad Sub 1",
    "Graduate Council Subcommittee Two": "Grad Sub 2",
    "Data Entry 1": "DE 1",
    "Data Entry 3": "DE 3",
    "Data Entry 3 - Awaiting Course Approval": "DE 3 (Await)",
    "Data Entry 5 - Awaiting Program Approval": "DE 5 (Await)",
    "Data Entry 8 - Hold PA courses": "DE 8 (Hold)",
    "Data Entry 9": "DE 9",
    "REGISTRAR Continuing Education Level Discussion": "Reg CE",
    "REGISTRAR Digital Badge Setup": "Reg Badge",
    "REGISTRAR Digital Badge Setup Hold": "Reg Badge Hold",
    "REGISTRAR Scheduling Office": "Reg Sched",
    "Banner - Prereq 2 Letter Course Number": "Banner Preq",
    "Banner": "Banner",
    "Editor": "Editor",
}

# Short display names for the pipeline summary
ROLE_SHORT_NAMES = {
    "Program PR Graduate Dean's Office": "PR Grad Dean",
    "Provost Initial Review": "Provost Init",
    "Program Review 2": "Review 2",
    "Program UIP College Approval": "UIP College",
    "Program Graduate Provost Review": "Grad Provost",
    "Program Graduate Curriculum Committee": "Grad Curric",
    "Program Undergraduate Curriculum Committee - Tabled Proposals": "Tabled",
    "Program Provost Administrative and Budgetary Review": "Provost A&B",
    "Program Provost Approval": "Provost Appr",
    "Program Faculty Senate": "Faculty Sen",
    "Program University Board of Trustees": "Trustees",
    "Program Banner Setup": "Banner",
    "Program Editor": "Editor",
    "Program Catalog Setup": "Catalog",
}


# Catalog pipeline: UCAT (undergraduate catalog) + GCAT (graduate catalog)
# editor, review, and approval roles. Pages are identified by their catalog
# path (e.g. "/graduate/mills"), not by a numeric ID.
CATALOG_TRACKED_ROLES = [
    # Undergraduate catalog (UCAT*)
    "UCAT BA Editor",
    "UCAT Coop",
    "UCAT CRIM Editor",
    "UCAT CS Editor",
    "UCAT CSGS Editor",
    "UCAT EN Editor",
    "UCAT ENVR Editor",
    "UCAT INTL Editor",
    "UCAT MATH Editor",
    "UCAT PHIL Editor",
    "UCAT POLS Editor",
    "UCAT Provost Approval",
    "UCAT SC Editor",
    "UCAT SOCL Editor",
    "UCAT We Care",
    "UCAT WLAC Editor",
    # Graduate catalog (GCAT*)
    "GCAT CS Editor",
    "GCAT EN Editor",
    "GCAT ENGL Editor",
    "GCAT ENVR Editor",
    "GCAT Gordon Leadership",
    "GCAT HIST Editor",
    "GCAT LW Editor",
    "GCAT MATH Editor",
    "GCAT PHYS Editor",
    "GCAT POLS Editor",
    "GCAT Provost Approval",
    "GCAT PSYC Editor",
    "GCAT SH Review",
    "GCAT SOCL Editor",
    # Post-provost catalog workflow (shared across UCAT and GCAT)
    "REGISTRAR Records Review",
    "Deputy Registrar - Operations",
    "Registrar Approval",
    "Shared Content - Registrar Review",
    "Editor",
    "CAT Final Review",
]

CATALOG_ROLE_SHORT_NAMES = {
    "UCAT Provost Approval": "UCAT Provost",
    "GCAT Provost Approval": "GCAT Provost",
    "GCAT SH Review": "GCAT SH Review",
    "UCAT We Care": "UCAT We Care",
    "UCAT Coop": "UCAT Coop",
    "GCAT Gordon Leadership": "GCAT Gordon",
    "REGISTRAR Records Review": "Records Review",
    "Deputy Registrar - Operations": "Deputy Reg",
    "Registrar Approval": "Reg Approval",
    "Shared Content - Registrar Review": "Shared Reg",
    "Editor": "Editor",
    "CAT Final Review": "Final Review",
    # Editor roles all collapse into "<X>CAT <DEPT> Ed" via display rules
    # in the frontend; keep their full names here for accuracy.
}



def run_js_in_tab(tab_identifier, js_code, match_by='title', timeout=30):
    """Execute JavaScript in a Chrome tab via AppleScript using a temp file for complex JS."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.js', delete=False) as f:
        f.write(js_code)
        js_file = f.name

    if match_by == 'title':
        match_clause = f'if title of t is "{tab_identifier}" then'
    else:
        match_clause = f'if URL of t contains "{tab_identifier}" then'

    # Two-phase pattern: find the tab INDEX first (cheap, just URL/title
    # property reads), then issue `tell tab N of window 1 to execute
    # javascript ...` directly. Avoids holding a tab alias across the
    # `execute javascript` call — Edge's AppleScript bridge sometimes
    # times out on `tell currentTab to execute javascript` in the
    # middle of a repeat-with iteration. Chrome handles either form.
    if match_by == 'title':
        match_predicate = f'(title of tab i of window 1) is "{tab_identifier}"'
    else:
        match_predicate = f'(URL of tab i of window 1) contains "{tab_identifier}"'

    # Edge (and recent Chrome) throttle background tabs — JS execution
    # via AppleScript stalls on tabs that aren't active and/or when the
    # browser isn't frontmost. We try the cheap path first (no
    # activation, no flicker) and only fall back to activating + tab
    # switching when the cheap path times out. This means: when Edge
    # is the user's active app, scans run silently without stealing
    # focus or strobing tabs; when Edge has been backgrounded for a
    # while, the first call wakes the tab up.
    applescript_fast = f'''
    set jsCode to (read POSIX file "{js_file}" as text)
    tell application "{BROWSER_APP}"
        set tabIdx to 0
        set n to count of tabs of window 1
        repeat with i from 1 to n
            if {match_predicate} then
                set tabIdx to i
                exit repeat
            end if
        end repeat
        if tabIdx = 0 then return "TAB_NOT_FOUND"
        tell tab tabIdx of window 1 to execute javascript jsCode
        return result
    end tell
    '''
    def _run(script, tmo):
        return subprocess.run(
            ['osascript', '-e', script],
            capture_output=True, text=True, timeout=tmo
        )

    try:
        # Fast path only — never wake up Chrome's foreground.
        # The wakeup-path fallback (which switched the active tab inside
        # Chrome) was the source of continuous focus-stealing: Chrome's
        # background throttle made the fast path time out on most JS
        # calls during a scan, every fallback brought Chrome forward
        # for ~1s of JS execution, and across hundreds of calls per scan
        # the user experienced this as Chrome continuously stealing focus.
        # Dropping the fallback gives up at most one round-trip per
        # throttled tab; the scraper already handles None returns and the
        # next scan re-tries.
        result = _run(applescript_fast, timeout)
        os.unlink(js_file)
        if result.returncode != 0:
            return None
        output = result.stdout.strip()
        if output == "TAB_NOT_FOUND":
            print(f"  Tab '{tab_identifier}' not found")
            return None
        return output
    except subprocess.TimeoutExpired:
        os.unlink(js_file)
        return None
    except Exception as e:
        print(f"  Error: {e}")
        return None


def scrape_approve_pages_role(role_name):
    """Select a role on the Approve Pages tab and get pending programs with IDs.

    NAVIGATION-PER-ROLE: Before each query, navigate the Approve Pages tab to
    `?role=X` and let the page fully reload. CIM's `showPendingList(role)` JS
    function mutates the listing DOM in-place; after many sequential role
    queries, the DOM can drift into a state where some role queries return
    stale or partial data (observed: a deployment program at Provost Review
    that was missed entirely until we forced a Cmd-R on the tab). A full
    navigation gives each query a clean server-fresh DOM.

    Cost: each role query adds ~2-3s for page reload. With ~215 roles in a
    full heal, that's ~7-10 min extra wall-clock — accepted in exchange for
    consistency.

    Uses async poll-until-stable on the pending-list DOM after navigation:
    CourseLeaf still populates the list via AJAX after page load. We poll
    up to 20s for non-empty stability, or bail early after 12 consecutive
    empty polls + ≥7s elapsed (legitimately empty role).
    """
    import urllib.parse
    encoded = urllib.parse.quote(role_name)
    target_url = (
        f"https://nextcatalog.northeastern.edu/courseleaf/approve/?role={encoded}"
    )

    # Step 1: navigate the Approve Pages tab to the role URL. window.location
    # assignment triggers a full page reload — the existing JS context dies
    # and a fresh DOM is built from the server response.
    nav_js = f'window.location.href = {json.dumps(target_url)};'
    run_js_in_tab("courseleaf/approve", nav_js, match_by='url', timeout=10)

    # Step 2: give the page a moment to start the navigation + initial render
    # before our extraction JS runs on the new page. Without this brief wait,
    # run_js_in_tab can execute against the OLD page that's mid-unload.
    time.sleep(2)

    # Step 3: extract from the fresh DOM via the same poll-until-stable
    # mechanism we used pre-navigation refactor (without the showPendingList
    # call — the URL parameter triggers CIM to auto-render the role queue).
    poll_tag = f"__approve_{int(time.time() * 1000)}"
    js = f'''
(function() {{
    var existing = document.getElementById("{poll_tag}");
    if (existing) existing.remove();
    var holder = document.createElement("div");
    holder.id = "{poll_tag}";
    holder.style.display = "none";
    holder.setAttribute("data-status", "running");
    document.body.appendChild(holder);

    function extract() {{
        var text = document.body.innerText;
        var lines = text.split("\\n");
        var programs = [];
        for (var i = 0; i < lines.length; i++) {{
            var line = lines[i].trim();
            var m = line.match(/^\\/programadmin\\/(\\d+):\\s*(.+)/);
            if (m) {{
                var id = parseInt(m[1]);
                var rest = m[2];
                var parts = rest.split("\\t");
                var nameRaw = parts[0].trim();
                var user = parts.length > 1 ? parts[1].trim() : "";
                var name = nameRaw.replace(/^:\\s*/, "").replace(/^[A-Z0-9_-]+:\\s*/, "");
                if (!name) name = nameRaw.replace(/^:\\s*/, "");
                programs.push({{id: id, name: name, user: user}});
            }}
        }}
        return programs;
    }}

    // Poll every 500ms. Return when the list has stabilized (same size across
    // 3 consecutive polls) and is non-empty, or after a 20s ceiling.
    //
    // EMPTY-LIST DETECTION: CIM populates the role queue via AJAX. The
    // request can take 4-8 seconds to complete on some roles. If we bail
    // too early on "consistently empty", we miss real programs and the
    // tracker then falls back to stale per-program workflow divs.
    // Threshold tuned to: 12 consecutive empty polls AND >=7s elapsed.
    // That's enough time for slow AJAX to land, while still bailing
    // promptly on legitimately empty roles (~7-8 sec).
    var lastSize = -1;
    var stableCount = 0;
    var elapsed = 0;
    var interval = setInterval(function() {{
        elapsed += 500;
        var progs = extract();
        if (progs.length === lastSize) stableCount++;
        else stableCount = 0;
        lastSize = progs.length;
        var stableEmptyDone = (progs.length === 0 && stableCount >= 12 && elapsed >= 7000);
        if ((progs.length > 0 && stableCount >= 3) || stableEmptyDone || elapsed >= 20000) {{
            clearInterval(interval);
            holder.textContent = JSON.stringify(progs);
            holder.setAttribute("data-status", "done");
        }}
    }}, 500);
    return "fired";
}})();
'''
    fired = run_js_in_tab("courseleaf/approve", js, match_by='url', timeout=20)
    if not fired or fired == 'missing value':
        return []

    check_js = f'''(function(){{ var el = document.getElementById("{poll_tag}"); if (!el) return "MISSING"; return el.getAttribute("data-status") === "done" ? el.textContent : "RUNNING"; }})();'''
    payload = None
    for _ in range(25):  # up to ~25s total (JS poll loop now bounded at 20s)
        time.sleep(1)
        r = run_js_in_tab("courseleaf/approve", check_js, match_by='url', timeout=10)
        if r and r != 'missing value' and r != 'RUNNING' and r != 'MISSING':
            payload = r
            break

    run_js_in_tab(
        "courseleaf/approve",
        f'var e=document.getElementById("{poll_tag}"); if(e) e.remove();',
        match_by='url', timeout=5,
    )

    if not payload:
        return []
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        return []
    if isinstance(data, dict) and 'error' in data:
        return []
    return data


def scrape_program_workflow(program_id):
    """Scrape workflow details for a specific program by navigating to its page.
    LEGACY: Kept for fallback. Use batch_fetch_program_details() instead."""
    js_nav = f'window.location.href = "https://nextcatalog.northeastern.edu/programadmin/{program_id}/";'
    run_js_in_tab("programadmin", js_nav, match_by='url')
    time.sleep(3)

    js_workflow = '''
(function() {
    var wfDiv = document.getElementById("workflow");
    if (!wfDiv) return JSON.stringify({error: "no workflow div"});
    var items = wfDiv.querySelectorAll("li");
    var steps = [];
    items.forEach(function(li, idx) {
        var link = li.querySelector("a");
        steps.push({
            order: idx,
            name: li.innerText.trim(),
            status: li.className.trim() || "pending",
            emails: link ? link.getAttribute("href").replace("mailto:", "") : ""
        });
    });
    var text = document.body.innerText;
    var meta = {};
    var patterns = [
        ["college", /College One:\\s*\\n\\s*(.+)/],
        ["department", /Department One:\\s*\\n\\s*(.+)/],
        ["degree", /Degree:\\s*\\n\\s*(.+)/],
        ["date_submitted", /Date Submitted:\\s*(.+)/],
        ["banner_code", /Banner Code:\\s*\\n\\s*(\\S+)/],
        ["proposal_type", /^(New Program Proposal|Program Revision Proposal|Inactivation Proposal)/m]
    ];
    patterns.forEach(function(p) {
        var match = text.match(p[1]);
        if (match) meta[p[0]] = match[1].trim();
    });
    if (!meta.proposal_type) {
        if (text.indexOf("New Program Proposal") !== -1) meta.proposal_type = "New Program Proposal";
        else if (text.indexOf("Inactivation Proposal") !== -1) meta.proposal_type = "Inactivation Proposal";
        else if (text.indexOf("Rationale for Changes") !== -1) meta.proposal_type = "Program Revision Proposal";
        else meta.proposal_type = "Program Revision Proposal";
    }
    var approvalDates = [];
    var approvalPattern = /([A-Z][a-z]{2}, \\d+ [A-Z][a-z]+ \\d{4} [\\d:]+ GMT)\\n.*?Approved for (.+)/g;
    var m;
    while ((m = approvalPattern.exec(text)) !== null) {
        approvalDates.push({date: m[1], step: m[2].trim()});
    }
    meta.last_approval_date = approvalDates.length > 0 ? approvalDates[approvalDates.length - 1].date : "";
    return JSON.stringify({ steps: steps, meta: meta });
})()
'''
    result = run_js_in_tab("programadmin", js_workflow, match_by='url', timeout=15)
    if not result or result == 'missing value':
        return None
    try:
        data = json.loads(result)
        if 'error' in data:
            return None
        return {'steps': data.get('steps', []), 'meta': data.get('meta', {})}
    except json.JSONDecodeError:
        return None


def batch_fetch_program_details(program_ids, batch_size=25):
    """Fetch workflow + metadata for multiple programs in parallel via async fetch().

    Chrome 147+ blocks synchronous XHR in main-thread documents (the call
    silently hangs without throwing), so we kick off async fetches with
    Promise.all, store the JSON in a hidden div, and poll from Python.
    Same pattern as `fetch_reference_curricula`.

    For each program: HTML page (workflow + approval history + proposal type)
    plus XML API (college, department, banner code, campus, curriculum_html).
    Per-batch parallelism is bounded by the network; each AppleScript round
    trip handles one batch.
    """
    if not program_ids:
        return {}

    all_results = {}
    batches = [program_ids[i:i+batch_size] for i in range(0, len(program_ids), batch_size)]

    for batch_num, batch in enumerate(batches):
        ids_json = json.dumps(batch)
        batch_tag = f"__detbatch_{batch_num}_{int(time.time())}"
        kickoff_js = f'''
(function() {{
    var existing = document.getElementById("{batch_tag}");
    if (existing) existing.remove();
    var holder = document.createElement("div");
    holder.id = "{batch_tag}";
    holder.style.display = "none";
    holder.setAttribute("data-status", "running");
    document.body.appendChild(holder);

    var ids = {ids_json};
    var parser = new DOMParser();

    function processOne(id, idx) {{
        var result = {{steps: [], meta: {{}}}};
        // cache:'no-store' is critical: without it, Chrome's HTTP
        // cache can serve a stale /programadmin/{id}/ that still
        // shows the OLD workflow step, even after the user has
        // moved the program forward in CIM. We'd then conclude
        // "no change" and the dashboard would stay stale.
        var htmlPromise = fetch("/programadmin/" + id + "/", {{cache: 'no-store'}})
            .then(function(r) {{ return r.ok ? r.text() : ""; }})
            .then(function(html) {{
                if (!html) return;
                var doc = parser.parseFromString(html, "text/html");
                var wfDiv = doc.getElementById("workflow");
                if (wfDiv) {{
                    var items = wfDiv.querySelectorAll("li");
                    items.forEach(function(li, ord) {{
                        var link = li.querySelector("a");
                        result.steps.push({{
                            order: ord,
                            name: (li.textContent || "").trim(),
                            status: li.className.trim() || "pending",
                            emails: link ? link.getAttribute("href").replace("mailto:", "") : ""
                        }});
                    }});
                }}
                var text = doc.body ? doc.body.textContent : "";
                if (text.indexOf("New Program Proposal") !== -1) result.meta.proposal_type = "New Program Proposal";
                else if (text.indexOf("Inactivation Proposal") !== -1) result.meta.proposal_type = "Inactivation Proposal";
                else if (text.indexOf("Rationale for Changes") !== -1) result.meta.proposal_type = "Program Revision Proposal";
                else result.meta.proposal_type = "Program Revision Proposal";

                var dsMatch = text.match(/Date Submitted:\\s*([^\\n]+)/);
                if (dsMatch) result.meta.date_submitted = dsMatch[1].trim();

                // CRITICAL: the inner negative lookahead prevents the
                // greedy `[\\s\\S]*?` from spanning across another date.
                // Without it, when there is only one "Rollback to X"
                // entry in the page, the regex would happily capture
                // the FIRST date in the file and skip past dozens of
                // approval entries to reach "Rollback to". Same risk
                // for approvals if a single "Approved for X" exists
                // far from its date. The lookahead forces the captured
                // date to be the one immediately preceding the keyword.
                var DATE_RE_SRC = '[A-Z][a-z]{{2}}, \\\\d+ [A-Z][a-z]+ \\\\d{{4}} [\\\\d:]+ GMT';
                var approvalDates = [];
                var apMatch;
                var apPattern = new RegExp(
                    '(' + DATE_RE_SRC + ')' +
                    '((?:(?!' + DATE_RE_SRC + ')[\\\\s\\\\S])*?)' +
                    'Approved for ([^<\\\\n]+)', 'g');
                while ((apMatch = apPattern.exec(text)) !== null) {{
                    approvalDates.push({{date: apMatch[1], step: apMatch[3].trim()}});
                }}

                // Rollbacks: "Rollback to X for Y" → workflow goes back
                // to X. Captures X (the "for Y" suffix is stripped).
                var rollbackDates = [];
                var rbMatch;
                var rbPattern = new RegExp(
                    '(' + DATE_RE_SRC + ')' +
                    '((?:(?!' + DATE_RE_SRC + ')[\\\\s\\\\S])*?)' +
                    'Rollback to ([^<\\\\n]+)', 'g');
                while ((rbMatch = rbPattern.exec(text)) !== null) {{
                    var rbStep = rbMatch[3].replace(/ for .*$/, '').trim();
                    rollbackDates.push({{date: rbMatch[1], step: rbStep}});
                }}
                result.meta.rollbacks = rollbackDates;
                // Filter to the CURRENT proposal cycle. CIM's workflow div for
                // a revision/inactivation also shows approvals from the
                // program's prior workflow runs (when it was first created or
                // last edited). Those stale entries leak into "days at step"
                // and the program_approvals table unless we drop them.
                // The current cycle's approvals are those at or after
                // date_submitted; if none yet (proposal just submitted, no
                // approvals in this cycle), we keep the array empty so
                // last_approval_date falls back to date_submitted below.
                var cycleStart = result.meta.date_submitted ? new Date(result.meta.date_submitted) : null;
                if (cycleStart && !isNaN(cycleStart)) {{
                    approvalDates = approvalDates.filter(function(a) {{
                        var d = new Date(a.date);
                        return !isNaN(d) && d >= cycleStart;
                    }});
                }}
                if (approvalDates.length > 0) {{
                    // Pick the chronologically latest one (CIM emits in
                    // workflow-step order, not strict chrono — be safe).
                    var latest = approvalDates[0];
                    var latestT = new Date(latest.date).getTime();
                    for (var ai = 1; ai < approvalDates.length; ai++) {{
                        var t = new Date(approvalDates[ai].date).getTime();
                        if (t > latestT) {{ latest = approvalDates[ai]; latestT = t; }}
                    }}
                    result.meta.last_approval_date = latest.date;
                }} else if (result.meta.date_submitted) {{
                    // No approvals in current cycle yet — proposal sits at
                    // its first review step. "Days at step" should be measured
                    // from submission, not from a prior cycle's approval.
                    result.meta.last_approval_date = result.meta.date_submitted;
                }}
                result.meta.approvals = approvalDates;
            }})
            .catch(function(e) {{ result.html_error = e.message || String(e); }});

        var xmlPromise = fetch("/programadmin/" + id + "/index.xml", {{cache: 'no-store'}})
            .then(function(r) {{
                result.meta.xml_status = r.status;
                return r.ok ? r.text() : "";
            }})
            .then(function(xml) {{
                if (!xml) return;
                var xmlDoc = parser.parseFromString(xml, "text/xml");
                var getXml = function(tag) {{
                    var el = xmlDoc.querySelector(tag);
                    return el ? el.textContent.trim() : "";
                }};
                result.meta.college = getXml("college");
                result.meta.department = getXml("department");
                result.meta.degree = getXml("degreecode");
                result.meta.banner_code = getXml("code");
                result.meta.program_title = getXml("programtitle");
                result.meta.campus = getXml("campus");
                result.meta.prog_acad_level = getXml("prog_acad_level");
                result.meta.eff_term = getXml("eff_term");
                result.meta.eff_cat = getXml("eff_cat");
                var bodyEl = xmlDoc.querySelector("body");
                result.meta.curriculum_html = bodyEl ? bodyEl.innerHTML : "";
                result.meta.req_degree_credits = getXml("req_degree_credits");
                // statustype is the XML-native proposal type field — more reliable
                // than scraping it from the raw HTML (which is a JS shell).
                var st = getXml("statustype");
                if (st) {{
                    if (/new/i.test(st)) {{
                        result.meta.proposal_type = "New Program Proposal";
                    }} else if (/inactivat/i.test(st)) {{
                        result.meta.proposal_type = "Inactivation Proposal";
                    }} else {{
                        result.meta.proposal_type = "Program Revision Proposal";
                    }}
                }}
                // <deletejustification> is captured as data only — NEVER
                // overrides proposal_type. CIM uses this field for any
                // proposal that removes the original program record from
                // the catalog (true inactivations AND splits/merges/major
                // restructures). HTML / <statustype> are the authoritative
                // proposal-type signals; trust them. See CLAUDE.md.
                var dj = getXml("deletejustification");
                if (dj) {{
                    result.meta.delete_justification = dj;
                }}
            }})
            .catch(function(e) {{ result.xml_error = e.message || String(e); }});

        return Promise.all([htmlPromise, xmlPromise]).then(function() {{
            return [id, result];
        }});
    }}

    Promise.all(ids.map(processOne)).then(function(pairs) {{
        var out = {{}};
        for (var i = 0; i < pairs.length; i++) out[pairs[i][0]] = pairs[i][1];
        holder.textContent = JSON.stringify(out);
        holder.setAttribute("data-status", "done");
    }}).catch(function(e) {{
        holder.textContent = "ERROR:" + (e && e.message || e);
        holder.setAttribute("data-status", "error");
    }});
    return "fired";
}})();
'''
        run_js_in_tab("programadmin", kickoff_js, match_by='url', timeout=20)

        check_js = f'''(function() {{
    var el = document.getElementById("{batch_tag}");
    if (!el) return "MISSING";
    var s = el.getAttribute("data-status");
    if (s === "done") return "DONE";
    if (s === "error") return "ERR:" + el.textContent.substring(0, 200);
    return "RUNNING";
}})();'''
        batch_results = None
        for _ in range(60):  # up to 120s per batch
            time.sleep(2)
            status = run_js_in_tab("programadmin", check_js, match_by='url', timeout=15)
            if status == "DONE":
                len_js = (
                    f'(function(){{ var el = document.getElementById("{batch_tag}"); '
                    f'return el ? el.textContent.length : 0; }})();'
                )
                total_len = int(run_js_in_tab("programadmin", len_js, match_by='url', timeout=15) or 0)
                if total_len == 0:
                    batch_results = {}
                    break
                chunk_size = 200000
                chunks = []
                for offset in range(0, total_len, chunk_size):
                    chunk_js = (
                        f'(function(){{ var el = document.getElementById("{batch_tag}"); '
                        f'return el ? el.textContent.substring({offset}, {offset + chunk_size}) : ""; }})();'
                    )
                    part = run_js_in_tab("programadmin", chunk_js, match_by='url', timeout=30)
                    if part and part != 'missing value':
                        chunks.append(part)
                try:
                    batch_results = json.loads(''.join(chunks))
                except json.JSONDecodeError as e:
                    print(f"    Batch {batch_num+1}/{len(batches)}: JSON parse error ({e})")
                    batch_results = {}
                run_js_in_tab(
                    "programadmin",
                    f'var e=document.getElementById("{batch_tag}"); if(e) e.remove();',
                    match_by='url', timeout=10,
                )
                break
            if status and status.startswith("ERR"):
                print(f"    Batch {batch_num+1}/{len(batches)}: JS error: {status}")
                batch_results = {}
                break

        if batch_results is None:
            print(f"    Batch {batch_num+1}/{len(batches)}: timed out after 120s")
            continue

        for pid_str, data in batch_results.items():
            pid_int = int(pid_str)
            all_results[pid_int] = data
            # Persist the per-step approval history scraped from the workflow
            # HTML. Done here so every caller (run_full_scan, sweeps, the
            # smaller "missing IDs" path) gets it for free.
            try:
                from database import upsert_program_approvals
                approvals = (data.get('meta') or {}).get('approvals') or []
                if approvals:
                    upsert_program_approvals(pid_int, approvals)
            except Exception as _e:
                pass  # never let an approval-log write break a scan
        print(f"    Batch {batch_num+1}/{len(batches)}: fetched {len(batch_results)} programs")

    # Clean up any leftover holder divs from this run
    run_js_in_tab(
        "programadmin",
        'document.querySelectorAll("[id^=__detbatch_]").forEach(function(e){e.remove();});',
        match_by='url', timeout=10,
    )

    return all_results


_DOCTORATE_CODES = {'PhD', 'EdD', 'EDD', 'DNP', 'DPT', 'DPS', 'DLP', 'PharmD', 'DMSc', 'JD'}


def classify_program_type(name, workflow_steps=None, degree=None):
    """Classify program as Undergraduate, Graduate, or Other.

    The CIM XML degree code is the most reliable signal when present:
    BS/BA/BFA/BLA/BACS/BSN/BSCE/BSME/BSCmpE/BSEE/BSIE/BSCmpE/BSEnvE/BSET/...
    are all undergraduate; M*-prefixed codes plus LLM/MARCH/MAT/MST and
    the doctorate codes above are graduate. We fall back to name and
    workflow patterns when degree is missing (older completed programs).

    PlusOne / Concentration / Certificate / Minor are kept as their own
    "kind" via classifyProgramKind on the frontend; here they still
    project to Graduate vs Undergraduate based on the same degree-code
    rule when available, else name patterns.
    """
    name_lower = name.lower()

    # Degree-code-driven (most reliable when present).
    deg = (degree or '').strip()
    if deg:
        if deg in _DOCTORATE_CODES:
            return 'Graduate'
        if deg == 'CAGS' or deg == 'CERTP':
            return 'Graduate'
        if deg.startswith('B'):
            return 'Undergraduate'  # BS, BA, BFA, BLA, BACS, BSN, BSCE, BSME, ...
        if deg.startswith('M') or deg == 'LLM':
            return 'Graduate'

    # Name-pattern fallback (used for entries with no degree code).
    grad_indicators = [', ms ', ', ms(', ', ms—', ', ma ', ', mfa', ', med', ', mph', ', mpa',
                       ', mps', ', phd', 'graduate certificate', ', mba', ', msf',
                       'doctoral', 'ms—align', ', msw', ', msis', ', mls', ', llm',
                       ', dnp', ', dpt', ', dps', ', dlp', ', edd', ', jd', ', pharmd']
    undergrad_indicators = [', bs ', ', bs(', ', ba ', ', ba(', ', bfa', ', bsba',
                           ', bsib', ', bsche', ', bsbioe', ', bscs', ', bsce', ', bsme',
                           ', bsee', ', bsie', ', bsn', ', bsenve', ', bset', ', bla',
                           ', bacs', ', bscmpe', 'minor', ', aa ',
                           'business concentration', 'half major']

    for ind in grad_indicators:
        if ind in name_lower or name_lower.endswith(ind.strip()):
            return 'Graduate'

    for ind in undergrad_indicators:
        if ind in name_lower or name_lower.endswith(ind.strip()):
            return 'Undergraduate'

    if workflow_steps:
        step_names = ' '.join([s.get('name', '') for s in workflow_steps]).lower()
        if 'graduate' in step_names:
            return 'Graduate'
        if 'undergraduate' in step_names:
            return 'Undergraduate'

    if 'plusone' in name_lower:
        return 'Graduate'
    if 'certificate' in name_lower:
        return 'Graduate'

    return 'Graduate'


def check_courseleaf_session():
    """Quickly probe CourseLeaf to verify the Chrome session is authenticated.

    Returns a dict: {'ok': bool, 'error': str (when not ok), 'detail': str}

    Checks:
    1. The programadmin tab exists and JS can execute (Chrome accessible)
    2. The XML API returns real program data (not a redirect to login)
    3. The Approve Pages tab's role <select> is populated (session valid)

    Fast: ~1-3 seconds total.
    """
    # Step 1: Can we talk to the programadmin tab at all?
    url = run_js_in_tab('programadmin', 'location.href', match_by='url', timeout=10)
    if not url or url == 'missing value':
        return {
            'ok': False,
            'error': 'browser_unreachable',
            'detail': f'{BROWSER_APP} programadmin tab not found or not responding. '
                      f'Open https://nextcatalog.northeastern.edu/programadmin/ in {BROWSER_APP} window 1.'
        }

    # Step 2: Probe the XML API for a known program to verify session.
    # Uses async fetch + polling (Chrome 147+ blocks sync XHR silently).
    probe_tag = f"__sessprobe_{int(time.time())}"
    kickoff_js = f'''
(function() {{
    var existing = document.getElementById("{probe_tag}");
    if (existing) existing.remove();
    var holder = document.createElement("div");
    holder.id = "{probe_tag}";
    holder.style.display = "none";
    holder.setAttribute("data-status", "running");
    document.body.appendChild(holder);
    // No cache: 'no-store' — this is a session-validity probe; we
    // don't care whether the response is fresh, only whether the
    // session is authenticated. Allowing the HTTP cache here also
    // sidesteps a CIM-side oddity where /programadmin/2/index.xml
    // returns 400 for direct uncached requests.
    fetch("/programadmin/2/index.xml")
        .then(function(r) {{
            return r.text().then(function(txt) {{ return [r.status, txt]; }});
        }})
        .then(function(pair) {{
            var status = pair[0];
            var txt = pair[1] || "";
            var verdict;
            if (status !== 200) verdict = "HTTP:" + status;
            else if (txt.indexOf("<courseleaf>") === -1) verdict = "NOT_XML";
            else if (txt.trimStart().toLowerCase().indexOf("<!doctype") === 0) verdict = "LOGIN_REDIRECT";
            else if (txt.length < 500) verdict = "SHORT:" + txt.length;
            else verdict = "OK:" + txt.length;
            holder.textContent = verdict;
            holder.setAttribute("data-status", "done");
        }})
        .catch(function(e) {{
            holder.textContent = "ERR:" + (e && e.message || e);
            holder.setAttribute("data-status", "done");
        }});
    return "fired";
}})();
'''
    fired = run_js_in_tab('programadmin', kickoff_js, match_by='url', timeout=10)
    if not fired or fired == 'missing value':
        return {
            'ok': False,
            'error': 'probe_failed',
            'detail': f'Could not start CourseLeaf probe. Check that {BROWSER_APP} is running.'
        }
    result = None
    for _ in range(15):  # up to ~15s
        time.sleep(1)
        check = run_js_in_tab(
            'programadmin',
            f'(function(){{var el=document.getElementById("{probe_tag}");return el && el.getAttribute("data-status")==="done" ? el.textContent : "";}})();',
            match_by='url', timeout=10,
        )
        if check and check != 'missing value' and check.strip():
            result = check.strip()
            break
    # Cleanup
    run_js_in_tab(
        'programadmin',
        f'var e=document.getElementById("{probe_tag}"); if(e) e.remove();',
        match_by='url', timeout=10,
    )
    if not result or result == 'missing value':
        return {
            'ok': False,
            'error': 'probe_failed',
            'detail': f'Could not probe CourseLeaf. Check that {BROWSER_APP} is running and '
                      'the programadmin tab is open.'
        }

    if not result.startswith('OK:'):
        return {
            'ok': False,
            'error': 'session_invalid',
            'detail': f'CourseLeaf session appears invalid or expired (probe: {result}). '
                      f'Please log in to CourseLeaf in {BROWSER_APP}, then retry.'
        }

    # Step 3: Verify Approve Pages tab has the role selector
    approve_js = '''
(function() {
    var sel = document.querySelector("select");
    if (!sel) return "NO_SELECT";
    var count = sel.options.length;
    if (count < 10) return "TOO_FEW:" + count;
    return "OK:" + count;
})();
'''
    ap_result = run_js_in_tab('courseleaf/approve', approve_js, match_by='url', timeout=10)
    if not ap_result or ap_result == 'missing value':
        return {
            'ok': False,
            'error': 'approve_pages_missing',
            'detail': 'The CourseLeaf Approve Pages tab is not open. '
                      f'Open https://nextcatalog.northeastern.edu/courseleaf/approve/ in {BROWSER_APP}.'
        }
    if not ap_result.startswith('OK:'):
        return {
            'ok': False,
            'error': 'approve_pages_invalid',
            'detail': f'Approve Pages tab is not showing roles ({ap_result}). '
                      'You may need to log in again.'
        }

    return {'ok': True, 'detail': 'CourseLeaf session is valid.'}


def run_full_scan(force_fetch_only=False):
    """Run a program scan: hybrid discovery, incremental fetch.

    When `force_fetch_only=True`: skips A1 discovery, A2 obscure-role
    lookup, A3 ID probe, and exit verification — just force-fetches
    the workflow div for every DB-active program and reconciles. Used
    by do_quick_role_update for fast role-change checks interleaved
    between thorough scans' slow phases. ~2 min instead of ~5 min.


    Architecture (Option C — see CLAUDE.md):
    - Phase A discovery has three sources:
        A1) Iterate ALL_ROLES (46 hardcoded common pipeline + college
            roles) — fast (~4 min) because empty roles short-circuit.
        A2) DB programs at OBSCURE roles (current_step ∉ ALL_ROLES) —
            already known, force-fetch their workflow div via Phase B
            to verify. Catches drift among the ~258 programs at the
            ~169 narrow roles that ALL_ROLES doesn't include.
        A3) ID probe (max_db_id, max_db_id + 50) — catches brand-new
            programs at any role, including obscure ones. CIM assigns
            sequential IDs.
    - Diff vs DB current_step: classify A1-discovered into new / moved
      / unchanged. A2 programs are unconditionally added to active set.
      A3 IDs that return real data are ingested as new.
    - Phase B (detail fetch): batch-fetch HTML+XML for the active set
      (new + moved + Boston-in-workflow refresh from C2 + A2 +
      A3 probe). Unchanged non-Boston programs at common roles are
      skipped — their DB rows stay as-is.
    - Step 3: process fetched programs, apply workflow-div
      reconciliation (CLAUDE.md "Reconciliation: which source wins"),
      record step transitions.
    - Exit verification: programs in DB at a step but not discovered
      get cross-checked against their workflow div before any
      destructive change.

    Why not iterate the live ~215-role dropdown for completeness?
    Empirically that costs ~87 min of active scan time because ~165
    of those roles are empty most of the time and each takes 5-15s
    of JS poll-until-stable. The hybrid (A1+A2+A3) above gives the
    same coverage at <1/10 the cost.

    Limitations (accepted, see CLAUDE.md):
    - Stale-cache from Approve Pages that happens to match a stale
      DB current_step is silently missed by this scan.
    - A3 assumes new programs get sequential IDs within max_db_id+50.
      Wider gaps would only be caught by the weekly
      `sweep_all_program_ids` (iterates every program ID 1-2100
      directly via the XML API, no Approve Pages dependency).

    First run on an empty DB → everyone is 'new', so it behaves like a
    full fetch. Subsequent scans typically have 0–10 active programs.
    """
    print(f"\n{'='*60}")
    print(f"Starting full scan at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'='*60}")

    init_db()
    scan_time = datetime.now().isoformat()
    overall_start = time.time()
    phase_times = {}  # name -> elapsed seconds

    # Get existing programs to detect changes
    existing_programs = {p['id']: p for p in get_all_programs()}

    # ---- Phase A: hybrid discovery (Option C, see CLAUDE.md).
    #
    # Discovery has three sources, designed to be both fast and complete:
    #   A1) Iterate ALL_ROLES (46 hardcoded common roles) — covers
    #       programs at the standard pipeline + canonical college roles.
    #       Fast (~4 min) because empty roles short-circuit.
    #   A2) DB programs whose `current_step` is at an OBSCURE role (one
    #       of the ~169 narrow roles like "Program MI Graduate
    #       Curriculum Committee Chair" not in ALL_ROLES) — we already
    #       know these exist; just force-fetch them via Phase B to
    #       verify their workflow div didn't change.
    #   A3) ID probe (max_db_id, max_db_id + 50) — catches brand-new
    #       programs at any role. CIM assigns IDs sequentially, so
    #       this catches anything created since last scan.
    #
    # The previous version iterated the live ~215-role dropdown for
    # completeness; that worked but cost ~87 min of active scan time
    # because ~165 of those roles are empty and each takes 5-15s of
    # JS poll-until-stable. The hybrid approach gives the same
    # coverage at <1/10 the cost: A1 hits the populated roles, A2
    # covers DB-known programs at obscure roles, A3 catches brand-new
    # programs by ID.
    all_discovered = {}  # id -> {name, role, user}
    all_roles_set = set(ALL_ROLES)
    new_ids = []
    moved_ids = []
    unchanged_ids = []
    boston_workflow_refresh_ids = []
    obscure_db_ids = []
    probe_ids = []
    all_active_db_ids = [pid for pid, db in existing_programs.items()
                         if db.get('current_step')]

    if force_fetch_only:
        # Quick role-update mode: skip A1/A2/A3 discovery, just force-fetch
        # every DB-active program's workflow div and reconcile.
        print(f"\nStep 1: SKIPPED (force_fetch_only mode — fetching {len(all_active_db_ids)} DB-active programs)")
        phase_times['1_discovery'] = 0.0
        # Synthesize all_discovered entries from DB so Step 3 can process them.
        for pid in all_active_db_ids:
            db = existing_programs[pid]
            all_discovered[pid] = {
                'name': db.get('name', ''),
                'user': '',
                'current_step': db.get('current_step', ''),
            }
        active_ids = list(all_active_db_ids)
        phase_times['2_diff'] = 0.0
        print(f"  Phase B will fetch details for {len(active_ids)} programs (force-fetch all DB-active)")
    else:
        print("\nStep 1: Scanning Approve Pages for all roles (A1)...")
        phase_start = time.time()
        for role in ALL_ROLES:
            print(f"  Scanning role: {role}...")
            programs = scrape_approve_pages_role(role)
            if programs:
                print(f"    Found {len(programs)} programs")
            for p in programs:
                pid = p['id']
                if pid not in all_discovered:
                    clean_name = p['name'].lstrip(': ').strip()
                    all_discovered[pid] = {
                        'name': clean_name,
                        'user': p.get('user', ''),
                        'current_step': role,
                        'from_approve_pages': True,
                    }
                all_discovered[pid]['current_step'] = role
                all_discovered[pid]['from_approve_pages'] = True
        phase_times['1_discovery'] = time.time() - phase_start
        print(f"\n  A1 total: {len(all_discovered)} programs at common roles "
              f"(took {phase_times['1_discovery']:.0f}s across {len(ALL_ROLES)} roles)")

        # ---- A2: DB-known programs at obscure roles
        for pid, db in existing_programs.items():
            db_step = db.get('current_step') or ''
            if not db_step or db_step in all_roles_set:
                continue
            if pid in all_discovered:
                continue
            all_discovered[pid] = {
                'name': db.get('name', ''),
                'user': '',
                'current_step': db_step,
                'from_approve_pages': False,
            }
            obscure_db_ids.append(pid)
        if obscure_db_ids:
            print(f"  A2: {len(obscure_db_ids)} DB programs at obscure roles "
                  f"(forced into active fetch)")

        # ---- A3: ID probe for brand-new programs
        max_db_id = max(existing_programs.keys()) if existing_programs else 0
        probe_id_count = 50
        probe_ids = list(range(max_db_id + 1, max_db_id + 1 + probe_id_count))
        if probe_ids:
            print(f"  A3: probing IDs {probe_ids[0]}..{probe_ids[-1]} for brand-new programs")

        # ---- Diff: classify discovered programs vs DB
        phase_start = time.time()
        for pid, info in all_discovered.items():
            live_step = info['current_step']
            db = existing_programs.get(pid)
            if db is None:
                new_ids.append(pid)
            elif (db.get('current_step') or '') != live_step:
                moved_ids.append(pid)
            else:
                unchanged_ids.append(pid)

        # C2: Boston-in-workflow programs (refresh curriculum_html every scan)
        for pid in unchanged_ids:
            db = existing_programs[pid]
            if not (db.get('current_step') or ''):
                continue
            db_campus = (db.get('campus') or '').lower()
            _, name_campus = _parse_campus_from_name(db.get('name') or '')
            if db_campus == 'boston' or (not db_campus and not name_campus):
                boston_workflow_refresh_ids.append(pid)

        active_ids = list(set(new_ids + moved_ids + boston_workflow_refresh_ids
                              + obscure_db_ids + probe_ids + all_active_db_ids))
        phase_times['2_diff'] = time.time() - phase_start
        print(f"  Diff vs DB: {len(unchanged_ids)} unchanged, "
              f"{len(moved_ids)} moved, {len(new_ids)} new, "
              f"{len(all_active_db_ids)} DB-active force-fetch (100% verify)")
        print(f"  Phase B will fetch details for {len(active_ids)} programs")

    # ---- Phase B: Batch-fetch workflow + metadata via XHR for moved/new only
    print(f"\nStep 2: Batch-fetching details for {len(active_ids)} programs via XHR...")
    phase_start = time.time()
    if active_ids:
        details = batch_fetch_program_details(active_ids, batch_size=25)
    else:
        details = {}
    phase_times['3_detail_fetch'] = time.time() - phase_start
    if details:
        per = phase_times['3_detail_fetch'] / max(len(details), 1) * 1000
        print(f"  Fetched {len(details)} programs in "
              f"{phase_times['3_detail_fetch']:.1f}s ({per:.0f}ms each)")
    else:
        print(f"  No programs needed re-fetch.")

    # ---- Force-fetch follow-up: synthesize all_discovered entries for
    # every DB-active program that wasn't already in all_discovered
    # (Approve Pages didn't show it). They WILL be processed in Step 3
    # using the workflow div as authoritative.
    for pid in all_active_db_ids:
        if pid in all_discovered:
            continue
        db = existing_programs[pid]
        all_discovered[pid] = {
            'name': db.get('name', ''),
            'user': '',
            'current_step': db.get('current_step', ''),
            'from_approve_pages': False,
        }

    # ---- A3 follow-up: probe IDs that returned real data are brand-new
    # programs. Synthesize all_discovered entries for them using their
    # workflow div's current step (or empty for completed-on-arrival).
    # IDs that returned no data (404, empty steps, html_error) are skipped.
    a3_ingested = 0
    for pid in probe_ids:
        if pid in all_discovered:
            continue
        detail = details.get(pid)
        if not detail:
            continue
        steps = detail.get('steps') or []
        meta = detail.get('meta') or {}
        if not steps and not meta.get('program_title'):
            continue  # empty ID slot
        current_step = ''
        for s in steps:
            if s.get('status') == 'current':
                current_step = s.get('name') or ''
                break
        all_discovered[pid] = {
            'name': meta.get('program_title') or '',
            'user': '',
            'current_step': current_step,
            'from_approve_pages': False,
        }
        # Treat as a new program for change tracking.
        if pid not in new_ids and pid not in moved_ids:
            new_ids.append(pid)
        a3_ingested += 1
    if a3_ingested:
        print(f"  A3 follow-up: ingested {a3_ingested} brand-new programs from ID probe")

    # Debug: log XML metadata from first program
    import sys
    for pid, detail in list(details.items())[:1]:
        meta = detail.get('meta', {})
        print(f"\n  XML debug for program {pid}:", flush=True)
        print(f"    xml_status: {meta.get('xml_status', 'N/A')}", flush=True)
        print(f"    statustype (proposal): '{meta.get('proposal_type', '')}'", flush=True)
        print(f"    college: '{meta.get('college', '')}'", flush=True)
        print(f"    department: '{meta.get('department', '')}'", flush=True)
        print(f"    banner_code: '{meta.get('banner_code', '')}'", flush=True)
        if meta.get('_xml_tags'):
            print(f"    xml_tags: {meta.get('_xml_tags', '')[:200]}", flush=True)
        if meta.get('_xml_sample'):
            print(f"    xml_sample: {meta.get('_xml_sample', '')[:300]}", flush=True)
        if meta.get('xml_error'):
            print(f"    xml_error: {meta.get('xml_error', '')}", flush=True)

    # ---- Step 3: Process fetched results and update database
    # Only iterates active_ids — unchanged programs are intentionally not
    # touched, so their DB rows are preserved exactly as-is.
    print(f"\nStep 3: Processing results...")
    phase_start = time.time()
    changes = 0
    # C3 signals consumed by `do_scan`'s targeted reference fetch.
    completed_in_scan = []      # programs that just transitioned to complete
    boston_curriculum_changed = []  # Boston-in-workflow programs whose
                                    # curriculum_html differed from the DB
                                    # (sentinel-mode deps may need refresh)
    boston_refresh_set = set(boston_workflow_refresh_ids)

    for prog_id in active_ids:
        # Skip probe IDs with no data — they're empty CIM ID slots, not
        # programs. (Real programs from the probe were added back to
        # all_discovered above.)
        if prog_id not in all_discovered:
            continue
        info = all_discovered[prog_id]
        prog_name = info['name']
        detail = details.get(prog_id, {'steps': [], 'meta': {}})

        steps = detail.get('steps', [])
        meta = detail.get('meta', {})

        # Use program title from XML if available (more reliable)
        if meta.get('program_title'):
            prog_name = meta['program_title']

        # Determine proposal status.
        # Prefer XML-sourced proposal_type (set from statustype in xmlPromise).
        # Fall back to preserving the existing DB status when the fetch clearly
        # failed (no steps returned AND an html_error or 400 xml_status) —
        # this prevents a transient 400 from resetting a correct "Added" or
        # "Deactivated" tag back to "Edited".
        banner_code = meta.get('banner_code', '')
        proposal_type = meta.get('proposal_type', '')
        fetch_failed = (not steps and
                        (detail.get('html_error') or
                         meta.get('xml_status') not in (None, '', 200, '200')))
        old_status = existing_programs.get(prog_id, {}).get('status', '') if fetch_failed else ''
        if 'New Program' in proposal_type:
            status = 'Added'
        elif 'Inactivation' in proposal_type:
            status = 'Deactivated'
        elif fetch_failed and old_status:
            status = old_status   # preserve existing rather than guess "Edited"
        else:
            status = 'Edited'

        college_code = meta.get('college', '')
        college = COLLEGE_NAMES.get(college_code, college_code)
        department = meta.get('department', '')
        degree = meta.get('degree', '')
        date_submitted = meta.get('date_submitted', '')
        step_entered_date = meta.get('last_approval_date', '')

        # Calculate progress
        total = len(steps)
        completed = sum(1 for s in steps if s.get('status') == 'approved')

        # ---- Reconciliation policy (see CLAUDE.md "Reconciliation: which
        # source wins"):
        #
        # Approve Pages role discovery is the AUTHORITATIVE source for
        # current_step. It's literally the pending list CIM shows to
        # approvers — "this program is waiting for you at role X". CIM
        # supports parallel workflow branches (especially for regulated
        # campuses like Vancouver) where a program is simultaneously
        # pending at a regulatory step AND at Program Graduate Provost
        # Review. The linear workflow div only renders one branch, so
        # walking the approval log can land on the wrong step (or one
        # that doesn't even exist in the visible workflow) while
        # Approve Pages correctly reflects what's pending right now.
        #
        # Priority order:
        #   1. Approve Pages saw this program in the current scan → use that
        #      role. This is the user-visible truth.
        #   2. Otherwise (DB-active program not surfaced by Approve Pages,
        #      or A3 probe brand-new), fall back to walking the approval
        #      log on /programadmin/{id}/. This handles obscure roles
        #      not in ALL_ROLES, programs we re-fetch to verify, etc.
        #   3. If the workflow div was empty/errored AND Approve Pages
        #      had nothing, leave current_step blank.
        #
        # Walking the log (used as the fallback): each "Approved for X"
        # advances past the matching step at-or-after the current index;
        # each "Rollback to X" rewinds to it. Walking handles workflows
        # with duplicate step names (e.g., "Program Review 2" appearing
        # twice when CIM loops back through it after Banner Setup).
        html_current = next((s for s in steps if s.get('status') == 'current'), None)
        html_error = detail.get('html_error')
        approve_pages_step = info.get('current_step', '')
        from_approve_pages = bool(info.get('from_approve_pages'))
        verified_via_workflow_div = bool(steps) and not html_error

        current_step = ''
        current_emails = ''

        if from_approve_pages and approve_pages_step:
            # Authoritative: this program is pending at this role per CIM.
            current_step = approve_pages_step
            # Try to find emails for this step in the parsed workflow div
            # (it may not contain this step at all if it's a parallel
            # branch like Graduate Provost Review on a Vancouver program;
            # in that case current_emails stays empty and the approver
            # filter just doesn't show it for this program).
            match = next(
                (s for s in steps
                    if (s.get('name') or '').strip() == approve_pages_step),
                None)
            if match is not None:
                current_emails = match.get('emails', '') or ''
        elif verified_via_workflow_div:
            # Approve Pages didn't see this program. Walk the approval log.
            from email.utils import parsedate_to_datetime as _pdt
            events = []
            for a in (meta.get('approvals') or []):
                try:
                    t = _pdt(a.get('date', '')).timestamp()
                except Exception:
                    continue
                events.append({'t': t, 'type': 'approved', 'step': (a.get('step') or '').strip()})
            for r in (meta.get('rollbacks') or []):
                try:
                    t = _pdt(r.get('date', '')).timestamp()
                except Exception:
                    continue
                events.append({'t': t, 'type': 'rollback', 'step': (r.get('step') or '').strip()})
            events.sort(key=lambda e: e['t'])

            if events:
                # Walk the workflow forward through every event.
                current_idx = 0
                for event in events:
                    name = event['step']
                    if event['type'] == 'approved':
                        # Forward match: step at-or-after current position.
                        # Handles duplicate step names by taking the NEXT
                        # occurrence (e.g. "Review 2" at steps 3 and 8).
                        match = next(
                            (s for s in steps
                                if s.get('order', -1) >= current_idx
                                   and (s.get('name') or '').strip() == name),
                            None)
                        if match is None:
                            # Implicit rollback: CIM records a return to an
                            # earlier step as "Approved for <earlier-step>"
                            # (not as an explicit "Rollback to" event).
                            # The forward search found nothing, so look
                            # backward — take the highest-order step before
                            # current_idx whose name matches.
                            match = next(
                                (s for s in sorted(
                                    steps,
                                    key=lambda s: s.get('order', -1),
                                    reverse=True)
                                    if s.get('order', -1) < current_idx
                                       and (s.get('name') or '').strip() == name),
                                None)
                        if match is not None:
                            current_idx = match.get('order', current_idx) + 1
                    else:  # rollback
                        match = next(
                            (s for s in steps
                                if (s.get('name') or '').strip() == name),
                            None)
                        if match is not None:
                            current_idx = match.get('order', current_idx)

                cur_step_obj = next(
                    (s for s in steps if s.get('order') == current_idx), None)
                if cur_step_obj:
                    current_step = (cur_step_obj.get('name') or '').strip()
                    current_emails = cur_step_obj.get('emails', '') or ''
                # else: walked past the end → workflow complete
            else:
                # No approval/rollback events: brand-new program. Use the
                # workflow div's class marker if present, else first step.
                if html_current:
                    current_step = (html_current.get('name') or '').strip()
                    current_emails = html_current.get('emails', '') or ''
                elif steps:
                    first = steps[0]
                    current_step = (first.get('name') or '').strip()
                    current_emails = first.get('emails', '') or ''

            # Parallel-branch preservation (force_fetch_only only).
            #
            # The walk algorithm only tracks the LINEAR workflow recorded
            # in the visible workflow div + approval log. CIM also routes
            # some programs to *parallel* reviewers — e.g., Program
            # Graduate Provost Review for a Vancouver program whose
            # linear workflow goes through GRA Regulatory steps. The
            # parallel-branch role is visible in Approve Pages but
            # absent from the linear workflow div, so the walk silently
            # clobbers a correct GP assignment with the linear truth
            # ("GRA Regulatory Modifications Submitted").
            #
            # Quick role updates (force_fetch_only=True) skip A1
            # discovery, so they have no way to verify a parallel-
            # branch role is still active. Heuristic: if the existing
            # current_step is NOT one of the workflow div step names,
            # it's a parallel-branch (or obscure-role) assignment —
            # leave it alone. The next FULL scan will iterate Approve
            # Pages and correctly reassign if the program has moved.
            #
            # We deliberately do NOT apply this preservation in full
            # scan mode (force_fetch_only=False). In a full scan, A1
            # had the chance to see this program at any pipeline role
            # and didn't, so the walk's result is what we should trust.
            # (Even fully-completed programs flow through the end-of-
            # scan verification block below.)
            if force_fetch_only:
                existing_step = (info.get('current_step') or '').strip()
                if existing_step and existing_step != current_step:
                    name_to_order = {(s.get('name') or '').strip(): s.get('order', -1)
                                     for s in steps}
                    existing_order = name_to_order.get(existing_step, None)
                    walk_order     = name_to_order.get(current_step, None)
                    # Case A: existing_step isn't in the workflow div at all
                    # — it's a parallel-branch or obscure-role assignment. The
                    # next full scan will re-verify via Approve Pages; quick
                    # updates have no business overwriting it. Preserve.
                    if existing_order is None:
                        current_step = existing_step
                        current_emails = ''
                    # Case B: walk's result is *earlier* in the workflow than
                    # existing_step. In parallel-branch programs, the walk
                    # locks onto the linear branch (often a regulatory step)
                    # while Approve Pages reports the parallel branch (e.g.,
                    # Program Graduate Provost Review) which is further along
                    # the linear ordering. Quick updates can't tell which is
                    # real, so default to NOT regressing — preserve existing.
                    # Genuine rollbacks will be picked up by the next full
                    # discovery scan (≤50 min). Forward advancement (same or
                    # later order) is allowed through unchanged.
                    elif walk_order is not None and walk_order < existing_order:
                        current_step = existing_step
                        current_emails = ''
        else:
            # Workflow div unverifiable (fetch failed/empty) AND Approve
            # Pages didn't see it. Best we can do is whatever Approve
            # Pages-style step was carried over from the DB.
            current_step = approve_pages_step
            current_emails = ''

        # completion_date is set when the workflow div was successfully
        # fetched AND shows no current step AND has at least one approved
        # step. If the fetch failed (unverifiable), we DO NOT mark the
        # program complete.
        is_complete = (verified_via_workflow_div and total > 0
                       and completed == total and not current_step)
        completion_date = meta.get('last_approval_date', '') if is_complete else ''

        prog_type = classify_program_type(prog_name, steps, degree)

        program_data = {
            'id': prog_id,
            'banner_code': banner_code,
            'name': prog_name,
            'status': status,
            'current_step': current_step,
            'total_steps': total,
            'completed_steps': completed,
            'current_approver_emails': current_emails,
            'program_type': prog_type,
            'college': college,
            'department': department,
            'degree': degree,
            'date_submitted': date_submitted,
            'step_entered_date': step_entered_date,
            'curriculum_html': meta.get('curriculum_html', '').replace('<![CDATA[', '').replace(']]>', '').strip(),
            'completion_date': completion_date,
            'campus': meta.get('campus', ''),
            'eff_cat': meta.get('eff_cat', ''),
        }

        # Detect changes
        old = existing_programs.get(prog_id)
        changed = upsert_program(program_data)

        if steps:
            upsert_workflow_steps(prog_id, steps)

        if changed and old:
            old_step = old.get('current_step', '')
            if old_step != current_step:
                record_change(scan_time, prog_id, old_step, current_step, 'step_change')
                print(f"  CHANGE: {prog_name}: {old_step} -> {current_step}")
                changes += 1
            # C3: this program just transitioned from in-workflow to
            # complete. Its own reference (last-approved history) gained
            # a new version; flag for ref refresh.
            if old_step and is_complete:
                completed_in_scan.append(prog_id)
        elif changed and not old:
            record_change(scan_time, prog_id, '', current_step, 'new_program')
            changes += 1

        # C2/C3: for Boston-in-workflow programs we re-fetched purely to
        # keep curriculum_html current, detect whether the curriculum
        # actually changed since last scan. If it did, the sentinel-mode
        # reference for any non-Boston deployment pointing at this
        # program now needs to be re-written from the fresh
        # curriculum_html (handled by fetch_reference_curricula's
        # sentinel block on every scan, so this is informational here —
        # but we still log it for diagnostic visibility).
        if prog_id in boston_refresh_set and old:
            old_curr = (old.get('curriculum_html') or '')
            new_curr = program_data.get('curriculum_html') or ''
            if old_curr != new_curr:
                boston_curriculum_changed.append(prog_id)

    phase_times['4_processing'] = time.time() - phase_start
    if boston_curriculum_changed:
        print(f"  C2: {len(boston_curriculum_changed)} Boston-in-workflow "
              f"program(s) had curriculum_html change "
              f"({len(boston_workflow_refresh_ids)} refreshed)")

    # ---- Exit verification: programs in DB at some step but not discovered
    # at any Approve Pages role this scan. Don't clear unconditionally —
    # verify against each program's workflow div first (positive-evidence
    # policy, see CLAUDE.md "Reconciliation: which source wins").
    #
    # In force_fetch_only mode every DB-active program is already in
    # all_discovered (synthesized from DB), so existing_in_pipeline is
    # empty and this block is a no-op — workflow-div reconciliation
    # already happened in Step 3.
    phase_start = time.time()
    from database import get_db
    discovered_ids = set(all_discovered.keys())
    existing_in_pipeline = [
        pid for pid, p in existing_programs.items()
        if p.get('current_step') and pid not in discovered_ids
    ]
    if existing_in_pipeline:
        print(f"  {len(existing_in_pipeline)} candidate(s) for current_step "
              f"clear (in DB but not on Approve Pages). Verifying via "
              f"workflow div...")
        verify_details = batch_fetch_program_details(
            existing_in_pipeline, batch_size=25)
        confirmed_complete = []
        moved_to_step = {}  # pid -> step_name (workflow div had a current)
        unverifiable = 0
        for pid, d in verify_details.items():
            steps = d.get('steps') or []
            html_err = d.get('html_error')
            if html_err or not steps:
                unverifiable += 1
                continue
            current = next((s.get('name') for s in steps if s.get('status') == 'current'), None)
            if current is None:
                confirmed_complete.append(pid)
            else:
                moved_to_step[pid] = current
        if confirmed_complete:
            with get_db() as conn:
                placeholders = ','.join('?' * len(confirmed_complete))
                conn.execute(
                    f"UPDATE programs SET current_step = '', current_approver_emails = '' "
                    f"WHERE id IN ({placeholders})",
                    confirmed_complete,
                )
            print(f"    Cleared {len(confirmed_complete)} (workflow div confirms complete)")
            # C3: these programs just transitioned to complete; their own
            # reference (last-approved history) needs a refresh, and any
            # non-Boston deployment pointing at one of them needs its
            # ref recomputed against the new last-approved version.
            completed_in_scan.extend(confirmed_complete)
        if moved_to_step:
            with get_db() as conn:
                for pid, step in moved_to_step.items():
                    conn.execute(
                        "UPDATE programs SET current_step = ? WHERE id = ?",
                        (step, pid))
            print(f"    Updated {len(moved_to_step)} to live workflow-div step "
                  f"(Approve Pages missed them)")
        if unverifiable:
            print(f"    Left {unverifiable} unchanged (workflow div fetch failed)")
    phase_times['5_exit_verification'] = time.time() - phase_start

    # NB: we intentionally do NOT record the scan here. The caller
    # (app.py do_scan) records it with a fresh timestamp after the
    # entire scan cycle finishes — programs + courses + reference +
    # export + deploy — so the dashboard's "Updated" header only
    # changes when the whole pipeline is actually done, not when this
    # first phase completes.

    # NOTE: The trailing `heal_stale_program_steps` call was removed.
    # That function did two things: (1) iterate the live ~215 Approve
    # Pages roles for completeness, and (2) cross-check every live
    # candidate against its per-program workflow div (the 73-min loop
    # that motivated removal). After we observed cross-check made 49
    # in-memory corrections but 0 DB changes (the main scan's
    # reconciliation policy already covered them), it became clear the
    # cross-check was redundant. We then folded heal's discovery
    # iteration directly into Phase A above (run the live 215-role
    # dropdown instead of the hardcoded 46) so completeness is
    # preserved without a redundant second pass. The weekly
    # `sweep_all_program_ids` remains as the deeper safety net.

    total_time = time.time() - overall_start
    print(f"\n{'='*60}")
    print(f"Scan complete: {len(all_discovered)} programs discovered, "
          f"{len(active_ids)} re-fetched, {len(unchanged_ids)} skipped, "
          f"{changes} changes detected")
    print(f"Phase timings:")
    for name in sorted(phase_times.keys()):
        secs = phase_times[name]
        print(f"  {name:.<25s} {secs:6.1f}s ({secs/max(total_time,1)*100:4.1f}%)")
    print(f"Total time: {total_time:.0f}s ({total_time/60:.1f} min)")
    print(f"{'='*60}")

    return {
        'scan_time': scan_time,
        'programs_scanned': len(all_discovered),
        'programs_with_workflow': len(details),
        'programs_skipped': len(unchanged_ids),
        'programs_active': len(active_ids),
        'changes': changes,
        'phase_times': phase_times,
        # C3 signals consumed by `do_scan` to compute the targeted
        # set for `fetch_reference_curricula`.
        'completed_in_scan': completed_in_scan,
        'boston_curriculum_changed': boston_curriculum_changed,
    }


def sweep_all_program_ids(start_id=1, end_id=2100, batch_size=25, log=True):
    """Sweep every CIM program ID in [start_id, end_id] and ingest anything
    present. Used once (bootstrap) and then weekly to pick up programs that
    completed the workflow since the last sweep.

    - Uses the same `batch_fetch_program_details` as regular scans (HTML +
      XML) so data shape matches.
    - Computes `completion_date` when a program's workflow is fully approved
      and no step is `current`.
    - `current_step` is left as-is for programs still in an active approval
      (the regular scan's Approve-Pages discovery is the authority on that);
      fully-approved programs get `current_step = ''`.
    - Programs with no workflow (404s, deleted IDs, empty shells) are
      skipped.

    Args:
        start_id, end_id: inclusive range to sweep.
        batch_size: XHR batches per AppleScript round-trip.
        log: print progress lines.

    Returns:
        {'scanned': int, 'completed': int, 'in_progress': int, 'skipped': int,
         'new_completions': int, 'new_completion_ids': list[int]}
    """
    from database import upsert_program, upsert_workflow_steps, get_db

    ids = list(range(start_id, end_id + 1))
    if log:
        print(f"\nHistorical sweep: fetching {len(ids)} program IDs "
              f"({start_id}..{end_id}) in batches of {batch_size}...")

    details = batch_fetch_program_details(ids, batch_size=batch_size)

    # Preload existing rows so we can tell new vs existing completions apart
    with get_db() as conn:
        existing = {r['id']: dict(r) for r in conn.execute(
            "SELECT id, current_step, completion_date FROM programs"
        ).fetchall()}

    scanned = 0
    completed = 0
    in_progress = 0
    skipped = 0
    new_completions = 0
    new_completion_ids = []  # C3: programs that just transitioned to complete
                             # in this sweep — their reference (last-approved
                             # history) needs a fresh fetch.

    for prog_id, detail in details.items():
        steps = detail.get('steps') or []
        meta = detail.get('meta') or {}
        if not steps and not meta.get('program_title') and not meta.get('banner_code'):
            skipped += 1
            continue

        total = len(steps)
        approved_count = sum(1 for s in steps if s.get('status') == 'approved')
        html_current = next((s for s in steps if s.get('status') == 'current'), None)

        # A program is "complete / historical" when it has no active workflow
        # proposal in CIM. CourseLeaf only renders the workflow div while a
        # proposal is in flight; once approved (or for programs that haven't
        # been revised in years), the workflow div disappears entirely.
        # We therefore treat ANY program with a present XML record but no
        # workflow as completed — using the catalog year (eff_cat) as the
        # surrogate "approval date" since CIM doesn't expose the actual one.
        no_workflow = (total == 0)
        all_approved = (total > 0 and approved_count == total and html_current is None)
        is_complete = no_workflow or all_approved

        if is_complete:
            if all_approved:
                completion_date = meta.get('last_approval_date', '')
            else:
                # No workflow — best surrogate for "when this program was
                # last formally approved" is the catalog year it took effect.
                eff = meta.get('eff_cat') or meta.get('eff_term') or ''
                completion_date = ('Catalog ' + eff) if eff else 'Approved'
            current_step = ''
            current_emails = ''
        else:
            completion_date = ''
            # Preserve whatever the regular scan set; the sweep's HTML
            # current marker can itself lag, so we leave it alone.
            prev = existing.get(prog_id, {})
            current_step = prev.get('current_step') or ''
            current_emails = ''  # only the scan-time call knows live approvers

        prog_name = meta.get('program_title') or detail.get('name') or f'Program #{prog_id}'
        banner_code = meta.get('banner_code', '')
        college_code = meta.get('college', '')
        college = COLLEGE_NAMES.get(college_code, college_code)

        proposal_type = meta.get('proposal_type', '')
        fetch_failed_sw = (total == 0 and not is_complete and
                           (detail.get('html_error') or
                            meta.get('xml_status') not in (None, '', 200, '200')))
        old_status_sw = existing.get(prog_id, {}).get('status', '') if fetch_failed_sw else ''
        if 'New Program' in proposal_type:
            status = 'Added'
        elif 'Inactivation' in proposal_type:
            status = 'Deactivated'
        elif fetch_failed_sw and old_status_sw:
            status = old_status_sw
        else:
            status = 'Edited'

        program_data = {
            'id': prog_id,
            'banner_code': banner_code,
            'name': prog_name,
            'status': status,
            'current_step': current_step,
            'total_steps': total,
            'completed_steps': approved_count,
            'current_approver_emails': current_emails,
            'program_type': classify_program_type(prog_name, steps, meta.get('degree', '')),
            'college': college,
            'department': meta.get('department', ''),
            'degree': meta.get('degree', ''),
            'date_submitted': meta.get('date_submitted', ''),
            'step_entered_date': meta.get('last_approval_date', ''),
            'curriculum_html': (meta.get('curriculum_html', '') or '')
                               .replace('<![CDATA[', '').replace(']]>', '').strip(),
            'completion_date': completion_date,
            'campus': meta.get('campus', ''),
            'eff_cat': meta.get('eff_cat', ''),
        }

        upsert_program(program_data)
        if steps:
            upsert_workflow_steps(prog_id, steps)

        scanned += 1
        if is_complete:
            completed += 1
            prev = existing.get(prog_id)
            if not prev or not (prev.get('completion_date') or ''):
                new_completions += 1
                new_completion_ids.append(prog_id)
        else:
            in_progress += 1

    if log:
        print(f"  Sweep complete: scanned={scanned}, completed={completed} "
              f"({new_completions} newly completed), in_progress={in_progress}, "
              f"skipped={skipped}")

    # Record the sweep time in the scans table so the weekly auto-trigger
    # knows when we last ran (uses a sentinel programs_scanned=-1).
    from datetime import datetime as _dt
    with get_db() as conn:
        conn.execute(
            "INSERT INTO scans (scan_time, programs_scanned, programs_with_workflow, changes_detected) "
            "VALUES (?, -1, ?, ?)",
            (_dt.now().isoformat(), scanned, new_completions),
        )

    return {
        'scanned': scanned,
        'completed': completed,
        'in_progress': in_progress,
        'skipped': skipped,
        'new_completions': new_completions,
        'new_completion_ids': new_completion_ids,
    }


def sweep_all_course_ids(start_id=1, end_id=25000, batch_size=25, log=True):
    """Sweep every CIM course ID in [start_id, end_id] and ingest anything
    present. Mirror of `sweep_all_program_ids` for the courses side.

    A course is treated as completed/historical when CIM has no workflow
    div for it (after a course completes, CourseLeaf only shows the workflow
    while a fresh proposal is in flight). Surrogate "completion date" is
    the catalog year (`eff_cat`); when a workflow IS present and fully
    approved, we record the real last-approval timestamp.

    Returns dict {scanned, completed, in_progress, skipped, new_completions}.
    """
    from database import upsert_course, upsert_course_workflow_steps, get_db

    ids = [str(i) for i in range(start_id, end_id + 1)]
    if log:
        print(f"\nHistorical course sweep: fetching {len(ids)} course IDs "
              f"({start_id}..{end_id}) in batches of {batch_size}...")

    details = batch_fetch_course_details(ids, batch_size=batch_size)

    with get_db() as conn:
        existing = {r['id']: dict(r) for r in conn.execute(
            "SELECT id, current_step, completion_date FROM courses"
        ).fetchall()}

    scanned = 0
    completed = 0
    in_progress = 0
    skipped = 0
    new_completions = 0

    for cid, detail in details.items():
        steps = detail.get('steps') or []
        meta = detail.get('meta') or {}
        # Empty record (404 or empty body) → skip without touching DB
        if not steps and not meta.get('course_title') and not meta.get('subject') and not meta.get('course_code'):
            skipped += 1
            continue

        total = len(steps)
        approved_count = sum(1 for s in steps if s.get('status') == 'approved')
        html_current = next((s for s in steps if s.get('status') == 'current'), None)

        no_workflow = (total == 0)
        all_approved = (total > 0 and approved_count == total and html_current is None)
        is_complete = no_workflow or all_approved

        # Course code/title from XML.  CIM exposes a pre-formatted "ARAB 1101"
        # in <code>; fall back to subject+number, then HTML scan, if missing or
        # purely numeric (some CIM courses return the CIM ID in <code>).
        course_code = (meta.get('course_code') or '').strip()
        if course_code.isdigit():
            course_code = ''  # treat numeric-only <code> as missing
        if not course_code:
            subject = (meta.get('subject') or '').strip()
            number = (meta.get('course_number') or '').strip()
            course_code = (subject + ' ' + number).strip() if (subject and number) else ''
        if not course_code:
            course_code = (meta.get('html_course_code') or '').strip()
        title = meta.get('course_title') or course_code or f"Course {cid}"
        if not course_code:
            # Use existing DB code if it's a real letter code; otherwise leave
            # empty rather than locking in the numeric CIM ID as the code.
            existing_code = existing.get(cid, {}).get('code') or ''
            course_code = existing_code if existing_code and not existing_code.isdigit() else ''
            # DEBUG: log all meta fields for first missing-code course
            if not course_code and not getattr(process_course_scans, '_debug_logged', False):
                process_course_scans._debug_logged = True
                print(f"DEBUG course {cid} meta fields: {dict(meta)}")

        college_code = meta.get('college', '')
        college = COLLEGE_NAMES.get(college_code, college_code) if college_code else ''

        ptype = meta.get('proposal_type', '')
        if 'New Course' in ptype:
            status = 'Added'
        elif 'Inactivation' in ptype:
            status = 'Deactivated'
        else:
            status = 'Edited'

        if is_complete:
            if all_approved:
                completion_date = meta.get('last_approval_date', '')
            else:
                # Courses don't expose `eff_cat` like programs; use `eff_term`
                # (a numeric code like 202630) as the surrogate. Frontend
                # formatCompletionDate displays "Term ..." verbatim.
                eff = meta.get('eff_cat') or meta.get('eff_term') or ''
                if meta.get('eff_cat'):
                    completion_date = 'Catalog ' + eff
                elif eff:
                    completion_date = 'Term ' + eff
                else:
                    completion_date = 'Approved'
            current_step = ''
            current_emails = ''
        else:
            completion_date = ''
            prev = existing.get(cid, {})
            current_step = prev.get('current_step') or ''
            current_emails = ''

        course_data = {
            'id': cid,
            'code': course_code,
            'title': title,
            'status': status,
            'current_step': current_step,
            'total_steps': total,
            'completed_steps': approved_count,
            'current_approver_emails': current_emails,
            'college': college,
            'date_submitted': meta.get('date_submitted', ''),
            'credits': meta.get('credits', ''),
            'description': meta.get('description', ''),
            'academic_level': meta.get('acad_level', ''),
            'completion_date': completion_date,
            'step_entered_date': meta.get('last_approval_date', ''),
        }

        upsert_course(course_data)
        if steps:
            upsert_course_workflow_steps(cid, [
                {
                    'order': s.get('order', i),
                    'name': s.get('name', ''),
                    'status': s.get('status', 'pending'),
                    'emails': s.get('emails', ''),
                }
                for i, s in enumerate(steps)
            ])

        scanned += 1
        if is_complete:
            completed += 1
            prev = existing.get(cid)
            if not prev or not (prev.get('completion_date') or ''):
                new_completions += 1
        else:
            in_progress += 1

    if log:
        print(f"  Course sweep: scanned={scanned}, completed={completed} "
              f"({new_completions} newly completed), in_progress={in_progress}, "
              f"skipped={skipped}")

    # Sentinel row in course_scans so the weekly auto-trigger knows when
    # we last ran (programs_scanned=-1 used elsewhere; here we use
    # changes_detected=-1 to distinguish course sweeps from program sweeps).
    from datetime import datetime as _dt
    with get_db() as conn:
        conn.execute(
            "INSERT INTO course_scans (scan_time, courses_scanned, courses_with_workflow, changes_detected) "
            "VALUES (?, ?, ?, -1)",
            (_dt.now().isoformat(), scanned, scanned - skipped),
        )

    return {
        'scanned': scanned,
        'completed': completed,
        'in_progress': in_progress,
        'skipped': skipped,
        'new_completions': new_completions,
    }


def heal_stale_program_steps(log=False, active_only=True):
    """Mirror DB current_step to live CourseLeaf Approve Pages pending lists.

    The dashboard's "where is each program" must match what you see when you
    visit /courseleaf/approve/ — the screen you use to approve programs.
    For each tracked role, we query its live pending list and set every
    program in that list to current_step = role. Programs in the DB at any
    tracked role but no longer on any live list get current_step cleared.

    Why not the per-program workflow HTML? Two CIM pages can disagree:
    the per-program /programadmin/{id}/ workflow panel can lag the pending
    list (we observed 9 programs whose workflow panel said "current=GPR"
    but who weren't in the GPR pending list). The pending list is the
    operational source — it's what the approver acts from. We mirror that.

    Brand-new programs found in a pending list but unknown to the DB are
    fetched in a small batch so we have name / college / banner to display.

    Args:
        log: if True, print a running commentary.
        active_only: kept for backwards-compat; this function always
            iterates every tracked role (which IS active-only by definition
            — completed programs aren't in any pending list).

    Returns:
        (warnings, fixed) -- fixed counts programs whose current_step changed.
    """
    from database import (
        get_all_programs, get_db, upsert_program, upsert_workflow_steps, record_scan,
    )

    # The hardcoded ALL_ROLES (~46 entries) misses many one-off
    # college-specific roles like "Program MI Graduate Curriculum
    # Committee Chair". Iterate the live dropdown (currently ~215
    # roles) — same pattern as heal_stale_course_steps. Empty roles
    # exit early via the JS poll's stable-empty short-circuit.
    all_roles = get_all_approve_roles() or ALL_ROLES
    if log:
        print(f"\nMirroring DB to live Approve Pages pending lists "
              f"({len(all_roles)} roles)...")

    # Step 1: build pid -> role map from live pending lists
    live_assignments = {}  # pid -> {role, name, user}
    for role in all_roles:
        progs = scrape_approve_pages_role(role)
        for p in progs:
            pid = p['id']
            if pid not in live_assignments:
                live_assignments[pid] = {
                    'role': role,
                    'name': p.get('name', ''),
                    'user': p.get('user', ''),
                }
        if log and progs:
            print(f"  {role}: {len(progs)}")

    if log:
        print(f"\nLive: {len(live_assignments)} unique programs (pre-validation)")

    # Policy: Approve Pages is the authoritative source of truth for which
    # role a program is currently at. CIM's per-program workflow div can
    # lag (the `<li class="current">` marker stays on the previous step
    # for a while after a reviewer approves), and the user has confirmed
    # that what they see at /courseleaf/approve/?role=X is the canonical
    # state. So we no longer cross-check workflow divs to "correct"
    # live_assignments here — whatever Approve Pages reports stands.

    # Step 2: snapshot current DB state
    db_programs = {p['id']: p for p in get_all_programs()}
    db_active = sum(1 for p in db_programs.values() if p.get('current_step'))

    # Safety net (see heal_stale_course_steps for rationale): if the live
    # scrape is implausibly sparse compared to known-active DB count, bail
    # rather than wipe.
    if db_active >= 200 and len(live_assignments) < max(50, int(db_active * 0.25)):
        msg = (f"ABORT heal_stale_program_steps: scraped only "
               f"{len(live_assignments)} programs across {len(all_roles)} "
               f"roles, but DB has {db_active} marked active. Refusing to "
               f"wipe — likely a transient AppleScript/tab-throttle issue.")
        if log: print(msg)
        return [msg], 0

    fixed = 0
    new_program_ids = []

    # Step 3a: programs in live → ensure DB matches
    for pid, info in live_assignments.items():
        existing = db_programs.get(pid)
        if existing and existing.get('current_step') == info['role']:
            continue  # already correct
        if not existing:
            # Brand-new program — defer to a single batched detail fetch below
            new_program_ids.append(pid)
            continue
        # Existing program at a different (or no) step — update directly.
        with get_db() as conn:
            conn.execute(
                "UPDATE programs SET current_step = ?, completion_date = '', "
                "last_updated = ? WHERE id = ?",
                (info['role'], datetime.now().isoformat(), pid),
            )
        fixed += 1
        if log and fixed <= 50:
            print(f"  {pid}: {(existing.get('current_step') or '(empty)')!r} → {info['role']!r}")

    # Step 3b: programs in DB at any step but no longer in live →
    # CANDIDATES for clearing. Don't clear unconditionally — verify via
    # the workflow div first (positive-evidence policy, see CLAUDE.md
    # "Reconciliation: which source wins"). Approve Pages can drop
    # programs from a role's pending list due to its stale-cache bug,
    # which would cause us to wipe `current_step` for programs that
    # are still in workflow.
    candidate_ids = [
        pid for pid, p in db_programs.items()
        if p.get('current_step') and pid not in live_assignments
    ]
    if candidate_ids:
        if log:
            print(f"  {len(candidate_ids)} candidate(s) for current_step "
                  f"clear (in DB but not in any live Approve Pages queue). "
                  f"Clearing per Approve-Pages-is-truth policy.")
        # Policy: Approve Pages is authoritative. If a DB program no longer
        # appears in any live role queue, treat its current_step as cleared
        # (it has moved off all visible queues — either completed, withdrawn,
        # or at a non-tracked obscure state). The previous "verify via
        # workflow div before clearing" gate is removed because the workflow
        # div is often stale relative to Approve Pages.
        with get_db() as conn:
            for pid in candidate_ids:
                conn.execute(
                    "UPDATE programs SET current_step = '', "
                    "current_approver_emails = '', last_updated = ? "
                    "WHERE id = ?",
                    (datetime.now().isoformat(), pid),
                )
                fixed += 1
        if log:
            print(f"    Cleared current_step for {len(candidate_ids)} programs "
                  f"(no longer surfaced by Approve Pages anywhere)")

    # Step 3c: brand-new programs — batch-fetch details for full metadata
    if new_program_ids:
        if log:
            print(f"\nFetching full details for {len(new_program_ids)} new programs...")
        details = batch_fetch_program_details(new_program_ids, batch_size=25)
        for pid in new_program_ids:
            d = details.get(pid, {})
            steps = d.get('steps') or []
            meta = d.get('meta') or {}
            info = live_assignments[pid]
            name = meta.get('program_title') or info.get('name') or f'Program #{pid}'
            college_code = meta.get('college', '')
            college = COLLEGE_NAMES.get(college_code, college_code) if college_code else ''
            proposal_type = meta.get('proposal_type', '')
            if 'New Program' in proposal_type:
                status = 'Added'
            elif 'Inactivation' in proposal_type:
                status = 'Deactivated'
            else:
                status = 'Edited'
            program_data = {
                'id': pid,
                'name': name,
                'banner_code': meta.get('banner_code', ''),
                'status': status,
                'current_step': info['role'],  # from Approve Pages
                'total_steps': len(steps),
                'completed_steps': sum(1 for s in steps if s.get('status') == 'approved'),
                'current_approver_emails': '',
                'program_type': classify_program_type(name, steps, meta.get('degree', '')),
                'college': college,
                'department': meta.get('department', ''),
                'degree': meta.get('degree', ''),
                'date_submitted': meta.get('date_submitted', ''),
                'step_entered_date': meta.get('last_approval_date', ''),
                'curriculum_html': (meta.get('curriculum_html', '') or '')
                                   .replace('<![CDATA[', '').replace(']]>', '').strip(),
                'completion_date': '',
                'campus': meta.get('campus', ''),
                'eff_cat': meta.get('eff_cat', ''),
            }
            upsert_program(program_data)
            if steps:
                upsert_workflow_steps(pid, steps)
            fixed += 1
            if log:
                print(f"  {pid}: NEW → {info['role']!r}")

    record_scan(
        datetime.now().isoformat(),
        programs_scanned=len(live_assignments),
        programs_with_workflow=len(live_assignments),
        changes_detected=fixed,
    )

    if log:
        print(f"Sync complete: {fixed} program changes")
    return 0, fixed


def heal_stale_course_steps(log=False, active_only=True):
    """Mirror DB course current_step to live Approve Pages pending lists.

    Same logic as heal_stale_program_steps but for courses. Iterates every
    course-bearing role's pending list (from get_all_approve_roles), sets
    current_step from the live list, and clears anything in DB no longer
    on any list.

    `active_only` is kept for API compatibility but doesn't affect behavior
    — completed courses aren't in any pending list, so they're naturally
    untouched.
    """
    from database import (
        get_all_courses, get_db, upsert_course, upsert_course_workflow_steps,
        record_course_scan,
    )

    if log:
        print(f"\nMirroring DB courses to live Approve Pages pending lists...")

    # Gather every role available in the dropdown (covers course-related
    # roles plus a few program ones that don't have courses; iterating
    # extras is cheap and avoids missing course roles).
    all_roles = get_all_approve_roles() or COURSE_TRACKED_ROLES

    live_assignments = {}  # cid -> {role, name, user}
    for role in all_roles:
        rows = scrape_courses_from_role(role)
        for r in rows:
            cid = r['id']
            if cid not in live_assignments:
                live_assignments[cid] = {
                    'role': role,
                    'name': r.get('name', ''),
                    'user': r.get('user', ''),
                }
        if log and rows:
            print(f"  {role}: {len(rows)}")

    if log:
        print(f"\nLive: {len(live_assignments)} unique courses (pre-validation)")

    # Cross-check live_assignments against each course's per-course workflow
    # div. See heal_stale_program_steps for the bug story. SAFETY: only
    # drop when we have POSITIVE proof — workflow div has steps but no
    # 'current'. Empty steps means fetch failed → leave alone.
    if live_assignments:
        candidate_ids = list(live_assignments.keys())
        if log:
            print(f"  Cross-checking {len(candidate_ids)} candidates against "
                  f"per-course workflow divs...")
        details = batch_fetch_course_details(candidate_ids, batch_size=25)
        confirmed_complete = []
        corrected = 0
        unverifiable = 0
        for cid, d in details.items():
            cid_int = int(cid) if isinstance(cid, str) else cid
            steps = d.get('steps') or []
            html_err = d.get('html_error')
            if html_err or not steps:
                unverifiable += 1
                continue
            current = next((s.get('name') for s in steps if s.get('status') == 'current'), None)
            if current is None:
                confirmed_complete.append(cid_int)
            elif cid_int in live_assignments and current != live_assignments[cid_int].get('role'):
                live_assignments[cid_int] = dict(live_assignments[cid_int], role=current)
                corrected += 1
        if confirmed_complete:
            if log:
                print(f"  Confirmed complete: {len(confirmed_complete)} courses. "
                      f"Examples: {confirmed_complete[:5]}")
            for cid in confirmed_complete:
                live_assignments.pop(cid, None)
        if log:
            print(f"  Corrected role for {corrected} courses (workflow div "
                  f"disagreed with Approve Pages)")
            if unverifiable:
                print(f"  {unverifiable} courses unverifiable (fetch failed) — left as-is")
            print(f"  After validation: {len(live_assignments)} live courses")

    db_courses = {c['id']: c for c in get_all_courses()}
    db_active = sum(1 for c in db_courses.values() if c.get('current_step'))

    # Safety: if the live scrape came up implausibly sparse compared to the
    # DB's known-active count, the role iteration probably had widespread
    # AppleScript timeouts (e.g. Edge backgrounded, tabs throttled). Bail
    # out rather than wipe every course's current_step. We only abort when
    # the DB had real prior data — first-run on an empty DB still works.
    SCRAPE_SANITY_FRACTION = 0.25  # require >=25% of prior active count
    SCRAPE_SANITY_MIN = 50         # ...or at least 50 courses outright
    if db_active >= 200 and len(live_assignments) < max(
        SCRAPE_SANITY_MIN, int(db_active * SCRAPE_SANITY_FRACTION)
    ):
        msg = (f"ABORT heal_stale_course_steps: scraped only "
               f"{len(live_assignments)} courses across {len(all_roles)} "
               f"roles, but DB has {db_active} marked active. Refusing to "
               f"wipe — likely a transient AppleScript/tab-throttle issue. "
               f"Re-run after Edge has been activated and tabs are warm.")
        if log: print(msg)
        return [msg], 0

    fixed = 0
    new_course_ids = []

    # 3a: courses in live → ensure DB matches
    for cid, info in live_assignments.items():
        existing = db_courses.get(cid)
        if existing and existing.get('current_step') == info['role']:
            continue
        if not existing:
            new_course_ids.append(cid)
            continue
        with get_db() as conn:
            conn.execute(
                "UPDATE courses SET current_step = ?, completion_date = '', "
                "last_updated = ? WHERE id = ?",
                (info['role'], datetime.now().isoformat(), cid),
            )
        fixed += 1
        if log and fixed <= 50:
            print(f"  {cid}: {(existing.get('current_step') or '(empty)')!r} → {info['role']!r}")

    # 3b: courses in DB at any step but no longer in live → CANDIDATES.
    # Same positive-evidence policy as heal_stale_program_steps —
    # verify via workflow div before clearing, never wipe current_step
    # on absence-of-evidence alone.
    candidate_cids = [
        cid for cid, c in db_courses.items()
        if c.get('current_step') and cid not in live_assignments
    ]
    if candidate_cids:
        if log:
            print(f"  {len(candidate_cids)} candidate(s) for current_step "
                  f"clear (in DB but not in live). Verifying...")
        verify_details = batch_fetch_course_details(candidate_cids, batch_size=25)
        confirmed_complete = []
        rebound = {}
        unverifiable = 0
        for cid, d in verify_details.items():
            cid_int = int(cid) if isinstance(cid, str) else cid
            steps = d.get('steps') or []
            html_err = d.get('html_error')
            if html_err or not steps:
                unverifiable += 1
                continue
            current = next((s.get('name') for s in steps if s.get('status') == 'current'), None)
            if current is None:
                confirmed_complete.append(cid_int)
            else:
                rebound[cid_int] = current
        with get_db() as conn:
            for cid in confirmed_complete:
                conn.execute(
                    "UPDATE courses SET current_step = '', "
                    "current_approver_emails = '', last_updated = ? "
                    "WHERE id = ?",
                    (datetime.now().isoformat(), cid),
                )
                fixed += 1
            for cid, step in rebound.items():
                conn.execute(
                    "UPDATE courses SET current_step = ?, last_updated = ? "
                    "WHERE id = ?",
                    (step, datetime.now().isoformat(), cid),
                )
                fixed += 1
        if log:
            if confirmed_complete:
                print(f"    Cleared {len(confirmed_complete)} confirmed-complete courses")
            if rebound:
                print(f"    Reassigned {len(rebound)} courses to their actual workflow step")
            if unverifiable:
                print(f"    Left {unverifiable} unchanged (workflow div fetch failed)")

    # 3c: brand-new courses — batch-fetch full details
    if new_course_ids:
        if log:
            print(f"\nFetching full details for {len(new_course_ids)} new courses...")
        details = batch_fetch_course_details(new_course_ids, batch_size=25)
        for cid in new_course_ids:
            d = details.get(cid, {})
            steps = d.get('steps') or []
            meta = d.get('meta') or {}
            info = live_assignments[cid]
            course_code = (meta.get('course_code') or '').strip()
            if not course_code:
                subject = (meta.get('subject') or '').strip()
                number = (meta.get('course_number') or '').strip()
                course_code = (subject + ' ' + number).strip() if (subject and number) else cid
            title = meta.get('course_title') or info.get('name') or course_code
            college_code = meta.get('college', '')
            college = COLLEGE_NAMES.get(college_code, college_code) if college_code else ''
            ptype = meta.get('proposal_type', '')
            if 'New Course' in ptype:
                status = 'Added'
            elif 'Inactivation' in ptype:
                status = 'Deactivated'
            else:
                status = 'Edited'
            course_data = {
                'id': cid,
                'code': course_code,
                'title': title,
                'status': status,
                'current_step': info['role'],
                'total_steps': len(steps),
                'completed_steps': sum(1 for s in steps if s.get('status') == 'approved'),
                'current_approver_emails': '',
                'college': college,
                'date_submitted': meta.get('date_submitted', ''),
                'credits': meta.get('credits', ''),
                'description': meta.get('description', ''),
                'academic_level': meta.get('acad_level', ''),
                'completion_date': '',
                'step_entered_date': meta.get('last_approval_date', ''),
            }
            upsert_course(course_data)
            if steps:
                upsert_course_workflow_steps(cid, [
                    {'order': s.get('order', i), 'name': s.get('name', ''),
                     'status': s.get('status', 'pending'), 'emails': s.get('emails', '')}
                    for i, s in enumerate(steps)
                ])
            fixed += 1
            if log:
                print(f"  {cid}: NEW → {info['role']!r}")

    record_course_scan(
        datetime.now().isoformat(),
        courses_scanned=len(live_assignments),
        courses_with_workflow=len(live_assignments),
        changes_detected=fixed,
    )

    if log:
        print(f"Course sync complete: {fixed} course changes")
    return 0, fixed


def _parse_campus_from_name(name):
    """Extract the campus/deployment from a program name.

    Handles two patterns:
    - Parenthetical campus: 'Management, MS (Oakland)' -> ('Management, MS', 'Oakland')
    - Em-dash deployment suffix: 'Business Analytics, MS—Online' ->
      ('Business Analytics, MS', 'Online')

    Only treats a limited set of em-dash suffixes as deployment variants
    (Online, Accelerated, Part-Time). Other em-dash suffixes like '—Align'
    are part of distinct program names and are left intact in the base.

    Returns (base_name_without_campus, campus) or (name, None) if no campus found.
    """
    match = re.search(r'\(([^)]+)\)\s*$', name)
    if match:
        campus = match.group(1).strip()
        base = name[:match.start()].strip()
        return base, campus
    # Em-dash deployment variants (not distinct programs like —Align, —Connect)
    m2 = re.search(r'—(Online|Accelerated|Part-Time)\s*$', name)
    if m2:
        campus = m2.group(1).strip()
        base = name[:m2.start()].strip()
        return base, campus
    return name, None


def _search_cim_for_boston_ids(banner_codes):
    """Search CIM for Boston program IDs by banner code.

    For each banner code, searches program IDs via XHR to find the one
    with matching code and Boston campus. Programs that completed the
    workflow aren't in our DB but still exist in CIM.

    Args:
        banner_codes: dict of {banner_code: [non_boston_program_id, ...]}

    Returns:
        dict of {banner_code: boston_program_id}
    """
    if not banner_codes:
        return {}

    codes_list = list(banner_codes.keys())
    codes_json = json.dumps(codes_list)
    print(f"  Searching CIM for {len(codes_list)} Boston program IDs by banner code...")

    # Search in chunks of 200 IDs (async fetch + poll, since Chrome 147 blocks sync XHR)
    all_found = {}
    chunk_size = 200
    for start in range(1, 2100, chunk_size):
        end = min(start + chunk_size, 2100)
        remaining = [c for c in codes_list if c.lower() not in all_found]
        if not remaining:
            break  # Found all
        remaining_json = json.dumps(remaining)
        chunk_tag = f"__bostonsearch_{start}_{int(time.time())}"
        kickoff_js = f'''
(function() {{
    var existing = document.getElementById("{chunk_tag}");
    if (existing) existing.remove();
    var holder = document.createElement("div");
    holder.id = "{chunk_tag}";
    holder.style.display = "none";
    holder.setAttribute("data-status", "running");
    document.body.appendChild(holder);

    var codes = {remaining_json};
    var codeSet = {{}};
    for (var c = 0; c < codes.length; c++) codeSet[codes[c].toLowerCase()] = true;
    var parser = new DOMParser();

    function probe(id) {{
        return fetch("/programadmin/" + id + "/index.xml", {{cache: 'no-store'}})
            .then(function(r) {{ return r.ok ? r.text() : ""; }})
            .then(function(txt) {{
                if (!txt || txt.length < 100) return null;
                var xml = parser.parseFromString(txt, "text/xml");
                var codeEl = xml.querySelector("code");
                if (!codeEl) return null;
                var campusEl = xml.querySelector("campus");
                var code = codeEl.textContent.trim().toLowerCase();
                var campus = campusEl ? campusEl.textContent.trim().toUpperCase() : "";
                if (codeSet[code] && (campus === "BOS" || campus === "")) {{
                    return [code, id];
                }}
                return null;
            }})
            .catch(function() {{ return null; }});
    }}

    var ids = [];
    for (var i = {start}; i < {end}; i++) ids.push(i);
    Promise.all(ids.map(probe)).then(function(pairs) {{
        var out = {{}};
        for (var i = 0; i < pairs.length; i++) {{
            var p = pairs[i];
            if (p && !out[p[0]]) out[p[0]] = p[1];
        }}
        holder.textContent = JSON.stringify(out);
        holder.setAttribute("data-status", "done");
    }}).catch(function(e) {{
        holder.textContent = "ERROR:" + (e && e.message || e);
        holder.setAttribute("data-status", "error");
    }});
    return "fired";
}})();
'''
        run_js_in_tab("programadmin", kickoff_js, match_by='url', timeout=20)

        check_js = f'''(function(){{ var el = document.getElementById("{chunk_tag}"); if (!el) return "MISSING"; var s = el.getAttribute("data-status"); if (s === "done") return el.textContent; if (s === "error") return el.textContent; return "RUNNING"; }})();'''
        chunk_text = None
        for _ in range(60):
            time.sleep(2)
            r = run_js_in_tab("programadmin", check_js, match_by='url', timeout=15)
            if r and r != 'missing value' and r != 'RUNNING' and r != 'MISSING':
                chunk_text = r
                break

        run_js_in_tab(
            "programadmin",
            f'var e=document.getElementById("{chunk_tag}"); if(e) e.remove();',
            match_by='url', timeout=10,
        )

        if not chunk_text or chunk_text.startswith('ERROR:'):
            print(f"    IDs {start}-{end}: {chunk_text or 'no response'}")
            continue
        try:
            chunk_results = json.loads(chunk_text)
            for code_lower, boston_id in chunk_results.items():
                all_found[code_lower] = boston_id
            if chunk_results:
                print(f"    IDs {start}-{end}: found {len(chunk_results)} matches")
        except json.JSONDecodeError:
            print(f"    IDs {start}-{end}: JSON parse error")

    # Normalize keys back to original case
    code_map = {}
    for code in banner_codes:
        boston_id = all_found.get(code.lower())
        if boston_id:
            code_map[code] = boston_id
    print(f"  CIM search found {len(code_map)} of {len(banner_codes)} Boston counterparts")
    return code_map


# Manual overrides: non-Boston program_id -> Boston counterpart program_id.
# Used when name-matching picks the wrong Boston program (e.g. a completed
# variant when the correct reference is the regular in-workflow Boston version).
REFERENCE_COUNTERPART_OVERRIDES = {
    1907: 392,  # MPH—Accelerated (Online) -> Public Health, MPH (Boston)
}


def _build_boston_counterpart_map(program_ids):
    """For non-Boston programs, find the Boston counterpart's CIM ID.

    First checks our database, then searches CIM by banner code for programs
    that completed the workflow and aren't in the pipeline anymore.
    Non-Boston programs without a counterpart fall back to their own CIM history.

    Returns two values:
    - counterpart_map: {non_boston_program_id: boston_program_id}
    - non_boston_ids: set of all non-Boston program IDs (including unmatched)
    """
    from database import get_db

    # Load all known programs (including ones not in current scan)
    with get_db() as conn:
        rows = conn.execute("SELECT id, name, banner_code FROM programs").fetchall()
        all_programs = {row['id']: row['name'] for row in rows}
        program_banner_codes = {row['id']: row['banner_code'] for row in rows}

    # Build name -> ID map for Boston programs
    boston_by_base_name = {}  # base_name -> program_id
    for pid, name in all_programs.items():
        base, campus = _parse_campus_from_name(name)
        if campus and campus.lower() == 'boston':
            boston_by_base_name[base.lower()] = pid
        elif not campus:
            # Programs without a campus parenthetical are assumed to be Boston
            boston_by_base_name[name.strip().lower()] = pid

    # Map non-Boston programs to their Boston counterparts
    counterpart_map = {}
    non_boston_ids = set()
    unmatched_by_code = {}  # banner_code -> [program_ids]
    for pid in program_ids:
        name = all_programs.get(pid, '')
        if not name:
            continue
        base, campus = _parse_campus_from_name(name)
        if campus and campus.lower() != 'boston':
            non_boston_ids.add(pid)
            boston_id = boston_by_base_name.get(base.lower())
            if boston_id:
                counterpart_map[pid] = boston_id
            else:
                # Collect banner code for CIM search
                code = program_banner_codes.get(pid, '')
                if code:
                    if code not in unmatched_by_code:
                        unmatched_by_code[code] = []
                    unmatched_by_code[code].append(pid)
                else:
                    print(f"  No Boston counterpart for: {name} (ID {pid}) — using own history")

    # Search CIM for unmatched programs by banner code
    if unmatched_by_code:
        cim_results = _search_cim_for_boston_ids(unmatched_by_code)
        for code, boston_id in cim_results.items():
            for pid in unmatched_by_code[code]:
                counterpart_map[pid] = boston_id
                print(f"  Found in CIM: {all_programs[pid]} -> Boston ID {boston_id}")

        # Report any still unmatched
        for code, pids in unmatched_by_code.items():
            if code not in cim_results:
                for pid in pids:
                    print(f"  No Boston counterpart for: {all_programs[pid]} (ID {pid}) — using own history")

    # Apply manual overrides (last, so they always win over name-matching)
    for pid, boston_id in REFERENCE_COUNTERPART_OVERRIDES.items():
        if pid in non_boston_ids:
            old = counterpart_map.get(pid)
            counterpart_map[pid] = boston_id
            if old != boston_id:
                print(f"  Override: {all_programs.get(pid, pid)} (ID {pid}) -> Boston ID {boston_id} (was {old})")

    return counterpart_map, non_boston_ids


def compute_db_fingerprint():
    """Hash the user-visible content of the dashboard's source tables.

    Used by app.py:do_scan to skip the static export + git push when the
    DB hasn't actually changed since the last successful export. Hashes
    only the SEMANTIC fields — explicitly excludes per-scan metadata
    like `fetched_at` so an idempotent re-fetch (same content, new
    timestamp) doesn't trigger a false-positive change signal.

    Returns a 64-char SHA-256 hex digest.
    """
    import hashlib
    from database import get_db

    h = hashlib.sha256()
    # Each query lists only fields that affect what the dashboard renders.
    # ORDER BY makes the hash stable across SQLite's row ordering.
    queries = [
        "SELECT id, current_step, status, total_steps, completed_steps, "
        "current_approver_emails, completion_date, name, college, "
        "banner_code, campus, step_entered_date, curriculum_html, "
        "program_type, department, degree, date_submitted, "
        "custom_reference_id, eff_cat "
        "FROM programs ORDER BY id",
        "SELECT program_id, step_order, step_name, step_status, approver_emails "
        "FROM workflow_steps ORDER BY program_id, step_order",
        "SELECT id, current_step, status, total_steps, completed_steps, "
        "current_approver_emails, completion_date, code, title, college, "
        "credits, description, academic_level, step_entered_date, "
        "date_submitted "
        "FROM courses ORDER BY id",
        "SELECT course_id, step_order, step_name, step_status, approver_emails "
        "FROM course_workflow_steps ORDER BY course_id, step_order",
        "SELECT program_id, version_id, version_date, curriculum_html "
        "FROM reference_curriculum ORDER BY program_id",
        "SELECT program_id, campus, source_file, sheet_name, sheet_title, "
        "edited_by, unit_header, confidence, match_reason, courses_json, "
        "sections_json "
        "FROM regulatory_approved_courses ORDER BY program_id",
        "SELECT id, name, source_type, source_filename, title, "
        "curriculum_html, sections_json, notes "
        "FROM custom_references ORDER BY id",
        "SELECT id, title, current_step, current_approver_emails "
        "FROM catalog_pages ORDER BY id",
        "SELECT id, program_name, college, campus, cim_program_id, cim_step, "
        "cim_completion_date, cim_change_type, inactivation_admission, otp_status, ipd_status, "
        "svt_status, roster_sub_status, roster_proposal_type, roster_launch_date, "
        "speed_to_market, gls_status, "
        "market_2025, performance_2025, "
        "market_score_2025, performance_score_2025, concentration_of "
        "FROM portfolio_programs ORDER BY id",
    ]
    with get_db() as conn:
        for q in queries:
            try:
                for row in conn.execute(q):
                    h.update(repr(tuple(row)).encode('utf-8'))
            except Exception as e:
                # Schema drift → table missing or column missing. Fold the
                # error message into the hash so a schema change forces a
                # re-export, but don't crash the scan.
                h.update(f"ERR:{q[:40]}:{e}".encode('utf-8'))
    return h.hexdigest()


def fetch_reference_curricula(program_ids, batch_size=10, targeted_ids=None):
    """Fetch the most recent historical version (reference curriculum) for each program.

    Args:
        program_ids: list of all program IDs in scope. Used to build the
            counterpart map and run the boston_in_workflow sentinel block
            (cheap DB writes) over the full set.
        batch_size: parallelism for the JS-history fetch loop.
        targeted_ids: C3 — optional set/list of program IDs to actually
            round-trip via the JS-history fetch. Programs not in this
            set are skipped from that loop (their existing reference
            row is assumed still current). The sentinel block + the
            self-reference synth fallback always run for the full set.
            When None, every program is fetched (legacy behavior).

    Uses the CourseLeaf history API:
    /courseleaf/courseleaf.cgi?page=/programadmin/{id}/index.html&output=xml&step=showtcf&view=history&diffversion={versionId}

    For EVERY program (Boston or non-Boston):
    - Fetches the program's OWN CIM history (most recent approved version)

    The cross-program Reference comparison (non-Boston compared against
    Boston counterpart) is computed at API/export time via the campus
    group map — it doesn't require storing Boston-counterpart data
    against the non-Boston program ID anymore. That separation lets the
    Changes tab show a non-Boston deployment's own-history diff.
    """
    from database import upsert_reference_curriculum, get_db

    # Check which programs already have reference data with up-to-date versions
    existing_refs = {}
    with get_db() as conn:
        rows = conn.execute(
            "SELECT program_id, version_id FROM reference_curriculum"
        ).fetchall()
        existing_refs = {row['program_id']: row['version_id'] for row in rows}

    # One-time cleanup: legacy version_id=0 sentinels (Boston-in-workflow
    # snapshots stored against non-Boston deployments) are no longer
    # produced and must be cleared so they don't shadow the next
    # own-history upsert.
    with get_db() as conn:
        cleared_sentinels = conn.execute(
            "DELETE FROM reference_curriculum WHERE version_id = 0"
        ).rowcount
    if cleared_sentinels:
        print(f"  Cleared {cleared_sentinels} legacy Boston-in-workflow sentinel row(s)")

    fetch_ids = list(program_ids)

    # C3: if a targeted set was supplied, only fetch programs in it. This
    # avoids the ~16 min round-trip cost of checking version_ids for the
    # 1500+ programs whose reference can't have changed since last scan.
    if targeted_ids is not None:
        targeted_set = set(targeted_ids)
        before = len(fetch_ids)
        fetch_ids = [pid for pid in fetch_ids if pid in targeted_set]
        print(f"  C3 targeting: fetching {len(fetch_ids)} of {before} "
              f"(skipping {before - len(fetch_ids)} assumed-fresh)")

    print(f"\nFetching reference curricula for {len(fetch_ids)} programs (via CIM history)...")
    # Larger batches are OK now since we parallelize fetches within each batch
    batch_size = max(batch_size, 25)
    batches = [fetch_ids[i:i+batch_size] for i in range(0, len(fetch_ids), batch_size)]
    fetched = 0
    skipped = 0
    import time as _time

    for batch_num, batch in enumerate(batches):
        ids_json = json.dumps(batch)

        # Fire off async parallel fetches; write results into a hidden div keyed by batch number.
        # The main thread returns immediately; Python polls the div for completion.
        batch_tag = f"__refbatch_{batch_num}"
        js_kickoff = f'''
(function() {{
    var existing = document.getElementById("{batch_tag}");
    if (existing) existing.remove();
    var holder = document.createElement("div");
    holder.id = "{batch_tag}";
    holder.style.display = "none";
    holder.setAttribute("data-status", "running");
    document.body.appendChild(holder);

    var ids = {ids_json};
    var parser = new DOMParser();

    function extractCurriculum(fullHtml) {{
        var doc = parser.parseFromString(fullHtml, "text/html");
        var parts = [];
        var bodyDiv = doc.getElementById("bodycontentframediv3");
        if (bodyDiv) parts.push(bodyDiv.innerHTML);
        var concDiv = doc.getElementById("concentrations");
        if (concDiv) {{
            var concRow = concDiv.closest(".row") || concDiv.parentElement;
            if (concRow) parts.push(concRow.innerHTML);
        }}
        var overviewDiv = doc.getElementById("overviewcontentframediv4");
        if (overviewDiv) parts.push('<h2>Program Overview</h2>' + overviewDiv.innerHTML);
        return parts.join("\\n");
    }}

    function processOne(id) {{
        // Always fetch the program's OWN history. Cross-program "Reference"
        // resolution (non-Boston compared against Boston counterpart) lives
        // in the API layer.
        var fetchId = id;
        // Step 1: page fetch (parallelizable — network limited)
        return fetch("/programadmin/" + fetchId + "/", {{cache: 'no-store'}})
            .then(function(res) {{
                if (!res.ok) throw new Error("fetch_failed:" + res.status);
                return res.text();
            }})
            .then(function(pageText) {{
                var doc = parser.parseFromString(pageText, "text/html");
                var histDiv = doc.getElementById("history");
                if (!histDiv) return {{id: id, error: "no_history"}};
                var links = histDiv.querySelectorAll("a[onclick]");
                if (links.length === 0) return {{id: id, error: "no_versions"}};
                var lastLink = links[links.length - 1];
                var vMatch = lastLink.getAttribute("onclick").match(/showHistory\\((\\d+)\\)/);
                if (!vMatch) return {{id: id, error: "no_version_id"}};
                var versionId = parseInt(vMatch[1]);
                var versionDate = lastLink.textContent.trim();
                // Step 2: CGI fetch (server serializes, but still faster with concurrent requests)
                var apiUrl = "/courseleaf/courseleaf.cgi?page=/programadmin/" + fetchId +
                    "/index.html&output=xml&step=showtcf&view=history&diffversion=" + versionId;
                return fetch(apiUrl, {{cache: 'no-store'}}).then(function(res) {{
                    if (!res.ok) throw new Error("history_fetch_failed:" + res.status);
                    return res.text();
                }}).then(function(xml) {{
                    var cdataStart = xml.indexOf("<![CDATA[");
                    var cdataEnd = xml.indexOf("]]>", cdataStart + 9);
                    var fullHtml = (cdataStart !== -1 && cdataEnd !== -1)
                        ? xml.substring(cdataStart + 9, cdataEnd) : "";
                    var html = extractCurriculum(fullHtml);
                    return {{id: id, version_id: versionId, version_date: versionDate, html: html}};
                }});
            }})
            .catch(function(e) {{ return {{id: id, error: e.message || String(e)}}; }});
    }}

    Promise.all(ids.map(processOne)).then(function(results) {{
        // Store results as JSON in the holder div
        holder.textContent = JSON.stringify(results);
        holder.setAttribute("data-status", "done");
    }}).catch(function(e) {{
        holder.textContent = "ERROR:" + e.message;
        holder.setAttribute("data-status", "error");
    }});

    return "fired";
}})();
'''
        run_js_in_tab("programadmin", js_kickoff, match_by='url', timeout=20)

        # Poll for completion (up to ~120 seconds per batch)
        check_js = f'''(function() {{
    var el = document.getElementById("{batch_tag}");
    if (!el) return "MISSING";
    var status = el.getAttribute("data-status");
    if (status === "done") return "DONE";
    if (status === "error") return "ERR:" + el.textContent.substring(0, 200);
    return "RUNNING";
}})();'''
        batch_results = None
        for _ in range(60):  # up to 120s total
            _time.sleep(2)
            status = run_js_in_tab("programadmin", check_js, match_by='url', timeout=15)
            if status == "DONE":
                # Retrieve results in chunks to avoid AppleScript return-value limits
                # Pull length first, then chunk through it
                len_js = f'''(function() {{ var el = document.getElementById("{batch_tag}"); return el ? el.textContent.length : 0; }})();'''
                total_len = int(run_js_in_tab("programadmin", len_js, match_by='url', timeout=15) or 0)
                if total_len == 0:
                    batch_results = []
                    break
                chunk_size = 200000
                chunks = []
                for offset in range(0, total_len, chunk_size):
                    chunk_js = f'''(function() {{ var el = document.getElementById("{batch_tag}"); return el ? el.textContent.substring({offset}, {offset + chunk_size}) : ""; }})();'''
                    part = run_js_in_tab("programadmin", chunk_js, match_by='url', timeout=30)
                    if part and part != 'missing value':
                        chunks.append(part)
                try:
                    batch_results = json.loads(''.join(chunks))
                except json.JSONDecodeError as e:
                    print(f"  Batch {batch_num+1}/{len(batches)}: JSON parse error ({e})")
                    batch_results = []
                # Clean up
                run_js_in_tab("programadmin", f'var e=document.getElementById("{batch_tag}"); if(e) e.remove();', match_by='url', timeout=10)
                break
            if status and status.startswith("ERR"):
                print(f"  Batch {batch_num+1}/{len(batches)}: JS error: {status}")
                batch_results = []
                break

        if batch_results is None:
            print(f"  Batch {batch_num+1}/{len(batches)}: timed out after 120s")
            continue

        # Process results
        batch_fetched = 0
        for info in batch_results:
            prog_id = info.get('id')
            if 'error' in info:
                if info['error'] not in ('no_history', 'no_versions'):
                    print(f"  Program {prog_id}: {info['error']}")
                skipped += 1
                continue
            version_id = info.get('version_id')
            version_date = info.get('version_date', '')
            html = info.get('html', '')
            if existing_refs.get(prog_id) == version_id:
                skipped += 1
                continue
            if html:
                # Always stores OWN history — no Boston-version annotation
                # anymore. Cross-program rendering is computed at API/export
                # time via the campus group map.
                upsert_reference_curriculum(prog_id, version_id, version_date, html)
                fetched += 1
                batch_fetched += 1
            else:
                skipped += 1

        print(f"  Batch {batch_num+1}/{len(batches)}: fetched {batch_fetched} (total {fetched})")

    # Clean up any leftover batch holders
    run_js_in_tab("programadmin", 'document.querySelectorAll("[id^=__refbatch_]").forEach(function(e){e.remove();});', match_by='url', timeout=10)

    # Note: previously this function synthesized a "self-reference" for
    # programs with no Boston counterpart and no CIM history — storing the
    # program's own current curriculum as its reference. That produced
    # misleading Alignment-tab diffs (a curriculum compared against an old
    # snapshot of itself, labeled "reference"). The Reference tab now
    # reports "no reference available" instead, and the user can pick an
    # explicit override via the Reference picker. Intra-program version
    # history lives on the new Changes tab, not on Reference.
    #
    # Also clean up any pre-existing sentinel rows from the old policy so
    # they don't keep flowing through to the dashboard.
    with get_db() as conn:
        cleared = conn.execute(
            "DELETE FROM reference_curriculum WHERE version_id = -1"
        ).rowcount
    if cleared:
        print(f"  Cleared {cleared} legacy self-reference sentinel row(s)")

    print(f"Reference curricula: {fetched} fetched, {skipped} skipped")
    return fetched


# ---------------------------------------------------------------------------
# Regulatory approved-curriculum fetch (from GlobalRegulatoryAffairs SharePoint)
# ---------------------------------------------------------------------------

# 1:1 mapping between campus name (as it appears in CIM program names) and
# the SharePoint filename prefix (and the workbook itself).
REGULATORY_CAMPUS_FILES = {
    'Vancouver': 'BC Approved Courses.xlsx',
    'Miami':     'FL Approved Courses.xlsx',
    'Portland':  'ME Approved Courses.xlsx',
    'Charlotte': 'NC Approved Courses.xlsx',
    'Toronto':   'Ontario Approved Courses.xlsx',
    'Arlington': 'VA Approved Courses.xlsx',
    'Seattle':   'WA Approved Courses.xlsx',
}

# Path of the SharePoint folder containing the workbooks. Changing this is
# the single point of control if the curriculum committee moves the files.
_REGULATORY_FOLDER_URL = (
    "/sites/GlobalRegulatoryAffairs/Shared%20Documents/Resources/"
    "Master%20Portfolio/CURRENT%20APPROVED%20CURRICULUM"
)

# Chrome tab match substring for SharePoint (any tab on the GRA site works).
_REGULATORY_TAB_MATCH = "sharepoint.com/sites/GlobalRegulatoryAffairs"


def _download_regulatory_workbooks():
    """Fetch the 7 workbook .xlsx files from SharePoint via the logged-in session.

    Uses the same Chrome/AppleScript bridge the CourseLeaf scraper relies on.
    The SharePoint REST endpoint `/_api/web/GetFileByServerRelativeUrl(...)/$value`
    returns the file bytes when the browser has an authenticated session cookie.

    Returns:
        dict of {campus: bytes or None}. A None value means the download failed.
    """
    import base64 as _b64

    # Kick off all 7 downloads in parallel; each writes base64 result into
    # window.__regwb[<campus>] so Python can pull them after.
    files_json = json.dumps([
        {'campus': c, 'filename': fn}
        for c, fn in REGULATORY_CAMPUS_FILES.items()
    ])
    folder_url = _REGULATORY_FOLDER_URL

    kickoff_js = f'''
(function(){{
    window.__regwb = {{}};
    window.__regwb_status = "running";
    var files = {files_json};
    var folder = "{folder_url}";

    function fetchOne(entry) {{
        var encoded = encodeURIComponent(entry.filename);
        var url = location.origin +
            "/sites/GlobalRegulatoryAffairs/_api/web/GetFileByServerRelativeUrl('" +
            folder + "/" + encoded + "')/$value";
        return new Promise(function(resolve) {{
            var xhr = new XMLHttpRequest();
            xhr.open("GET", url, true);
            xhr.responseType = "arraybuffer";
            xhr.onload = function(){{
                if (xhr.status >= 200 && xhr.status < 300) {{
                    var b = new Uint8Array(xhr.response);
                    var bin = "";
                    // Chunk-wise to avoid call-stack limits on very large files
                    var step = 32768;
                    for (var i = 0; i < b.length; i += step) {{
                        bin += String.fromCharCode.apply(null, b.subarray(i, i+step));
                    }}
                    window.__regwb[entry.campus] = {{ status: xhr.status, len: b.length, b64: btoa(bin) }};
                }} else {{
                    window.__regwb[entry.campus] = {{ status: xhr.status, error: "http" }};
                }}
                resolve();
            }};
            xhr.onerror = function(){{
                window.__regwb[entry.campus] = {{ error: "network" }};
                resolve();
            }};
            xhr.send();
        }});
    }}

    Promise.all(files.map(fetchOne)).then(function(){{
        window.__regwb_status = "done";
    }}).catch(function(e){{
        window.__regwb_status = "error:" + (e && e.message || e);
    }});
    return "fired";
}})();
'''
    fired = run_js_in_tab(_REGULATORY_TAB_MATCH, kickoff_js, match_by='url', timeout=30)
    if not fired or fired == 'missing value':
        print("  SharePoint tab not open — skipping regulatory fetch")
        return {c: None for c in REGULATORY_CAMPUS_FILES}

    # Poll for completion
    status_js = 'window.__regwb_status || "missing"'
    for _ in range(90):  # up to 180s
        time.sleep(2)
        status = run_js_in_tab(_REGULATORY_TAB_MATCH, status_js, match_by='url', timeout=15)
        if status == "done":
            break
        if status and status.startswith("error:"):
            print(f"  Regulatory fetch JS error: {status}")
            break
    else:
        print("  Regulatory fetch timed out after 180s")

    # Pull each workbook's base64 in chunks
    results = {}
    for campus in REGULATORY_CAMPUS_FILES:
        meta_js = (
            'JSON.stringify(window.__regwb && window.__regwb[' + json.dumps(campus) +
            '] ? {status: window.__regwb[' + json.dumps(campus) + '].status || null,'
            ' len: window.__regwb[' + json.dumps(campus) + '].len || 0,'
            ' b64len: (window.__regwb[' + json.dumps(campus) + '].b64 || "").length,'
            ' error: window.__regwb[' + json.dumps(campus) + '].error || null} : null)'
        )
        meta = run_js_in_tab(_REGULATORY_TAB_MATCH, meta_js, match_by='url', timeout=15)
        if not meta or meta == 'missing value' or meta == 'null':
            print(f"  {campus}: no download result")
            results[campus] = None
            continue
        try:
            m = json.loads(meta)
        except json.JSONDecodeError:
            results[campus] = None
            continue
        if m.get('error') or not m.get('b64len'):
            err = m.get('error') or f"status {m.get('status')}"
            print(f"  {campus}: download failed ({err})")
            results[campus] = None
            continue
        total = m['b64len']
        chunk = 200000
        parts = []
        for offset in range(0, total, chunk):
            js = (
                'window.__regwb[' + json.dumps(campus) + '].b64.substr(' +
                f'{offset},{chunk})'
            )
            part = run_js_in_tab(_REGULATORY_TAB_MATCH, js, match_by='url', timeout=30)
            if part and part != 'missing value':
                parts.append(part)
        try:
            data = _b64.b64decode(''.join(parts))
        except Exception as e:
            print(f"  {campus}: base64 decode failed ({e})")
            results[campus] = None
            continue
        if len(data) != m['len']:
            print(f"  {campus}: length mismatch (expected {m['len']}, got {len(data)})")
        results[campus] = data
        print(f"  {campus}: downloaded {len(data)} bytes from {REGULATORY_CAMPUS_FILES[campus]}")

    # Clean up window state
    run_js_in_tab(_REGULATORY_TAB_MATCH,
                  'try{delete window.__regwb; delete window.__regwb_status;}catch(e){}',
                  match_by='url', timeout=10)

    return results


def fetch_regulatory_approved(program_ids):
    """Download the 7 regulatory workbooks from SharePoint and match them to
    CIM programs in `program_ids`. Upserts `regulatory_approved_courses`.

    Requires a Chrome tab open on the GlobalRegulatoryAffairs SharePoint site
    (any page on that site will have the auth cookie).

    Returns (matched_count, unmatched_count, skipped_campuses_count).
    """
    import json as _json
    from database import (
        upsert_regulatory_approved, delete_regulatory_approved, get_db,
    )
    try:
        from xlsx_parser import parse_workbook, match_sheets_to_programs
    except ImportError as e:
        print(f"  xlsx_parser unavailable: {e}")
        return (0, 0, 0)

    if not program_ids:
        return (0, 0, 0)

    print("\nFetching regulatory approved curricula from SharePoint...")
    workbooks = _download_regulatory_workbooks()
    skipped = sum(1 for v in workbooks.values() if v is None)

    # Build {campus: [cim_program_dict]} for programs that are in program_ids
    # AND have a campus parenthetical matching one of the regulatory campuses.
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, name, curriculum_html FROM programs WHERE id IN "
            f"({','.join('?'*len(program_ids))})",
            program_ids,
        ).fetchall()

    by_campus = {c: [] for c in REGULATORY_CAMPUS_FILES}
    all_scan_ids_per_campus = {c: [] for c in REGULATORY_CAMPUS_FILES}
    for row in rows:
        _base, campus = _parse_campus_from_name(row['name'])
        if campus not in REGULATORY_CAMPUS_FILES:
            continue
        codes = set()
        if row['curriculum_html']:
            for m in re.finditer(r'\b([A-Z]{2,5})\s*(\d{4}[A-Z]?)\b', row['curriculum_html']):
                codes.add(f"{m.group(1)} {m.group(2)}")
        by_campus[campus].append({
            'id': row['id'],
            'name': row['name'],
            'curriculum_codes': codes,
        })
        all_scan_ids_per_campus[campus].append(row['id'])

    total_matched = 0
    total_unmatched = 0

    for campus, cim_programs in by_campus.items():
        if not cim_programs:
            continue
        data = workbooks.get(campus)
        if data is None:
            # Workbook download failed — don't touch any existing rows.
            total_unmatched += len(cim_programs)
            continue
        try:
            sheets = parse_workbook(data)
        except Exception as e:
            print(f"  {campus}: parse error {e}")
            total_unmatched += len(cim_programs)
            continue

        matches = match_sheets_to_programs(sheets, cim_programs, campus)
        matched_ids = set()
        for m in matches:
            sheet = sheets[m['sheet_index']]
            upsert_regulatory_approved(
                program_id=m['program_id'],
                campus=campus,
                source_file=REGULATORY_CAMPUS_FILES[campus],
                sheet_name=sheet['sheet_name'],
                sheet_title=sheet.get('title', ''),
                edited_by=sheet.get('edited_by', ''),
                unit_header=sheet.get('unit_header', ''),
                confidence=m['confidence'],
                match_reason=m['reason'],
                courses_json=_json.dumps(sheet.get('courses', [])),
                sections_json=_json.dumps(sheet.get('sections', [])),
            )
            matched_ids.add(m['program_id'])
        # Clear rows for scanned programs that no longer match (workbook changed).
        for pid in all_scan_ids_per_campus[campus]:
            if pid not in matched_ids:
                delete_regulatory_approved(pid)
        total_matched += len(matched_ids)
        total_unmatched += (len(cim_programs) - len(matched_ids))
        print(f"  {campus}: matched {len(matched_ids)}/{len(cim_programs)} CIM programs")

    print(f"Regulatory approved: {total_matched} matched, "
          f"{total_unmatched} unmatched, {skipped} workbook(s) unavailable")
    return (total_matched, total_unmatched, skipped)


def scrape_catalog_pages_from_role(role_name):
    """Select a UCAT/GCAT role on Approve Pages and extract pending catalog pages.

    Catalog pages are identified by path (e.g. "/graduate/mills"), not a
    numeric ID. Pending-list lines look like:
        /graduate/mills: Mills College at Northeastern\\tHeather Daly
        /shared/course-credit-sharing: Shared Content: ...\\tHeather Daly

    Same poll-until-stable async pattern as the program/course scrapers.

    Returns list of dicts with `id` (the path), `title`, and `user`.
    """
    poll_tag = f"__catapp_{int(time.time() * 1000)}"
    js = f'''
(function() {{
    var existing = document.getElementById("{poll_tag}");
    if (existing) existing.remove();
    var holder = document.createElement("div");
    holder.id = "{poll_tag}";
    holder.style.display = "none";
    holder.setAttribute("data-status", "running");
    document.body.appendChild(holder);

    var select = document.querySelector("select");
    if (!select) {{
        holder.textContent = JSON.stringify({{error: "no select"}});
        holder.setAttribute("data-status", "done");
        return "fired";
    }}
    select.value = {json.dumps(role_name)};
    if (typeof showPendingList === "function") {{
        showPendingList(select.value);
    }} else {{
        select.dispatchEvent(new Event("change", {{bubbles: true}}));
    }}

    function extract() {{
        var lines = document.body.innerText.split("\\n");
        var pages = [];
        for (var i = 0; i < lines.length; i++) {{
            var line = lines[i].trim();
            // Catalog paths: lines starting with "/<word>/<more>:" but NOT
            // "/programadmin/" or "/courseadmin/" (those have numeric IDs).
            if (!line.startsWith("/") || line.startsWith("/programadmin/") || line.startsWith("/courseadmin/")) continue;
            var m = line.match(/^(\\/[^:]+):\\s*(.+)/);
            if (!m) continue;
            var path = m[1].trim();
            var rest = m[2];
            var parts = rest.split("\\t");
            var title = parts[0].trim();
            var user = parts.length > 1 ? parts[1].trim() : "";
            pages.push({{id: path, title: title, user: user}});
        }}
        return pages;
    }}

    var lastSize = -1;
    var stableCount = 0;
    var elapsed = 0;
    var interval = setInterval(function() {{
        elapsed += 500;
        var pages = extract();
        if (pages.length === lastSize) stableCount++;
        else stableCount = 0;
        lastSize = pages.length;
        // See scrape_courses_from_role / scrape_approve_pages_role
        // for rationale. Empty roles exit early after 3s + 5 stable polls.
        var stableEmptyDone = (pages.length === 0 && stableCount >= 5 && elapsed >= 3000);
        if ((pages.length > 0 && stableCount >= 3) || stableEmptyDone || elapsed >= 15000) {{
            clearInterval(interval);
            holder.textContent = JSON.stringify(pages);
            holder.setAttribute("data-status", "done");
        }}
    }}, 500);
    return "fired";
}})();
'''
    fired = run_js_in_tab("courseleaf/approve", js, match_by='url', timeout=20)
    if not fired or fired == 'missing value':
        return []

    check_js = f'''(function(){{ var el = document.getElementById("{poll_tag}"); if (!el) return "MISSING"; return el.getAttribute("data-status") === "done" ? el.textContent : "RUNNING"; }})();'''
    payload = None
    for _ in range(20):
        time.sleep(1)
        r = run_js_in_tab("courseleaf/approve", check_js, match_by='url', timeout=10)
        if r and r != 'missing value' and r != 'RUNNING' and r != 'MISSING':
            payload = r
            break

    run_js_in_tab(
        "courseleaf/approve",
        f'var e=document.getElementById("{poll_tag}"); if(e) e.remove();',
        match_by='url', timeout=5,
    )

    if not payload:
        return []
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        return []
    if isinstance(data, dict) and 'error' in data:
        return []
    return data


def heal_stale_catalog_pages(log=False, progress_callback=None, callback_every=10):
    """Mirror DB catalog_pages to live UCAT/GCAT pending lists.

    Same approach as heal_stale_program_steps / heal_stale_course_steps but
    for catalog pages. Iterates each CATALOG_TRACKED_ROLE, builds a
    `path -> role` map from live pending lists, sets `current_step = role`
    for each path, clears `current_step` for catalog rows no longer on any
    list. Catalog pages have no per-page admin URL so there's no equivalent
    of "fetch full details for new IDs" — the Approve Pages line gives us
    everything we display (path, title, role, approver name).

    Args:
        log: print per-role counts.
        progress_callback: optional callable invoked every
            `callback_every` roles (used by chunked-scan path to
            interleave quick role-update fetches between groups).
        callback_every: roles between callback firings.
    """
    from database import (
        get_all_catalog_pages, get_db, upsert_catalog_page, record_catalog_scan,
    )

    if log:
        print(f"\nMirroring catalog DB to live UCAT/GCAT pending lists "
              f"({len(CATALOG_TRACKED_ROLES)} roles)...")

    live_assignments = {}  # path -> {role, title, user}
    for idx, role in enumerate(CATALOG_TRACKED_ROLES):
        pages = scrape_catalog_pages_from_role(role)
        for p in pages:
            path = p['id']
            if path not in live_assignments:
                live_assignments[path] = {
                    'role': role,
                    'title': p.get('title', ''),
                    'user': p.get('user', ''),
                }
        if log and pages:
            print(f"  {role}: {len(pages)}")
        if progress_callback and (idx + 1) % callback_every == 0 and (idx + 1) < len(CATALOG_TRACKED_ROLES):
            try:
                progress_callback(idx + 1, len(CATALOG_TRACKED_ROLES))
            except Exception as e:
                print(f"  heal_stale_catalog_pages progress_callback error: {e}")

    if log:
        print(f"\nLive: {len(live_assignments)} unique catalog pages")

    db_pages = {p['id']: p for p in get_all_catalog_pages()}
    db_active = sum(1 for p in db_pages.values() if p.get('current_step'))

    # Safety net (see heal_stale_course_steps for rationale).
    if db_active >= 50 and len(live_assignments) < max(20, int(db_active * 0.25)):
        msg = (f"ABORT heal_stale_catalog_pages: scraped only "
               f"{len(live_assignments)} pages across "
               f"{len(CATALOG_TRACKED_ROLES)} roles, but DB has {db_active} "
               f"marked active. Refusing to wipe — likely a transient "
               f"AppleScript/tab-throttle issue.")
        if log: print(msg)
        return [msg], 0

    fixed = 0

    # 1) Pages in live → upsert
    for path, info in live_assignments.items():
        existing = db_pages.get(path)
        if existing and existing.get('current_step') == info['role'] and existing.get('title') == info['title']:
            continue
        upsert_catalog_page({
            'id': path,
            'title': info['title'],
            'current_step': info['role'],
            'current_approver_emails': '',
            'user': info['user'],
        })
        fixed += 1
        if log and fixed <= 50:
            old = (existing.get('current_step') or '(empty)') if existing else '(NEW)'
            print(f"  {path}: {old!r} → {info['role']!r}")

    # 2) Pages in DB at any role but no longer on any list → clear current_step
    for path, p in db_pages.items():
        if not p.get('current_step'):
            continue
        if path in live_assignments:
            continue
        with get_db() as conn:
            conn.execute(
                "UPDATE catalog_pages SET current_step = '', current_approver_emails = '', last_updated = ? WHERE id = ?",
                (datetime.now().isoformat(), path),
            )
        fixed += 1
        if log and fixed <= 50:
            print(f"  {path}: {p.get('current_step')!r} → '' (gone from all pending lists)")

    record_catalog_scan(
        datetime.now().isoformat(),
        pages_scanned=len(live_assignments),
        pages_with_workflow=len(live_assignments),
        changes_detected=fixed,
    )

    if log:
        print(f"Catalog sync complete: {fixed} catalog page changes")
    return 0, fixed


def scrape_courses_from_role(role_name):
    """Select a role on Approve Pages and extract pending courses.

    Same poll-until-stable pattern as scrape_approve_pages_role — CourseLeaf
    loads the list async and a fixed sleep was undercounting on slow loads.

    Returns list of dicts with course id, name, user (approver).
    """
    poll_tag = f"__crsapp_{int(time.time() * 1000)}"
    js = f'''
(function() {{
    var existing = document.getElementById("{poll_tag}");
    if (existing) existing.remove();
    var holder = document.createElement("div");
    holder.id = "{poll_tag}";
    holder.style.display = "none";
    holder.setAttribute("data-status", "running");
    document.body.appendChild(holder);

    var select = document.querySelector("select");
    if (!select) {{
        holder.textContent = JSON.stringify({{error: "no select"}});
        holder.setAttribute("data-status", "done");
        return "fired";
    }}
    select.value = {json.dumps(role_name)};
    if (typeof showPendingList === "function") {{
        showPendingList(select.value);
    }} else {{
        select.dispatchEvent(new Event("change", {{bubbles: true}}));
    }}

    function extract() {{
        var lines = document.body.innerText.split("\\n");
        var courses = [];
        for (var i = 0; i < lines.length; i++) {{
            var line = lines[i].trim();
            var m = line.match(/^\\/courseadmin\\/(\\d+):\\s*(.+)/);
            if (m) {{
                var parts = m[2].split("\\t");
                courses.push({{
                    id: m[1],
                    name: parts[0].trim(),
                    user: parts.length > 1 ? parts[1].trim() : "",
                }});
            }}
        }}
        return courses;
    }}

    var lastSize = -1;
    var stableCount = 0;
    var elapsed = 0;
    var interval = setInterval(function() {{
        elapsed += 500;
        var courses = extract();
        if (courses.length === lastSize) stableCount++;
        else stableCount = 0;
        lastSize = courses.length;
        // Exit when stable for >=3 polls (1.5s) — works for both empty
        // and populated lists. Also break out if the role's pending list
        // is genuinely empty after 3s, since most "Program ..." roles
        // never have courses. Hard ceiling at 15s.
        var stableEmptyDone = (courses.length === 0 && stableCount >= 5 && elapsed >= 3000);
        if ((courses.length > 0 && stableCount >= 3) || stableEmptyDone || elapsed >= 15000) {{
            clearInterval(interval);
            holder.textContent = JSON.stringify(courses);
            holder.setAttribute("data-status", "done");
        }}
    }}, 500);
    return "fired";
}})();
'''
    fired = run_js_in_tab("courseleaf/approve", js, match_by='url', timeout=20)
    if not fired or fired == 'missing value':
        return []

    check_js = f'''(function(){{ var el = document.getElementById("{poll_tag}"); if (!el) return "MISSING"; return el.getAttribute("data-status") === "done" ? el.textContent : "RUNNING"; }})();'''
    payload = None
    for _ in range(20):
        time.sleep(1)
        r = run_js_in_tab("courseleaf/approve", check_js, match_by='url', timeout=10)
        if r and r != 'missing value' and r != 'RUNNING' and r != 'MISSING':
            payload = r
            break

    run_js_in_tab(
        "courseleaf/approve",
        f'var e=document.getElementById("{poll_tag}"); if(e) e.remove();',
        match_by='url', timeout=5,
    )

    if not payload:
        return []
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        return []
    if isinstance(data, dict) and 'error' in data:
        return []
    return data


def get_all_approve_roles():
    """Fetch every role option from the Approve Pages dropdown."""
    js_code = '''
(function() {
    var select = document.querySelector("select[name='role']") ||
                 document.querySelector("select");
    if (!select) return JSON.stringify([]);
    var options = select.querySelectorAll("option");
    var roles = [];
    options.forEach(function(opt) {
        var t = (opt.textContent || "").trim();
        if (t && t !== "Select a role") roles.push(t);
    });
    return JSON.stringify(roles);
})();
'''
    result = run_js_in_tab("courseleaf/approve", js_code, match_by='url', timeout=30)
    if not result or result == 'missing value':
        return []
    try:
        return json.loads(result)
    except json.JSONDecodeError:
        return []


def get_course_common_roles():
    """Return the set of course roles currently observed in the DB.

    Used as the iteration source for `scrape_courses` (Option F).
    Iterating only roles where DB courses currently sit drops the
    course-discovery cost from ~25 min (215 roles, mostly empty) to
    ~10 min (~80 populated roles). Roles NOT in this set are covered by:
    - process_course_scans's A2 block (DB courses at obscure roles
      forced into the active fetch set, so they're verified every
      scan even though we didn't iterate their role)
    - A3 ID probe (catches brand-new courses regardless of role —
      CIM assigns sequential IDs)
    - Course exit-verification block (catches courses that completed
      or moved between obscure roles).

    The cache self-heals: when a course lands at a never-before-seen
    role, A3's ID probe ingests it with the new role, and from the
    *next* scan onward that role is in the common set.
    """
    from database import get_db
    with get_db() as conn:
        rows = conn.execute(
            "SELECT DISTINCT current_step FROM courses "
            "WHERE current_step IS NOT NULL AND current_step != ''"
        ).fetchall()
    return [row[0] for row in rows]


def scrape_courses(only_common=True, progress_callback=None, callback_every=15):
    """Scrape courses from Approve Pages.

    Args:
        only_common: when True (default), iterate only the roles
            currently observed in the DB (~80, see
            `get_course_common_roles`). When False, iterate the
            full live dropdown (~215). The False path is for
            cold-start (empty DB) or weekly safety sweeps.
        progress_callback: optional callable invoked every
            `callback_every` roles with (roles_done, total_roles).
            Used by the chunked-scan path to interleave quick
            role-update fetches between groups of slow Approve
            Pages role iterations.
        callback_every: how many roles between callback firings.
    """
    print("\n=== COURSE SCRAPING ===", flush=True)

    if only_common:
        roles = get_course_common_roles()
        if not roles:
            # First run / empty DB: fall back to full live dropdown.
            roles = get_all_approve_roles()
            print(f"  No common roles in DB; falling back to live "
                  f"dropdown ({len(roles)} roles)", flush=True)
        else:
            print(f"  Scanning {len(roles)} common roles "
                  f"(Option F; full dropdown has ~215)", flush=True)
    else:
        roles = get_all_approve_roles()
        print(f"  Scanning {len(roles)} roles "
              f"(full dropdown — only_common=False)", flush=True)

    all_courses = {}  # id -> {id, name, current_step, user}

    for idx, role in enumerate(roles):
        courses = scrape_courses_from_role(role)
        if courses:
            print(f"    {role}: {len(courses)} courses", flush=True)
            for c in courses:
                cid = c['id']
                if cid not in all_courses:
                    all_courses[cid] = {
                        'id': cid,
                        'name': c['name'],
                        'user': c.get('user', ''),
                        'current_step': role,
                    }
                else:
                    # Update to latest role where the course was found
                    all_courses[cid]['current_step'] = role
        # Interleaved-chunk hook: every `callback_every` roles, call
        # the callback. Caller typically uses this to fire a quick
        # role-update fetch + export so dashboard sees role changes
        # mid-scan instead of only at the end.
        if progress_callback and (idx + 1) % callback_every == 0 and (idx + 1) < len(roles):
            try:
                progress_callback(idx + 1, len(roles))
            except Exception as e:
                print(f"  scrape_courses progress_callback error: {e}", flush=True)

    print(f"  Total unique courses found: {len(all_courses)}", flush=True)
    return list(all_courses.values())


def batch_fetch_course_details(course_ids, batch_size=25):
    """Fetch workflow + metadata for multiple courses via async fetch().

    Parallel to batch_fetch_program_details. Chrome 147+ silently blocks
    sync XHR, so we kick off Promise.all in JS and Python polls the result.
    Returns { course_id (str): { steps: [...], meta: {...} } }.
    """
    if not course_ids:
        return {}

    all_results = {}
    batches = [course_ids[i:i+batch_size] for i in range(0, len(course_ids), batch_size)]

    for batch_num, batch in enumerate(batches):
        ids_json = json.dumps(batch)
        batch_tag = f"__crsbatch_{batch_num}_{int(time.time())}"
        kickoff_js = f'''
(function() {{
    var existing = document.getElementById("{batch_tag}");
    if (existing) existing.remove();
    var holder = document.createElement("div");
    holder.id = "{batch_tag}";
    holder.style.display = "none";
    holder.setAttribute("data-status", "running");
    document.body.appendChild(holder);

    var ids = {ids_json};
    var parser = new DOMParser();

    function processOne(id) {{
        var result = {{steps: [], meta: {{}}}};
        // cache:'no-store' — same rationale as the programadmin
        // fetch: without it, Chrome HTTP-cached HTML can show stale
        // workflow steps and the scan would miss role transitions.
        var htmlPromise = fetch("/courseadmin/" + id + "/", {{cache: 'no-store'}})
            .then(function(r) {{ return r.ok ? r.text() : ""; }})
            .then(function(html) {{
                if (!html) return;
                var doc = parser.parseFromString(html, "text/html");
                var wfDiv = doc.getElementById("workflow");
                if (wfDiv) {{
                    var items = wfDiv.querySelectorAll("li");
                    items.forEach(function(li, ord) {{
                        var link = li.querySelector("a");
                        result.steps.push({{
                            order: ord,
                            name: (li.textContent || "").trim(),
                            status: li.className.trim() || "pending",
                            emails: link ? link.getAttribute("href").replace("mailto:", "") : ""
                        }});
                    }});
                }}
                var stripTags = function(s) {{ return s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\\s+/g, " ").trim(); }};
                // Extract course code from page title or h1 (e.g. "ABRD 1001").
                // Only look in <title>/<h1> to avoid false matches in approval logs.
                var titleMatch = html.match(/<title[^>]*>[^<]*?([A-Z]{{2,6}}\\s+\\d{{4}})[^<]*<\/title>/i)
                             || html.match(/<h1[^>]*>[^<]*?([A-Z]{{2,6}}\\s+\\d{{4}})[^<]*<\/h1>/i);
                if (titleMatch) result.meta.html_course_code = titleMatch[1];
                var dsMatch = html.match(/Date Submitted:[\\s\\S]{{0,120}}?([A-Z][a-z]{{2}},\\s*\\d+\\s+[A-Z][a-z]+\\s+\\d{{4}}[\\d:\\s]*GMT)/i);
                if (dsMatch) result.meta.date_submitted = dsMatch[1].replace(/\\s+/g, " ").trim();
                var leMatch = html.match(/Last edit[\\s\\S]{{0,300}}?([A-Z][a-z]{{2}},\\s*\\d+\\s+[A-Z][a-z]+\\s+\\d{{4}}[\\d:\\s]*GMT)/i);
                if (leMatch) result.meta.last_edit = leMatch[1].replace(/\\s+/g, " ").trim();
                if (html.indexOf("New Course Proposal") !== -1) result.meta.proposal_type = "New Course Proposal";
                else if (html.indexOf("Inactivation") !== -1) result.meta.proposal_type = "Inactivation Proposal";
                else result.meta.proposal_type = "Course Revision Proposal";
                var approvalDates = [];
                var apMatch;
                var apPattern = /([A-Z][a-z]{{2}},\\s+\\d+\\s+[A-Z][a-z]+\\s+\\d{{4}}\\s+[\\d:]+\\s+GMT)[\\s\\S]{{0,400}}?Approved for ([^<\\n]+)/g;
                while ((apMatch = apPattern.exec(html)) !== null) {{
                    approvalDates.push({{date: apMatch[1], step: stripTags(apMatch[2])}});
                }}
                // Filter to current proposal cycle (see program-side comment).
                var cycleStart = result.meta.date_submitted ? new Date(result.meta.date_submitted) : null;
                if (cycleStart && !isNaN(cycleStart)) {{
                    approvalDates = approvalDates.filter(function(a) {{
                        var d = new Date(a.date);
                        return !isNaN(d) && d >= cycleStart;
                    }});
                }}
                if (approvalDates.length > 0) {{
                    var latest = approvalDates[0];
                    var latestT = new Date(latest.date).getTime();
                    for (var ai = 1; ai < approvalDates.length; ai++) {{
                        var t = new Date(approvalDates[ai].date).getTime();
                        if (t > latestT) {{ latest = approvalDates[ai]; latestT = t; }}
                    }}
                    result.meta.last_approval_date = latest.date;
                }} else if (result.meta.date_submitted) {{
                    result.meta.last_approval_date = result.meta.date_submitted;
                }}
                result.meta.approvals = approvalDates;
            }})
            .catch(function(e) {{ result.html_error = e.message || String(e); }});

        var xmlPromise = fetch("/courseadmin/" + id + "/index.xml", {{cache: 'no-store'}})
            .then(function(r) {{
                result.meta.xml_status = r.status;
                return r.ok ? r.text() : "";
            }})
            .then(function(xml) {{
                if (!xml) return;
                var xmlDoc = parser.parseFromString(xml, "text/xml");
                var getXml = function(tag) {{
                    var el = xmlDoc.querySelector(tag);
                    return el ? el.textContent.trim() : "";
                }};
                result.meta.college = getXml("college");
                result.meta.department = getXml("department");
                result.meta.subject = getXml("subject") || getXml("subjectcode") || getXml("prefix");
                result.meta.course_number = getXml("course_number") || getXml("number") || getXml("courseNumber") || getXml("coursenumber");
                result.meta.course_code = getXml("code");  // pre-formatted "ARAB 1101"
                result.meta.course_title = getXml("long_title") || getXml("short_title") || getXml("title") || getXml("courseTitle");
                result.meta.credits = getXml("credits") || getXml("credithoursmin") || getXml("credit_hours") || getXml("credithours");
                result.meta.description = getXml("description") || getXml("coursedescription") || getXml("catalogdescription");
                result.meta.acad_level = getXml("acad_level") || getXml("level") || getXml("courselevel");
                result.meta.eff_term = getXml("eff_term") || getXml("effterm");
                result.meta.eff_cat = getXml("eff_cat") || getXml("effcat");
            }})
            .catch(function(e) {{ result.xml_error = e.message || String(e); }});

        return Promise.all([htmlPromise, xmlPromise]).then(function() {{
            return [id, result];
        }});
    }}

    Promise.all(ids.map(processOne)).then(function(pairs) {{
        var out = {{}};
        for (var i = 0; i < pairs.length; i++) out[pairs[i][0]] = pairs[i][1];
        holder.textContent = JSON.stringify(out);
        holder.setAttribute("data-status", "done");
    }}).catch(function(e) {{
        holder.textContent = "ERROR:" + (e && e.message || e);
        holder.setAttribute("data-status", "error");
    }});
    return "fired";
}})();
'''
        # Reuse the programadmin tab — same CourseLeaf origin so same-origin
        # fetches work and we don't need a separate courseadmin tab.
        run_js_in_tab("programadmin", kickoff_js, match_by='url', timeout=20)

        check_js = f'''(function() {{
    var el = document.getElementById("{batch_tag}");
    if (!el) return "MISSING";
    var s = el.getAttribute("data-status");
    if (s === "done") return "DONE";
    if (s === "error") return "ERR:" + el.textContent.substring(0, 200);
    return "RUNNING";
}})();'''
        batch_results = None
        for _ in range(60):  # up to 120s per batch
            time.sleep(2)
            status = run_js_in_tab("programadmin", check_js, match_by='url', timeout=15)
            if status == "DONE":
                len_js = (
                    f'(function(){{ var el = document.getElementById("{batch_tag}"); '
                    f'return el ? el.textContent.length : 0; }})();'
                )
                total_len = int(run_js_in_tab("programadmin", len_js, match_by='url', timeout=15) or 0)
                if total_len == 0:
                    batch_results = {}
                    break
                chunk_size = 200000
                chunks = []
                for offset in range(0, total_len, chunk_size):
                    chunk_js = (
                        f'(function(){{ var el = document.getElementById("{batch_tag}"); '
                        f'return el ? el.textContent.substring({offset}, {offset + chunk_size}) : ""; }})();'
                    )
                    part = run_js_in_tab("programadmin", chunk_js, match_by='url', timeout=30)
                    if part and part != 'missing value':
                        chunks.append(part)
                try:
                    batch_results = json.loads(''.join(chunks))
                except json.JSONDecodeError as e:
                    print(f"    Batch {batch_num+1}/{len(batches)}: JSON parse error ({e})", flush=True)
                    batch_results = {}
                run_js_in_tab(
                    "programadmin",
                    f'var e=document.getElementById("{batch_tag}"); if(e) e.remove();',
                    match_by='url', timeout=10,
                )
                break
            if status and status.startswith("ERR"):
                print(f"    Batch {batch_num+1}/{len(batches)}: JS error: {status}", flush=True)
                batch_results = {}
                break

        if batch_results is None:
            print(f"    Batch {batch_num+1}/{len(batches)}: timed out after 120s", flush=True)
            continue

        for cid_str, data in batch_results.items():
            all_results[cid_str] = data
            try:
                from database import upsert_course_approvals
                approvals = (data.get('meta') or {}).get('approvals') or []
                if approvals:
                    upsert_course_approvals(int(cid_str), approvals)
            except Exception:
                pass
        print(f"    Batch {batch_num+1}/{len(batches)}: fetched {len(batch_results)} courses", flush=True)

    # Clean up any leftover holder divs
    run_js_in_tab(
        "programadmin",
        'document.querySelectorAll("[id^=__crsbatch_]").forEach(function(e){e.remove();});',
        match_by='url', timeout=10,
    )

    return all_results


def process_course_scans(courses, force_fetch_only=False):
    """Store scraped courses in the database (Option F: hybrid discovery).

    When `force_fetch_only=True`: ignores `courses` (caller can pass
    `[]`), skips A2 obscure-role lookup, A3 ID probe, and exit
    verification — just force-fetches the workflow div for every
    DB-active course and reconciles. Used by do_quick_role_update.


    Discovery has the same shape as run_full_scan's Phase A:
      A1) `courses` arg is whatever scrape_courses iterated (common roles)
      A2) DB courses whose current_step is at an obscure role (one not
          in the iterated set) — force-fetched via Phase B to verify
      A3) ID probe (max_course_id, max_course_id + 50) for brand-new
          courses

    Plus a courses-side exit-verification block: courses in DB at a
    common role that didn't show up in `courses` (typically because
    they completed mid-workflow and disappeared from Approve Pages)
    get verified via workflow div before any destructive change.
    """
    print("\nProcessing course scans...", flush=True)
    now = datetime.now().isoformat()
    overall_start = time.time()
    phase_times = {}
    existing = {c['id']: c for c in get_all_courses()}
    changes = 0

    # ---- Diff: classify scraped courses vs DB
    phase_start = time.time()
    new_ids, moved_ids, unchanged_ids = [], [], []
    obscure_db_ids = []
    probe_cids = []

    if force_fetch_only:
        # Quick mode: skip discovery, just force-fetch all DB-active.
        print(f"  Force-fetch only mode (skipping diff/A2/A3)", flush=True)
    else:
        for c in courses:
            cid = c['id']
            live_step = c.get('current_step', '') or ''
            db = existing.get(cid)
            if db is None:
                new_ids.append(cid)
            elif (db.get('current_step') or '') != live_step:
                moved_ids.append(cid)
            else:
                unchanged_ids.append(cid)

        # ---- A2: DB courses at obscure roles (those NOT iterated by
        # scrape_courses this run) — force-fetch via Phase B.
        iterated_roles = {c.get('current_step', '') for c in courses if c.get('current_step')}
        for cid, db in existing.items():
            db_step = db.get('current_step') or ''
            if not db_step or db_step in iterated_roles:
                continue
            obscure_db_ids.append(cid)
        if obscure_db_ids:
            print(f"  A2: {len(obscure_db_ids)} DB courses at obscure roles "
                  f"(forced into active fetch)", flush=True)

        # ---- A3: ID probe for brand-new courses.
        max_db_cid = 0
        for cid in existing.keys():
            try:
                n = int(cid)
                if n > max_db_cid:
                    max_db_cid = n
            except (ValueError, TypeError):
                continue
        probe_id_count = 50
        probe_cids = [str(n) for n in range(max_db_cid + 1, max_db_cid + 1 + probe_id_count)]
        if probe_cids:
            print(f"  A3: probing course IDs {probe_cids[0]}..{probe_cids[-1]} "
                  f"for brand-new courses", flush=True)

    # 100% accuracy: every DB course currently in workflow gets its
    # workflow div re-fetched and reconciled this scan, regardless of
    # what Approve Pages said.
    all_active_db_cids = [cid for cid, db in existing.items()
                          if db.get('current_step')]

    active_ids = (set(new_ids) | set(moved_ids) | set(obscure_db_ids)
                  | set(probe_cids) | set(all_active_db_cids))
    phase_times['1_diff'] = time.time() - phase_start
    print(f"  Diff vs DB: {len(unchanged_ids)} unchanged, "
          f"{len(moved_ids)} moved, {len(new_ids)} new, "
          f"{len(all_active_db_cids)} DB-active force-fetch (100% verify)",
          flush=True)

    # ---- Phase B: Batch-fetch details only for active courses
    phase_start = time.time()
    course_ids = list(active_ids)
    details = batch_fetch_course_details(course_ids) if course_ids else {}
    phase_times['2_detail_fetch'] = time.time() - phase_start
    if details:
        per = phase_times['2_detail_fetch'] / max(len(details), 1) * 1000
        print(f"  Fetched {len(details)} courses in "
              f"{phase_times['2_detail_fetch']:.1f}s ({per:.0f}ms each)", flush=True)
    else:
        print(f"  No courses needed re-fetch.", flush=True)

    # ---- A3 follow-up: probe IDs that returned real data are brand-new
    # courses. Synthesize entries in the iterating list so Step 3 below
    # processes them. IDs returning empty data are skipped (empty CIM ID
    # slot). For obscure-role A2 courses, synthesize with their DB
    # current_step as the live step (Phase B's reconciliation will
    # adjust based on workflow div).
    courses_by_id = {c['id']: c for c in courses}
    a3_ingested = 0
    for cid in probe_cids:
        if cid in courses_by_id:
            continue
        detail = details.get(cid)
        if not detail:
            continue
        steps = detail.get('steps') or []
        meta = detail.get('meta') or {}
        if not steps and not meta.get('course_title'):
            continue  # empty ID slot
        current_step = ''
        for s in steps:
            if s.get('status') == 'current':
                current_step = s.get('name') or ''
                break
        # Try to get name from XML or workflow
        name = meta.get('course_title') or cid
        courses_by_id[cid] = {
            'id': cid,
            'name': name,
            'user': '',
            'current_step': current_step,
        }
        if cid not in new_ids and cid not in moved_ids:
            new_ids.append(cid)
        a3_ingested += 1
    if a3_ingested:
        print(f"  A3 follow-up: ingested {a3_ingested} brand-new courses from ID probe", flush=True)

    # For obscure-role A2 courses, synthesize entries from DB so Step 3
    # has the metadata it needs.
    for cid in obscure_db_ids:
        if cid in courses_by_id:
            continue
        db = existing[cid]
        courses_by_id[cid] = {
            'id': cid,
            'name': db.get('title') or cid,
            'user': '',
            'current_step': db.get('current_step') or '',
        }

    # 100% accuracy: every DB-active course must have an entry in
    # courses_by_id so Step 3's processing loop covers it.
    for cid in all_active_db_cids:
        if cid in courses_by_id:
            continue
        db = existing[cid]
        courses_by_id[cid] = {
            'id': cid,
            'name': db.get('title') or cid,
            'user': '',
            'current_step': db.get('current_step') or '',
        }

    # Debug: dump info for first few courses missing workflow
    missing_dumped = 0
    for cid, d in details.items():
        if missing_dumped >= 3:
            break
        if not d.get('steps'):
            meta = d.get('meta', {})
            print(f"  [debug] no steps for course {cid}:", flush=True)
            print(f"    empty={meta.get('_wf_empty')}, missing={meta.get('_wf_missing')}, html_len={meta.get('_html_len')}", flush=True)
            if meta.get('_wf_html'):
                print(f"    wf_html: {meta['_wf_html'][:300]!r}", flush=True)
            missing_dumped += 1

    # Debug: show proposal hits + body sample for first 2 courses
    debug_shown = 0
    for cid, d in details.items():
        if debug_shown >= 2:
            break
        meta = d.get('meta', {})
        hits = meta.get('_proposal_hits')
        if hits is not None:
            print(f"  [debug] course {cid} proposal_hits={hits}, type={meta.get('proposal_type')}", flush=True)
            print(f"    body_sample: {meta.get('_body_sample','')[:300]!r}", flush=True)
            debug_shown += 1

    # Surface XML-tag debug info once so we can confirm field names.
    for cid, d in details.items():
        tags = (d.get('meta') or {}).get('_xml_tags')
        if tags:
            print(f"  [debug] sample course XML tags: {tags}", flush=True)
            break

    # ---- Step 3: Process fetched results. Only iterates active courses;
    # unchanged courses' DB rows are intentionally left untouched.
    # Iterates `courses_by_id` (which now includes A2 + A3 synthetic
    # entries) instead of just the original `courses` list.
    phase_start = time.time()
    with_workflow = 0
    for cid, c in list(courses_by_id.items()):
        if cid not in active_ids:
            continue
        name = c['name']
        title = name
        m = re.match(r'^([A-Z]+\s+\d+):\s*(.+)$', name)
        if m:
            course_code = m.group(1)
            title = m.group(2)
        else:
            course_code = ''

        detail = details.get(cid, {})
        steps = detail.get('steps', [])
        meta = detail.get('meta', {})

        # Resolve course code from XML metadata when the name didn't have it.
        # CIM's <code> element is pre-formatted "ARAB 1101" but can return the
        # numeric CIM ID for some courses — treat that as missing.
        if not course_code:
            xml_code = (meta.get('course_code') or '').strip()
            if xml_code and not xml_code.isdigit():
                course_code = xml_code
        if not course_code:
            subject = (meta.get('subject') or '').strip()
            number = (meta.get('course_number') or '').strip()
            course_code = (subject + ' ' + number).strip() if (subject and number) else ''
        if not course_code:
            course_code = (meta.get('html_course_code') or '').strip()
        if not course_code:
            existing_code = existing.get(cid, {}).get('code') or ''
            course_code = existing_code if existing_code and not existing_code.isdigit() else ''
        if not course_code:
            course_code = cid  # last resort: numeric CIM ID

        total_steps = len(steps)
        completed_steps = sum(1 for s in steps if s.get('status') == 'approved')
        # current_step from Phase 1 Approve Pages discovery (mirrors live
        # pending list, which is what the user sees at /courseleaf/approve/).
        # Workflow HTML's `current` marker only fills in approver emails or
        # acts as a fallback when Phase 1 had no role assignment for this id.
        html_current = next((s for s in steps if s.get('status') == 'current'), None)
        current_step_from_aq = c.get('current_step', '')
        current_emails = ''
        matched = next((s for s in steps if s.get('name') == current_step_from_aq), None)
        if matched:
            current_emails = matched.get('emails', '')
        elif not current_step_from_aq and html_current:
            current_step_from_aq = html_current.get('name', '')
            current_emails = html_current.get('emails', '')

        college_code = meta.get('college', '')
        college_name = COLLEGE_NAMES.get(college_code, college_code) if college_code else ''

        # Map proposal type to status used for row coloring.
        # Matches program convention: Added / Edited / Deactivated.
        ptype = meta.get('proposal_type', '')
        if 'New Course' in ptype:
            status = 'Added'
        elif 'Inactivation' in ptype:
            status = 'Deactivated'
        else:
            status = 'Edited'

        # Completion detection — same convention as programs: the workflow is
        # done when all steps are approved AND no step is current. Course
        # ingestion via Approve Pages discovery rarely sees completed courses
        # (they fall off the queue), but this guards the rare case where a
        # final-step approval lands between scrape and detail fetch.
        html_current = next((s for s in steps if s.get('status') == 'current'), None)
        is_complete = (
            total_steps > 0
            and completed_steps == total_steps
            and html_current is None
            and not current_step_from_aq
        )
        completion_date = meta.get('last_approval_date', '') if is_complete else ''

        course_data = {
            'id': cid,
            'code': course_code,
            'title': meta.get('course_title') or title,
            'status': status,
            'current_step': current_step_from_aq,
            'total_steps': total_steps,
            'completed_steps': completed_steps,
            'current_approver_emails': current_emails,
            'college': college_name,
            'date_submitted': meta.get('date_submitted', ''),
            'credits': meta.get('credits', ''),
            'description': meta.get('description', ''),
            'academic_level': meta.get('acad_level', ''),
            'completion_date': completion_date,
            'step_entered_date': (
                meta.get('last_approval_date')
                or meta.get('date_submitted')
                or meta.get('last_edit')
                or ''
            ),
        }

        if upsert_course(course_data):
            changes += 1
            old_step = existing.get(cid, {}).get('current_step', '')
            new_step = course_data['current_step']
            if old_step and old_step != new_step:
                record_course_change(now, cid, old_step, new_step, 'step_transition')

        if steps:
            upsert_course_workflow_steps(cid, [
                {
                    'order': s.get('order', i),
                    'name': s.get('name', ''),
                    'status': s.get('status', 'pending'),
                    'emails': s.get('emails', ''),
                }
                for i, s in enumerate(steps)
            ])
            with_workflow += 1

    phase_times['3_processing'] = time.time() - phase_start

    # ---- Exit verification (Option F): courses in DB at a common role
    # but not discovered (and not in active_ids — i.e., they didn't
    # appear in scrape_courses' output AND aren't being force-fetched
    # via A2). Most likely they completed mid-workflow and disappeared
    # from Approve Pages. Verify via workflow div before any
    # destructive change — same positive-evidence policy as programs.
    phase_start = time.time()
    discovered_ids = {c['id'] for c in courses}
    courses_to_verify = []
    for cid, db in existing.items():
        if not (db.get('current_step') or ''):
            continue
        if cid in discovered_ids or cid in active_ids:
            continue
        courses_to_verify.append(cid)

    confirmed_complete = []
    completed_in_scan = []
    if courses_to_verify:
        print(f"  Exit verification: {len(courses_to_verify)} candidates "
              f"(in DB at a step but not discovered)", flush=True)
        verify_details = batch_fetch_course_details(courses_to_verify, batch_size=25)
        moved_to_step = {}
        unverifiable = 0
        for cid, d in verify_details.items():
            steps = d.get('steps') or []
            if not steps:
                unverifiable += 1
                continue
            current = next(
                (s.get('name') for s in steps if s.get('status') == 'current'), None)
            if current is None:
                confirmed_complete.append(cid)
            elif current != (existing[cid].get('current_step') or ''):
                moved_to_step[cid] = current
        if confirmed_complete:
            from database import get_db
            with get_db() as conn:
                placeholders = ','.join('?' * len(confirmed_complete))
                conn.execute(
                    f"UPDATE courses SET current_step = '', "
                    f"current_approver_emails = '', "
                    f"completion_date = CASE WHEN completion_date != '' "
                    f"THEN completion_date ELSE ? END "
                    f"WHERE id IN ({placeholders})",
                    [now] + confirmed_complete,
                )
            completed_in_scan.extend(confirmed_complete)
            print(f"    Cleared {len(confirmed_complete)} (workflow div confirms complete)",
                  flush=True)
        if moved_to_step:
            from database import get_db
            with get_db() as conn:
                for cid, step in moved_to_step.items():
                    conn.execute(
                        "UPDATE courses SET current_step = ? WHERE id = ?",
                        (step, cid))
            print(f"    Updated {len(moved_to_step)} to live workflow-div step",
                  flush=True)
        if unverifiable:
            print(f"    Left {unverifiable} unchanged (workflow div fetch failed)",
                  flush=True)
    phase_times['4_exit_verification'] = time.time() - phase_start

    record_course_scan(now, len(courses_by_id), with_workflow, changes)
    total_time = time.time() - overall_start
    print(f"  Courses processed: {len(courses_by_id)} discovered "
          f"({len(courses)} from Approve Pages + {len(courses_by_id) - len(courses)} "
          f"from A2/A3), {len(active_ids)} active, "
          f"with workflow: {with_workflow}, changes: {changes}", flush=True)
    print(f"  Course phase timings:", flush=True)
    for name in sorted(phase_times.keys()):
        secs = phase_times[name]
        print(f"    {name:.<24s} {secs:6.1f}s ({secs/max(total_time,1)*100:4.1f}%)", flush=True)
    print(f"  Course phase total: {total_time:.0f}s ({total_time/60:.1f} min)", flush=True)
    return len(courses_by_id), with_workflow, changes


def run_course_scan(progress_callback=None):
    """Run a full course scan across all roles.

    `progress_callback` is forwarded to `scrape_courses` so callers
    can interleave quick role-update fetches between groups of slow
    Approve Pages role iterations.
    """
    print("\n=== STARTING COURSE SCAN ===")
    init_db()
    courses = scrape_courses(progress_callback=progress_callback)
    if not courses:
        print("No courses found")
        return 0, 0, 0
    scanned, with_workflow, changes = process_course_scans(courses)
    print(f"\n=== COURSE SCAN COMPLETE ===")
    print(f"Courses: {scanned} | With workflow: {with_workflow} | Changes: {changes}")
    return scanned, with_workflow, changes


if __name__ == '__main__':
    run_full_scan()
