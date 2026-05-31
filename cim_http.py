"""Direct authenticated HTTP access to CourseLeaf CIM.

Replaces the AppleScript-driven-Chrome scraping path for reading program
pages. We reuse the CIM session that already lives in the user's Chrome
profile by reading + decrypting Chrome's cookie store, then make plain
HTTP requests to the same /programadmin/{id}/ URLs the old scraper hit
via in-page fetch().

Why this exists: driving the visible Chrome via AppleScript coupled the
scraper to Chrome's background-tab throttling (intermittent JS-execution
stalls → 57-131 failed fetches per scan) and to focus-stealing whenever
we tried to defeat that throttling by foregrounding the tab. Reading the
session cookie and issuing direct HTTP requests has none of those
problems: no tab, no throttling, no foregrounding, ~0.5s per page.

macOS only (Chrome cookie encryption uses the macOS Keychain).

Session lifecycle: the Shibboleth `_shibsession_*` cookie is a session
cookie kept alive by the user's normal CIM use in Chrome. When SSO
expires, CIM returns a login/redirect page instead of program content;
`CIMSession.check()` / the `logged_out` flag surface that as a
session-invalid condition, same as the old tab probe.
"""

import os
import re
import glob
import shutil
import sqlite3
import hashlib
import subprocess
import tempfile
import urllib.request
import urllib.error
import urllib.parse
from html.parser import HTMLParser

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend

CIM_HOST = "nextcatalog.northeastern.edu"
CIM_BASE = f"https://{CIM_HOST}"
_CHROME_DIR = os.path.expanduser("~/Library/Application Support/Google/Chrome")


# ---------------------------------------------------------------------------
# Cookie extraction + decryption
# ---------------------------------------------------------------------------

def _safe_storage_key():
    """Return Chrome's 'Safe Storage' key from the macOS Keychain.

    Triggers a one-time Keychain prompt unless the caller has been granted
    access (click "Always Allow" once). Raises on failure.
    """
    r = subprocess.run(
        ['security', 'find-generic-password', '-w',
         '-s', 'Chrome Safe Storage', '-a', 'Chrome'],
        capture_output=True, text=True)
    pw = r.stdout.strip()
    if not pw:
        raise RuntimeError(
            "Could not read 'Chrome Safe Storage' key from Keychain "
            "(access denied or Chrome not installed). stderr: "
            + r.stderr.strip())
    return pw


def _aes_key():
    pw = _safe_storage_key()
    return hashlib.pbkdf2_hmac('sha1', pw.encode('utf8'), b'saltysalt', 1003, 16)


def _decrypt_value(enc, aes_key):
    """Decrypt one Chrome cookie value (v10/v11 AES-128-CBC)."""
    if not enc or enc[:3] not in (b'v10', b'v11'):
        # Unencrypted (rare) — return as-is if printable.
        try:
            return enc.decode('utf8')
        except Exception:
            return None
    dec = Cipher(algorithms.AES(aes_key), modes.CBC(b' ' * 16),
                 backend=default_backend()).decryptor()
    raw = dec.update(enc[3:]) + dec.finalize()
    if raw:
        raw = raw[:-raw[-1]]  # strip PKCS7 padding
    try:
        return raw.decode('utf8')
    except UnicodeDecodeError:
        # Chrome v127+ prepends a 32-byte SHA256 domain hash to the value.
        return raw[32:].decode('utf8', 'replace')


def _copy_cookie_db(src):
    """Copy a Chrome Cookies SQLite DB to a temp file INCLUDING its WAL/SHM
    sidecars, so we read the live state (recent writes — e.g. a just-after-
    login session cookie — live in Cookies-wal until checkpointed; copying
    only the main file yields a stale snapshot). Returns the temp DB path."""
    tmp = tempfile.NamedTemporaryFile(suffix='.db', delete=False).name
    shutil.copy2(src, tmp)
    for ext in ('-wal', '-shm'):
        side = src + ext
        if os.path.exists(side):
            try:
                shutil.copy2(side, tmp + ext)
            except OSError:
                pass
    return tmp


def _cleanup_db(tmp):
    for p in (tmp, tmp + '-wal', tmp + '-shm'):
        try:
            os.unlink(p)
        except OSError:
            pass


