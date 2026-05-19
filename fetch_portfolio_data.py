"""
Fetch program portfolio data from SharePoint and Smartsheet
via AppleScript-driven Chrome.

Usage:
    python3 fetch_portfolio_data.py

Prerequisites:
    - Google Chrome open and logged into your Northeastern SSO
    - Run once with the pages open; they will be opened automatically if missing

Outputs (saved to data/portfolio_feeds/ inside the project directory):
    portfolio_sharepoint.xlsx   — OTP Program Tracking workbook
    portfolio_smartsheet.tsv    — IPD Dashboard (tab-separated)
    portfolio_roster.tsv        — SVT Roster of Record (all campuses/colleges)
    portfolio_gls.csv           — GLS Program Detail (Tableau)
"""

import subprocess
import tempfile
import os
import time
import json
import base64

BROWSER_APP = os.environ.get("BROWSER_APP", "Google Chrome")

SHAREPOINT_URL = "https://northeastern-my.sharepoint.com/:x:/r/personal/g_wahhab_northeastern_edu/Documents/Optimization,%20Withdrawal,%20and%20Deactivation%20Tracker.xlsx?d=w8de2224c326e4b8eb46cdbc819a6ff9d&csf=1&web=1&e=DblQiu"
SMARTSHEET_URL = "https://app.smartsheet.com/b/publish?EQBCT=65a022ed48d94beea1d54ef5b933fc48"
GLS_ROSTER_HUB = "https://app.smartsheet.com/b/publish?EQBCT=547ce640b5bf44809634971051a0bf62"
TABLEAU_PAT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'tableau_pat.json')

# Sub-dashboard tokens extracted from the GLS hub config API
_CAMPUS_DASHBOARDS = {
    'Arlington':     'd751f5548e794e70b2b531bdc84289af',
    'Charlotte':     'ceca29d8f56e4186bc3d6d76ecf7561a',
    'London':        'cc1219a77cad4568acb355c8caa691bd',
    'Miami':         '21103778427e42f78cff0aef6312ee5a',
    'Oakland':       '5a0c2899d6254b3fb19dcb3e6c8f1526',
    'Portland':      '2e1d696f39b840b3b340aecb27559fc9',
    'Seattle':       'bbc5471eb96743b59d295b0fdbd6a5b1',
    'Silicon Valley': '9a30e49f01e04956babf66faa63528dd',
    'Toronto':       '673b151e6dec461a95e79417364b924f',
    'Vancouver':     '70ae410274d94c2687cfbc07a073d8a1',
}
_COLLEGE_DASHBOARDS = {
    'Bouve':  'd01544b14a424ab6aee76273326530d3',
    'CAMD':   '0dc5b3491df446f08c4587d11cba95f7',
    'COE':    '87cd8db65f8246dd998de934a8d2cf40',
    'COS':    'ea761b30cb97404b823440a1c83378eb',
    'CPS':    'd179688a085c4d9eb24d2d07973a980b',
    'CSSH':   'af90d8ce41dd44389066115be7f9f7e0',
    'DMSB':   'de3b9c86da1249b6b5bae5688b201cef',
    'Khoury': '65b598fc45c3481dbca1fc6b439da4b9',
    'LAW':    'e4c4bb6bc7604f978bdcc66b023b0ea5',
    'NCH':    'e6e0cad32a594eacab50d33c669cb198',
    'Mills':  'a0a8b191371640a98eb82ad30c147a0c',
}

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'portfolio_feeds')

_frontmost_app = None  # cached before any Chrome interaction


def _save_focus():
    """Remember which app is currently frontmost so we can restore it later."""
    global _frontmost_app
    r = subprocess.run(
        ['osascript', '-e', 'name of (info for (path to frontmost application))'],
        capture_output=True, text=True, timeout=5)
    _frontmost_app = r.stdout.strip() if r.returncode == 0 else None


