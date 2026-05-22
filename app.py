"""Flask server for Program Approval Status Tracker."""

import os
import time
import json as _json
import threading
from datetime import datetime
from flask import Flask, render_template, jsonify, request, make_response, send_from_directory
from flask_cors import CORS

from database import (
    init_db, migrate_db, get_all_programs, get_program_workflow,
    get_pipeline_counts, get_recent_changes, get_last_scan,
    get_programs_by_step, get_colleges, get_current_approvers,
    get_programs_by_approver, get_program_curriculum,
    get_reference_curriculum, get_all_courses, get_course_workflow,
    get_course_pipeline_counts, get_recent_course_changes, get_last_course_scan,
    get_courses_by_step, get_course_colleges,
    get_course_current_approvers, get_courses_by_approver,
    record_scan,
    create_custom_reference, list_custom_references, get_custom_reference,
    delete_custom_reference, set_program_reference_override,
    get_program_reference_override_id, get_program_reference_override,
    get_referenced_by,
)
from docx_parser import parse_docx
from html_cleaner import clean_curriculum_html
try:
    from pdf_parser import parse_pdf
    _PDF_AVAILABLE = True
except ImportError:
    _PDF_AVAILABLE = False
from scraper import TRACKED_ROLES, ROLE_SHORT_NAMES, COURSE_TRACKED_ROLES, COURSE_ROLE_SHORT_NAMES, run_full_scan, fetch_reference_curricula, run_course_scan, check_courseleaf_session
from export_static import build_campus_groups

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})

# Scan state
scan_lock = threading.Lock()
scan_status = {
    'running': False,
    'last_result': None,
    'error': None,
    'phase': '',
    'progress': 0,  # 0-100
}

# Path to scan log and mismatch files
_DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
_SCAN_LOG_PATH = os.path.join(_DATA_DIR, 'scan_log.json')
_MISMATCHES_PATH = os.path.join(_DATA_DIR, 'portfolio_mismatches.json')
_MAX_SCAN_LOG = 50

def _load_scan_log():
    try:
        with open(_SCAN_LOG_PATH) as f:
            return _json.load(f)
    except Exception:
        return []

def _save_scan_log(entries):
    with open(_SCAN_LOG_PATH, 'w') as f:
        _json.dump(entries[-_MAX_SCAN_LOG:], f, indent=2)

@app.route('/')
def dashboard():
    """Serve the main dashboard."""
    import time
    resp = make_response(render_template('dashboard.html', cache_bust=int(time.time())))
    # Force reload on every visit so user never sees stale JS/CSS.
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    resp.headers['Pragma'] = 'no-cache'
    return resp


# Serve static files with short cache so code updates are picked up quickly
@app.route('/static/<path:filename>')
def _static_no_cache(filename):
    resp = make_response(send_from_directory(app.static_folder, filename))
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    return resp


@app.route('/api/programs')
def api_programs():
    """Get all programs with active workflows."""
    from database import get_db
    programs = get_all_programs()

    # Flag programs that have a regulatory approved-courses match so the
    # frontend can show/hide the Regulatory tab without an extra round-trip.
    with get_db() as conn:
        rows = conn.execute(
            "SELECT program_id FROM regulatory_approved_courses"
        ).fetchall()
        has_reg = {row['program_id'] for row in rows}
    for p in programs:
        p['has_regulatory'] = p['id'] in has_reg

    # Group by type
    grouped = {}
    for p in programs:
        ptype = p.get('program_type', 'Other')
        if ptype not in grouped:
            grouped[ptype] = []
        grouped[ptype].append(p)

    return jsonify({
        'programs': programs,
        'grouped': grouped,
        'total': len(programs)
    })


@app.route('/api/program/<int:program_id>/workflow')
def api_program_workflow(program_id):
    """Get workflow steps for a specific program."""
    steps = get_program_workflow(program_id)
    return jsonify({'steps': steps})


@app.route('/api/program/<int:program_id>/curriculum')
def api_program_curriculum(program_id):
    """Get curriculum HTML for a specific program."""
    html = get_program_curriculum(program_id)
    return jsonify({'curriculum_html': clean_curriculum_html(html)})


@app.route('/api/program/<int:program_id>/regulatory')
def api_program_regulatory(program_id):
    """Return regulatory approved-curriculum data for a program.

    Returns the list of approved courses from the matching SharePoint
    workbook sheet, or 404 if no match is on file.
    """
    from database import get_regulatory_approved
    reg = get_regulatory_approved(program_id)
    if not reg:
        return jsonify({'available': False}), 404
    return jsonify({
        'available': True,
        'campus': reg.get('campus'),
        'source_file': reg.get('source_file'),
        'sheet_name': reg.get('sheet_name'),
        'sheet_title': reg.get('sheet_title'),
        'edited_by': reg.get('edited_by'),
        'unit_header': reg.get('unit_header'),
        'confidence': reg.get('confidence'),
        'match_reason': reg.get('match_reason'),
        'fetched_at': reg.get('fetched_at'),
        'courses': reg.get('courses', []),
        'sections': reg.get('sections', []),
    })


