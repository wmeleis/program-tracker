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

                // Extract approval dates for step_entered_date AND all historical approvals
                // (used to cross-check Approve Pages staleness in Phase 3).
                var approvalDates = [];
                var apMatch;
                var apPattern = /([A-Z][a-z]{{2}}, \\d+ [A-Z][a-z]+ \\d{{4}} [\\d:]+ GMT)[\\s\\S]*?Approved for ([^<\\n]+)/g;
                while ((apMatch = apPattern.exec(text)) !== null) {{
                    approvalDates.push({{date: apMatch[1], step: apMatch[2].trim()}});
                }}
                if (approvalDates.length > 0) {{
                    result.meta.last_approval_date = approvalDates[approvalDates.length - 1].date;
                }}
                result.meta.approvals = approvalDates;
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
                           ', bsib', ', bsche', ', bsbioe', ', bscs', 'minor', ', aa ',
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
            'error': 'chrome_unreachable',
            'detail': 'Chrome programadmin tab not found or not responding. '
                      'Open https://nextcatalog.northeastern.edu/programadmin/ in Chrome window 1.'
        }

    # Step 2: Probe the XML API for a known program to verify session
    probe_js = '''
(function() {
    try {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", "/programadmin/2/index.xml", false);
        xhr.send();
        var txt = xhr.responseText || "";
        if (xhr.status !== 200) return "HTTP:" + xhr.status;
        // A valid session returns XML that starts with <?xml> and contains <courseleaf>
        if (txt.indexOf("<courseleaf>") === -1) return "NOT_XML";
        // A logged-out response often redirects to login HTML (starts with <!DOCTYPE or <html)
        if (txt.trimStart().toLowerCase().indexOf("<!doctype") === 0) return "LOGIN_REDIRECT";
        if (txt.length < 500) return "SHORT:" + txt.length;
        return "OK:" + txt.length;
    } catch(e) {
        return "ERR:" + e.message;
    }
})();
'''
    result = run_js_in_tab('programadmin', probe_js, match_by='url', timeout=15)
    if not result or result == 'missing value':
        return {
            'ok': False,
            'error': 'probe_failed',
            'detail': 'Could not probe CourseLeaf. Check that Chrome is running and '
                      'the programadmin tab is open.'
        }

    if not result.startswith('OK:'):
        return {
            'ok': False,
            'error': 'session_invalid',
            'detail': f'CourseLeaf session appears invalid or expired (probe: {result}). '
                      'Please log in to CourseLeaf in Chrome, then retry.'
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
                      'Open https://nextcatalog.northeastern.edu/courseleaf/approve/ in Chrome.'
        }
    if not ap_result.startswith('OK:'):
        return {
            'ok': False,
            'error': 'approve_pages_invalid',
            'detail': f'Approve Pages tab is not showing roles ({ap_result}). '
                      'You may need to log in again.'
        }

    return {'ok': True, 'detail': 'CourseLeaf session is valid.'}


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
        college = COLLEGE_NAMES.get(college_code, college_code)
        department = meta.get('department', '')
        degree = meta.get('degree', '')
        date_submitted = meta.get('date_submitted', '')
        step_entered_date = meta.get('last_approval_date', '')

        # Calculate progress
        total = len(steps)
        completed = sum(1 for s in steps if s.get('status') == 'approved')
        # Default: trust Approve Pages queue (Phase 1) for current_step,
        # because the per-program workflow HTML's `<li class="current">`
        # marker used to lag in the opposite direction. But the approval
        # history is the authoritative record — if Approve Pages put the
        # program at step X but the history log shows X already approved,
        # Approve Pages is stale (this exact failure caused MS Management
        # Boston/Online to sit at "Graduate Provost Review" after they'd
        # moved to GCC). In that case we defer to the workflow HTML's
        # `current` marker instead.
        current_step = info.get('current_step', '')
        current_emails = ''
        approvals = meta.get('approvals', []) or []
        approved_step_names = {
            (a.get('step') or '').rstrip('</li>').strip()
            for a in approvals
        }
        html_current = next((s for s in steps if s.get('status') == 'current'), None)

        if current_step and current_step in approved_step_names:
            # Approve Pages queue is stale — this step was already approved.
            if html_current:
                current_step = html_current.get('name', '')
                current_emails = html_current.get('emails', '')
            else:
                # All steps approved per HTML → program has completed workflow.
                current_step = ''
                current_emails = ''
        else:
            matched = next((s for s in steps if s.get('name') == current_step), None)
            if matched:
                current_emails = matched.get('emails', '')
            elif not current_step and html_current:
                # Approve Pages had no assignment; fall back to workflow div.
                current_step = html_current.get('name', '')
                current_emails = html_current.get('emails', '')

        # Derive completion_date when the workflow is fully approved.
        is_complete = (
            total > 0
            and completed == total
            and html_current is None
            and not current_step
        )
        completion_date = meta.get('last_approval_date', '') if is_complete else ''

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
            'completion_date': completion_date,
            'campus': meta.get('campus', ''),
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

    # Clear current_step for programs no longer on any Approve Pages role.
    # When a program advances past the last tracked step (or is archived),
    # Approve Pages drops it, but the per-program workflow HTML's `<li
    # class="current">` marker can stay stale. If we leave the old
    # current_step in place, the pipeline bucket for that role keeps
    # counting it forever.
    from database import get_db
    discovered_ids = set(all_discovered.keys())
    existing_in_pipeline = [
        pid for pid, p in existing_programs.items()
        if p.get('current_step') and pid not in discovered_ids
    ]
    if existing_in_pipeline:
        with get_db() as conn:
            placeholders = ','.join('?' * len(existing_in_pipeline))
            conn.execute(
                f"UPDATE programs SET current_step = '', current_approver_emails = '' "
                f"WHERE id IN ({placeholders})",
                existing_in_pipeline
            )
        print(f"  Cleared current_step for {len(existing_in_pipeline)} program(s) no longer on Approve Pages")

    # NB: we intentionally do NOT record the scan here. The caller
    # (app.py do_scan) records it with a fresh timestamp after the
    # entire scan cycle finishes — programs + courses + reference +
    # export + deploy — so the dashboard's "Updated" header only
    # changes when the whole pipeline is actually done, not when this
    # first phase completes.

    # Validation + auto-heal: reconcile DB against live Approve Pages.
    warnings, healed = heal_stale_program_steps(log=True)
    if warnings == 0:
        print("  All role counts match live data.")
    else:
        print(f"  {warnings} role(s) had count differences; auto-healed {healed} stale program row(s)")

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
         'new_completions': int}
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

    for prog_id, detail in details.items():
        steps = detail.get('steps') or []
        meta = detail.get('meta') or {}
        if not steps and not meta.get('program_title') and not meta.get('banner_code'):
            skipped += 1
            continue

        total = len(steps)
        approved_count = sum(1 for s in steps if s.get('status') == 'approved')
        html_current = next((s for s in steps if s.get('status') == 'current'), None)

        is_complete = (total > 0 and approved_count == total and html_current is None)
        completion_date = meta.get('last_approval_date', '') if is_complete else ''

        # Don't touch current_step for programs still in an active step —
        # the regular scan's Approve Pages discovery is canonical there.
        # For completed programs we must clear current_step.
        if is_complete:
            current_step = ''
            current_emails = ''
        else:
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
        if 'New Program' in proposal_type:
            status = 'Added'
        elif 'Inactivation' in proposal_type:
            status = 'Deactivated'
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
            'program_type': classify_program_type(prog_name, steps),
            'college': college,
            'department': meta.get('department', ''),
            'degree': meta.get('degree', ''),
            'date_submitted': meta.get('date_submitted', ''),
            'step_entered_date': meta.get('last_approval_date', ''),
            'curriculum_html': (meta.get('curriculum_html', '') or '')
                               .replace('<![CDATA[', '').replace(']]>', '').strip(),
            'completion_date': completion_date,
            'campus': meta.get('campus', ''),
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
    }