def _restore_focus():
    """Give focus back to the app that was frontmost before Chrome stole it."""
    if _frontmost_app and _frontmost_app != BROWSER_APP:
        subprocess.run(
            ['osascript', '-e', f'tell application "{_frontmost_app}" to activate'],
            capture_output=True, timeout=5)


# ---------------------------------------------------------------------------
# AppleScript helpers
# ---------------------------------------------------------------------------

def run_js(url_fragment, js, timeout=60):
    """Execute JavaScript in the Chrome tab whose URL contains url_fragment."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.js', delete=False) as f:
        f.write(js)
        js_file = f.name
    script = f'''
    set jsCode to (read POSIX file "{js_file}" as text)
    tell application "{BROWSER_APP}"
        set tabIdx to 0
        set n to count of tabs of window 1
        repeat with i from 1 to n
            if (URL of tab i of window 1) contains "{url_fragment}" then
                set tabIdx to i
                exit repeat
            end if
        end repeat
        if tabIdx = 0 then return "TAB_NOT_FOUND"
        tell tab tabIdx of window 1 to execute javascript jsCode
        return result
    end tell
    '''
    try:
        r = subprocess.run(['osascript', '-e', script], capture_output=True, text=True, timeout=timeout)
        os.unlink(js_file)
        if r.returncode != 0:
            return None
        out = r.stdout.strip()
        return None if out == 'TAB_NOT_FOUND' else out
    except subprocess.TimeoutExpired:
        os.unlink(js_file)
        return None


def run_js_by_idx(tab_idx, js, timeout=60):
    """Execute JavaScript in the Chrome tab at the given index (1-based)."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.js', delete=False) as f:
        f.write(js)
        js_file = f.name
    script = f'''
    set jsCode to (read POSIX file "{js_file}" as text)
    tell application "{BROWSER_APP}"
        tell tab {tab_idx} of window 1 to execute javascript jsCode
        return result
    end tell
    '''
    try:
        r = subprocess.run(['osascript', '-e', script], capture_output=True, text=True, timeout=timeout)
        os.unlink(js_file)
        if r.returncode != 0:
            return None
        return r.stdout.strip() or None
    except subprocess.TimeoutExpired:
        os.unlink(js_file)
        return None


def open_tab_if_missing(url, url_fragment):
    """Check for a Chrome tab whose URL contains url_fragment; create it if
    missing. Save+restore frontmost app ATOMICALLY in the same AppleScript so
    Chrome never gets to be visibly frontmost between the tab-create and the
    focus restore."""
    script = f'''
    set prevApp to name of (info for (path to frontmost application))
    tell application "{BROWSER_APP}"
        set found to false
        repeat with i from 1 to count of tabs of window 1
            if (URL of tab i of window 1) contains "{url_fragment}" then
                set found to true
                exit repeat
            end if
        end repeat
        if not found then tell window 1 to make new tab with properties {{URL:"{url}"}}
    end tell
    if found is false and prevApp is not "{BROWSER_APP}" and prevApp is not "{BROWSER_APP}.app" then
        -- Strip optional ".app" suffix and reactivate the previous app
        set appName to prevApp
        if appName ends with ".app" then
            set appName to text 1 thru -5 of appName
        end if
        try
            tell application appName to activate
        end try
    end if
    '''
    subprocess.run(['osascript', '-e', script], capture_output=True)


def find_existing_tab(url_fragment):
    """Return the 1-based index of the first tab whose URL contains url_fragment, or None."""
    script = f'''tell application "{BROWSER_APP}"
        repeat with i from 1 to count of tabs of window 1
            if (URL of tab i of window 1) contains "{url_fragment}" then
                return i as text
            end if
        end repeat
        return "0"
    end tell'''
    r = subprocess.run(['osascript', '-e', script], capture_output=True, text=True, timeout=10)
    try:
        idx = int(r.stdout.strip())
        return idx if idx > 0 else None
    except (ValueError, AttributeError):
        return None