@app.route('/api/program/<int:program_id>/reference')
def api_program_reference(program_id):
    """Get reference curriculum for a program.

    Resolution precedence (top wins):
      1. Uploaded file (custom_reference_id) → source='custom'
      2. Another CIM program (reference_program_id) → source='program'
      3. Auto: Boston counterpart for non-Boston / own history otherwise
         → source='auto'
      4. No reference available → 404

    No more self-reference fallback. If a program has no Boston counterpart
    and no prior approved version in CIM, the API returns 404 and the
    Alignment tab shows "no reference available" instead of synthesizing
    a comparison against the program's own current curriculum.
    """
    override = get_program_reference_override(program_id)

    # 1. Custom uploaded file
    if override['custom_reference_id']:
        custom = get_custom_reference(override['custom_reference_id'])
        if custom:
            return jsonify({
                'source': 'custom',
                'custom_reference_id': override['custom_reference_id'],
                'name': custom.get('name'),
                'source_filename': custom.get('source_filename'),
                'version_date': f"Custom reference: {custom.get('name', '')}",
                'curriculum_html': clean_curriculum_html(custom.get('curriculum_html', '')),
            })
        # Override points to a deleted ref — fall through

    # 2. Another CIM program (explicit override)
    if override['reference_program_id']:
        from database import get_db
        other_id = override['reference_program_id']
        with get_db() as conn:
            row = conn.execute(
                "SELECT name, curriculum_html FROM programs WHERE id = ?",
                (other_id,)
            ).fetchone()
        if row and (row['curriculum_html'] or '').strip():
            return jsonify({
                'source': 'program',
                'reference_program_id': other_id,
                'name': row['name'],
                'version_date': f"Reference program: {row['name']}",
                'curriculum_html': clean_curriculum_html(row['curriculum_html']),
            })
        # Target missing or empty — fall through to auto

    # 3. Inheritance: if this program is a non-Boston deployment whose Boston
    # counterpart has a file or program override set, use that. Lets a single
    # override on Boston cover every deployment.
    programs = get_all_programs()
    _boston_to_deployments, deployment_to_boston = build_campus_groups(programs)
    boston_id = deployment_to_boston.get(program_id)
    if boston_id:
        boston_override = get_program_reference_override(boston_id)
        if boston_override['custom_reference_id']:
            custom = get_custom_reference(boston_override['custom_reference_id'])
            if custom:
                return jsonify({
                    'source': 'custom',
                    'custom_reference_id': boston_override['custom_reference_id'],
                    'name': custom.get('name'),
                    'source_filename': custom.get('source_filename'),
                    'version_date': f"Custom reference (via Boston counterpart): {custom.get('name', '')}",
                    'curriculum_html': clean_curriculum_html(custom.get('curriculum_html', '')),
                })
        if boston_override['reference_program_id']:
            from database import get_db
            with get_db() as conn:
                row = conn.execute(
                    "SELECT name, curriculum_html FROM programs WHERE id = ?",
                    (boston_override['reference_program_id'],)
                ).fetchone()
            if row and (row['curriculum_html'] or '').strip():
                return jsonify({
                    'source': 'program',
                    'reference_program_id': boston_override['reference_program_id'],
                    'name': row['name'],
                    'version_date': f"Reference program (via Boston counterpart): {row['name']}",
                    'curriculum_html': clean_curriculum_html(row['curriculum_html']),
                })

    # 4. Auto-derived: ONLY for non-Boston deployments — fall through to
    #    the Boston counterpart's own last-approved version. Reference is
    #    a cross-program concept; a program comparing against an older
    #    edit of itself is not a Reference comparison — that's the
    #    Changes tab.
    #
    # Boston programs / standalone programs / non-Boston deployments
    # without a Boston counterpart all return 404 here. The UI explains
    # and offers the picker (Another program / Uploaded file).
    if program_id in deployment_to_boston:
        # Non-Boston deployment — Reference is the Boston counterpart's
        # curriculum, resolved at request time. Two flavors:
        #   1. Boston is in workflow (current_step set, no completion_date):
        #      use Boston's CURRENT curriculum_html (the in-flight proposal).
        #   2. Otherwise: use Boston's last-approved history version from
        #      reference_curriculum.
        boston_id = deployment_to_boston[program_id]
        boston_row = next((p for p in programs if p['id'] == boston_id), None)
        if boston_row:
            boston_in_workflow = (bool((boston_row.get('current_step') or '').strip())
                                  and not (boston_row.get('completion_date') or '').strip())
            if boston_in_workflow and boston_row.get('curriculum_html'):
                return jsonify({
                    'source': 'auto',
                    'version_id': 0,
                    'version_date': 'current proposal (Boston counterpart, in workflow)',
                    'curriculum_html': clean_curriculum_html(boston_row['curriculum_html']),
                })
            boston_ref = get_reference_curriculum(boston_id)
            if boston_ref and boston_ref.get('version_id') not in (0, -1) \
                    and 'no prior approved' not in (boston_ref.get('version_date') or '').lower():
                boston_ref['source'] = 'auto'
                boston_ref['version_date'] = (boston_ref.get('version_date') or '') + ' (Boston counterpart)'
                boston_ref['curriculum_html'] = clean_curriculum_html(boston_ref.get('curriculum_html', ''))
                return jsonify(boston_ref)
    return jsonify({'error': 'No reference curriculum found'}), 404


@app.route('/api/program/<int:program_id>/changes')
def api_program_changes(program_id):
    """Get the program's OWN most-recent approved version for the Changes tab.

    The Changes tab compares the program's current curriculum against its
    last-approved CIM history version (intra-program diff). This is
    distinct from the Reference tab, which compares against a different
    program / uploaded file.

    Returns 404 when this program has no own-history row — either it's a
    brand-new program with no prior approved version, or the stored
    reference is a Boston-counterpart record (used as the Reference, not
    the Changes baseline).
    """
    ref = get_reference_curriculum(program_id)
    if not ref:
        return jsonify({'error': 'No prior version available'}), 404
    # reference_curriculum now always stores own-history; legacy sentinels
    # (version_id 0/-1) are filtered out for safety.
    if ref.get('version_id') in (0, -1):
        return jsonify({'error': 'No prior version available'}), 404
    ref['curriculum_html'] = clean_curriculum_html(ref.get('curriculum_html', ''))
    return jsonify(ref)


