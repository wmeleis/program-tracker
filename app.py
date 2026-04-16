"""Flask server for Program Approval Status Tracker."""

import os
import threading
import time
from datetime import datetime
from flask import Flask, render_template, jsonify
from flask_cors import CORS

from database import (
    init_db, migrate_db, get_all_programs, get_program_workflow,
    get_pipeline_counts, get_recent_changes, get_last_scan,
    get_programs_by_step, get_colleges, get_current_approvers,
    get_programs_by_approver, get_program_curriculum,
    get_reference_curriculum, get_all_courses, get_course_workflow,
    get_course_pipeline_counts, get_recent_course_changes, get_last_course_scan,
    get_courses_by_step, get_course_colleges
)
from scraper import TRACKED_ROLES, ROLE_SHORT_NAMES, COURSE_TRACKED_ROLES, COURSE_ROLE_SHORT_NAMES, run_full_scan, fetch_reference_curricula, run_course_scan
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

SCAN_INTERVAL_MINUTES = 30


def background_scanner():
    """Background thread that runs scans periodically."""
    while True:
        time.sleep(SCAN_INTERVAL_MINUTES * 60)
        if not scan_status['running']:
            try:
                scan_status['running'] = True
                scan_status['error'] = None
                result = run_full_scan()
                scan_status['last_result'] = result
            except Exception as e:
                scan_status['error'] = str(e)
                import traceback
                print(f"Scan error: {e}")
                traceback.print_exc()
            finally:
                scan_status['running'] = False


@app.route('/')
def dashboard():
    """Serve the main dashboard."""
    return render_template('dashboard.html')


@app.route('/api/programs')
def api_programs():
    """Get all programs with active workflows."""
    programs = get_all_programs()

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
    return jsonify({'curriculum_html': html})


@app.route('/api/program/<int:program_id>/reference')
def api_program_reference(program_id):
    """Get reference (previously approved) curriculum for a program."""
    ref = get_reference_curriculum(program_id)
    if ref:
        return jsonify(ref)
    return jsonify({'error': 'No reference curriculum found'}), 404


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


@app.route('/api/scan/status')
def api_scan_status():
    """Get current scan status."""
    last_scan = get_last_scan()
    return jsonify({
        'running': scan_status['running'],
        'error': scan_status['error'],
        'last_scan': last_scan,
        'phase': scan_status.get('phase', ''),
        'progress': scan_status.get('progress', 0)
    })


@app.route('/api/scan/trigger', methods=['POST'])
def api_scan_trigger():
    """Trigger a manual scan."""
    if scan_status['running']:
        return jsonify({'error': 'Scan already in progress'}), 409

    def do_scan():
        try:
            scan_status['running'] = True
            scan_status['error'] = None
            scan_status['phase'] = 'Discovering programs (discovering roles)...'
            scan_status['progress'] = 5

            # Scan programs
            print("\n>>> STARTING RUN_FULL_SCAN", flush=True)
            result = run_full_scan()
            print(f">>> RUN_FULL_SCAN COMPLETE, result: {result}", flush=True)
            scan_status['last_result'] = result
            scan_status['phase'] = 'Processing programs...'
            scan_status['progress'] = 40
            print(">>> PHASE SET TO: Processing programs...", flush=True)

            # Scan courses
            print("\n>>> About to start course scanning...", flush=True)
            scan_status['phase'] = 'Discovering courses...'
            scan_status['progress'] = 50
            print(">>> Phase/progress updated for courses", flush=True)
            try:
                print(">>> Calling run_course_scan()...", flush=True)
                course_result = run_course_scan()
                print(f">>> Course scan result: {course_result}", flush=True)
                scan_status['phase'] = 'Processing courses...'
                scan_status['progress'] = 65
            except Exception as e:
                print(f">>> Course scan error: {e}", flush=True)
                import traceback
                traceback.print_exc()

            # Fetch reference curricula for all programs in the pipeline
            scan_status['phase'] = 'Fetching reference data...'
            scan_status['progress'] = 75
            try:
                programs = get_all_programs()
                prog_ids = [p['id'] for p in programs]
                if prog_ids:
                    fetch_reference_curricula(prog_ids)
                    scan_status['progress'] = 85
            except Exception as e:
                print(f"Reference fetch error: {e}")

            # Auto-export and deploy to GitHub Pages
            scan_status['phase'] = 'Exporting & deploying...'
            scan_status['progress'] = 90
            try:
                import subprocess
                subprocess.run(['python3', 'export_static.py'], cwd=os.path.dirname(os.path.abspath(__file__)))
                subprocess.run(['git', 'add', 'docs/'], cwd=os.path.dirname(os.path.abspath(__file__)))
                subprocess.run(['git', 'commit', '-m', f'Auto-update {datetime.now().strftime("%Y-%m-%d %H:%M")}'],
                              cwd=os.path.dirname(os.path.abspath(__file__)))
                subprocess.run(['git', 'push'], cwd=os.path.dirname(os.path.abspath(__file__)))
                print("Exported and pushed to GitHub Pages")
                scan_status['progress'] = 100
            except Exception as e:
                print(f"Deploy error: {e}")
        except Exception as e:
            scan_status['error'] = str(e)
        finally:
            scan_status['running'] = False
            scan_status['phase'] = ''
            scan_status['progress'] = 0

    thread = threading.Thread(target=do_scan, daemon=True)
    thread.start()

    return jsonify({'status': 'scan_started'})


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


@app.route('/api/course_colleges')
def api_course_colleges():
    """Get list of all colleges with courses."""
    return jsonify({'colleges': get_course_colleges()})


@app.route('/api/course/<path:step_name>')
def api_step_courses(step_name):
    """Get all courses at a specific workflow step."""
    courses = get_courses_by_step(step_name)
    return jsonify({'courses': courses, 'step': step_name})


if __name__ == '__main__':
    init_db()
    migrate_db()

    # Start background scanner
    scanner_thread = threading.Thread(target=background_scanner, daemon=True)
    scanner_thread.start()
    print(f"Background scanner started (every {SCAN_INTERVAL_MINUTES} minutes)")

    app.run(debug=True, port=5001, use_reloader=False)