def heal_stale_program_steps(log=False):
    """Reconcile DB program rows against live Approve Pages for each tracked role.

    For each role: re-query the live pending list; if the DB has programs at
    that role that aren't on the live list, re-fetch each candidate's
    workflow HTML directly and update the DB from that authoritative source
    (not from a blind clear). Requires two back-to-back pending-list queries
    to agree before acting (guards against CourseLeaf's transient stale
    views).

    This verify-before-act design prevents the "pending list is stale in both
    directions" failure mode: some programs linger at their old step (stale
    positive) while newly-arrived programs don't appear in their new step's
    pending list yet (stale negative). Either way, the per-program workflow
    HTML at `/programadmin/{id}/` is the ground truth.

    Safe to call outside a full scan — shared by end-of-scan validation
    and the on-demand `/api/heal` endpoint.

    Args:
        log: if True, print a running commentary (used by `run_full_scan`).

    Returns:
        (warnings, fixed) -- counts (`fixed` = rows whose current_step was
        updated or cleared based on the workflow HTML truth).
    """
    from database import (
        get_pipeline_counts, get_programs_by_step, get_db,
        upsert_program, upsert_workflow_steps,
    )
    if log:
        print(f"\nValidating DB against live Approve Pages...")
    db_counts = get_pipeline_counts(TRACKED_ROLES)
    warnings = 0
    fixed = 0
    for role in TRACKED_ROLES:
        live1 = scrape_approve_pages_role(role)
        db_c = db_counts.get(role, 0)
        if len(live1) == db_c:
            continue

        if log:
            print(f"  WARNING: {role}: DB={db_c}, Live={len(live1)} (delta={len(live1) - db_c})")
        warnings += 1

        if len(live1) >= db_c:
            continue  # live has more → scanner missed something; don't speculate

        live2 = scrape_approve_pages_role(role)
        live_ids = {p['id'] for p in live1} & {p['id'] for p in live2}
        if live_ids != {p['id'] for p in live1} or len(live2) != len(live1):
            if log:
                print(f"    Skipping heal for {role}: live view unstable across two queries")
            continue

        db_progs = get_programs_by_step(role)
        candidate_ids = [p['id'] for p in db_progs if p['id'] not in live_ids]
        if not candidate_ids:
            continue

        # Re-fetch each candidate's workflow HTML and treat that as truth.
        details = batch_fetch_program_details(candidate_ids, batch_size=25)
        for pid in candidate_ids:
            d = details.get(pid, {})
            steps = d.get('steps') or []
            meta = d.get('meta') or {}

            if not steps:
                # No workflow HTML came back — play it safe and leave DB alone
                # rather than clearing based on a failed fetch.
                if log:
                    print(f"    Skipping {pid}: workflow HTML unavailable")
                continue

            html_current = next((s for s in steps if s.get('status') == 'current'), None)
            total = len(steps)
            approved = sum(1 for s in steps if s.get('status') == 'approved')
            if html_current and html_current.get('name') == role:
                # HTML confirms the program IS still at this role — CourseLeaf's
                # pending list is falsely missing it. Leave DB as-is.
                if log:
                    print(f"    Keeping {pid}: workflow HTML still shows 'current' at {role}")
                continue

            # HTML says the program moved (or completed). Load the existing
            # DB row so we can preserve name / status / program_type while
            # updating just the workflow-state fields.
            with get_db() as conn:
                existing = conn.execute(
                    "SELECT * FROM programs WHERE id = ?", (pid,)
                ).fetchone()
            if not existing:
                continue  # nothing to update
            existing = dict(existing)

            if html_current:
                new_step = html_current.get('name', '')
                new_emails = html_current.get('emails', '')
            else:
                new_step = ''
                new_emails = ''
            is_complete = (total > 0 and approved == total and html_current is None)
            program_data = {
                'id': pid,
                'name': existing.get('name') or '',
                'banner_code': meta.get('banner_code') or existing.get('banner_code', ''),
                'status': existing.get('status') or '',
                'current_step': new_step,
                'total_steps': total,
                'completed_steps': approved,
                'current_approver_emails': new_emails,
                'program_type': existing.get('program_type') or 'Unknown',
                'college': COLLEGE_NAMES.get(meta.get('college', ''), meta.get('college', ''))
                           or existing.get('college', ''),
                'department': meta.get('department') or existing.get('department', ''),
                'degree': meta.get('degree') or existing.get('degree', ''),
                'date_submitted': meta.get('date_submitted') or existing.get('date_submitted', ''),
                'step_entered_date': meta.get('last_approval_date') or existing.get('step_entered_date', ''),
                'curriculum_html': (meta.get('curriculum_html', '') or '')
                                   .replace('<![CDATA[', '').replace(']]>', '').strip()
                                   or existing.get('curriculum_html', ''),
                'completion_date': meta.get('last_approval_date', '') if is_complete else '',
                'campus': meta.get('campus') or existing.get('campus', ''),
            }
            upsert_program(program_data)
            upsert_workflow_steps(pid, steps)
            fixed += 1
            if log:
                target = 'completed' if is_complete else new_step
                print(f"    Fixed {pid}: {role} → {target!r}")

    return warnings, fixed


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

    # Search in chunks of 200 IDs to avoid Chrome JS timeout
    all_found = {}
    chunk_size = 200
    for start in range(1, 2100, chunk_size):
        end = min(start + chunk_size, 2100)
        remaining = [c for c in codes_list if c.lower() not in all_found]
        if not remaining:
            break  # Found all
        remaining_json = json.dumps(remaining)
        js_code = f'''
(function() {{
    var codes = {remaining_json};
    var codeSet = {{}};
    for (var c = 0; c < codes.length; c++) codeSet[codes[c].toLowerCase()] = true;
    var results = {{}};
    var parser = new DOMParser();

    for (var id = {start}; id < {end}; id++) {{
        var xhr = new XMLHttpRequest();
        xhr.open("GET", "/programadmin/" + id + "/index.xml", false);
        xhr.send();
        if (xhr.status !== 200 || xhr.responseText.length < 100) continue;

        var xml = parser.parseFromString(xhr.responseText, "text/xml");
        var codeEl = xml.querySelector("code");
        var campusEl = xml.querySelector("campus");
        if (!codeEl) continue;

        var code = codeEl.textContent.trim().toLowerCase();
        var campus = campusEl ? campusEl.textContent.trim().toUpperCase() : "";

        if (codeSet[code] && (campus === "BOS" || campus === "")) {{
            if (!results[code]) results[code] = id;
        }}
    }}

    return JSON.stringify(results);
}})();
'''
        result = run_js_in_tab("programadmin", js_code, match_by='url', timeout=120)
        if result and result != 'missing value':
            try:
                chunk_results = json.loads(result)
                for code_lower, boston_id in chunk_results.items():
                    all_found[code_lower] = boston_id
                if chunk_results:
                    print(f"    IDs {start}-{end}: found {len(chunk_results)} matches")
            except json.JSONDecodeError:
                print(f"    IDs {start}-{end}: JSON parse error")
        else:
            print(f"    IDs {start}-{end}: no response")

    # Normalize keys back to original case
    code_map = {}
    for code in banner_codes:
        boston_id = all_found.get(code.lower())
        if boston_id:
            code_map[code] = boston_id
    print(f"  CIM search found {len(code_map)} of {len(banner_codes)} Boston counterparts")
    return code_map


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

    return counterpart_map, non_boston_ids