@app.route('/api/programs/comparable')
def api_programs_comparable():
    """Picker source: list programs eligible as a reference for a given
    program (by subject + degree). Used by the "Another program" picker
    on the Reference tab.

    Query params:
      - program_id (required): the program asking for candidates
      - scope (optional): 'family' (default — same subject + base degree)
        or 'all' (every program)
    """
    program_id = request.args.get('program_id', type=int)
    scope = request.args.get('scope', 'family')
    if not program_id:
        return jsonify({'error': 'program_id required'}), 400
    programs = get_all_programs()
    target = next((p for p in programs if p['id'] == program_id), None)
    if not target:
        return jsonify({'error': 'program_not_found'}), 404

    if scope == 'all':
        out = [{'id': p['id'], 'name': p['name'], 'degree': p['degree'],
                'campus': p.get('campus', '')}
               for p in programs if p['id'] != program_id]
    else:
        # Same subject + base degree family. Strip variant suffixes
        # ("—Bridge", "—Online") from the degree code so a Bridge variant
        # can pick a regular variant of the same program as its reference.
        import re as _re
        def base_deg(d):
            return (d or '').split('—')[0].strip().upper()
        def base_subject(name):
            n = _re.sub(r'\s*\([^)]*\)\s*$', '', name or '')
            # Strip ", DEGREE" suffix if present
            if ',' in n:
                n = n.rsplit(',', 1)[0]
            return n.strip().lower()
        target_subject = base_subject(target['name'])
        target_deg     = base_deg(target['degree'])
        out = []
        for p in programs:
            if p['id'] == program_id: continue
            if base_subject(p['name']) != target_subject: continue
            if target_deg and base_deg(p['degree']) != target_deg: continue
            out.append({'id': p['id'], 'name': p['name'],
                        'degree': p['degree'], 'campus': p.get('campus', '')})
    out.sort(key=lambda r: (r['name'] or '').lower())
    return jsonify({'candidates': out, 'scope': scope})


@app.route('/api/program/<int:program_id>/referenced_by')
def api_program_referenced_by(program_id):
    """Reverse lookup: which programs use THIS program as their reference?

    Two sources combined:
      - Explicit `reference_program_id` pointers (any program that picked
        this one via the "Another program" override).
      - Implicit Boston-counterpart references (deployments that resolve
        to this program automatically because there's no override).
        Only populated when this program IS a Boston deployment.

    Returns {'explicit': [{id, name}], 'implicit': [{id, name}]}.
    """
    explicit = get_referenced_by(program_id)
    implicit = []
    programs = get_all_programs()
    boston_to_deployments, _ = build_campus_groups(programs)
    if program_id in boston_to_deployments:
        prog_by_id = {p['id']: p for p in programs}
        for dep_id in boston_to_deployments[program_id]:
            # Exclude any deployment that has an override pointing somewhere
            # else — those resolve to that target, not to this Boston program.
            dep_override = get_program_reference_override(dep_id)
            if dep_override['custom_reference_id'] or dep_override['reference_program_id']:
                continue
            p = prog_by_id.get(dep_id)
            if p:
                implicit.append({'id': dep_id, 'name': p['name']})
    return jsonify({'explicit': explicit, 'implicit': implicit})


@app.route('/api/custom_references', methods=['GET'])
def api_list_custom_references():
    """List all custom references (metadata only)."""
    return jsonify({'references': list_custom_references()})


@app.route('/api/custom_references', methods=['POST'])
def api_upload_custom_reference():
    """Upload a custom reference file (.docx) and save it.

    Accepts multipart/form-data with:
      - file: the .docx file
      - name: display name for this reference (optional; defaults to filename)
      - notes: free-text notes (optional)
    """
    if 'file' not in request.files:
        return jsonify({'error': 'No file uploaded'}), 400
    f = request.files['file']
    if not f or not f.filename:
        return jsonify({'error': 'Empty filename'}), 400

    filename = f.filename
    ext = (filename.rsplit('.', 1)[-1] if '.' in filename else '').lower()
    if ext not in ('docx', 'pdf'):
        # Helpful message for common rejections
        if ext == 'doc':
            detail = ('Legacy .doc files are not supported directly. Open the file in Word, '
                      'then Save As → Word Document (.docx) and upload the .docx.')
        else:
            detail = (f'.{ext} files are not supported. Please upload a .docx or .pdf file.')
        return jsonify({'error': 'unsupported_format', 'detail': detail}), 415

    if ext == 'pdf' and not _PDF_AVAILABLE:
        return jsonify({
            'error': 'pdf_unavailable',
            'detail': 'PDF parsing is not available — pdfplumber is not installed on the server. '
                      'Run: pip3 install pdfplumber'
        }), 503

    data = f.read()
    try:
        if ext == 'pdf':
            parsed = parse_pdf(data)
        else:
            parsed = parse_docx(data)
    except Exception as e:
        return jsonify({'error': 'parse_failed', 'detail': str(e)}), 400

    if not parsed.get('curriculum_html'):
        return jsonify({
            'error': 'empty_content',
            'detail': 'No course content could be extracted from this file. '
                      'Warnings: ' + '; '.join(parsed.get('warnings', []))
        }), 400

    name = request.form.get('name', '').strip() or parsed.get('title') or filename.rsplit('.', 1)[0]
    notes = request.form.get('notes', '').strip()

    ref_id = create_custom_reference(
        name=name,
        source_type=ext,
        source_filename=filename,
        title=parsed.get('title', ''),
        curriculum_html=parsed.get('curriculum_html', ''),
        sections_json=_json.dumps(parsed.get('sections', [])),
        notes=notes,
    )
    # Return the preview so the UI can confirm the parse looked reasonable
    return jsonify({
        'id': ref_id,
        'name': name,
        'title': parsed.get('title', ''),
        'sections': parsed.get('sections', []),
        'warnings': parsed.get('warnings', []),
    })


@app.route('/api/custom_references/<int:ref_id>', methods=['GET'])
def api_get_custom_reference(ref_id):
    ref = get_custom_reference(ref_id)
    if not ref:
        return jsonify({'error': 'not_found'}), 404
    # Parse sections_json back into structured data for UI
    try:
        ref['sections'] = _json.loads(ref.get('sections_json') or '[]')
    except Exception:
        ref['sections'] = []
    return jsonify(ref)


@app.route('/api/custom_references/<int:ref_id>', methods=['DELETE'])
def api_delete_custom_reference(ref_id):
    cleared = delete_custom_reference(ref_id)
    return jsonify({'deleted': True, 'overrides_cleared': cleared})


