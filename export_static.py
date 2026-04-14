"""Export current data to a static site that can be hosted on GitHub Pages."""

import json
import os
import re
import shutil
import subprocess
from datetime import datetime
from database import (
    get_all_programs, get_program_workflow, get_pipeline_counts,
    get_recent_changes, get_last_scan, get_colleges,
    get_current_approvers, get_all_curriculum, get_all_reference_curriculum
)
from scraper import TRACKED_ROLES, ROLE_SHORT_NAMES

STATICRYPT_PASSWORD = 'husky26'
BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _parse_campus(name):
    """Extract campus from 'Program, Degree (Campus)'. Returns (base, campus) or (name, None)."""
    m = re.search(r'\(([^)]+)\)\s*$', name)
    if m:
        return name[:m.start()].strip(), m.group(1).strip()
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

    # Export campus relationship data
    boston_to_deployments, deployment_to_boston = build_campus_groups(data['programs'])
    campus_groups = {
        'boston_to_deployments': {str(k): v for k, v in boston_to_deployments.items()},
        'deployment_to_boston': {str(k): v for k, v in deployment_to_boston.items()},
    }
    with open(os.path.join(EXPORT_DIR, 'campus_groups.json'), 'w') as f:
        json.dump(campus_groups, f)

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

    import time
    cache_bust = int(time.time())
    html = html.replace('href="/static/style.css"', f'href="style.css?v={cache_bust}"')
    html = html.replace('src="/static/app.js"', f'src="app.js?v={cache_bust}"')
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

    # Build self-contained HTML with everything inlined
    # (CSS, JS, and all JSON data embedded as script variables)
    css_path = os.path.join(EXPORT_DIR, 'style.css')
    with open(css_path, 'r') as f:
        css_content = f.read()

    data_json = json.dumps(data)
    curriculum_json = json.dumps(curriculum)
    reference_json = json.dumps(reference)
    campus_json = json.dumps(campus_groups)

    # Replace external CSS/JS references with inline content
    # Remove cache-bust references since everything is inlined
    # Use lambda replacements to avoid re.sub interpreting backslashes in JS/CSS
    html = re.sub(
        r'<link[^>]*href="style\.css[^"]*"[^>]*/?>',
        lambda m: f'<style>{css_content}</style>',
        html
    )
    html = re.sub(
        r'<script[^>]*src="app\.js[^"]*"[^>]*></script>',
        lambda m: f'<script>\n{static_js}\n</script>',
        html
    )

    # Embed JSON data as script variables so no fetch() calls are needed
    # Insert before closing </body> tag
    embedded_data = f'''<script>
// Embedded data — no external JSON files needed
window.__EMBEDDED_DATA__ = {data_json};
window.__EMBEDDED_CURRICULUM__ = {curriculum_json};
window.__EMBEDDED_REFERENCE__ = {reference_json};
window.__EMBEDDED_CAMPUS_GROUPS__ = {campus_json};
</script>'''
    html = html.replace('</body>', f'{embedded_data}\n</body>')

    # Write the self-contained HTML
    inline_path = os.path.join(EXPORT_DIR, 'index.html')
    with open(inline_path, 'w') as f:
        f.write(html)

    # Encrypt with StatiCrypt
    print("Encrypting with StatiCrypt...")
    result = subprocess.run(
        ['npx', 'staticrypt', inline_path,
         '-p', STATICRYPT_PASSWORD,
         '-d', EXPORT_DIR,
         '--remember', '30',
         '--config', 'false',
         '--short',
         '--template-title', 'Program Approval Tracker',
         '--template-instructions', 'Enter the password to access the dashboard.'],
        capture_output=True, text=True, cwd=BASE_DIR
    )
    if result.returncode != 0:
        print(f"StatiCrypt error: {result.stderr}")
        raise RuntimeError("StatiCrypt encryption failed")
    print("Encryption complete.")

    # Clean up separate asset files (everything is inlined + encrypted)
    for f in ['style.css', 'app.js', 'data.json', 'curriculum.json',
              'reference.json', 'campus_groups.json']:
        path = os.path.join(EXPORT_DIR, f)
        if os.path.exists(path):
            os.remove(path)

    print(f"\nStatic site ready in: {EXPORT_DIR}/")
    print("Password-protected with StatiCrypt (password saved in export_static.py)")
    print("Remember-me cookie lasts 30 days.")


def build_static_js(original_js):
    """Build static version of app.js that reads from data.json."""
    # We'll override just the data-loading functions at the top.
    # The original rendering, filter, and UI code stays intact.

    override = r'''/* ======= STATIC SITE DATA LAYER ======= */
/* Overrides API calls to use embedded data (inlined by export_static.py) */
let _cache = null;
let _curriculumCache = null;
async function _getData() {
    if (!_cache) {
        _cache = window.__EMBEDDED_DATA__ || (await (await fetch('data.json')).json());
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
            const header = ref.version_date
                ? '<div class="reference-header">Comparing against: ' + escapeHtml(ref.version_date) + '</div>' : '';
            if (identical) {
                contentEl.innerHTML = header + '<div class="compare-identical">Curriculum is identical to the Boston reference.</div>';
            } else {
                const table = renderSideBySide(diff, getProgramName(programId), 'Boston Reference');
                contentEl.innerHTML = header +
                    '<div class="compare-legend"><span class="compare-legend-item"><span class="legend-box diff-removed-bg"></span> Only in this version</span>' +
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
                    html += '<div class="compare-legend"><span class="compare-legend-item"><span class="legend-box diff-removed-bg"></span> Only in ' + escapeHtml(dep.name) + '</span>' +
                        '<span class="compare-legend-item"><span class="legend-box diff-added-bg"></span> Only in Boston</span>' +
                        '<span class="compare-legend-item"><span class="legend-box diff-moved-bg"></span> Moved between sections</span></div>';
                    html += renderSideBySide(dep.diff, dep.name, 'Boston');
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
                const table = renderSideBySide(diff, 'Current Proposal', 'Last Approved');
                contentEl.innerHTML = '<div class="compare-legend"><span class="compare-legend-item"><span class="legend-box diff-removed-bg"></span> Only in proposal</span>' +
                    '<span class="compare-legend-item"><span class="legend-box diff-added-bg"></span> Only in approved</span>' +
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