def fetch_reference_curricula(program_ids, batch_size=10):
    """Fetch the most recent historical version (reference curriculum) for each program.

    Uses the CourseLeaf history API:
    /courseleaf/courseleaf.cgi?page=/programadmin/{id}/index.html&output=xml&step=showtcf&view=history&diffversion={versionId}

    For Boston programs:
    - Fetches the program's own CIM history (most recent approved version)

    For non-Boston programs (Oakland, Charlotte, etc.):
    - Finds the Boston counterpart by name (strips campus, matches Boston version)
    - Uses the Boston program's most recently approved CIM history version as reference
    - This is because non-Boston programs are typically based on the Boston curriculum
    """
    from database import upsert_reference_curriculum, get_db

    # Check which programs already have reference data with up-to-date versions
    existing_refs = {}
    with get_db() as conn:
        rows = conn.execute(
            "SELECT program_id, version_id FROM reference_curriculum"
        ).fetchall()
        existing_refs = {row['program_id']: row['version_id'] for row in rows}

    # Build mapping of non-Boston programs to their Boston counterparts
    counterpart_map, non_boston_ids = _build_boston_counterpart_map(program_ids)
    if counterpart_map:
        print(f"  Found {len(counterpart_map)} non-Boston programs with Boston counterparts")
    if non_boston_ids - set(counterpart_map.keys()):
        unmatched = non_boston_ids - set(counterpart_map.keys())
        print(f"  {len(unmatched)} non-Boston programs will use own history as fallback")

    # Special case: if the Boston counterpart is ITSELF in the current
    # workflow (being revised), use its in-workflow curriculum as the
    # reference rather than its last-approved history version. This lets
    # non-Boston deployments compare against the up-to-date proposed
    # Boston curriculum when one exists.
    scanning_set = set(program_ids)
    boston_in_workflow = {
        non_boston_id: boston_id
        for non_boston_id, boston_id in counterpart_map.items()
        if boston_id in scanning_set
    }
    if boston_in_workflow:
        print(f"  {len(boston_in_workflow)} non-Boston programs will use the Boston workflow-revised curriculum as reference")
        with get_db() as conn:
            for non_boston_id, boston_id in boston_in_workflow.items():
                row = conn.execute(
                    "SELECT curriculum_html FROM programs WHERE id = ?",
                    (boston_id,),
                ).fetchone()
                if row and row['curriculum_html']:
                    # Sentinel version_id=0 marks this as an in-workflow
                    # reference so later scans always replace it (the
                    # curriculum may change while Boston is being edited).
                    upsert_reference_curriculum(
                        non_boston_id,
                        0,
                        "current proposal (Boston, in workflow)",
                        row['curriculum_html'],
                    )

    # Remove those programs from the JS-history path — already handled above.
    fetch_ids = [pid for pid in program_ids if pid not in boston_in_workflow]

    print(f"\nFetching reference curricula for {len(fetch_ids)} programs (via CIM history)...")
    # Larger batches are OK now since we parallelize fetches within each batch
    batch_size = max(batch_size, 25)
    batches = [fetch_ids[i:i+batch_size] for i in range(0, len(fetch_ids), batch_size)]
    fetched = 0
    skipped = 0
    import time as _time

    for batch_num, batch in enumerate(batches):
        ids_json = json.dumps(batch)
        batch_counterparts = {pid: counterpart_map[pid] for pid in batch if pid in counterpart_map}
        counterparts_json = json.dumps(batch_counterparts)

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
    var counterparts = {counterparts_json};
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
        var fetchId = counterparts[id] || id;
        // Step 1: page fetch (parallelizable — network limited)
        return fetch("/programadmin/" + fetchId + "/")
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
                return fetch(apiUrl).then(function(res) {{
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
                display_date = f"{version_date} (Boston version)" if prog_id in counterpart_map else version_date
                upsert_reference_curriculum(prog_id, version_id, display_date, html)
                fetched += 1
                batch_fetched += 1
            else:
                skipped += 1

        print(f"  Batch {batch_num+1}/{len(batches)}: fetched {batch_fetched} (total {fetched})")

    # Clean up any leftover batch holders
    run_js_in_tab("programadmin", 'document.querySelectorAll("[id^=__refbatch_]").forEach(function(e){e.remove();});', match_by='url', timeout=10)

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


def scrape_courses_from_role(role_name):
    """Select a role on Approve Pages and extract pending courses.

    Returns list of dicts with course id, name, user (approver).
    """
    # Select the role and trigger the pending-list display
    js_select = f'''
(function() {{
    var select = document.querySelector("select");
    if (!select) return JSON.stringify({{error: "no select"}});
    select.value = "{role_name}";
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

    time.sleep(2)

    # Extract courses using the /courseadmin/NNNNN: pattern
    js_extract = '''
(function() {
    var text = document.body.innerText;
    var lines = text.split("\\n");
    var courses = [];
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        var match = line.match(/^\\/courseadmin\\/(\\d+):\\s*(.+)/);
        if (match) {
            var id = match[1];
            var rest = match[2];
            var parts = rest.split("\\t");
            var nameRaw = parts[0].trim();
            var user = parts.length > 1 ? parts[1].trim() : "";
            courses.push({ id: id, name: nameRaw, user: user });
        }
    }
    return JSON.stringify(courses);
})()
'''
    result = run_js_in_tab("courseleaf/approve", js_extract, match_by='url')
    if not result or result == 'missing value':
        return []

    try:
        return json.loads(result)
    except json.JSONDecodeError:
        return []


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


def scrape_courses():
    """Scrape all courses from Approve Pages across every dropdown role."""
    print("\n=== COURSE SCRAPING ===", flush=True)

    roles = get_all_approve_roles()
    print(f"  Scanning {len(roles)} roles for courses...", flush=True)

    all_courses = {}  # id -> {id, name, current_step, user}

    for role in roles:
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

    print(f"  Total unique courses found: {len(all_courses)}", flush=True)
    return list(all_courses.values())


def batch_fetch_course_details(course_ids, batch_size=25):
    """Fetch workflow + metadata for multiple courses via XHR.

    Parallel to batch_fetch_program_details but targets /courseadmin/{id}/.
    Returns { course_id (str): { steps: [...], meta: {...} } }.
    """
    all_results = {}
    batches = [course_ids[i:i+batch_size] for i in range(0, len(course_ids), batch_size)]

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
            var xhr1 = new XMLHttpRequest();
            xhr1.open("GET", "/courseadmin/" + id + "/", false);
            xhr1.send();

            if (xhr1.status === 200) {{
                var doc = parser.parseFromString(xhr1.responseText, "text/html");
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
                    if (items.length === 0) {{
                        result.meta._wf_empty = true;
                        result.meta._wf_html = wfDiv.outerHTML.substring(0, 600);
                    }}
                }} else {{
                    result.meta._wf_missing = true;
                    result.meta._html_len = xhr1.responseText.length;
                }}
                // Search raw HTML source (parseFromString's textContent loses newlines/whitespace)
                var html = xhr1.responseText;
                var stripTags = function(s) {{ return s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\\s+/g, " ").trim(); }};
                // Match a GMT-formatted date close to "Date Submitted:"
                var dsMatch = html.match(/Date Submitted:[\\s\\S]{{0,120}}?([A-Z][a-z]{{2}},\\s*\\d+\\s+[A-Z][a-z]+\\s+\\d{{4}}[\\d:\\s]*GMT)/i);
                if (dsMatch) result.meta.date_submitted = dsMatch[1].replace(/\\s+/g, " ").trim();
                // Many already-approved courses under revision lack a "Date
                // Submitted" label entirely; fall back to "Last edit" (when
                // the revision was last saved, ~= when it entered workflow).
                var leMatch = html.match(/Last edit[\\s\\S]{{0,300}}?([A-Z][a-z]{{2}},\\s*\\d+\\s+[A-Z][a-z]+\\s+\\d{{4}}[\\d:\\s]*GMT)/i);
                if (leMatch) result.meta.last_edit = leMatch[1].replace(/\\s+/g, " ").trim();
                // Detect proposal type from raw HTML
                var proposalKeywords = ["New Course Proposal", "Inactivation Proposal", "Course Inactivation", "Course Revision", "Revise Course"];
                result.meta._proposal_hits = [];
                for (var pk = 0; pk < proposalKeywords.length; pk++) {{
                    if (html.indexOf(proposalKeywords[pk]) !== -1) result.meta._proposal_hits.push(proposalKeywords[pk]);
                }}
                if (html.indexOf("New Course Proposal") !== -1) result.meta.proposal_type = "New Course Proposal";
                else if (html.indexOf("Inactivation") !== -1) result.meta.proposal_type = "Inactivation Proposal";
                else result.meta.proposal_type = "Course Revision Proposal";
                // Capture a sample of the raw HTML for diagnostics
                result.meta._body_sample = html.substring(0, 500);
                // Extract approval dates from raw HTML - last one is when current step was entered
                var approvalDates = [];
                var apMatch;
                var apPattern = /([A-Z][a-z]{{2}},\\s+\\d+\\s+[A-Z][a-z]+\\s+\\d{{4}}\\s+[\\d:]+\\s+GMT)[\\s\\S]{{0,400}}?Approved for ([^<\\n]+)/g;
                while ((apMatch = apPattern.exec(html)) !== null) {{
                    approvalDates.push({{date: apMatch[1], step: stripTags(apMatch[2])}});
                }}
                result.meta._approval_count = approvalDates.length;
                if (approvalDates.length > 0) {{
                    result.meta.last_approval_date = approvalDates[approvalDates.length - 1].date;
                }}
            }}
        }} catch(e) {{
            result.html_error = e.message;
        }}

        try {{
            var xhr2 = new XMLHttpRequest();
            xhr2.open("GET", "/courseadmin/" + id + "/index.xml", false);
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
                result.meta.subject = getXml("subject") || getXml("subjectcode") || getXml("prefix");
                result.meta.course_number = getXml("number") || getXml("courseNumber") || getXml("coursenumber");
                result.meta.course_title = getXml("title") || getXml("courseTitle");
                result.meta.credits = getXml("credits") || getXml("credithoursmin") || getXml("credit_hours") || getXml("credithours");
                result.meta.description = getXml("description") || getXml("coursedescription") || getXml("catalogdescription");
                result.meta.acad_level = getXml("acad_level") || getXml("level") || getXml("courselevel");
                // Dump tag names from the first course in the first batch for debugging
                if (batch_num === 0 && i === 0) {{
                    var tags = [];
                    var els = xmlDoc.querySelectorAll("*");
                    for (var t = 0; t < Math.min(els.length, 80); t++) {{
                        var tn = els[t].tagName;
                        if (tags.indexOf(tn) === -1) tags.push(tn);
                    }}
                    result.meta._xml_tags = tags.join(",");
                }}
            }}
        }} catch(e) {{
            result.xml_error = e.message;
        }}

        results[id] = result;
    }}

    return JSON.stringify(results);
}})()
'''.replace("batch_num === 0", f"{batch_num} === 0")
        # Reuse the programadmin tab — it's on the same CourseLeaf origin as
        # /courseadmin/, so same-origin XHRs work and we don't require a
        # separate Course Inventory Management tab to be open.
        result = run_js_in_tab("programadmin", js_code, match_by='url', timeout=120)
        if not result or result == 'missing value':
            print(f"    Batch {batch_num+1}/{len(batches)}: FAILED (no response)", flush=True)
            continue
        try:
            batch_results = json.loads(result)
            for cid_str, data in batch_results.items():
                all_results[cid_str] = data
            print(f"    Batch {batch_num+1}/{len(batches)}: fetched {len(batch_results)} courses", flush=True)
        except json.JSONDecodeError as e:
            print(f"    Batch {batch_num+1}/{len(batches)}: FAILED (JSON error: {e})", flush=True)

    return all_results


def process_course_scans(courses):
    """Store scraped courses in the database, including workflow + college."""
    print("\nProcessing course scans...", flush=True)
    now = datetime.now().isoformat()
    existing = {c['id']: c for c in get_all_courses()}
    changes = 0

    course_ids = [c['id'] for c in courses]
    details = batch_fetch_course_details(course_ids) if course_ids else {}

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

    with_workflow = 0
    for c in courses:
        cid = c['id']
        name = c['name']
        course_code = cid
        title = name
        m = re.match(r'^([A-Z]+\s+\d+):\s*(.+)$', name)
        if m:
            course_code = m.group(1)
            title = m.group(2)

        detail = details.get(cid, {})
        steps = detail.get('steps', [])
        meta = detail.get('meta', {})

        total_steps = len(steps)
        completed_steps = sum(1 for s in steps if s.get('status') == 'approved')
        # Same caveat as the programs path: CourseLeaf's per-course
        # workflow HTML can lag the Approve Pages queue, so we prefer
        # the Approve Pages role assignment (Phase 1 discovery) and
        # only use the workflow div as a fallback.
        current_step_from_aq = c.get('current_step', '')
        current_emails = ''
        matched = next((s for s in steps if s.get('name') == current_step_from_aq), None)
        if matched:
            current_emails = matched.get('emails', '')
        elif not current_step_from_aq:
            for s in steps:
                if s.get('status') == 'current':
                    current_step_from_aq = s.get('name', '')
                    current_emails = s.get('emails', '')
                    break

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

    record_course_scan(now, len(courses), with_workflow, changes)
    print(f"  Courses processed: {len(courses)}, with workflow: {with_workflow}, changes: {changes}", flush=True)
    return len(courses), with_workflow, changes


def run_course_scan():
    """Run a full course scan across all roles."""
    print("\n=== STARTING COURSE SCAN ===")
    init_db()
    courses = scrape_courses()
    if not courses:
        print("No courses found")
        return 0, 0, 0
    scanned, with_workflow, changes = process_course_scans(courses)
    print(f"\n=== COURSE SCAN COMPLETE ===")
    print(f"Courses: {scanned} | With workflow: {with_workflow} | Changes: {changes}")
    return scanned, with_workflow, changes


if __name__ == '__main__':
    run_full_scan()