def open_new_tab(url):
    """Open a new tab and return its 1-based index. Atomically restores
    focus to the previous frontmost app so Chrome never visibly pops."""
    script = f'''
    set prevApp to name of (info for (path to frontmost application))
    tell application "{BROWSER_APP}"
        set n to count of tabs of window 1
        tell window 1 to make new tab with properties {{URL:"{url}"}}
    end tell
    if prevApp is not "{BROWSER_APP}" and prevApp is not "{BROWSER_APP}.app" then
        set appName to prevApp
        if appName ends with ".app" then
            set appName to text 1 thru -5 of appName
        end if
        try
            tell application appName to activate
        end try
    end if
    return (n + 1) as text
    '''
    r = subprocess.run(['osascript', '-e', script], capture_output=True, text=True, timeout=15)
    try:
        return int(r.stdout.strip())
    except (ValueError, AttributeError):
        return None


def close_tab_by_idx(tab_idx):
    script = f'''tell application "{BROWSER_APP}"
        close tab {tab_idx} of window 1
    end tell'''
    subprocess.run(['osascript', '-e', script], capture_output=True, timeout=10)


def navigate_tab(tab_idx, url):
    script = f'''tell application "{BROWSER_APP}"
        set URL of tab {tab_idx} of window 1 to "{url}"
    end tell'''
    subprocess.run(['osascript', '-e', script], capture_output=True, timeout=10)


