"""Export current data to a static site that can be hosted on GitHub Pages."""

import base64
import json
import os
import re
import secrets
import shutil
from datetime import datetime
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
from database import (
    get_all_programs, get_program_workflow, get_pipeline_counts,
    get_recent_changes, get_last_scan, get_colleges,
    get_current_approvers, get_all_curriculum, get_all_reference_curriculum,
    get_all_program_reference_overrides, get_custom_reference,
    get_all_courses, get_course_workflow, get_course_pipeline_counts,
    get_course_colleges, get_course_current_approvers
)
from scraper import (
    TRACKED_ROLES, ROLE_SHORT_NAMES,
    COURSE_TRACKED_ROLES, COURSE_ROLE_SHORT_NAMES,
)

SITE_PASSWORD = 'husky26'
PBKDF2_ITERATIONS = 200_000
BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _derive_key(password: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=PBKDF2_ITERATIONS,
    )
    return kdf.derive(password.encode('utf-8'))


def _encrypt_to_file(plaintext: bytes, key: bytes, out_path: str) -> None:
    """Write `iv(12) || AES-256-GCM ciphertext+tag` to out_path."""
    iv = secrets.token_bytes(12)
    ct = AESGCM(key).encrypt(iv, plaintext, None)
    with open(out_path, 'wb') as f:
        f.write(iv + ct)


def _write_json_encrypted(obj, path_without_ext: str, key: bytes) -> None:
    """Serialize `obj` to JSON and write an encrypted `.enc` file only."""
    plaintext = json.dumps(obj).encode('utf-8')
    _encrypt_to_file(plaintext, key, path_without_ext + '.enc')


def _load_or_create_salt() -> bytes:
    """Reuse the salt from docs/crypto.json if it exists; otherwise generate.

    Keeping the salt stable across builds lets the client cache a derived
    key in localStorage (remember-me) without being invalidated every scan.
    """
    path = os.path.join(EXPORT_DIR, 'crypto.json')
    if os.path.exists(path):
        try:
            with open(path, 'r') as f:
                params = json.load(f)
            return base64.b64decode(params['salt'])
        except Exception:
            pass  # fall through to generating a new one
    return secrets.token_bytes(16)


def _parse_campus(name):
    """Extract campus from a program name. Handles parenthetical (Boston)/(Oakland)
    and em-dash deployment suffixes like —Online, —Accelerated, —Part-Time.
    Returns (base, campus) or (name, None)."""
    m = re.search(r'\(([^)]+)\)\s*$', name)
    if m:
        return name[:m.start()].strip(), m.group(1).strip()
    m2 = re.search(r'—(Online|Accelerated|Part-Time)\s*$', name)
    if m2:
        return name[:m2.start()].strip(), m2.group(1).strip()
    return name, None


def build_campus_groups(programs):
    """Build mapping of Boston programs to their non-Boston deployments.

    Returns dict: { boston_program_id: [deployment_ids], ... }
    Also returns: { deployment_id: boston_program_id, ... }
    """
    # Index Boston programs by base name
    boston_by_base = {}  # base_name_lower -> program_id
    all_programs = {}  # id -> {name, base, campus}
    for p in programs:
        pid = p['id']
        name = p['name']
        base, campus = _parse_campus(name)
        all_programs[pid] = {'name': name, 'base': base, 'campus': campus}
        if campus and campus.lower() == 'boston':
            boston_by_base[base.lower()] = pid
        elif not campus:
            # No campus parenthetical = Boston
            boston_by_base[name.strip().lower()] = pid

    boston_to_deployments = {}  # boston_id -> [deployment_ids]
    deployment_to_boston = {}  # deployment_id -> boston_id
    for pid, info in all_programs.items():
        if info['campus'] and info['campus'].lower() != 'boston':
            boston_id = boston_by_base.get(info['base'].lower())
            if boston_id:
                boston_to_deployments.setdefault(boston_id, []).append(pid)
                deployment_to_boston[pid] = boston_id

    return boston_to_deployments, deployment_to_boston

EXPORT_DIR = os.path.join(os.path.dirname(__file__), 'docs')


def export_data():
    """Export all dashboard data to a single JSON file."""
    from database import get_db
    programs = get_all_programs()
    courses = get_all_courses()

    # Flag programs with regulatory approved-courses matches for the
    # static-site Regulatory tab. Matches the flag added by api_programs.
    with get_db() as conn:
        rows = conn.execute(
            "SELECT program_id FROM regulatory_approved_courses"
        ).fetchall()
        has_reg = {row['program_id'] for row in rows}
    for p in programs:
        p['has_regulatory'] = p['id'] in has_reg
    pipeline_counts = get_pipeline_counts(TRACKED_ROLES)
    changes = get_recent_changes(limit=100)
    last_scan = get_last_scan()
    colleges = get_colleges()
    approvers = get_current_approvers()

    workflows = {}
    for p in programs:
        steps = get_program_workflow(p['id'])
        if steps:
            workflows[str(p['id'])] = steps

    pipeline = []
    for role in TRACKED_ROLES:
        pipeline.append({
            'role': role,
            'short_name': ROLE_SHORT_NAMES.get(role, role),
            'count': pipeline_counts.get(role, 0)
        })

    # Course-side data parallel to the program side
    course_pipeline_counts = get_course_pipeline_counts(COURSE_TRACKED_ROLES)
    course_pipeline = [
        {
            'role': role,
            'short_name': COURSE_ROLE_SHORT_NAMES.get(role, role),
            'count': course_pipeline_counts.get(role, 0),
        }
        for role in COURSE_TRACKED_ROLES
    ]
    course_workflows = {}
    for c in courses:
        steps = get_course_workflow(c['id'])
        if steps:
            course_workflows[str(c['id'])] = steps
    course_colleges = get_course_colleges()
    course_approvers = get_course_current_approvers()

    return {
        'exported_at': datetime.now().isoformat(),
        'programs': programs,
        'courses': courses,
        'pipeline': pipeline,
        'changes': changes,
        'last_scan': last_scan,
        'colleges': colleges,
        'approvers': approvers,
        'workflows': workflows,
        'course_pipeline': course_pipeline,
        'course_workflows': course_workflows,
        'course_colleges': course_colleges,
        'course_approvers': course_approvers,
    }