def _find_profile_cookie_db():
    """Find the Chrome profile whose cookie store has CIM cookies.

    The user's CIM session may live in 'Default', 'Profile 1', etc. We scan
    every profile's Cookies DB for a nextcatalog host_key and pick the first
    that has one. Returns the path to the Cookies DB, or None.
    """
    candidates = glob.glob(os.path.join(_CHROME_DIR, '*', 'Cookies'))
    for path in candidates:
        try:
            tmp = _copy_cookie_db(path)
            con = sqlite3.connect(tmp)
            n = con.execute(
                "SELECT COUNT(*) FROM cookies WHERE host_key = ?", (CIM_HOST,)
            ).fetchone()[0]
            con.close()
            _cleanup_db(tmp)
            if n:
                return path
        except Exception:
            continue
    return None


def load_cim_cookie_header():
    """Read + decrypt CIM cookies from Chrome, return a Cookie: header string.

    Returns (cookie_header, profile_path). Raises RuntimeError if no CIM
    cookies are found in any Chrome profile.
    """
    db_path = _find_profile_cookie_db()
    if not db_path:
        raise RuntimeError(
            f"No Chrome profile has cookies for {CIM_HOST}. "
            "Log into CIM in Chrome first.")
    aes_key = _aes_key()
    tmp = _copy_cookie_db(db_path)
    try:
        con = sqlite3.connect(tmp)
        rows = con.execute(
            "SELECT name, encrypted_value FROM cookies WHERE host_key = ?",
            (CIM_HOST,)
        ).fetchall()
        con.close()
    finally:
        _cleanup_db(tmp)
    pairs = []
    for name, enc in rows:
        val = _decrypt_value(enc, aes_key)
        if val is not None:
            pairs.append((name, val))
    if not pairs:
        raise RuntimeError("CIM cookies present but none decrypted.")
    header = '; '.join(f'{n}={v}' for n, v in pairs)
    return header, db_path


# ---------------------------------------------------------------------------
# Workflow-div HTML parsing (mirrors the old in-page JS parse)
# ---------------------------------------------------------------------------

class _WorkflowParser(HTMLParser):
    """Extract the <div id="workflow"> <li> steps: name, status, emails."""
    def __init__(self):
        super().__init__()
        self._depth = 0          # div nesting depth inside #workflow
        self._in_wf = False
        self._li_class = None
        self._li_text = []
        self._li_mailto = None
        self.steps = []
        self.found_workflow = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'div' and a.get('id') == 'workflow':
            self._in_wf = True
            self._depth = 1
            self.found_workflow = True
            return
        if not self._in_wf:
            return
        if tag == 'div':
            self._depth += 1
        elif tag == 'li':
            self._li_class = (a.get('class') or '').strip()
            self._li_text = []
            self._li_mailto = None
        elif tag == 'a' and self._li_class is not None:
            href = a.get('href') or ''
            if href.startswith('mailto:'):
                self._li_mailto = href[len('mailto:'):]

    def handle_data(self, data):
        if self._in_wf and self._li_class is not None:
            self._li_text.append(data)

    def handle_endtag(self, tag):
        if not self._in_wf:
            return
        if tag == 'li' and self._li_class is not None:
            name = ' '.join(''.join(self._li_text).split()).strip()
            status = 'pending'
            cls = self._li_class.lower()
            if 'current' in cls:
                status = 'current'
            elif 'completed' in cls or 'approved' in cls:
                status = 'approved'
            self.steps.append({
                'order': len(self.steps),
                'name': name,
                'status': status,
                'emails': self._li_mailto or '',
            })
            self._li_class = None
        elif tag == 'div':
            self._depth -= 1
            if self._depth <= 0:
                self._in_wf = False


def parse_workflow(html):
    """Return (steps, found_workflow_div). steps: [{order,name,status,emails}]."""
    p = _WorkflowParser()
    try:
        p.feed(html)
    except Exception:
        pass
    return p.steps, p.found_workflow


# ---------------------------------------------------------------------------
# Session
# ---------------------------------------------------------------------------

_LOGIN_MARKERS = ('shibboleth', 'idp.northeastern', 'login.microsoftonline',
                  'sign in', 'log in to ', 'sso')