def poll_div(url_fragment, div_id, timeout=90):
    """Poll until a holder div has non-empty content."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        result = run_js(url_fragment, f"(document.getElementById('{div_id}')||{{innerText:''}}).innerText", timeout=10)
        if result and result.strip():
            return result
        time.sleep(1)
    return None


def wait_for_load(url_fragment, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if run_js(url_fragment, "document.readyState", timeout=10) == "complete":
            return True
        time.sleep(1)
    return False


def wait_for_grid(tab_idx, min_rows=5, timeout=30):
    """Wait for Smartsheet grid to render (readyState alone isn't enough)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        result = run_js_by_idx(tab_idx, "document.querySelectorAll('tr').length", timeout=10)
        try:
            if int(result) >= min_rows:
                return True
        except (TypeError, ValueError):
            pass
        time.sleep(1)
    return False


# ---------------------------------------------------------------------------
# Session health checks
# ---------------------------------------------------------------------------

_SP_OTP_FRAGMENT      = "g_wahhab_northeastern_edu"
_SP_REGULATORY_FRAGMENT = "GlobalRegulatoryAffairs"

_SP_REGULATORY_URL = "https://northeastern.sharepoint.com/sites/GlobalRegulatoryAffairs"

def _check_sharepoint_tab(source, url, fragment):
    """Open the tab if missing, then verify the session isn't a login redirect."""
    open_tab_if_missing(url, fragment)
    time.sleep(2)  # brief wait for tab to start loading
    current_url = run_js(fragment, "location.href", timeout=15)
    if current_url is None:
        return {
            'source': source,
            'ok': False,
            'detail': f'{source} tab could not be opened — is Chrome running?',
        }
    login_domains = ('login.microsoftonline.com', 'login.microsoft.com', 'login.live.com')
    if any(d in current_url for d in login_domains):
        return {
            'source': source,
            'ok': False,
            'detail': f'{source} session expired — please log back into SharePoint.',
        }
    return {'source': source, 'ok': True, 'detail': ''}


def _check_smartsheet_tab(source, url):
    """Open Smartsheet tab if missing, then verify it's not a login redirect."""
    fragment = "b/publish?EQBCT=" + url.split("EQBCT=")[-1]
    open_tab_if_missing(url, fragment)
    time.sleep(2)
    current_url = run_js(fragment, "location.href", timeout=15)
    if current_url is None:
        return {
            'source': source,
            'ok': False,
            'detail': f'{source} tab could not be opened — is Chrome running?',
        }
    if 'app.smartsheet.com/b/publish' not in current_url and 'smartsheet.com' in current_url:
        return {
            'source': source,
            'ok': False,
            'detail': f'{source} session expired — please log back into Smartsheet.',
        }
    return {'source': source, 'ok': True, 'detail': ''}


def check_portfolio_sessions():
    """Verify that all required portfolio data sources are accessible in Chrome.
    Opens tabs automatically if not already open.

    Returns a list of dicts: [{'source': str, 'ok': bool, 'detail': str}]
    """
    results = []
    results.append(_check_sharepoint_tab('SharePoint (OTP)', SHAREPOINT_URL, _SP_OTP_FRAGMENT))
    results.append(_check_sharepoint_tab('SharePoint (Regulatory)', _SP_REGULATORY_URL, _SP_REGULATORY_FRAGMENT))
    results.append(_check_smartsheet_tab('Smartsheet (IPD)', SMARTSHEET_URL))
    results.append(_check_smartsheet_tab('Smartsheet (GLS Roster)', GLS_ROSTER_HUB))
    return results


# ---------------------------------------------------------------------------
# SharePoint: download the .xlsx via the FileGetUrl in the page's JS
# ---------------------------------------------------------------------------

def fetch_sharepoint():
    print("\n--- SharePoint Excel ---")
    _save_focus()
    # Use the owner's personal URL path as fragment — more specific than the
    # sharepoint.com domain alone, which can match the OneDrive home tab.
    _sp_fragment = "g_wahhab_northeastern_edu"
    open_tab_if_missing(SHAREPOINT_URL, _sp_fragment)
    _restore_focus()  # Chrome may pop forward on tab create; restore immediately
    print("  Waiting for page to load...")
    wait_for_load(_sp_fragment, timeout=30)
    time.sleep(2)

    # Extract the authenticated download URL from the page's embedded JS
    dl_url = run_js(_sp_fragment, """
    (function() {
        for (var s of document.querySelectorAll('script')) {
            var m = s.textContent.match(/"FileGetUrl"\\s*:\\s*"([^"]+)"/);
            if (m) return m[1].replace(/\\\\u0026/g, '&').replace(/\\u0026/g, '&');
        }
        return 'NOT_FOUND';
    })()
    """)
    if not dl_url or dl_url == 'NOT_FOUND':
        print("  Could not find download URL — is the SharePoint tab loaded and logged in?")
        return

    print(f"  Download URL found ({len(dl_url)} chars)")

    # Fetch the file as binary via XHR in the browser, encode as base64, store in divs
    CHUNK = 200000
    run_js(_sp_fragment, f"""
    (function() {{
        fetch("{dl_url}", {{credentials: 'include'}})
            .then(r => r.arrayBuffer())
            .then(function(buf) {{
                var bytes = new Uint8Array(buf);
                var binary = '';
                for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
                var b64 = btoa(binary);
                var chunkSize = {CHUNK};
                var n = Math.ceil(b64.length / chunkSize);
                for (var c = 0; c < n; c++) {{
                    var d = document.createElement('div');
                    d.id = '__xlchunk_' + c;
                    d.style.display = 'none';
                    d.innerText = b64.substring(c * chunkSize, (c+1) * chunkSize);
                    document.body.appendChild(d);
                }}
                var m = document.createElement('div');
                m.id = '__xlmeta';
                m.innerText = JSON.stringify({{chunks: n, totalLen: b64.length}});
                document.body.appendChild(m);
            }})
            .catch(function(e) {{
                var d = document.createElement('div');
                d.id = '__xlmeta';
                d.innerText = JSON.stringify({{error: e.message}});
                document.body.appendChild(d);
            }});
    }})()
    """, timeout=10)

    print("  Downloading file...")
    meta_raw = poll_div(_sp_fragment, "__xlmeta", timeout=90)
    if not meta_raw:
        print("  Timeout waiting for download")
        return

    meta = json.loads(meta_raw)
    if 'error' in meta:
        print(f"  Download error: {meta['error']}")
        return

    parts = []
    for c in range(meta['chunks']):
        chunk = run_js(_sp_fragment,
                       f"(document.getElementById('__xlchunk_{c}')||{{innerText:''}}).innerText",
                       timeout=15)
        parts.append(chunk or '')
        if (c + 1) % 5 == 0:
            print(f"    chunk {c+1}/{meta['chunks']}")

    xlsx_bytes = base64.b64decode(''.join(parts))
    out = os.path.join(OUTPUT_DIR, "portfolio_sharepoint.xlsx")
    with open(out, 'wb') as f:
        f.write(xlsx_bytes)
    print(f"  Saved: {out}  ({len(xlsx_bytes):,} bytes)")

    # Clean up holder divs
    run_js(_sp_fragment,
           "document.querySelectorAll('[id^=__xl]').forEach(d => d.remove())", timeout=5)
    _restore_focus()


# ---------------------------------------------------------------------------
# Smartsheet: extract all rows from the published grid
# ---------------------------------------------------------------------------

def fetch_smartsheet():
    print("\n--- Smartsheet IPD Dashboard ---")
    _save_focus()
    # Match by the specific EQBCT token so we don't accidentally reuse a
    # roster tab that fetch_roster_dashboards() left on a different dashboard.
    _ipd_token = "b/publish?EQBCT=" + SMARTSHEET_URL.split("EQBCT=")[-1]
    open_tab_if_missing(SMARTSHEET_URL, _ipd_token)
    _restore_focus()  # Chrome may pop forward on tab create; restore immediately
    print("  Waiting for page to load...")
    wait_for_load(_ipd_token, timeout=30)
    time.sleep(4)  # extra time for JS grid to render

    raw = run_js(_ipd_token, """
    (function() {
        var rows = Array.from(document.querySelectorAll('tr'));
        var data = rows.map(function(row) {
            return Array.from(row.querySelectorAll('th, td')).map(function(cell) {
                return cell.innerText.trim().replace(/\\t/g, ' ').replace(/\\n/g, ' | ');
            });
        });
        return JSON.stringify(data);
    })()
    """, timeout=30)

    if not raw or not raw.startswith('['):
        print(f"  Failed to extract rows: {(raw or '')[:100]}")
        return

    rows = json.loads(raw)
    lines = ['\t'.join(row) for row in rows]
    out = os.path.join(OUTPUT_DIR, "portfolio_smartsheet.tsv")
    with open(out, 'w') as f:
        f.write('\n'.join(lines))
    print(f"  Saved: {out}  ({len(rows)} rows)")
    _restore_focus()


# ---------------------------------------------------------------------------
# GLS Roster of Record: extract rows from all campus + college sub-dashboards
# ---------------------------------------------------------------------------

# JS to extract program rows from a Smartsheet grid. Each data row maps to:
#   program_name \t col5_value \t col5_label \t status \t sub_status \t proposal_type \t launch_date
_ROSTER_EXTRACT_JS = r"""
(function() {
    var rows = Array.from(document.querySelectorAll('tr'));
    if (rows.length < 4) return '__NOT_READY__';
    var results = [];
    var sec = {col5Label: '', statusCol: -1, subStatusCol: -1, proposalCol: -1, launchDateCol: -1};

    rows.forEach(function(row) {
        var cells = Array.from(row.querySelectorAll('th,td')).map(function(c) {
            return c.innerText.trim().replace(/\n/g, ' ').replace(/\t/g, ' ');
        });
        if (cells.length < 4) return;
        var col1 = cells[1] || '';

        // Section header row: col[1] == 'Primary'
        if (col1 === 'Primary') {
            sec.col5Label = cells[2] || '';
            sec.statusCol = -1; sec.subStatusCol = -1; sec.proposalCol = -1; sec.launchDateCol = -1;
            for (var i = 2; i < cells.length; i++) {
                var dataIdx = i + 3;
                var h = cells[i];
                if (h === 'Status') sec.statusCol = dataIdx;
                else if (h === 'Launch Sub-Status') sec.subStatusCol = dataIdx;
                else if (h === 'How Can We Help You') sec.proposalCol = dataIdx;
                else if (h === 'Actual Launch Date') sec.launchDateCol = dataIdx;
            }
            return;
        }

        // Skip child rows (3 or fewer cells) and blank rows
        if (cells.length < 6 || !col1) return;

        var col5    = cells[5] || '';
        var status  = sec.statusCol  >= 0 && cells.length > sec.statusCol  ? cells[sec.statusCol]  : '';
        var sub     = sec.subStatusCol >= 0 && cells.length > sec.subStatusCol ? cells[sec.subStatusCol] : '';
        var prop    = sec.proposalCol  >= 0 && cells.length > sec.proposalCol  ? cells[sec.proposalCol]  : '';
        var date    = sec.launchDateCol >= 0 && cells.length > sec.launchDateCol ? cells[sec.launchDateCol] : '';

        results.push([col1, col5, sec.col5Label, status, sub, prop, date].join('\t'));
    });

    return results.join('\n');
})()
"""


def fetch_roster_dashboards():
    """Extract program data from all GLS Roster campus and college sub-dashboards."""
    print("\n--- GLS Roster of Record (all campuses & colleges) ---")
    _save_focus()

    all_dashboards = (
        [(name, token, 'campus') for name, token in _CAMPUS_DASHBOARDS.items()] +
        [(name, token, 'college') for name, token in _COLLEGE_DASHBOARDS.items()]
    )

    all_lines = []
    roster_tab_idx = None
    opened_new_tab = False

    for name, token, dtype in all_dashboards:
        url = f"https://app.smartsheet.com/b/publish?EQBCT={token}"
        print(f"  {name} ({dtype})...", end='', flush=True)

        if roster_tab_idx is None:
            # Reuse any existing Smartsheet publish tab rather than opening a new one
            roster_tab_idx = find_existing_tab("app.smartsheet.com/b/publish")
            if roster_tab_idx is not None:
                navigate_tab(roster_tab_idx, url)
            else:
                roster_tab_idx = open_new_tab(url)
                opened_new_tab = True
            _restore_focus()  # Chrome pops forward on tab create/navigate; restore immediately
            if roster_tab_idx is None:
                print(" FAILED to open tab")
                continue
        else:
            navigate_tab(roster_tab_idx, url)
            _restore_focus()  # restore after each navigation

        # Wait for readyState then grid render
        deadline = time.time() + 35
        ready = False
        while time.time() < deadline:
            state = run_js_by_idx(roster_tab_idx, "document.readyState", timeout=8)
            if state == 'complete':
                ready = True
                break
            time.sleep(1)
        if not ready:
            print(" TIMEOUT (readyState)")
            continue

        wait_for_grid(roster_tab_idx, min_rows=4, timeout=20)
        time.sleep(3)  # extra render time

        # Extract with retry if not ready
        raw = None
        for attempt in range(3):
            raw = run_js_by_idx(roster_tab_idx, _ROSTER_EXTRACT_JS, timeout=20)
            if raw and raw != '__NOT_READY__' and '\t' in raw:
                break
            time.sleep(3)

        count = 0
        if raw and raw != '__NOT_READY__' and '\t' in raw:
            for line in raw.split('\n'):
                line = line.strip()
                if line:
                    all_lines.append(f"{name}\t{dtype}\t{line}")
                    count += 1
        print(f" {count} rows")

    if roster_tab_idx and opened_new_tab:
        close_tab_by_idx(roster_tab_idx)

    _restore_focus()
    out = os.path.join(OUTPUT_DIR, "portfolio_roster.tsv")
    with open(out, 'w', encoding='utf-8') as f:
        f.write('\n'.join(all_lines))
    print(f"  Saved: {out}  ({len(all_lines)} total rows from {len(all_dashboards)} dashboards)")


# ---------------------------------------------------------------------------
# GLS Tableau: download Program Detail CSV
# ---------------------------------------------------------------------------

def fetch_gls_tableau():
    """Download the GLS Program Detail CSV from Tableau using the REST API + PAT.

    Credentials are read from data/tableau_pat.json (gitignored).
    No browser required — pure Python urllib requests.
    Saves to ~/Downloads/portfolio_gls.csv.
    """
    import requests as _requests

    print("\n--- GLS Tableau CSV ---")

    # Load PAT credentials
    pat_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'tableau_pat.json')
    if not os.path.exists(pat_path):
        print(f"  No credentials file at {pat_path} — skipping")
        return
    with open(pat_path) as f:
        creds = json.load(f)

    server       = creds['server'].rstrip('/')
    site_name    = creds['site']
    token_name   = creds['token_name']
    token_secret = creds['token_secret']

    api_ver = '3.24'   # Tableau Server 2025.1

    sess = _requests.Session()
    sess.headers.update({'Content-Type': 'application/json', 'Accept': 'application/json'})

    def _req(method, url, body=None, token=None, accept=None, timeout=60):
        if accept:
            sess.headers['Accept'] = accept
        if token:
            sess.headers['X-Tableau-Auth'] = token
        resp = sess.request(method, url, json=body, timeout=timeout)
        return resp.status_code, resp.content

    # Step 1 — sign in with PAT
    signin_url = f"{server}/api/{api_ver}/auth/signin"
    status, raw = _req('POST', signin_url, body={
        'credentials': {
            'personalAccessTokenName': token_name,
            'personalAccessTokenSecret': token_secret,
            'site': {'contentUrl': site_name},
        }
    })
    if status != 200:
        print(f"  Tableau sign-in failed (HTTP {status}): {raw[:200]}")
        return
    signin_data = json.loads(raw)
    auth_token = signin_data['credentials']['token']
    site_id    = signin_data['credentials']['site']['id']
    print(f"  Signed in (site id={site_id[:8]}…)")

    try:
        # Step 2 — find the view by workbook/view name
        view_url = (
            f"{server}/api/{api_ver}/sites/{site_id}/views"
            f"?filter=viewUrlName:eq:ProgramDetail"
        )
        status, raw = _req('GET', view_url, token=auth_token)
        if status != 200:
            print(f"  Could not list views (HTTP {status}): {raw[:200]}")
            return
        views_data = json.loads(raw)
        views = views_data.get('views', {}).get('view', [])
        if not views:
            print("  No view named 'ProgramDetail' found — skipping")
            return
        # Pick the one in the right workbook
        view = next(
            (v for v in views
             if 'ProgramOptimazationDeactivationWithdrawal' in v.get('contentUrl', '')),
            views[0]
        )
        view_id = view['id']
        print(f"  Found view: {view.get('name')} (id={view_id[:8]}…)")

        # Step 3 — download CSV data (Tableau renders the view server-side; allow 120s)
        data_url = f"{server}/api/{api_ver}/sites/{site_id}/views/{view_id}/data"
        status, raw = _req('GET', data_url, token=auth_token, accept='*/*', timeout=120)
        if status != 200:
            print(f"  CSV download failed (HTTP {status}): {raw[:200]}")
            return
        csv_text = raw.decode('utf-8-sig')  # strip BOM if present
        out = os.path.join(OUTPUT_DIR, "portfolio_gls.csv")
        with open(out, 'w', encoding='utf-8') as f:
            f.write(csv_text)
        lines = csv_text.count('\n')
        print(f"  Saved: {out}  ({lines} rows, {len(csv_text):,} chars)")

    finally:
        # Sign out
        signout_url = f"{server}/api/{api_ver}/auth/signout"
        _req('POST', signout_url, token=auth_token)


def wait_for_load_by_idx(tab_idx, timeout=30):
    """Wait for readyState == 'complete' on a tab identified by index."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = run_js_by_idx(tab_idx, "document.readyState", timeout=10)
        if state == 'complete':
            return True
        time.sleep(1)
    return False


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print(f"Browser : {BROWSER_APP}")
    print(f"Output  : {OUTPUT_DIR}")
    fetch_sharepoint()
    fetch_smartsheet()
    fetch_roster_dashboards()
    fetch_gls_tableau()
    print("\nDone.")