def build_static_site():
    """Build the static site in docs/, with JSON data encrypted via AES-GCM.

    Output layout:
      index.html             - dashboard markup + inline password gate + gate JS
      app.js                 - dashboard JS (loaded dynamically after unlock)
      style.css
      crypto.json            - {salt (b64), iterations} — public by design
      data.json.enc          - loaded on unlock
      campus_groups.json.enc - loaded on unlock
      curriculum.json.enc    - lazy-fetched + decrypted on program expand
      reference.json.enc     - lazy-fetched + decrypted on program expand

    Client flow: the gate derives a key from the password + salt using
    PBKDF2-SHA256, monkey-patches fetch() to redirect *.json -> *.json.enc
    and decrypt the bytes, then dynamically loads app.js. If decryption of
    data.json.enc fails (auth-tag mismatch), the user sees "wrong password"
    and is re-prompted.
    """
    os.makedirs(EXPORT_DIR, exist_ok=True)

    # Reuse the existing salt across builds so that client-side remember-me
    # (stored derived key in localStorage) keeps working after each scan.
    # The salt is public by design; rotating it only helps against rainbow
    # tables, which PBKDF2-SHA256 at 200k iterations already prevents.
    salt = _load_or_create_salt()
    key = _derive_key(SITE_PASSWORD, salt)

    # Remove stale artifacts from previous builds (plain or encrypted).
    # NB: we preserve crypto.json if it already holds the reused salt.
    for fname in os.listdir(EXPORT_DIR):
        if fname == 'crypto.json':
            continue
        if fname.endswith(('.json', '.enc', '.html', '.js', '.css')):
            os.remove(os.path.join(EXPORT_DIR, fname))

    # Export data
    data = export_data()
    # Strip curriculum_html from program rows — it lives in curriculum.json
    for p in data.get('programs', []):
        p.pop('curriculum_html', None)
    _write_json_encrypted(data, os.path.join(EXPORT_DIR, 'data.json'), key)

    # Curriculum + reference (large; lazy-fetched + decrypted on expand)
    from html_cleaner import clean_curriculum_html
    curriculum = get_all_curriculum()
    for pid, html in list(curriculum.items()):
        if html:
            curriculum[pid] = clean_curriculum_html(html)
    _write_json_encrypted(curriculum, os.path.join(EXPORT_DIR, 'curriculum.json'), key)

    reference = get_all_reference_curriculum()
    # Bake custom-reference overrides into reference.json: if a program has an
    # override, that overrides the auto-derived reference for the static site.
    overrides = get_all_program_reference_overrides()
    for program_id, custom_ref_id in overrides.items():
        custom = get_custom_reference(custom_ref_id)
        if custom and custom.get('curriculum_html'):
            reference[str(program_id)] = {
                'version_date': f"Custom reference: {custom.get('name', '')}",
                'html': custom.get('curriculum_html', ''),
            }

    # Campus relationship data
    boston_to_deployments, deployment_to_boston = build_campus_groups(data['programs'])

    # Propagate Boston's custom override to non-Boston deployments so their
    # Compare tab sees the same umbrella reference (matches app.py's runtime
    # /api/program/<id>/reference logic). Deployments that already have their
    # own override keep it.
    for deployment_id, boston_id in deployment_to_boston.items():
        if deployment_id in overrides:
            continue
        boston_custom_id = overrides.get(boston_id)
        if not boston_custom_id:
            continue
        custom = get_custom_reference(boston_custom_id)
        if custom and custom.get('curriculum_html'):
            reference[str(deployment_id)] = {
                'version_date': f"Custom reference (via Boston counterpart): {custom.get('name', '')}",
                'html': custom.get('curriculum_html', ''),
            }

    # Apply server-side HTML cleaner (strips plan-of-study sections etc.) so
    # the static site's Reference + Compare tabs get the same cleanup as Flask.
    for pid, entry in reference.items():
        if isinstance(entry, dict) and entry.get('html'):
            entry['html'] = clean_curriculum_html(entry['html'])
        elif isinstance(entry, dict) and entry.get('curriculum_html'):
            entry['curriculum_html'] = clean_curriculum_html(entry['curriculum_html'])

    _write_json_encrypted(reference, os.path.join(EXPORT_DIR, 'reference.json'), key)
    campus_groups = {
        'boston_to_deployments': {str(k): v for k, v in boston_to_deployments.items()},
        'deployment_to_boston': {str(k): v for k, v in deployment_to_boston.items()},
    }
    _write_json_encrypted(campus_groups, os.path.join(EXPORT_DIR, 'campus_groups.json'), key)

    # Regulatory approved-curriculum map (lazy-loaded per program)
    from database import get_all_regulatory_approved
    regulatory = get_all_regulatory_approved()
    _write_json_encrypted(regulatory, os.path.join(EXPORT_DIR, 'regulatory.json'), key)

    # Public crypto parameters (salt is not a secret)
    with open(os.path.join(EXPORT_DIR, 'crypto.json'), 'w') as f:
        json.dump({
            'salt': base64.b64encode(salt).decode('ascii'),
            'iterations': PBKDF2_ITERATIONS,
            'algorithm': 'AES-GCM-256',
            'kdf': 'PBKDF2-SHA256',
        }, f)

    print(f"Exported: {len(data['programs'])} programs, {len(data['courses'])} courses, {len(data['workflows'])} workflows, {len(curriculum)} curricula, {len(reference)} references")

    # Copy CSS
    shutil.copy2(
        os.path.join(os.path.dirname(__file__), 'static', 'style.css'),
        os.path.join(EXPORT_DIR, 'style.css')
    )

    # Build static app.js (overrides API calls + readyState-aware bootstrap)
    src_js_path = os.path.join(os.path.dirname(__file__), 'static', 'app.js')
    with open(src_js_path, 'r') as f:
        original_js = f.read()
    static_js = build_static_js(original_js)
    with open(os.path.join(EXPORT_DIR, 'app.js'), 'w') as f:
        f.write(static_js)

    # Generate index.html: take the dashboard template, wrap the dashboard
    # content in a hidden container, and prepend the password gate.
    tmpl_path = os.path.join(os.path.dirname(__file__), 'templates', 'dashboard.html')
    with open(tmpl_path, 'r') as f:
        html = f.read()

    import time
    cache_bust = int(time.time())
    # Strip Jinja placeholders (left by the Flask template) — static site has none
    html = re.sub(r'\?v=\{\{\s*cache_bust\s*\}\}', '', html)
    html = html.replace('href="/static/style.css"', f'href="style.css?v={cache_bust}"')
    # Remove the static app.js <script> tag; the gate injects it after unlock
    html = re.sub(r'\s*<script[^>]*src="/static/app\.js"[^>]*></script>', '', html)
    html = html.replace(
        '<button id="scan-btn" onclick="triggerScan()">Scan Now</button>',
        ''
    )
    # Remove the References management UI — static site has no backend for uploads.
    # Overrides are baked into reference.json, so the current reference display still works.
    html = re.sub(
        r'<div class="subtle-links">.*?</div>',
        '', html, count=1, flags=re.DOTALL
    )
    html = re.sub(
        r'<div id="refs-modal"[^>]*>.*?</div>\s*</div>\s*</div>',
        '', html, count=1, flags=re.DOTALL
    )

    # Wrap the dashboard body content in a hidden container and prepend gate
    gate_html = _gate_html(cache_bust)
    html = html.replace('<body>', f'<body>\n{gate_html}\n<div id="app-root" style="display:none">', 1)
    html = html.replace('</body>', '</div>\n</body>', 1)

    with open(os.path.join(EXPORT_DIR, 'index.html'), 'w') as f:
        f.write(html)

    print(f"\nStatic site ready in: {EXPORT_DIR}/  (AES-GCM, password-gated)")


