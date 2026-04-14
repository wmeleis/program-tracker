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
    get_reference_curriculum
)
from scraper import TRACKED_ROLES, ROLE_SHORT_NAMES, run_full_scan, fetch_reference_curricula
from export_static import build_campus_groups

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})

# Scan state
scan_lock = threading.Lock()
scan_status = {
    'running': False,
    'last_result': None,
    'error': None,
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
        'last_scan': last_scan
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
            result = run_full_scan()
            scan_status['last_result'] = result
            # Fetch reference curricula for all programs in the pipeline
            try:
                programs = get_all_programs()
                prog_ids = [p['id'] for p in programs]
                if prog_ids:
                    fetch_reference_curricula(prog_ids)
            except Exception as e:
                print(f"Reference fetch error: {e}")
            # Auto-export and deploy to GitHub Pages
            try:
                import subprocess
                subprocess.run(['python3', 'export_static.py'], cwd=os.path.dirname(os.path.abspath(__file__)))
                subprocess.run(['git', 'add', 'docs/'], cwd=os.path.dirname(os.path.abspath(__file__)))
                subprocess.run(['git', 'commit', '-m', f'Auto-update {datetime.now().strftime("%Y-%m-%d %H:%M")}'],
                              cwd=os.path.dirname(os.path.abspath(__file__)))
                subprocess.run(['git', 'push'], cwd=os.path.dirname(os.path.abspath(__file__)))
                print("Exported and pushed to GitHub Pages")
            except Exception as e:
                print(f"Deploy error: {e}")
        except Exception as e:
            scan_status['error'] = str(e)
        finally:
            scan_status['running'] = False

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


if __name__ == '__main__':
    init_db()
    migrate_db()

    # Start background scanner
    scanner_thread = threading.Thread(target=background_scanner, daemon=True)
    scanner_thread.start()
    print(f"Background scanner started (every {SCAN_INTERVAL_MINUTES} minutes)")

    app.run(debug=True, port=5001, use_reloader=False)