@app.route('/api/program/<int:program_id>/reference_override', methods=['POST'])
def api_set_reference_override(program_id):
    """Set (or clear) a program's reference override.

    Body shapes (one of):
      {"custom_reference_id": N}     — pick an uploaded file as reference
      {"reference_program_id": N}    — pick another CIM program as reference
      {"custom_reference_id": null}  — clear to Auto (back-compat)
      {}                             — clear to Auto
    """
    body = request.get_json(silent=True) or {}
    custom_id  = body.get('custom_reference_id')
    program_id_arg = body.get('reference_program_id')

    if custom_id is not None and program_id_arg is not None:
        return jsonify({'error': 'cannot_set_both',
                        'detail': 'Pass exactly one of custom_reference_id / reference_program_id, '
                                  'or pass null/empty to clear both.'}), 400

    if custom_id is not None:
        if not get_custom_reference(int(custom_id)):
            return jsonify({'error': 'custom_reference_not_found'}), 404
        set_program_reference_override(program_id, custom_reference_id=int(custom_id))
    elif program_id_arg is not None:
        # Validate the target program exists and isn't this program
        if int(program_id_arg) == program_id:
            return jsonify({'error': 'self_reference_not_allowed'}), 400
        from database import get_db
        with get_db() as conn:
            exists = conn.execute(
                "SELECT 1 FROM programs WHERE id = ?", (int(program_id_arg),)
            ).fetchone()
        if not exists:
            return jsonify({'error': 'reference_program_not_found'}), 404
        set_program_reference_override(program_id, reference_program_id=int(program_id_arg))
    else:
        # Both null — clear
        set_program_reference_override(program_id)
    return jsonify({
        'program_id': program_id,
        'custom_reference_id': custom_id if custom_id is not None else None,
        'reference_program_id': int(program_id_arg) if program_id_arg is not None else None,
    })


@app.route('/api/campus_groups')
def api_campus_groups():
    """Get Boston-to-deployment campus relationship mappings."""
    programs = get_all_programs()
    boston_to_deployments, deployment_to_boston = build_campus_groups(programs)
    return jsonify({
        'boston_to_deployments': {str(k): v for k, v in boston_to_deployments.items()},
        'deployment_to_boston': {str(k): v for k, v in deployment_to_boston.items()},
    })


@app.route('/api/pipeline')
def api_pipeline():
    """Get pipeline summary counts."""
    counts = get_pipeline_counts(TRACKED_ROLES)
    pipeline = []
    for role in TRACKED_ROLES:
        pipeline.append({
            'role': role,
            'short_name': ROLE_SHORT_NAMES.get(role, role),
            'count': counts.get(role, 0)
        })
    return jsonify({'pipeline': pipeline})


@app.route('/api/changes')
def api_changes():
    """Get recent changes."""
    changes = get_recent_changes(limit=100)
    return jsonify({'changes': changes})


def _with_local_tz(iso_str):
    """Attach the machine's local timezone offset to a naive ISO timestamp
    so browsers parse it correctly regardless of their own timezone.

    Historical scan_time values are stored via `datetime.now().isoformat()`
    (no tz), which browsers then interpret as their own local time — off
    by the server<->client tz gap. Here we attach the server's local tz
    so "2026-04-24T12:08:47" becomes "2026-04-24T12:08:47-07:00".
    """
    if not iso_str:
        return iso_str
    try:
        dt = datetime.fromisoformat(iso_str)
    except ValueError:
        return iso_str
    if dt.tzinfo is not None:
        return dt.isoformat()
    return dt.astimezone().isoformat()


@app.route('/api/scan/status')
def api_scan_status():
    """Get current scan status."""
    last_scan = get_last_scan()
    if last_scan and 'scan_time' in last_scan:
        last_scan = dict(last_scan)
        last_scan['scan_time'] = _with_local_tz(last_scan['scan_time'])
    return jsonify({
        'running': scan_status['running'],
        'error': scan_status['error'],
        'last_scan': last_scan,
        'phase': scan_status.get('phase', ''),
        'progress': scan_status.get('progress', 0)
    })


@app.route('/api/session/check')
def api_session_check():
    """Verify the CourseLeaf session and all portfolio data source logins."""
    from fetch_portfolio_data import check_portfolio_sessions
    cim = check_courseleaf_session()
    portfolio = check_portfolio_sessions()
    all_ok = cim.get('ok') and all(s['ok'] for s in portfolio)
    missing = []
    if not cim.get('ok'):
        missing.append(f"CIM: {cim.get('detail', 'session invalid')}")
    for s in portfolio:
        if not s['ok']:
            missing.append(f"{s['source']}: {s['detail']}")
    result = {
        'ok': all_ok,
        'cim': cim,
        'portfolio': portfolio,
    }
    if missing:
        result['error'] = 'session_invalid'
        result['detail'] = ' | '.join(missing)
    status_code = 200 if all_ok else 503
    return jsonify(result), status_code