class CIMSession:
    """Authenticated CIM HTTP session backed by Chrome's cookies.

    Load cookies once, reuse for many fetches. `logged_out` flips True if a
    response looks like an SSO/login page; callers should treat that like
    the old 'session invalid' condition.
    """
    def __init__(self):
        import http.cookiejar
        self.cookie_header, self.profile_path = load_cim_cookie_header()
        self.logged_out = False
        # Cookie jar seeded from Chrome's cookies. Using an opener with a
        # jar means session-refresh Set-Cookie responses are captured and
        # resent on subsequent requests — the same mechanism that keeps the
        # browser's CIM session alive. (A bare snapshot-cookie header does
        # not refresh, so the SSO idle-timer expires our session in minutes
        # even while the browser's stays valid.)
        self._jar = http.cookiejar.CookieJar()
        for pair in self.cookie_header.split('; '):
            if '=' not in pair:
                continue
            name, _, value = pair.partition('=')
            self._jar.set_cookie(http.cookiejar.Cookie(
                version=0, name=name, value=value, port=None, port_specified=False,
                domain=CIM_HOST, domain_specified=True, domain_initial_dot=False,
                path='/', path_specified=True, secure=True, expires=None,
                discard=False, comment=None, comment_url=None, rest={}))
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self._jar))

    def get(self, path, timeout=30):
        """GET an absolute URL or a CIM-relative path. Returns the body text,
        or None on HTTP error / login redirect (sets logged_out).

        Login detection keys on the RESPONSE HOST: an unauthenticated CIM
        request 302-redirects to the SSO IdP (a different host), and urllib
        follows it, so `resp.geturl()` ends up off-CIM. That's an
        unambiguous signal that doesn't false-positive on legitimate XML
        responses (the old body-keyword heuristic flagged the Approve Pages
        XML dump as a "login page" because it contains the word "sso").
        """
        url = path if path.startswith('http') else (CIM_BASE + path)
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (program-tracker cim_http)',
            'Cache-Control': 'no-store',
        })
        try:
            resp = self._opener.open(req, timeout=timeout)
            body = resp.read().decode('utf8', 'replace')
            final = resp.geturl()
        except urllib.error.HTTPError:
            return None
        except Exception:
            return None
        if urllib.parse.urlparse(final).netloc != CIM_HOST:
            self.logged_out = True
            return None
        return body

    def fetch_approve_pending(self, timeout=120):
        """Fetch the entire Approve Pages pending state in one request and
        return {program_id: {'current_step', 'all_pending', 'title'}}.

        current_step = first non-'fyiall' <mustsignoff> role (the current
        actionable step the reviewer sees; for parallel branches this is the
        academic step, matching Approve Pages exactly). all_pending = every
        non-fyiall mustsignoff role (the parallel set). Returns None if the
        request fails / session invalid.
        """
        url = ("/courseleaf/courseleaf.cgi?page=/courseleaf/approve/index.html"
               "&step=load&output=xml&role=any")
        body = self.get(url, timeout=timeout)
        if body is None:
            return None
        out = {}
        for m in re.finditer(
                r'<pending path="/programadmin/(\d+)[^"]*">(.*?)</pending>',
                body, re.S):
            pid = int(m.group(1))
            block = m.group(2)
            tm = re.search(r'<title>(.*?)</title>', block, re.S)
            title = ' '.join((tm.group(1) if tm else '').split()).strip()
            roles = [r for r in re.findall(r'<mustsignoff id="([^"]+)">', block)
                     if not r.endswith('fyiall')]
            out[pid] = {
                'current_step': roles[0] if roles else '',
                'all_pending': roles,
                'title': title,
            }
        return out

    def fetch_program_xml(self, pid, timeout=30):
        """Fetch + parse a program's XML API. Returns a metadata dict, or {}."""
        body = self.get(f"/programadmin/{pid}/index.xml", timeout=timeout)
        if body is None:
            return {}
        return parse_program_xml(body)

    def fetch_program(self, pid, timeout=30):
        """Fetch a program's workflow page. Returns
        {steps, found_workflow, html} or None (failed/logged out)."""
        body = self.get(f"/programadmin/{pid}/", timeout=timeout)
        if body is None:
            return None
        steps, found = parse_workflow(body)
        return {'steps': steps, 'found_workflow': found, 'html': body}

    def check(self):
        """Probe a known program to verify the session is valid.
        Returns (ok: bool, detail: str)."""
        r = self.fetch_program(522, timeout=20)
        if self.logged_out:
            return False, "CIM session expired (login redirect). Log into CIM in Chrome."
        if r is None:
            return False, "CIM fetch failed (network or cookie issue)."
        if not r['found_workflow'] and not r['steps']:
            return True, "CIM reachable (probe program had no workflow div)."
        return True, "CIM session is valid (HTTP)."


