"""Export current data to a static site that can be hosted on GitHub Pages."""

import json
import os
import shutil
from datetime import datetime
from database import (
    get_all_programs, get_program_workflow, get_pipeline_counts,
    get_recent_changes, get_last_scan, get_colleges,
    get_current_approvers, get_all_curriculum, get_all_reference_curriculum
)
from scraper import TRACKED_ROLES, ROLE_SHORT_NAMES

EXPORT_DIR = os.path.join(os.path.dirname(__file__), 'docs')


def export_data():
    """Export all dashboard data to a single JSON file."""
    programs = get_all_programs()
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

    return {
        'exported_at': datetime.now().isoformat(),
        'programs': programs,
        'pipeline': pipeline,
        'changes': changes,
        'last_scan': last_scan,
        'colleges': colleges,
        'approvers': approvers,
        'workflows': workflows,
    }


def build_static_site():
    """Build a complete static site in the docs/ directory."""
    os.makedirs(EXPORT_DIR, exist_ok=True)

    # Export data
    data = export_data()
    with open(os.path.join(EXPORT_DIR, 'data.json'), 'w') as f:
        json.dump(data, f)

    # Export curriculum data separately (can be large)
    curriculum = get_all_curriculum()
    with open(os.path.join(EXPORT_DIR, 'curriculum.json'), 'w') as f:
        json.dump(curriculum, f)

    # Export reference curriculum data
    reference = get_all_reference_curriculum()
    with open(os.path.join(EXPORT_DIR, 'reference.json'), 'w') as f:
        json.dump(reference, f)

    print(f"Exported: {len(data['programs'])} programs, {len(data['workflows'])} workflows, {len(curriculum)} curricula, {len(reference)} references")

    # Copy CSS
    shutil.copy2(
        os.path.join(os.path.dirname(__file__), 'static', 'style.css'),
        os.path.join(EXPORT_DIR, 'style.css')
    )

    # Generate index.html
    tmpl_path = os.path.join(os.path.dirname(__file__), 'templates', 'dashboard.html')
    with open(tmpl_path, 'r') as f:
        html = f.read()

    html = html.replace('href="/static/style.css"', 'href="style.css"')
    html = html.replace('src="/static/app.js"', 'src="app.js"')
    html = html.replace(
        '<button id="scan-btn" onclick="triggerScan()">Scan Now</button>',
        ''
    )

    with open(os.path.join(EXPORT_DIR, 'index.html'), 'w') as f:
        f.write(html)

    # Generate static app.js
    # Read original and keep all the rendering/filter/UI logic,
    # but replace data loading to use data.json
    src_js_path = os.path.join(os.path.dirname(__file__), 'static', 'app.js')
    with open(src_js_path, 'r') as f:
        original_js = f.read()

    # Find the section between "Data Loading" and "Rendering" and replace it
    # Simpler: just prepend a data loader and override the load functions
    static_js = build_static_js(original_js)
    with open(os.path.join(EXPORT_DIR, 'app.js'), 'w') as f:
        f.write(static_js)

    print(f"\nStatic site ready in: {EXPORT_DIR}/")
    print("To deploy to GitHub Pages:")
    print("  1. cd to project root")
    print("  2. git init && git add docs/")
    print("  3. git commit -m 'Deploy dashboard'")
    print("  4. Push to GitHub and enable Pages from docs/ folder")


def build_static_js(original_js):
    """Build static version of app.js that reads from data.json."""
    # We'll override just the data-loading functions at the top.
    # The original rendering, filter, and UI code stays intact.

    override = r'''/* ======= STATIC SITE DATA LAYER ======= */
/* Overrides API calls to read from data.json and curriculum.json */
let _cache = null;
let _curriculumCache = null;
async function _getData() {
    if (!_cache) {
        const r = await fetch('data.json');
        _cache = await r.json();
    }
    return _cache;
}

// Override all load* functions AFTER the original script defines them
document.addEventListener('DOMContentLoaded', () => {
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

    // Patch workflow detail loading
    window._origLoadWorkflowDetail = loadWorkflowDetail;
    window.loadWorkflowDetail = async function(programId) {
        const D = await _getData();
        const steps = D.workflows[String(programId)] || [];
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

        contentEl.innerHTML = `
            <div class="workflow-steps">${stepsHtml}</div>
            ${metaHtml}
        `;
    };

    // Patch approver filter to use static data
    const _origApplyFilters = applyFilters;
    window.applyFilters = async function() {
        const approverFilter = document.getElementById('filter-approver').value;
        if (approverFilter) {
            const D = await _getData();
            const ids = new Set();
            D.programs.forEach(p => {
                const wf = D.workflows[String(p.id)] || [];
                if (wf.some(s => s.step_status === 'current' && s.approver_emails && s.approver_emails.includes(approverFilter))) {
                    ids.add(p.id);
                }
            });
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
                const r = await fetch('curriculum.json');
                _curriculumCache = await r.json();
            } catch(e) {
                contentEl.innerHTML = '<div class="workflow-meta">Failed to load curriculum data.</div>';
                return;
            }
        }
        const html = _curriculumCache[String(programId)] || '';
        if (html) {
            contentEl.innerHTML = `<div class="curriculum-content">${html}</div>`;
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
                const r = await fetch('reference.json');
                _referenceCache = await r.json();
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
});
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