@app.route('/api/heal', methods=['POST'])
def api_heal():
    """Deep-refresh endpoint: iterate the live ~215-role Approve Pages
    dropdown, then cross-check every observed program/course/catalog
    entry against its workflow div. Use when scan-trigger's lighter-
    weight discovery seems to be missing things, or after a CIM
    schema change.

    NOTE: As of Options C+F, `/api/scan/trigger` is the faster path
    for everyday updates (~22 min, with Phase A+B incremental fetch
    and targeted reference/regulatory). `/api/heal` is now the
    *deeper* (and slower) reconciliation — it cross-fetches every
    live program's workflow div, costing ~70+ min on a busy
    pipeline. Prefer scan-trigger; reach for heal when you suspect
    the incremental path missed something.

    Request body (JSON, optional):
      {"scope": "programs"}    — programs only (~30-40 min)
      {"scope": "courses"}     — courses only (~30-40 min)
      {"scope": "both"}        — default; both (~70+ min)
      {"active_only": false}   — include completed/historical too (slower still)
      {"deploy": true}         — default; run export + git push to GitHub Pages when done
      {"deploy": false}        — skip deploy; DB-only update (for debugging)
    """
    from scraper import (
        heal_stale_program_steps, heal_stale_course_steps, heal_stale_catalog_pages,
    )

    if scan_status['running']:
        return jsonify({'error': 'Scan already in progress'}), 409

    session = check_courseleaf_session()
    if not session.get('ok'):
        return jsonify({
            'error': session.get('error', 'session_invalid'),
            'detail': session.get('detail', 'CourseLeaf session invalid'),
        }), 503

    body = request.get_json(silent=True) or {}
    scope = body.get('scope', 'all')
    # Backwards-compat: 'both' used to mean programs+courses; 'all' now also covers catalog.
    if scope == 'both':
        scope = 'all'
    active_only = body.get('active_only', True)
    deploy = body.get('deploy', True)

    def do_heal():
        try:
            scan_status['running'] = True
            scan_status['error'] = None
            scan_status['phase'] = 'Syncing active pipeline…'
            scan_status['progress'] = 5

            result = {'scope': scope, 'active_only': active_only}

            if scope in ('programs', 'all'):
                scan_status['phase'] = 'Refreshing program workflow states…'
                scan_status['progress'] = 10
                pw, pf = heal_stale_program_steps(log=True, active_only=active_only)
                result['programs'] = {'warnings': pw, 'fixed': pf}
                scan_status['progress'] = 40

            if scope in ('courses', 'all'):
                scan_status['phase'] = 'Refreshing course workflow states…'
                scan_status['progress'] = 50
                cw, cf = heal_stale_course_steps(log=True, active_only=active_only)
                result['courses'] = {'warnings': cw, 'fixed': cf}
                scan_status['progress'] = 75

            if scope in ('catalog', 'all'):
                scan_status['phase'] = 'Refreshing catalog page states…'
                scan_status['progress'] = 80
                kw, kf = heal_stale_catalog_pages(log=True)
                result['catalog'] = {'warnings': kw, 'fixed': kf}
                scan_status['progress'] = 88

            if deploy:
                scan_status['phase'] = 'Exporting & deploying…'
                scan_status['progress'] = 90
                import subprocess
                cwd = os.path.dirname(os.path.abspath(__file__))
                subprocess.run(['python3', 'export_static.py'], cwd=cwd)
                subprocess.run(['git', 'add', 'docs/'], cwd=cwd)
                subprocess.run(['git', 'commit', '-m',
                                f'Quick update {datetime.now().strftime("%Y-%m-%d %H:%M")}'], cwd=cwd)
                subprocess.run(['git', 'push'], cwd=cwd)
                scan_status['progress'] = 100

            scan_status['last_result'] = result
        except Exception as e:
            scan_status['error'] = str(e)
            print(f"Quick-update error: {e}")
        finally:
            scan_status['running'] = False
            scan_status['phase'] = ''

    import threading
    threading.Thread(target=do_heal, daemon=True).start()
    return jsonify({'ok': True, 'started': True, 'scope': scope,
                    'active_only': active_only, 'deploy': deploy})