# ---------------------------------------------------------------------------
# XML metadata + program-page parsing (Python ports of the old in-page JS)
# ---------------------------------------------------------------------------

def _xml_tag(xml, tag):
    m = re.search(r'<' + tag + r'\b[^>]*>(.*?)</' + tag + r'>', xml, re.S)
    if not m:
        return ''
    val = m.group(1)
    # unwrap CDATA
    val = re.sub(r'^\s*<!\[CDATA\[', '', val)
    val = re.sub(r'\]\]>\s*$', '', val)
    return val.strip()


def parse_program_xml(xml):
    """Extract program metadata from the CIM XML API (mirrors the JS getXml)."""
    statustype = _xml_tag(xml, 'statustype')
    if re.search(r'new', statustype, re.I):
        proposal_type = 'New Program Proposal'
    elif re.search(r'inactivat', statustype, re.I):
        proposal_type = 'Inactivation Proposal'
    else:
        proposal_type = 'Program Revision Proposal'
    return {
        'college': _xml_tag(xml, 'college'),
        'department': _xml_tag(xml, 'department'),
        'degree': _xml_tag(xml, 'degreecode'),
        'banner_code': _xml_tag(xml, 'code'),
        'program_title': _xml_tag(xml, 'programtitle'),
        'campus': _xml_tag(xml, 'campus'),
        'prog_acad_level': _xml_tag(xml, 'prog_acad_level'),
        'eff_term': _xml_tag(xml, 'eff_term'),
        'eff_cat': _xml_tag(xml, 'eff_cat'),
        'curriculum_html': _xml_tag(xml, 'body'),
        'proposal_type': proposal_type,
        'delete_justification': _xml_tag(xml, 'deletejustification'),
    }


_DATE_RE = r'[A-Z][a-z]{2}, \d+ [A-Z][a-z]+ \d{4} [\d:]+ GMT'


def parse_program_page(html):
    """Parse a program HTML page: workflow steps, proposal type, date
    submitted, and the approval log (approvals/rollbacks). Mirrors the
    regexes the old in-page JS used."""
    steps, found = parse_workflow(html)
    text = re.sub(r'<[^>]+>', ' ', html)
    text = re.sub(r'\s+', ' ', text)

    if 'New Program Proposal' in text:
        proposal_type = 'New Program Proposal'
    elif 'Inactivation Proposal' in text:
        proposal_type = 'Inactivation Proposal'
    else:
        proposal_type = 'Program Revision Proposal'

    ds = re.search(r'Date Submitted:\s*(' + _DATE_RE + r')', text)
    date_submitted = ds.group(1) if ds else ''

    approvals = []
    ap = re.compile(r'(' + _DATE_RE + r')((?:(?!' + _DATE_RE + r')[\s\S])*?)Approved for ([^<\n]+)')
    for m in ap.finditer(text):
        approvals.append({'date': m.group(1), 'step': m.group(3).strip()})
    rollbacks = []
    rb = re.compile(r'(' + _DATE_RE + r')((?:(?!' + _DATE_RE + r')[\s\S])*?)Rollback to ([^<\n]+)')
    for m in rb.finditer(text):
        rollbacks.append({'date': m.group(1), 'step': re.sub(r' for .*$', '', m.group(3)).strip()})

    last_approval_date = approvals[-1]['date'] if approvals else ''
    return {
        'steps': steps,
        'found_workflow': found,
        'proposal_type': proposal_type,
        'date_submitted': date_submitted,
        'approvals': approvals,
        'rollbacks': rollbacks,
        'last_approval_date': last_approval_date,
    }


if __name__ == '__main__':
    # Smoke test
    s = CIMSession()
    print("profile:", s.profile_path)
    ok, detail = s.check()
    print("check:", ok, detail)
    for pid in (61, 92, 1347):
        r = s.fetch_program(pid)
        cur = next((x['name'] for x in r['steps'] if x['status'] == 'current'), '(none/complete)') if r else '(fetch failed)'
        print(f"  {pid}: current = {cur}")