def _gate_html(cache_bust: int) -> str:
    """HTML + inline JS for the password gate and client-side decryption."""
    return r"""
<style>
  #password-gate {
    position: fixed; inset: 0; z-index: 9999;
    background: #f5f5f5;
    display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  #password-gate .gate-card {
    background: white; padding: 2.5rem; border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.08);
    width: 360px; max-width: 90vw;
  }
  #password-gate h1 { margin: 0 0 0.25rem 0; font-size: 1.4rem; color: #333; }
  #password-gate .subtitle { color: #888; font-size: 0.9rem; margin-bottom: 1.5rem; display: block; }
  #password-gate form { display: flex; gap: 0.5rem; }
  #password-gate input {
    flex: 1; padding: 0.6rem 0.8rem; font-size: 1rem;
    border: 1px solid #ccc; border-radius: 4px; outline: none;
  }
  #password-gate input:focus { border-color: #C8102E; }
  #password-gate button {
    padding: 0.6rem 1.2rem; font-size: 1rem; font-weight: 600;
    background: #C8102E; color: white; border: 0; border-radius: 4px; cursor: pointer;
  }
  #password-gate button:disabled { opacity: 0.6; cursor: default; }
  #password-gate .gate-error { color: #C8102E; font-size: 0.9rem; margin-top: 0.75rem; min-height: 1.2em; }
  #password-gate .gate-remember { font-size: 0.85rem; color: #666; margin-top: 0.75rem; }
  #password-gate .gate-remember input { flex: 0; width: auto; margin-right: 0.4rem; vertical-align: middle; }
</style>
<div id="password-gate">
  <div class="gate-card">
    <h1>Program Approval Tracker</h1>
    <span class="subtitle">Enter password to access the dashboard.</span>
    <form id="gate-form" autocomplete="off">
      <input type="password" id="gate-password" placeholder="Password" autofocus required>
      <button type="submit" id="gate-submit">Unlock</button>
    </form>
    <label class="gate-remember">
      <input type="checkbox" id="gate-remember" checked>
      Remember me for 30 days on this device
    </label>
    <div id="gate-error" class="gate-error"></div>
  </div>
</div>
<script>
(function() {
  const CACHE_BUST = """ + str(cache_bust) + r""";
  const REMEMBER_KEY = 'cim-tracker-key-v1';
  const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  const gate = document.getElementById('password-gate');
  const form = document.getElementById('gate-form');
  const input = document.getElementById('gate-password');
  const submit = document.getElementById('gate-submit');
  const errEl = document.getElementById('gate-error');
  const remember = document.getElementById('gate-remember');

  const textDecoder = new TextDecoder();

  const ENC_FILES = new Set([
    'data.json', 'curriculum.json', 'reference.json', 'campus_groups.json',
    'regulatory.json',
  ]);

  let cryptoKey = null;
  const cache = new Map(); // path -> parsed JSON

  async function loadCryptoParams() {
    const r = await fetch('crypto.json?v=' + CACHE_BUST);
    if (!r.ok) throw new Error('crypto.json missing');
    return r.json();
  }

  function b64ToBytes(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  async function deriveKey(password, salt, iterations) {
    const baseKey = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), {name: 'PBKDF2'}, false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      {name: 'PBKDF2', salt, iterations, hash: 'SHA-256'},
      baseKey,
      {name: 'AES-GCM', length: 256},
      true,  // extractable (so we can stash it for remember-me)
      ['decrypt']
    );
  }

  async function decryptBlob(key, blob) {
    // Layout: iv(12) || ciphertext+tag
    const iv = blob.slice(0, 12);
    const ct = blob.slice(12);
    const pt = await crypto.subtle.decrypt({name: 'AES-GCM', iv}, key, ct);
    return textDecoder.decode(pt);
  }

  async function fetchAndDecrypt(path) {
    if (cache.has(path)) return cache.get(path);
    const r = await fetch(path + '.enc?v=' + CACHE_BUST);
    if (!r.ok) throw new Error('fetch ' + path + '.enc failed');
    const blob = new Uint8Array(await r.arrayBuffer());
    const plaintext = await decryptBlob(cryptoKey, blob);
    const obj = JSON.parse(plaintext);
    cache.set(path, obj);
    return obj;
  }

  // Monkey-patch fetch so existing app.js paths (fetch('data.json') etc.)
  // transparently go through the decryptor.
  const origFetch = window.fetch.bind(window);
  window.fetch = async function(url, opts) {
    const name = typeof url === 'string'
      ? url.replace(/^\.\//, '').split('?')[0]
      : null;
    if (name && ENC_FILES.has(name)) {
      const obj = await fetchAndDecrypt(name);
      return new Response(JSON.stringify(obj), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
      });
    }
    return origFetch(url, opts);
  };

  async function tryRememberedKey() {
    try {
      const raw = localStorage.getItem(REMEMBER_KEY);
      if (!raw) return null;
      const {jwk, expires} = JSON.parse(raw);
      if (Date.now() > expires) { localStorage.removeItem(REMEMBER_KEY); return null; }
      return await crypto.subtle.importKey(
        'jwk', jwk, {name: 'AES-GCM'}, true, ['decrypt']
      );
    } catch (e) { return null; }
  }

  async function stashKeyForRemember(key) {
    const jwk = await crypto.subtle.exportKey('jwk', key);
    localStorage.setItem(REMEMBER_KEY, JSON.stringify({
      jwk, expires: Date.now() + REMEMBER_TTL_MS,
    }));
  }

  async function verifyKey(key) {
    // Try decrypting data.json.enc as a password check. AES-GCM throws if tag mismatches.
    const r = await fetch('data.json.enc?v=' + CACHE_BUST);
    const blob = new Uint8Array(await r.arrayBuffer());
    const plaintext = await decryptBlob(key, blob);
    const obj = JSON.parse(plaintext);
    cache.set('data.json', obj);
    return obj;
  }

  function bootDashboard() {
    gate.style.display = 'none';
    document.getElementById('app-root').style.display = '';
    const s = document.createElement('script');
    s.src = 'app.js?v=' + CACHE_BUST;
    document.head.appendChild(s);
  }

  async function attemptUnlock(password) {
    const params = await loadCryptoParams();
    const salt = b64ToBytes(params.salt);
    const key = await deriveKey(password, salt, params.iterations);
    await verifyKey(key);  // throws on bad password
    cryptoKey = key;
    if (remember.checked) {
      try { await stashKeyForRemember(key); } catch (e) { /* ignore */ }
    }
    bootDashboard();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    submit.disabled = true;
    submit.textContent = 'Unlocking...';
    try {
      await attemptUnlock(input.value);
    } catch (err) {
      errEl.textContent = 'Wrong password.';
      submit.disabled = false;
      submit.textContent = 'Unlock';
      input.select();
    }
  });

  // Try remembered key silently
  (async () => {
    const key = await tryRememberedKey();
    if (!key) return;
    try {
      await verifyKey(key);
      cryptoKey = key;
      bootDashboard();
    } catch (e) {
      localStorage.removeItem(REMEMBER_KEY);
    }
  })();
})();
</script>
"""