@app.route('/api/scan/trigger', methods=['POST'])
def api_scan_trigger():
    """Trigger a manual scan.

    Preflight: verify the CourseLeaf session is authenticated before spending
    10+ minutes on a scan that would silently do nothing.
    """
    if scan_status['running']:
        return jsonify({'error': 'Scan already in progress'}), 409

    # Fast session probe (~1-3s per source); abort scan if any required login is missing.
    from fetch_portfolio_data import check_portfolio_sessions
    session = check_courseleaf_session()
    portfolio_sessions = check_portfolio_sessions()
    missing = []
    if not session.get('ok'):
        missing.append(f"CIM: {session.get('detail', 'session invalid')}")
    for s in portfolio_sessions:
        if not s['ok']:
            missing.append(f"{s['source']}: {s['detail']}")
    if missing:
        detail = ' | '.join(missing)
        scan_status['error'] = detail
        return jsonify({'error': 'session_invalid', 'detail': detail}), 503

    def do_quick_role_update(label='quick role update'):
        """Force-fetch every DB-active program and course's workflow div,
        reconcile DB, and push to GitHub Pages if anything changed.
        Called multiple times throughout a thorough scan to publish
        role changes mid-scan instead of waiting until the end. ~3-4
        min per call. C1 fingerprint check makes this a no-op (no push)
        when no role changed since the last call.
        """
        from scraper import (
            run_full_scan as _scraper_run_full_scan,
            process_course_scans as _scraper_process_course_scans,
            compute_db_fingerprint,
        )
        print(f"\n>>> {label.upper()} — START", flush=True)
        scan_status['phase'] = f'{label} (programs)…'
        try:
            _scraper_run_full_scan(force_fetch_only=True)
        except Exception as e:
            print(f">>> {label} (programs) error: {e}", flush=True)
        scan_status['phase'] = f'{label} (courses)…'
        try:
            _scraper_process_course_scans([], force_fetch_only=True)
        except Exception as e:
            print(f">>> {label} (courses) error: {e}", flush=True)
        # C1: export + push if and only if DB content changed.
        try:
            import subprocess
            cwd = os.path.dirname(os.path.abspath(__file__))
            fp_path = os.path.join(cwd, 'data', 'last_export_fingerprint')
            current_fp = compute_db_fingerprint()
            prev_fp = ''
            if os.path.exists(fp_path):
                try:
                    with open(fp_path) as f:
                        prev_fp = f.read().strip()
                except Exception:
                    prev_fp = ''
            if current_fp != prev_fp:
                scan_status['phase'] = f'{label} (publishing)…'
                # Timeouts on every subprocess call so a hung
                # network/credential-prompt doesn't freeze the entire
                # scan. Empirically a normal export takes ~10s, git
                # push <10s; 180s is well above noise.
                subprocess.run(['python3', 'export_static.py'], cwd=cwd, timeout=300)
                subprocess.run(['git', 'add', 'docs/'], cwd=cwd, timeout=30)
                subprocess.run(['git', 'commit', '-m',
                                f'Quick role update {datetime.now().strftime("%Y-%m-%d %H:%M")}'], cwd=cwd, timeout=30)
                subprocess.run(['git', 'push'], cwd=cwd, timeout=180)
                with open(fp_path, 'w') as f:
                    f.write(current_fp)
                # Record a scan row so the dashboard's "Updated" timestamp
                # refreshes. Use programs_scanned=-3 as a sentinel for
                # "this row came from a quick role update mid-scan, not
                # a full do_scan completion".
                try:
                    record_scan(datetime.now().isoformat(), -3, 0, 0)
                except Exception:
                    pass
                print(f">>> {label.upper()} pushed (fp {prev_fp[:12] or '(none)'}... → {current_fp[:12]}...)", flush=True)
            else:
                print(f">>> {label.upper()} no DB changes (fp unchanged)", flush=True)
        except Exception as e:
            print(f">>> {label} (publish) error: {e}", flush=True)

    def do_scan():
        try:
            scan_status['running'] = True
            scan_status['error'] = None
            scan_status['phase'] = 'Discovering programs (discovering roles)...'
            scan_status['progress'] = 5
            started_at = datetime.now().isoformat()

            # Scan programs (full path: A1 discovery + force-fetch + reconcile)
            print("\n>>> STARTING RUN_FULL_SCAN", flush=True)
            result = run_full_scan()
            print(f">>> RUN_FULL_SCAN COMPLETE, result: {result}", flush=True)
            scan_status['last_result'] = result
            scan_status['progress'] = 40

            # Quick update after program-side discovery (catches anything
            # the A1 discovery + force-fetch turned up).
            do_quick_role_update(label='post-programs quick update')

            # Scan courses with interleaved quick updates every 15 roles
            # (so within the ~22-min courses scrape, role updates publish
            # every ~5-7 min).
            print("\n>>> About to start course scanning...", flush=True)
            scan_status['phase'] = 'Discovering courses...'
            scan_status['progress'] = 50
            try:
                print(">>> Calling run_course_scan() with interleaved callback...", flush=True)
                course_result = run_course_scan(
                    progress_callback=lambda done, total: do_quick_role_update(
                        label=f'mid-courses quick update ({done}/{total} roles)'))
                print(f">>> Course scan result: {course_result}", flush=True)
                scan_status['phase'] = 'Processing courses...'
                scan_status['progress'] = 65
            except Exception as e:
                print(f">>> Course scan error: {e}", flush=True)
                import traceback
                traceback.print_exc()

            # Quick update after courses phase
            do_quick_role_update(label='post-courses quick update')

            # Catalog page sync with interleaved quick updates
            scan_status['phase'] = 'Syncing catalog pages...'
            scan_status['progress'] = 68
            try:
                from scraper import heal_stale_catalog_pages
                heal_stale_catalog_pages(
                    log=True,
                    progress_callback=lambda done, total: do_quick_role_update(
                        label=f'mid-catalog quick update ({done}/{total} roles)'))
            except Exception as e:
                print(f">>> Catalog sync error: {e}", flush=True)

            # Quick update after catalog sync
            do_quick_role_update(label='post-catalog quick update')

            # Weekly historical sweeps run FIRST (before reference/regulatory
            # fetches) so any newly-ingested completed programs/courses are
            # included in get_all_programs() for the downstream fetches.
            # Otherwise they'd linger without references until the next scan.
            sweep_program_completions = []  # C3: programs newly completed via sweep
            scan_status['phase'] = 'Checking historical sweep...'
            scan_status['progress'] = 72
            try:
                from database import get_db
                from scraper import sweep_all_program_ids, sweep_all_course_ids
                with get_db() as conn:
                    last_p = conn.execute(
                        "SELECT scan_time FROM scans WHERE programs_scanned = -1 "
                        "ORDER BY scan_time DESC LIMIT 1"
                    ).fetchone()
                p_due = True
                if last_p and last_p['scan_time']:
                    p_due = (datetime.now() - datetime.fromisoformat(last_p['scan_time'])).days >= 7
                if p_due:
                    scan_status['phase'] = 'Weekly program sweep...'
                    sweep_result = sweep_all_program_ids(start_id=1, end_id=2100, log=True)
                    sweep_program_completions = sweep_result.get('new_completion_ids', []) if sweep_result else []

                with get_db() as conn:
                    last_c = conn.execute(
                        "SELECT scan_time FROM course_scans WHERE changes_detected = -1 "
                        "ORDER BY scan_time DESC LIMIT 1"
                    ).fetchone()
                c_due = True
                if last_c and last_c['scan_time']:
                    c_due = (datetime.now() - datetime.fromisoformat(last_c['scan_time'])).days >= 7
                if c_due:
                    scan_status['phase'] = 'Weekly course sweep...'
                    sweep_all_course_ids(start_id=1, end_id=3000, log=True)
            except Exception as e:
                # Sweep is a background refresh — failures shouldn't break the
                # main scan or the static export that follows.
                print(f"Historical sweep error: {e}")

            # Fetch reference curricula. Runs AFTER the sweep so newly-ingested
            # historical programs get their Boston-counterpart references in
            # the same scan.
            #
            # C3: targeted fetch — round-trip CIM history only for programs
            # that need it. Pre-C3 this loop did 1669 HTML fetches every scan
            # to compare version_ids; "0 fetched, 1669 skipped" still cost
            # ~16 min. Now we only fetch when there's positive reason to
            # believe the reference might be stale:
            #   - no existing reference row (initial fetch)
            #   - program just completed workflow (own history advanced)
            #   - non-Boston whose Boston counterpart just completed
            #     (its ref now points at Boston's new last-approved version,
            #      not the version_id=0 sentinel)
            # Boston-in-workflow non-Boston refs (sentinel mode) are
            # propagated by fetch_reference_curricula's sentinel block,
            # which always runs over the full set.
            scan_status['phase'] = 'Fetching reference data...'
            scan_status['progress'] = 78
            try:
                programs = get_all_programs()
                prog_ids = [p['id'] for p in programs]
                if prog_ids:
                    completed_in_scan = set(result.get('completed_in_scan', [])) if result else set()
                    completed_in_scan |= set(sweep_program_completions)

                    from database import get_db
                    from scraper import _build_boston_counterpart_map
                    with get_db() as conn:
                        existing_ref_ids = {
                            r['program_id'] for r in conn.execute(
                                "SELECT program_id FROM reference_curriculum"
                            ).fetchall()
                        }
                    targeted_ids = set(prog_ids) - existing_ref_ids
                    targeted_ids |= completed_in_scan
                    # Non-Boston deployments whose Boston counterpart just
                    # completed need their ref recomputed against Boston's
                    # new last-approved version.
                    if completed_in_scan:
                        counterpart_map, _ = _build_boston_counterpart_map(prog_ids)
                        for nb_id, b_id in counterpart_map.items():
                            if b_id in completed_in_scan:
                                targeted_ids.add(nb_id)
                    print(f"Reference fetch (C3): targeting "
                          f"{len(targeted_ids)} of {len(prog_ids)} programs "
                          f"(missing-ref + completed-in-scan + boston-just-completed deps)")
                    fetch_reference_curricula(prog_ids, targeted_ids=targeted_ids)
                    scan_status['progress'] = 84
            except Exception as e:
                print(f"Reference fetch error: {e}")
                import traceback
                traceback.print_exc()

            # Fetch regulatory approved curricula (SharePoint workbooks).
            # C4: rate-limit to once per 24h. The 7 SharePoint workbooks
            # rarely change; downloading them on every scan was ~30-60s
            # of waste. The timestamp ticks only when at least one
            # workbook was successfully downloaded — a fetch where every
            # workbook was unavailable (SharePoint tab closed / session
            # expired) is treated as "didn't actually run" so the next
            # scan retries.
            scan_status['phase'] = 'Fetching regulatory data...'
            scan_status['progress'] = 86
            try:
                from scraper import fetch_regulatory_approved, REGULATORY_CAMPUS_FILES
                cwd = os.path.dirname(os.path.abspath(__file__))
                reg_stamp = os.path.join(cwd, 'data', 'last_regulatory_fetch')
                reg_due = True
                if os.path.exists(reg_stamp):
                    age_h = (time.time() - os.path.getmtime(reg_stamp)) / 3600.0
                    if age_h < 24:
                        reg_due = False
                        print(f"Regulatory fetch: skipping (last run {age_h:.1f}h ago, < 24h)")
                if prog_ids and reg_due:
                    matched, unmatched, skipped = fetch_regulatory_approved(prog_ids)
                    if skipped < len(REGULATORY_CAMPUS_FILES):
                        # At least one workbook came through — count this
                        # as a real run.
                        with open(reg_stamp, 'w') as f:
                            f.write(str(int(time.time())))
                    else:
                        print("Regulatory fetch: all workbooks unavailable; "
                              "not advancing timestamp (will retry next scan)")
            except Exception as e:
                # Regulatory fetch is best-effort — a missing SharePoint tab
                # or expired session must not block the rest of the scan.
                print(f"Regulatory fetch error: {e}")

            # Portfolio: re-download feeds from SharePoint/Smartsheet, then ingest.
            # Both steps are best-effort — failures must not block export or deployment.
            try:
                import subprocess, sys
                script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fetch_portfolio_data.py')
                subprocess.run([sys.executable, script], check=True, timeout=300)
                print("Portfolio feeds downloaded.")
            except Exception as e:
                print(f"Portfolio feed download error (non-fatal): {e}")
            try:
                from portfolio_ingest import ingest as portfolio_ingest
                portfolio_ingest()
                print("Portfolio ingest complete.")
            except Exception as e:
                print(f"Portfolio ingest error (non-fatal): {e}")

            # C1: Auto-export + git push only when DB content actually
            # changed since last successful export. The fingerprint hashes
            # the user-visible fields of all source tables (programs, courses,
            # workflows, references, regulatory, catalog_pages, portfolio_programs)
            # — not `fetched_at` etc. — so an idempotent re-fetch (same content,
            # new timestamp) doesn't false-trigger an export. Portfolio ingest
            # runs BEFORE this check so portfolio changes (e.g. a completed
            # inactivation being linked) also trigger re-export. On no-change
            # days this saves ~30-60s of CPU/IO + git push bandwidth.
            scan_status['phase'] = 'Exporting & deploying...'
            scan_status['progress'] = 90
            try:
                import subprocess
                from scraper import compute_db_fingerprint
                cwd = os.path.dirname(os.path.abspath(__file__))
                fp_path = os.path.join(cwd, 'data', 'last_export_fingerprint')
                current_fp = compute_db_fingerprint()
                prev_fp = ''
                if os.path.exists(fp_path):
                    try:
                        with open(fp_path) as f:
                            prev_fp = f.read().strip()
                    except Exception:
                        prev_fp = ''
                if current_fp == prev_fp:
                    print(f"Export: skipping (fingerprint unchanged: {current_fp[:12]}...)")
                    scan_status['progress'] = 100
                else:
                    subprocess.run(['python3', 'export_static.py'], cwd=cwd, timeout=300)
                    subprocess.run(['git', 'add', 'docs/'], cwd=cwd, timeout=30)
                    subprocess.run(['git', 'commit', '-m', f'Auto-update {datetime.now().strftime("%Y-%m-%d %H:%M")}'], cwd=cwd, timeout=30)
                    subprocess.run(['git', 'push'], cwd=cwd, timeout=180)
                    print(f"Exported and pushed (fingerprint {prev_fp[:12] or '(none)'}... → {current_fp[:12]}...)")
                    # Persist new fingerprint after successful export+push.
                    with open(fp_path, 'w') as f:
                        f.write(current_fp)
                    scan_status['progress'] = 100
            except Exception as e:
                print(f"Deploy error: {e}")

            # Record scan completion only now (after the whole pipeline:
            # programs + courses + reference + export + deploy). The
            # dashboard's "Updated" header reads from this row, so this
            # keeps it pinned to the previous scan's timestamp until the
            # current one is fully done.
            try:
                completion_time = datetime.now().isoformat()
                record_scan(
                    completion_time,
                    result.get('programs_scanned', 0) if result else 0,
                    result.get('programs_with_workflow', 0) if result else 0,
                    result.get('changes', 0) if result else 0,
                )
                log_entries = _load_scan_log()
                log_entries.append({
                    'started_at': started_at,
                    'completed_at': completion_time,
                    'programs_scanned': result.get('programs_scanned', 0) if result else 0,
                    'changes': result.get('changes', 0) if result else 0,
                    'error': None,
                })
                _save_scan_log(log_entries)
            except Exception as e:
                print(f"Failed to record scan completion: {e}")
        except Exception as e:
            scan_status['error'] = str(e)
            try:
                completion_time = datetime.now().isoformat()
                log_entries = _load_scan_log()
                log_entries.append({
                    'started_at': started_at,
                    'completed_at': completion_time,
                    'programs_scanned': 0,
                    'changes': 0,
                    'error': str(e),
                })
                _save_scan_log(log_entries)
            except Exception:
                pass
        finally:
            scan_status['running'] = False
            scan_status['phase'] = ''
            scan_status['progress'] = 0

    thread = threading.Thread(target=do_scan, daemon=True)
    thread.start()

    return jsonify({'status': 'scan_started'})


