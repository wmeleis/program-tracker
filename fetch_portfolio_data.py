"""
Fetch program portfolio data from SharePoint and Smartsheet
via AppleScript-driven Chrome.

Usage:
    python3 fetch_portfolio_data.py

Prerequisites:
    - Google Chrome open and logged into your Northeastern SSO
    - Run once with the pages open; they will be opened automatically if missing

Outputs:
    ~/Downloads/portfolio_sharepoint.xlsx   — OTP Program Tracking workbook
    ~/Downloads/portfolio_smartsheet.tsv    — IPD Dashboard (tab-separated)
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

OUTPUT_DIR = os.path.expanduser("~/Downloads")


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
        set active tab index of window 1 to tabIdx
        delay 0.3
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


def open_tab_if_missing(url, url_fragment):
    script = f'''tell application "{BROWSER_APP}"
        set found to false
        repeat with i from 1 to count of tabs of window 1
            if (URL of tab i of window 1) contains "{url_fragment}" then
                set found to true
                exit repeat
            end if
        end repeat
        if not found then tell window 1 to make new tab with properties {{URL:"{url}"}}
    end tell'''
    subprocess.run(['osascript', '-e', script], capture_output=True)


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


# ---------------------------------------------------------------------------
# SharePoint: download the .xlsx via the FileGetUrl in the page's JS
# ---------------------------------------------------------------------------

def fetch_sharepoint():
    print("\n--- SharePoint Excel ---")
    open_tab_if_missing(SHAREPOINT_URL, "northeastern-my.sharepoint.com")
    print("  Waiting for page to load...")
    wait_for_load("northeastern-my.sharepoint.com", timeout=30)
    time.sleep(2)

    # Extract the authenticated download URL from the page's embedded JS
    dl_url = run_js("northeastern-my.sharepoint.com", """
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
    run_js("northeastern-my.sharepoint.com", f"""
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
    meta_raw = poll_div("northeastern-my.sharepoint.com", "__xlmeta", timeout=90)
    if not meta_raw:
        print("  Timeout waiting for download")
        return

    meta = json.loads(meta_raw)
    if 'error' in meta:
        print(f"  Download error: {meta['error']}")
        return

    parts = []
    for c in range(meta['chunks']):
        chunk = run_js("northeastern-my.sharepoint.com",
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
    run_js("northeastern-my.sharepoint.com",
           "document.querySelectorAll('[id^=__xl]').forEach(d => d.remove())", timeout=5)


# ---------------------------------------------------------------------------
# Smartsheet: extract all rows from the published grid
# ---------------------------------------------------------------------------

def fetch_smartsheet():
    print("\n--- Smartsheet ---")
    open_tab_if_missing(SMARTSHEET_URL, "app.smartsheet.com")
    print("  Waiting for page to load...")
    wait_for_load("app.smartsheet.com", timeout=30)
    time.sleep(4)  # extra time for JS grid to render

    raw = run_js("app.smartsheet.com", """
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


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print(f"Browser : {BROWSER_APP}")
    print(f"Output  : {OUTPUT_DIR}")
    fetch_sharepoint()
    fetch_smartsheet()
    print("\nDone.")
