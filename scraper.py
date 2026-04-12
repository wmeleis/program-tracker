"""AppleScript-based Chrome scraper for CourseLeaf CIM data."""

import subprocess
import json
import re
import time
import os
import tempfile
from datetime import datetime
from database import (
    init_db, upsert_program, upsert_workflow_steps,
    record_change, record_scan, get_all_programs
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


def run_js_in_tab(tab_identifier, js_code, match_by='title', timeout=30):
    """Execute JavaScript in a Chrome tab via AppleScript using a temp file for complex JS."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.js', delete=False) as f:
        f.write(js_code)
        js_file = f.name

    if match_by == 'title':
        match_clause = f'if title of t is "{tab_identifier}" then'
    else:
        match_clause = f'if URL of t contains "{tab_identifier}" then'

    applescript = f'''
    set jsCode to (read POSIX file "{js_file}" as text)
    tell application "Google Chrome"
        set tabList to every tab of window 1
        repeat with t in tabList
            {match_clause}
                set currentTab to t
                tell currentTab to execute javascript jsCode
                return result
            end if
        end repeat
        return "TAB_NOT_FOUND"
    end tell
    '''

    try:
        result = subprocess.run(
            ['osascript', '-e', applescript],
            capture_output=True, text=True, timeout=timeout
        )
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
    """Select a role on the Approve Pages tab and get pending programs with IDs."""
    # Select the role in the dropdown and trigger the page's own handler
    js_select = f'''
(function() {{
    var select = document.querySelector("select");
    if (!select) return JSON.stringify({{error: "no select"}});
    select.value = "{role_name}";
    // CourseLeaf uses onchange=showPendingList(this.value)
    if (typeof showPendingList === "function") {{
        showPendingList(select.value);
    }} else {{
        select.dispatchEvent(new Event("change", {{bubbles: true}}));
    }}
    return "selected";
}})()
'''
    result = run_js_in_tab("courseleaf/approve", js_select, match_by='url')
    if not result or result == 'missing value':
        return []

    time.sleep(2)  # Wait for the page to update

    # Extract programs by scanning page text for /programadmin/NNNN patterns
    js_extract = '''
(function() {
    var text = document.body.innerText;
    var lines = text.split("\\n");
    var programs = [];
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        var match = line.match(/^\\/programadmin\\/(\\d+):\\s*(.+)/);
        if (match) {
            var id = parseInt(match[1]);
            var rest = match[2];
            var parts = rest.split("\\t");
            var nameRaw = parts[0].trim();
            var user = parts.length > 1 ? parts[1].trim() : "";
            var name = nameRaw.replace(/^:\\s*/, "").replace(/^[A-Z0-9_-]+:\\s*/, "");
            if (!name) name = nameRaw.replace(/^:\\s*/, "");
            programs.push({ id: id, name: name, user: user });
        }
    }
    return JSON.stringify(programs);
})()
'''
    result = run_js_in_tab("courseleaf/approve", js_extract, match_by='url')
    if not result or result == 'missing value':
        return []

    try:
        return json.loads(result)
    except json.JSONDecodeError:
        return []


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
    """Fetch workflow + metadata for multiple programs using XHR (no page navigation).

    Uses synchronous XHR to fetch each program's HTML page (for workflow steps)
    and XML API (for metadata like college, department, banner code, etc.).
    ~200ms per program vs ~5s with page navigation.
    """
    all_results = {}
    batches = [program_ids[i:i+batch_size] for i in range(0, len(program_ids), batch_size)]

    for batch_num, batch in enumerate(batches):
        ids_json = json.dumps(batch)
        js_code = f'''
(function() {{
    var ids = {ids_json};
    var results = {{}};
    var parser = new DOMParser();

    for (var i = 0; i < ids.length; i++) {{
        var id = ids[i];
        var result = {{steps: [], meta: {{}}}};

        try {{
            // Fetch HTML page for workflow steps and approval dates
            var xhr1 = new XMLHttpRequest();
            xhr1.open("GET", "/programadmin/" + id + "/", false);
            xhr1.send();

            if (xhr1.status === 200) {{
                var doc = parser.parseFromString(xhr1.responseText, "text/html");

                // Extract workflow steps
                var wfDiv = doc.getElementById("workflow");
                if (wfDiv) {{
                    var items = wfDiv.querySelectorAll("li");
                    items.forEach(function(li, idx) {{
                        var link = li.querySelector("a");
                        result.steps.push({{
                            order: idx,
                            name: (li.textContent || "").trim(),
                            status: li.className.trim() || "pending",
                            emails: link ? link.getAttribute("href").replace("mailto:", "") : ""
                        }});
                    }});
                }}

                // Extract proposal type and approval dates from page text
                var text = doc.body ? doc.body.textContent : "";
                if (text.indexOf("New Program Proposal") !== -1) result.meta.proposal_type = "New Program Proposal";
                else if (text.indexOf("Inactivation Proposal") !== -1) result.meta.proposal_type = "Inactivation Proposal";
                else if (text.indexOf("Rationale for Changes") !== -1) result.meta.proposal_type = "Program Revision Proposal";
                else result.meta.proposal_type = "Program Revision Proposal";

                // Extract date submitted
                var dsMatch = text.match(/Date Submitted:\\s*([^\\n]+)/);
                if (dsMatch) result.meta.date_submitted = dsMatch[1].trim();

                // Extract approval dates for step_entered_date
                var approvalDates = [];
                var apMatch;
                var apPattern = /([A-Z][a-z]{{2}}, \\d+ [A-Z][a-z]+ \\d{{4}} [\\d:]+ GMT)[\\s\\S]*?Approved for ([^\\n]+)/g;
                while ((apMatch = apPattern.exec(text)) !== null) {{
                    approvalDates.push({{date: apMatch[1], step: apMatch[2].trim()}});
                }}
                if (approvalDates.length > 0) {{
                    result.meta.last_approval_date = approvalDates[approvalDates.length - 1].date;
                }}
            }}
        }} catch(e) {{
            result.html_error = e.message;
        }}

        try {{
            // Fetch XML for metadata (college, department, degree, banner code, campus)
            var xhr2 = new XMLHttpRequest();
            xhr2.open("GET", "/programadmin/" + id + "/index.xml", false);
            xhr2.send();

            result.meta.xml_status = xhr2.status;
            if (xhr2.status === 200) {{
                var xmlDoc = parser.parseFromString(xhr2.responseText, "text/xml");
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
                // Curriculum body (HTML with course tables)
                var bodyEl = xmlDoc.querySelector("body");
                result.meta.curriculum_html = bodyEl ? bodyEl.innerHTML : "";
                result.meta.req_degree_credits = getXml("req_degree_credits");
                // deletejustification non-empty implies inactivation
                var dj = getXml("deletejustification");
                if (dj) result.meta.proposal_type = "Inactivation Proposal";
                // Debug: capture tag names from first program in batch
                if (i === 0) {{
                    var tags = [];
                    var els = xmlDoc.querySelectorAll("*");
                    for (var t = 0; t < Math.min(els.length, 50); t++) {{
                        tags.push(els[t].tagName);
                    }}
                    result.meta._xml_tags = tags.join(",");
                    result.meta._xml_sample = xhr2.responseText.substring(0, 500);
                }}
            }}
        }} catch(e) {{
            result.xml_error = e.message;
        }}

        results[id] = result;
    }}

    return JSON.stringify(results);
}})()
'''
        result = run_js_in_tab("programadmin", js_code, match_by='url', timeout=120)
        if not result or result == 'missing value':
            print(f"    Batch {batch_num+1}/{len(batches)}: FAILED (no response)")
            continue

        try:
            batch_results = json.loads(result)
            for pid_str, data in batch_results.items():
                all_results[int(pid_str)] = data
            print(f"    Batch {batch_num+1}/{len(batches)}: fetched {len(batch_results)} programs")
        except json.JSONDecodeError as e:
            print(f"    Batch {batch_num+1}/{len(batches)}: FAILED (JSON error: {e})")

    return all_results


def classify_program_type(name, workflow_steps=None):
    """Classify program as Undergraduate, Graduate, or Other based on name/workflow."""
    name_lower = name.lower()

    grad_indicators = [', ms ', ', ms(', ', ms—', ', ma ', ', mfa', ', med', ', mph', ', mpa',
                       ', mps', ', phd', 'graduate certificate', ', mba', ', msf',
                       'doctoral', 'ms—align', ', msw', ', msis']
    undergrad_indicators = [', bs ', ', bs(', ', ba ', ', ba(', ', bfa', ', bsba',
                           ', bsib', ', bsche', 'minor', ', aa ']

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
    if 'concentration' in name_lower:
        return 'Other'
    if 'half major template' in name_lower:
        return 'Other'
    if 'certificate' in name_lower:
        return 'Graduate'

    return 'Other'


def run_full_scan():
    """Run a complete scan: discover programs via Approve Pages, then batch-fetch details.

    Uses XHR-based batch fetching (~200ms/program) instead of page navigation (~5s/program).
    Total scan time: ~5 minutes instead of ~45 minutes.
    """
    print(f"\n{'='*60}")
    print(f"Starting full scan at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'='*60}")

    init_db()
    scan_time = datetime.now().isoformat()

    # Get existing programs to detect changes
    existing_programs = {p['id']: p for p in get_all_programs()}

    # Step 1: Discover all programs at tracked roles via Approve Pages
    all_discovered = {}  # id -> {name, role, user}

    print("\nStep 1: Scanning Approve Pages for all roles...")
    for role in ALL_ROLES:
        print(f"  Scanning role: {role}...")
        programs = scrape_approve_pages_role(role)
        print(f"    Found {len(programs)} programs")
        for p in programs:
            pid = p['id']
            if pid not in all_discovered:
                clean_name = p['name'].lstrip(': ').strip()
                all_discovered[pid] = {
                    'name': clean_name,
                    'user': p.get('user', ''),
                    'current_step': role,
                }
            all_discovered[pid]['current_step'] = role

    print(f"\n  Total unique programs discovered: {len(all_discovered)}")

    # Step 2: Batch-fetch workflow + metadata via XHR (no page navigation)
    program_ids = list(all_discovered.keys())
    print(f"\nStep 2: Batch-fetching details for {len(program_ids)} programs via XHR...")
    start_time = time.time()
    details = batch_fetch_program_details(program_ids, batch_size=25)
    elapsed = time.time() - start_time
    print(f"  Fetched {len(details)} programs in {elapsed:.1f}s ({elapsed/max(len(details),1)*1000:.0f}ms each)")

    # Debug: log XML metadata from first program
    import sys
    for pid, detail in list(details.items())[:1]:
        meta = detail.get('meta', {})
        print(f"\n  XML debug for program {pid}:", flush=True)
        print(f"    xml_status: {meta.get('xml_status', 'N/A')}", flush=True)
        print(f"    college: '{meta.get('college', '')}'", flush=True)
        print(f"    department: '{meta.get('department', '')}'", flush=True)
        print(f"    banner_code: '{meta.get('banner_code', '')}'", flush=True)
        if meta.get('_xml_tags'):
            print(f"    xml_tags: {meta.get('_xml_tags', '')[:200]}", flush=True)
        if meta.get('_xml_sample'):
            print(f"    xml_sample: {meta.get('_xml_sample', '')[:300]}", flush=True)
        if meta.get('xml_error'):
            print(f"    xml_error: {meta.get('xml_error', '')}", flush=True)

    # Step 3: Process results and update database
    print(f"\nStep 3: Processing results...")
    changes = 0

    for prog_id in program_ids:
        info = all_discovered[prog_id]
        prog_name = info['name']
        detail = details.get(prog_id, {'steps': [], 'meta': {}})

        steps = detail.get('steps', [])
        meta = detail.get('meta', {})

        # Use program title from XML if available (more reliable)
        if meta.get('program_title'):
            prog_name = meta['program_title']

        # Determine proposal status
        banner_code = meta.get('banner_code', '')
        proposal_type = meta.get('proposal_type', '')
        if 'New Program' in proposal_type:
            status = 'Added'
        elif 'Inactivation' in proposal_type:
            status = 'Deactivated'
        elif proposal_type:
            status = 'Edited'
        else:
            status = 'Edited'

        college_code = meta.get('college', '')
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
        college = COLLEGE_NAMES.get(college_code, college_code)
        department = meta.get('department', '')
        degree = meta.get('degree', '')
        date_submitted = meta.get('date_submitted', '')
        step_entered_date = meta.get('last_approval_date', '')

        # Calculate progress
        total = len(steps)
        completed = sum(1 for s in steps if s.get('status') == 'approved')
        current_step = info.get('current_step', '')
        current_emails = ''

        for s in steps:
            if s.get('status') == 'current':
                current_emails = s.get('emails', '')
                current_step = s.get('name', current_step)
                break

        prog_type = classify_program_type(prog_name, steps)

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
        elif changed and not old:
            record_change(scan_time, prog_id, '', current_step, 'new_program')
            changes += 1

    # Record scan
    record_scan(scan_time, len(all_discovered), len(details), changes)

    # Validation: spot-check a few tracked roles against live Approve Pages
    print(f"\nValidating scan results against live data...")
    from database import get_pipeline_counts
    db_counts = get_pipeline_counts(TRACKED_ROLES)
    warnings = 0
    for role in TRACKED_ROLES:
        live = scrape_approve_pages_role(role)
        db_c = db_counts.get(role, 0)
        if len(live) != db_c:
            print(f"  WARNING: {role}: DB={db_c}, Live={len(live)} (delta={len(live)-db_c})")
            warnings += 1
    if warnings == 0:
        print("  All role counts match live data.")
    else:
        print(f"  {warnings} role(s) have count differences (may be due to approvals during scan)")

    total_time = time.time() - (time.mktime(datetime.fromisoformat(scan_time).timetuple()))
    print(f"\n{'='*60}")
    print(f"Scan complete: {len(all_discovered)} programs, {changes} changes detected")
    print(f"Total time: {total_time:.0f}s ({total_time/60:.1f} min)")
    print(f"{'='*60}")

    return {
        'scan_time': scan_time,
        'programs_scanned': len(all_discovered),
        'programs_with_workflow': len(details),
        'changes': changes
    }


def fetch_reference_curricula(program_ids, batch_size=10):
    """Fetch the most recent historical version (reference curriculum) for each program.

    Uses the CourseLeaf history API:
    /courseleaf/courseleaf.cgi?page=/programadmin/{id}/index.html&output=xml&step=showtcf&view=history&diffversion={versionId}

    For each program:
    1. Fetches the program page to get the history div with version IDs
    2. Takes the most recent history entry (last onclick with highest version ID)
    3. Fetches that version's full content via the API
    4. Extracts the HTML content from the <showdata> CDATA section
    """
    from database import upsert_reference_curriculum, get_db

    # Check which programs already have reference data with up-to-date versions
    existing_refs = {}
    with get_db() as conn:
        rows = conn.execute(
            "SELECT program_id, version_id FROM reference_curriculum"
        ).fetchall()
        existing_refs = {row['program_id']: row['version_id'] for row in rows}

    print(f"\nFetching reference curricula for {len(program_ids)} programs...")
    batches = [program_ids[i:i+batch_size] for i in range(0, len(program_ids), batch_size)]
    fetched = 0
    skipped = 0

    for batch_num, batch in enumerate(batches):
        ids_json = json.dumps(batch)
        js_code = f'''
(function() {{
    var ids = {ids_json};
    var results = {{}};
    var parser = new DOMParser();

    for (var i = 0; i < ids.length; i++) {{
        var id = ids[i];
        try {{
            // Step 1: Fetch program page to get history versions
            var xhr1 = new XMLHttpRequest();
            xhr1.open("GET", "/programadmin/" + id + "/", false);
            xhr1.send();
            if (xhr1.status !== 200) {{
                results[id] = {{error: "fetch_failed", status: xhr1.status}};
                continue;
            }}

            var doc = parser.parseFromString(xhr1.responseText, "text/html");
            var histDiv = doc.getElementById("history");
            if (!histDiv) {{
                results[id] = {{error: "no_history"}};
                continue;
            }}

            // Parse version IDs and dates from onclick="return cim.showHistory(N);"
            var links = histDiv.querySelectorAll("a[onclick]");
            if (links.length === 0) {{
                results[id] = {{error: "no_versions"}};
                continue;
            }}

            // Last link = most recent history entry
            var lastLink = links[links.length - 1];
            var onclickAttr = lastLink.getAttribute("onclick");
            var vMatch = onclickAttr.match(/showHistory\\((\\d+)\\)/);
            if (!vMatch) {{
                results[id] = {{error: "no_version_id"}};
                continue;
            }}

            var versionId = parseInt(vMatch[1]);
            var versionDate = lastLink.textContent.trim();

            // Step 2: Fetch historical version content
            var apiUrl = "/courseleaf/courseleaf.cgi?page=/programadmin/" + id +
                "/index.html&output=xml&step=showtcf&view=history&diffversion=" + versionId;
            var xhr2 = new XMLHttpRequest();
            xhr2.open("GET", apiUrl, false);
            xhr2.send();

            if (xhr2.status !== 200) {{
                results[id] = {{error: "history_fetch_failed", status: xhr2.status}};
                continue;
            }}

            // Step 3: Extract content from <showdata> CDATA
            var xml = xhr2.responseText;
            var cdataStart = xml.indexOf("<![CDATA[");
            var cdataEnd = xml.indexOf("]]>", cdataStart + 9);
            var html = "";
            if (cdataStart !== -1 && cdataEnd !== -1) {{
                html = xml.substring(cdataStart + 9, cdataEnd);
            }}

            results[id] = {{
                version_id: versionId,
                version_date: versionDate,
                html_size: html.length
            }};

            // Store HTML in a data attribute to avoid JSON escaping issues
            var store = document.createElement("div");
            store.id = "__ref_" + id;
            store.style.display = "none";
            store.textContent = html;
            document.body.appendChild(store);

        }} catch(e) {{
            results[id] = {{error: e.toString()}};
        }}
    }}

    return JSON.stringify(results);
}})();
'''
        result = run_js_in_tab("programadmin", js_code, match_by='url', timeout=120)
        if not result:
            print(f"  Batch {batch_num+1}/{len(batches)}: No result from Chrome")
            continue

        try:
            batch_results = json.loads(result)
        except json.JSONDecodeError:
            print(f"  Batch {batch_num+1}/{len(batches)}: JSON parse error")
            continue

        # Now fetch the stored HTML for each successful program
        for prog_id in batch:
            prog_str = str(prog_id)
            info = batch_results.get(prog_str, {})

            if 'error' in info:
                if info['error'] != 'no_history' and info['error'] != 'no_versions':
                    print(f"  Program {prog_id}: {info['error']}")
                skipped += 1
                continue

            version_id = info.get('version_id')
            version_date = info.get('version_date', '')

            # Skip if we already have this version
            if existing_refs.get(prog_id) == version_id:
                skipped += 1
                continue

            # Retrieve the stored HTML from the hidden div
            js_get = f'''
(function() {{
    var el = document.getElementById("__ref_{prog_id}");
    if (!el) return "";
    var html = el.textContent;
    el.remove();
    return html;
}})();
'''
            html = run_js_in_tab("programadmin", js_get, match_by='url', timeout=30)
            if html and html != 'missing value':
                upsert_reference_curriculum(prog_id, version_id, version_date, html)
                fetched += 1
            else:
                skipped += 1

        print(f"  Batch {batch_num+1}/{len(batches)}: fetched {fetched} references")

    # Clean up any remaining hidden divs
    cleanup_js = '''
(function() {
    var els = document.querySelectorAll("[id^=__ref_]");
    els.forEach(function(el) { el.remove(); });
    return els.length;
})();
'''
    run_js_in_tab("programadmin", cleanup_js, match_by='url', timeout=10)

    print(f"Reference curricula: {fetched} fetched, {skipped} skipped")
    return fetched


if __name__ == '__main__':
    run_full_scan()