@app.route('/api/console')
def api_console():
    """Return scan history and portfolio mismatch data for the Console modal."""
    scan_log = _load_scan_log()
    mismatches = {}
    mismatch_report = {}
    try:
        with open(_MISMATCHES_PATH) as f:
            mismatches = _json.load(f)
    except Exception:
        pass
    _REPORT_PATH = os.path.join(_DATA_DIR, 'portfolio_mismatch_report.json')
    try:
        with open(_REPORT_PATH) as f:
            mismatch_report = _json.load(f)
    except Exception:
        pass
    return jsonify({'scan_log': scan_log, 'mismatches': mismatches, 'mismatch_report': mismatch_report})


@app.route('/api/colleges')
def api_colleges():
    """Get list of all colleges."""
    return jsonify({'colleges': get_colleges()})


@app.route('/api/approvers')
def api_approvers():
    """Get all current approvers with program counts."""
    return jsonify({'approvers': get_current_approvers()})


@app.route('/api/approver/<path:email>')
def api_approver_programs(email):
    """Get programs waiting on a specific approver."""
    programs = get_programs_by_approver(email)
    return jsonify({'programs': programs, 'email': email})


@app.route('/api/step/<path:step_name>')
def api_step_programs(step_name):
    """Get all programs at a specific workflow step."""
    programs = get_programs_by_step(step_name)
    return jsonify({'programs': programs, 'step': step_name})