def build_static_js(original_js):
    """Build static version of app.js that reads from data.json."""
    # We'll override just the data-loading functions at the top.
    # The original rendering, filter, and UI code stays intact.

    override = r'''/* ======= STATIC SITE DATA LAYER ======= */
/* Overrides API calls to use embedded data (inlined by export_static.py) */
window._staticMode = true;
let _cache = null;
let _curriculumCache = null;
async function _getData() {
    if (!_cache) {
        _cache = window.__EMBEDDED_DATA__ || (await (await fetch('data.json')).json());
    }
    return _cache;
}

// Override all load* functions AFTER the original script defines them.
// Run immediately if DOM is already ready (app.js may be injected after
// DOMContentLoaded has fired, e.g. by the password gate).
function __staticInit() {
    // Patch the load functions to use static data
    window._origLoadDashboard = loadDashboard;

    window.loadDashboard = async function() {
        const D = await _getData();

        // Programs (load before pipeline so college count works)
        allPrograms = D.programs || [];
        cachedPipeline = D.pipeline;

        // Pipeline (after allPrograms so college count is correct)
        renderPipeline(D.pipeline, allPrograms);
        populateStepFilter();
        populateCampusFilter();

        // Colleges
        const cSel = document.getElementById('filter-college');
        cSel.innerHTML = '<option value="">All Colleges</option>' +
            (D.colleges||[]).map(c => `<option value="${c}">${c}</option>`).join('');

        // Approvers
        const aSel = document.getElementById('filter-approver');
        aSel.innerHTML = '<option value="">All Approvers</option>' +
            (D.approvers||[]).map(a => `<option value="${a.email}">${a.display} (${a.count})</option>`).join('');

        // Timestamps
        const updatedEl = document.getElementById('last-updated');
        const statusEl = document.getElementById('scan-status');
        statusEl.textContent = '';
        if (D.last_scan) {
            const d = new Date(D.last_scan.scan_time);
            updatedEl.textContent = `Updated: ${d.toLocaleDateString('en-US', {month: 'short', day: 'numeric', timeZone: 'America/New_York'})} at ${d.toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'})} ET`;
        }

        // Changes shown via smart view button, not separate section

        // Counts
        updateSmartViewCounts();
        updateTypeCounts();
        updateProposalCounts();

        applyFilters();
    };

    // Patch courses dashboard + loaders to use embedded data (no server).
    window.loadCoursesDashboard = async function() {
        const D = await _getData();
        allCourses = D.courses || [];
        cachedCoursePipeline = collapseCoursePipeline(D.course_pipeline || []);
        renderPipeline(cachedCoursePipeline, allCourses);
        populateCourseStepFilter();
        if (typeof populateCourseSubjectFilter === 'function') populateCourseSubjectFilter();
        const cSel = document.getElementById('filter-college');
        cSel.innerHTML = '<option value="">All Colleges</option>' +
            (D.course_colleges || []).map(c => `<option value="${c}">${c}</option>`).join('');
        const aSel = document.getElementById('filter-approver');
        aSel.innerHTML = '<option value="">All Approvers</option>' +
            (D.course_approvers || []).map(a =>
                `<option value="${a.email}">${a.display} (${a.count})</option>`
            ).join('');
        updateCourseSmartViewCounts();
        applyFilters();
    };
    window.loadCourseApprovers = async function() {
        const D = await _getData();
        const select = document.getElementById('filter-approver');
        const options = (D.course_approvers || []).map(a =>
            `<option value="${a.email}">${a.display} (${a.count})</option>`
        ).join('');
        select.innerHTML = '<option value="">All Approvers</option>' + options;
    };
    window.loadCoursePipeline = async function() {
        const D = await _getData();
        cachedCoursePipeline = collapseCoursePipeline(D.course_pipeline || []);
        renderPipeline(cachedCoursePipeline);
    };
    window.loadCourses = async function() {
        const D = await _getData();
        allCourses = D.courses || [];
        populateCourseStepFilter();
        if (typeof populateCourseSubjectFilter === 'function') populateCourseSubjectFilter();
        applyFilters();
    };
    window.loadCourseColleges = async function() {
        const D = await _getData();
        const select = document.getElementById('filter-college');
        const options = (D.course_colleges || []).map(c => `<option value="${c}">${c}</option>`).join('');
        select.innerHTML = '<option value="">All Colleges</option>' + options;
    };

    // Patch workflow detail loading (handles both programs and courses).
    window._origLoadWorkflowDetail = loadWorkflowDetail;
    window.loadWorkflowDetail = async function(programId, isCourseView) {
        const D = await _getData();
        const source = isCourseView ? (D.course_workflows || {}) : (D.workflows || {});
        const steps = source[String(programId)] || [];
        const contentEl = document.getElementById(`detail-content-${programId}`);
        if (!contentEl) return;

        if (steps.length === 0) {
            contentEl.innerHTML = '<div class="workflow-meta">No workflow data.</div>';
            return;
        }

        let currentEmails = '';
        const stepsHtml = steps.map((s, i) => {
            const statusClass = s.step_status || 'pending';
            const icon = statusClass === 'approved' ? '&#10003;' : statusClass === 'current' ? '&#9679;' : '&#9675;';
            if (statusClass === 'current') currentEmails = s.approver_emails || '';
            const arrow = i < steps.length - 1 ? '<span class="wf-arrow">&#8594;</span>' : '';
            return `<span class="wf-step ${statusClass}" title="${s.step_name}">${icon} ${s.step_name}</span>${arrow}`;
        }).join('');

        let metaHtml = '';
        if (currentEmails) {
            const emails = currentEmails.split(';').map(e => e.trim()).filter(Boolean);
            const emailLinks = emails.map(e => `<a href="mailto:${e}">${e}</a>`).join(', ');
            metaHtml = `<div class="workflow-meta">Current approver(s): ${emailLinks}</div>`;
        }

        let courseMetaHtml = '';
        if (isCourseView) {
            const course = allCourses.find(c => String(c.id) === String(programId));
            if (course) {
                const parts = [];
                if (course.credits) parts.push(`<div class="workflow-meta"><strong>Credits:</strong> ${escapeHtml(course.credits)}</div>`);
                if (course.description) parts.push(`<div class="workflow-meta"><strong>Description:</strong> ${escapeHtml(course.description)}</div>`);
                courseMetaHtml = parts.join('');
            }
        }

        contentEl.innerHTML = `
            <div class="workflow-steps">${stepsHtml}</div>
            ${metaHtml}
            ${courseMetaHtml}
        `;
    };

    // Patch approver filter to use static data (branches on programs vs courses view)
    const _origApplyFilters = applyFilters;
    window.applyFilters = async function() {
        const approverFilter = document.getElementById('filter-approver').value;
        if (approverFilter) {
            const D = await _getData();
            const ids = new Set();
            if (currentView === 'courses') {
                (D.courses || []).forEach(c => {
                    const wf = (D.course_workflows || {})[String(c.id)] || [];
                    if (wf.some(s => s.step_status === 'current' && s.approver_emails && s.approver_emails.includes(approverFilter))) {
                        ids.add(c.id);
                    }
                });
            } else {
                (D.programs || []).forEach(p => {
                    const wf = (D.workflows || {})[String(p.id)] || [];
                    if (wf.some(s => s.step_status === 'current' && s.approver_emails && s.approver_emails.includes(approverFilter))) {
                        ids.add(p.id);
                    }
                });
            }
            window._staticApproverIds = ids;
        } else {
            window._staticApproverIds = null;
        }
        return _origApplyFilters();
    };

    // Patch curriculum loading to use static data
    window.loadCurriculumDetail = async function(programId) {
        const contentEl = document.getElementById(`detail-content-${programId}`);
        if (!contentEl) return;
        contentEl.innerHTML = '<div class="workflow-loading">Loading curriculum...</div>';
        if (!_curriculumCache) {
            try {
                _curriculumCache = window.__EMBEDDED_CURRICULUM__ || (await (await fetch('curriculum.json')).json());
            } catch(e) {
                contentEl.innerHTML = '<div class="workflow-meta">Failed to load curriculum data.</div>';
                return;
            }
        }
        const html = _curriculumCache[String(programId)] || '';
        if (html) {
            const cleaned = cleanCurriculumHtml(html);
            contentEl.innerHTML = `<div class="curriculum-content">${cleaned}</div>`;
        } else {
            contentEl.innerHTML = '<div class="workflow-meta">No curriculum data available.</div>';
        }
    };

    // Patch reference curriculum loading to use static data
    let _referenceCache = null;
    window.loadReferenceDetail = async function(programId) {
        const contentEl = document.getElementById(`detail-content-${programId}`);
        if (!contentEl) return;
        contentEl.innerHTML = '<div class="workflow-loading">Loading reference curriculum...</div>';
        if (!_referenceCache) {
            try {
                _referenceCache = window.__EMBEDDED_REFERENCE__ || (await (await fetch('reference.json')).json());
            } catch(e) {
                contentEl.innerHTML = '<div class="workflow-meta">Failed to load reference data.</div>';
                return;
            }
        }
        const ref = _referenceCache[String(programId)];
        if (ref && ref.html) {
            const cleaned = cleanCurriculumHtml(ref.html);
            const header = ref.version_date
                ? `<div class="reference-header">Last approved version: ${ref.version_date}</div>`
                : '';
            contentEl.innerHTML = `${header}<div class="curriculum-content">${cleaned}</div>`;
        } else {
            contentEl.innerHTML = '<div class="workflow-meta">No reference curriculum available. This may be a new program with no prior approvals.</div>';
        }
    };

    // Patch regulatory loading to read from regulatory.json (lazy) instead of API
    let _regulatoryCache = null;
    window.loadRegulatoryDetail = async function(programId) {
        const contentEl = document.getElementById(`detail-content-${programId}`);
        if (!contentEl) return;
        contentEl.innerHTML = '<div class="workflow-loading">Loading regulatory data...</div>';
        if (!_regulatoryCache) {
            try { _regulatoryCache = await (await fetch('regulatory.json')).json(); }
            catch(e) { _regulatoryCache = {}; }
        }
        if (!_curriculumCache) {
            try { _curriculumCache = window.__EMBEDDED_CURRICULUM__ || (await (await fetch('curriculum.json')).json()); } catch(e) {}
        }
        const reg = _regulatoryCache[String(programId)];
        if (!reg || !Array.isArray(reg.courses) || reg.courses.length === 0) {
            contentEl.innerHTML = '<div class="workflow-meta">No regulatory approved-course list on file for this program.</div>';
            return;
        }
        const currHtml = (_curriculumCache || {})[String(programId)] || '';
        const approvedBySection = new Map();
        for (const c of reg.courses) {
            if (!c || !c.code) continue;
            const key = c.code.toUpperCase().replace(/\\s+/g, ' ').trim();
            if (!approvedBySection.has(key)) approvedBySection.set(key, new Set());
            approvedBySection.get(key).add(
                (normalizeSection ? normalizeSection(c.section || '') : (c.section || '').trim().toLowerCase())
            );
        }
        const approvedCount = reg.courses.length;
        if (!currHtml) {
            contentEl.innerHTML = renderRegulatoryHeader(reg, 0, 0, 0, approvedCount)
                + '<div class="workflow-meta">No proposed curriculum to compare.</div>';
            return;
        }
        const items = extractCourseLines(cleanCurriculumHtml(currHtml));
        let totalProposed = 0, missing = 0, moved = 0;
        let rowsHtml = '';
        for (const it of items) {
            if (it.isHeader) {
                rowsHtml += `<tr><td class="reg-section" colspan="4">${escapeHtml(it.title)}</td></tr>`;
                continue;
            }
            if (!it.code) continue;
            totalProposed++;
            const codeKey = it.code.toUpperCase().replace(/\\s+/g, ' ').trim();
            let flag = 'ok', flagLabel = '';
            if (!approvedBySection.has(codeKey)) {
                flag = 'missing';
                flagLabel = 'Not on approved list';
                missing++;
            } else {
                const approvedSections = approvedBySection.get(codeKey);
                const proposalSection = normalizeSection ? normalizeSection(it.section || '') : (it.section || '').trim().toLowerCase();
                const anyMatch = !proposalSection ||
                    approvedSections.has(proposalSection) ||
                    approvedSections.has('');
                if (!anyMatch) {
                    flag = 'moved';
                    flagLabel = 'Approved, but in a different section';
                    moved++;
                }
            }
            const titleDisplay = it.hours ? `${it.title} (${it.hours}SH)` : it.title;
            rowsHtml += `<tr class="regflag-${flag}" title="${escapeHtml(flagLabel)}">` +
                `<td class="reg-flag">${flag === 'missing' ? '&#9888;' : flag === 'moved' ? '&#9651;' : ''}</td>` +
                `<td class="reg-code">${escapeHtml(it.code)}</td>` +
                `<td class="reg-title">${escapeHtml(titleDisplay)}</td>` +
                `<td class="reg-note">${escapeHtml(flagLabel)}</td>` +
                `</tr>`;
        }
        contentEl.innerHTML = renderRegulatoryHeader(reg, totalProposed, missing, moved, approvedCount) +
            '<table class="regulatory-table">' +
            '<thead><tr><th></th><th>Code</th><th>Title</th><th>Status</th></tr></thead>' +
            '<tbody>' + rowsHtml + '</tbody></table>';
    };

    // Patch campus groups to use static data
    let _campusGroupsCache = null;
    window.getCampusGroups = async function() {
        if (_campusGroupsCache) return _campusGroupsCache;
        try {
            _campusGroupsCache = window.__EMBEDDED_CAMPUS_GROUPS__ || (await (await fetch('campus_groups.json')).json());
        } catch(e) {
            _campusGroupsCache = {boston_to_deployments: {}, deployment_to_boston: {}};
        }
        return _campusGroupsCache;
    };

    // Patch compare to use static curriculum/reference/campus data
    window.loadCompareDetail = async function(programId) {
        const contentEl = document.getElementById(`detail-content-${programId}`);
        if (!contentEl) return;
        contentEl.innerHTML = '<div class="workflow-loading">Loading comparison...</div>';

        if (!_curriculumCache) {
            try { _curriculumCache = window.__EMBEDDED_CURRICULUM__ || (await (await fetch('curriculum.json')).json()); } catch(e) {}
        }
        if (!_referenceCache) {
            try { _referenceCache = window.__EMBEDDED_REFERENCE__ || (await (await fetch('reference.json')).json()); } catch(e) {}
        }
        const groups = await getCampusGroups();
        const currHtml = (_curriculumCache || {})[String(programId)] || '';
        const bostonId = groups.deployment_to_boston[String(programId)];
        const deploymentIds = groups.boston_to_deployments[String(programId)];
        const progName = getProgramName(programId);
        const campusMatch = progName.match(/\(([^)]+)\)\s*$/);
        const campus = campusMatch ? campusMatch[1] : null;
        const isNonBoston = campus && campus.toLowerCase() !== 'boston';

        // Custom-reference override takes precedence over campus-based comparison logic
        const _ref = (_referenceCache || {})[String(programId)];
        const isCustomRef = _ref && _ref.version_date && _ref.version_date.indexOf('Custom reference') === 0;
        if (isCustomRef) {
            const refHtml = _ref.html || '';
            if (!currHtml || !refHtml) {
                contentEl.innerHTML = '<div class="workflow-meta">Curriculum or custom reference data not available for comparison.</div>';
                updateCompareButton(programId, null);
                return;
            }
            const {identical, diff} = compareCurricula(currHtml, refHtml);
            updateCompareButton(programId, identical);
            const header = '<div class="reference-header">Comparing against ' + escapeHtml(_ref.version_date) + '</div>';
            if (identical) {
                contentEl.innerHTML = header + '<div class="compare-identical">Proposed curriculum is identical to the custom reference.</div>';
            } else {
                const table = renderSideBySide(diff, 'Proposed Curriculum', 'Reference Curriculum');
                contentEl.innerHTML = header +
                    '<div class="compare-legend"><span class="compare-legend-item"><span class="legend-box diff-removed-bg"></span> Only in proposal</span>' +
                    '<span class="compare-legend-item"><span class="legend-box diff-added-bg"></span> Only in reference</span>' +
                    '<span class="compare-legend-item"><span class="legend-box diff-moved-bg"></span> Moved between sections</span></div>' + table;
            }
            return;
        }

        if (bostonId || isNonBoston) {
            // Non-Boston deployment
            const ref = (_referenceCache || {})[String(programId)];
            const refHtml = ref ? ref.html : '';
            if (!currHtml || !refHtml) {
                contentEl.innerHTML = '<div class="workflow-meta">Curriculum or reference data not available for comparison.</div>';
                updateCompareButton(programId, null);
                return;
            }
            const {identical, diff} = compareCurricula(currHtml, refHtml);
            updateCompareButton(programId, identical);
            const inWorkflow = ref.version_date && ref.version_date.toLowerCase().includes('in workflow');
            const identicalMsg = inWorkflow
                ? 'Curriculum is identical to the current Boston proposal (in workflow).'
                : 'Curriculum is identical to the Boston reference.';
            const header = ref.version_date
                ? '<div class="reference-header">Comparing against: ' + escapeHtml(ref.version_date) + '</div>' : '';
            if (identical) {
                contentEl.innerHTML = header + '<div class="compare-identical">' + identicalMsg + '</div>';
            } else {
                const table = renderSideBySide(diff, 'Proposed Curriculum', 'Reference Curriculum');
                contentEl.innerHTML = header +
                    '<div class="compare-legend"><span class="compare-legend-item"><span class="legend-box diff-removed-bg"></span> Only in proposal</span>' +
                    '<span class="compare-legend-item"><span class="legend-box diff-added-bg"></span> Only in reference</span>' +
                    '<span class="compare-legend-item"><span class="legend-box diff-moved-bg"></span> Moved between sections</span></div>' + table;
            }
        } else if (deploymentIds && deploymentIds.length > 0) {
            // Boston program
            let allIdentical = true;
            const results = [];
            for (const depId of deploymentIds) {
                const depHtml = (_curriculumCache || {})[String(depId)] || '';
                const depName = getProgramName(depId);
                if (!currHtml || !depHtml) { results.push({name: depName, noData: true}); continue; }
                const {identical, diff} = compareCurricula(depHtml, currHtml);
                if (!identical) allIdentical = false;
                results.push({name: depName, identical, diff});
            }
            updateCompareButton(programId, allIdentical);
            let html = '<div class="reference-header">Comparing Boston curriculum against ' + deploymentIds.length + ' campus deployment' + (deploymentIds.length > 1 ? 's' : '') + '</div>';
            if (allIdentical) html += '<div class="compare-identical">All campus deployments are identical to this curriculum.</div>';
            for (const dep of results) {
                html += '<div class="compare-deployment-section"><h3 class="compare-deployment-name">' + escapeHtml(dep.name) + '</h3>';
                if (dep.noData) html += '<div class="workflow-meta">Curriculum data not available.</div>';
                else if (dep.identical) html += '<div class="compare-identical-small">Identical</div>';
                else {
                    html += '<div class="compare-legend"><span class="compare-legend-item"><span class="legend-box diff-removed-bg"></span> Only in proposal</span>' +
                        '<span class="compare-legend-item"><span class="legend-box diff-added-bg"></span> Only in reference</span>' +
                        '<span class="compare-legend-item"><span class="legend-box diff-moved-bg"></span> Moved between sections</span></div>';
                    html += renderSideBySide(dep.diff, 'Proposed Curriculum', 'Reference Curriculum');
                }
                html += '</div>';
            }
            contentEl.innerHTML = html;
        } else {
            // Standalone program
            const ref = (_referenceCache || {})[String(programId)];
            const refHtml = ref ? ref.html : '';
            if (!currHtml || !refHtml) {
                contentEl.innerHTML = '<div class="workflow-meta">No comparison available.</div>';
                updateCompareButton(programId, null);
                return;
            }
            const {identical, diff} = compareCurricula(currHtml, refHtml);
            updateCompareButton(programId, identical);
            if (identical) {
                contentEl.innerHTML = '<div class="compare-identical">Current curriculum is identical to the last approved version.</div>';
            } else {
                const table = renderSideBySide(diff, 'Proposed Curriculum', 'Reference Curriculum');
                contentEl.innerHTML = '<div class="compare-legend"><span class="compare-legend-item"><span class="legend-box diff-removed-bg"></span> Only in proposal</span>' +
                    '<span class="compare-legend-item"><span class="legend-box diff-added-bg"></span> Only in reference</span>' +
                    '<span class="compare-legend-item"><span class="legend-box diff-moved-bg"></span> Moved between sections</span></div>' + table;
            }
        }
    };

    // Update button tries to reach local Flask server to trigger scan + deploy
    window.triggerScan = async function() {
        const btn = document.getElementById('scan-btn');
        const statusEl = document.getElementById('scan-status');
        btn.disabled = true;
        statusEl.innerHTML = '<span class="spinner"></span> Connecting...';
        statusEl.className = 'scan-status running';
        try {
            const res = await fetch('http://localhost:5001/api/scan/trigger', {method: 'POST', mode: 'cors'});
            if (res.ok) {
                statusEl.innerHTML = '<span class="spinner"></span> Updating (this takes ~20 min)...';
                // Poll local server for completion
                const poll = setInterval(async () => {
                    try {
                        const s = await fetch('http://localhost:5001/api/scan/status');
                        const d = await s.json();
                        if (!d.running) {
                            clearInterval(poll);
                            statusEl.textContent = 'Update complete! Page will refresh with new data shortly.';
                            btn.disabled = false;
                        }
                    } catch(e) { clearInterval(poll); btn.disabled = false; }
                }, 15000);
            }
        } catch(e) {
            statusEl.textContent = 'Cannot reach local server. Run update.sh on your Mac.';
            btn.disabled = false;
        }
    };

    // Remove auto-refresh interval (static data doesn't change)

    // Initial load
    loadDashboard();
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', __staticInit);
} else {
    __staticInit();
}
'''

    # Remove the DOMContentLoaded listener from the original since we add our own
    modified = original_js.replace(
        "document.addEventListener('DOMContentLoaded', loadDashboard);",
        "// DOMContentLoaded handled by static override"
    )
    # Remove the auto-refresh
    modified = modified.replace(
        "setInterval(loadDashboard, 120000);",
        "// Auto-refresh disabled in static mode"
    )

    return modified + "\n\n" + override


if __name__ == '__main__':
    build_static_site()