# ===== COURSE API ENDPOINTS =====

@app.route('/api/courses')
def api_courses():
    """Get all courses with active workflows."""
    courses = get_all_courses()

    # Group by college
    grouped = {}
    for c in courses:
        college = c.get('college', 'Unknown')
        if college not in grouped:
            grouped[college] = []
        grouped[college].append(c)

    return jsonify({
        'courses': courses,
        'grouped': grouped,
        'total': len(courses)
    })


@app.route('/api/course/<path:course_id>/workflow')
def api_course_workflow(course_id):
    """Get workflow steps for a specific course."""
    steps = get_course_workflow(course_id)
    return jsonify({'steps': steps})


@app.route('/api/course_pipeline')
def api_course_pipeline():
    """Get course pipeline summary counts."""
    counts = get_course_pipeline_counts(COURSE_TRACKED_ROLES)
    pipeline = []
    for role in COURSE_TRACKED_ROLES:
        pipeline.append({
            'role': role,
            'short_name': COURSE_ROLE_SHORT_NAMES.get(role, role),
            'count': counts.get(role, 0)
        })
    return jsonify({'pipeline': pipeline})


@app.route('/api/course_changes')
def api_course_changes():
    """Get recent course changes."""
    changes = get_recent_course_changes(limit=100)
    return jsonify({'changes': changes})


# ---- Catalog pages (third entity type) ----

@app.route('/api/catalog')
def api_catalog():
    """Get all catalog pages currently in any UCAT/GCAT pending list."""
    from database import get_all_catalog_pages
    pages = get_all_catalog_pages()
    return jsonify({'catalog_pages': pages, 'total': len(pages)})


@app.route('/api/catalog_pipeline')
def api_catalog_pipeline():
    """Get catalog pipeline counts per UCAT/GCAT role."""
    from database import get_catalog_pipeline_counts
    from scraper import CATALOG_TRACKED_ROLES, CATALOG_ROLE_SHORT_NAMES
    counts = get_catalog_pipeline_counts(CATALOG_TRACKED_ROLES)
    pipeline = [{
        'role': role,
        'short_name': CATALOG_ROLE_SHORT_NAMES.get(role, role),
        'count': counts.get(role, 0),
    } for role in CATALOG_TRACKED_ROLES]
    return jsonify({'pipeline': pipeline})


@app.route('/api/course_colleges')
def api_course_colleges():
    """Get list of all colleges with courses."""
    return jsonify({'colleges': get_course_colleges()})


@app.route('/api/course_approvers')
def api_course_approvers():
    """Get all current course approvers with course counts."""
    return jsonify({'approvers': get_course_current_approvers()})


@app.route('/api/course_approver/<path:email>')
def api_course_approver_courses(email):
    """Get courses waiting on a specific approver."""
    courses = get_courses_by_approver(email)
    return jsonify({'courses': courses, 'email': email})


@app.route('/api/course/<path:step_name>')
def api_step_courses(step_name):
    """Get all courses at a specific workflow step."""
    courses = get_courses_by_step(step_name)
    return jsonify({'courses': courses, 'step': step_name})


@app.route('/api/portfolio')
def api_portfolio():
    from database import get_all_portfolio_programs
    return jsonify({'programs': get_all_portfolio_programs()})


@app.route('/api/portfolio/refresh', methods=['POST'])
def api_portfolio_refresh():
    """Re-download data via Chrome and re-ingest into the portfolio tables."""
    import subprocess, sys
    try:
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fetch_portfolio_data.py')
        subprocess.run([sys.executable, script], check=True, timeout=300)
    except Exception as e:
        return jsonify({'error': f'fetch failed: {e}'}), 500
    try:
        from portfolio_ingest import ingest
        count = ingest()
        return jsonify({'ok': True, 'programs': count})
    except Exception as e:
        return jsonify({'error': f'ingest failed: {e}'}), 500


@app.route('/api/portfolio/note/<path:program_id>', methods=['POST'])
def api_portfolio_note(program_id):
    from database import upsert_portfolio_note
    data = request.get_json(force=True)
    note = data.get('note', '')
    upsert_portfolio_note(program_id, note)
    return jsonify({'ok': True})


if __name__ == '__main__':
    init_db()
    migrate_db()
    # Scans are driven externally by launchd/update.sh, not on a Flask timer.
    port = int(os.environ.get('CIM_PORT', 5001))
    app.run(debug=True, port=port, use_reloader=False)
