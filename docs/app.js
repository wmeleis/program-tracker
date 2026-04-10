/* Program Approval Tracker - Frontend Logic */

let allPrograms = [];
let expandedRows = new Set();
let currentSort = { column: 'name', direction: 'asc' };
let pipelineFilter = null;
let smartView = 'all';
let typeFilter = '';
let proposalFilter = '';
let approverPrograms = null;
const STUCK_THRESHOLD_DAYS = 30;

// ==================== Data Loading ====================

async function loadDashboard() {
    await Promise.all([
        loadPipeline(),
        loadPrograms(),
        loadChanges(),
        loadScanStatus(),
        loadColleges(),
        loadApprovers()
    ]);
    updateSmartViewCounts();
    updateTypeCounts();
    updateProposalCounts();
}

async function loadPipeline() {
    try {
        const res = await fetch('/api/pipeline');
        const data = await res.json();
        renderPipeline(data.pipeline);
    } catch (e) {
        console.error('Failed to load pipeline:', e);
    }
}

async function loadPrograms() {
    try {
        const res = await fetch('/api/programs');
        const data = await res.json();
        allPrograms = data.programs || [];
        groupedPrograms = data.grouped || {};
        populateStepFilter();
        applyFilters();
    } catch (e) {
        console.error('Failed to load programs:', e);
    }
}

async function loadChanges() {
    try {
        const res = await fetch('/api/changes');
        const data = await res.json();
        renderChanges(data.changes || []);
    } catch (e) {
        console.error('Failed to load changes:', e);
    }
}

async function loadApprovers() {
    try {
        const res = await fetch('/api/approvers');
        const data = await res.json();
        const select = document.getElementById('filter-approver');
        const options = (data.approvers || []).map(a =>
            `<option value="${a.email}">${a.display} (${a.count})</option>`
        ).join('');
        select.innerHTML = '<option value="">All Approvers</option>' + options;
    } catch (e) {
        console.error('Failed to load approvers:', e);
    }
}

function setTypeFilter(type) {
    typeFilter = type;
    document.querySelectorAll('.type-btn').forEach(btn => {
        const btnType = btn.getAttribute('onclick').match(/'([^']*)'/)[1];
        btn.classList.toggle('active', btnType === type);
    });
    applyFilters();
}

function setProposalFilter(status) {
    proposalFilter = status;
    document.querySelectorAll('.proposal-btn').forEach(btn => {
        const btnStatus = btn.getAttribute('onclick').match(/'([^']*)'/)[1];
        // Remove all active states
        btn.classList.remove('active-all', 'active-new', 'active-edit', 'active-inact');
        if (btnStatus === status) {
            if (status === '') btn.classList.add('active-all');
            else if (status === 'Added') btn.classList.add('active-new');
            else if (status === 'Edited') btn.classList.add('active-edit');
            else if (status === 'Deactivated') btn.classList.add('active-inact');
        }
    });
    applyFilters();
}

function updateProposalCounts() {
    const counts = { '': allPrograms.length, 'Added': 0, 'Edited': 0, 'Deactivated': 0 };
    allPrograms.forEach(p => {
        const s = p.status || '';
        if (counts[s] !== undefined) counts[s]++;
    });
    document.querySelectorAll('.proposal-btn').forEach(btn => {
        const s = btn.getAttribute('onclick').match(/'([^']*)'/)[1];
        const count = counts[s] || 0;
        const labels = { '': 'All', 'Added': 'New Programs', 'Edited': 'Changes', 'Deactivated': 'Inactivations' };
        btn.textContent = `${labels[s]} (${count})`;
    });
}

function updateTypeCounts() {
    const counts = { '': allPrograms.length };
    allPrograms.forEach(p => {
        const t = p.program_type || 'Other';
        counts[t] = (counts[t] || 0) + 1;
    });
    document.querySelectorAll('.type-btn').forEach(btn => {
        const t = btn.getAttribute('onclick').match(/'([^']*)'/)[1];
        const count = counts[t] || 0;
        const label = t || 'All';
        btn.textContent = `${label} (${count})`;
    });
}

async function loadColleges() {
    try {
        const res = await fetch('/api/colleges');
        const data = await res.json();
        const select = document.getElementById('filter-college');
        const options = (data.colleges || []).map(c => `<option value="${c}">${c}</option>`).join('');
        select.innerHTML = '<option value="">All Colleges</option>' + options;
    } catch (e) {
        console.error('Failed to load colleges:', e);
    }
}

function updateSmartViewCounts() {
    const now = new Date();
    const recentCount = allPrograms.filter(p => {
        const updated = new Date(p.last_updated);
        return (now - updated) < 7 * 86400000; // 7 days
    }).length;
    const stuckCount = allPrograms.filter(p => getDaysAtStep(p) >= STUCK_THRESHOLD_DAYS).length;
    const newCount = allPrograms.filter(p => {
        const submitted = p.date_submitted ? new Date(p.date_submitted) : null;
        return submitted && (now - submitted) < 30 * 86400000;
    }).length;

    document.querySelectorAll('.smart-view-btn').forEach(btn => {
        const view = btn.getAttribute('onclick').match(/'(\w+)'/)[1];
        if (view === 'recent') btn.innerHTML = `Recently Moved <span class="view-count">${recentCount}</span>`;
        else if (view === 'stuck') btn.innerHTML = `Potentially Stuck <span class="view-count">${stuckCount}</span>`;
        else if (view === 'new') btn.innerHTML = `New This Month <span class="view-count">${newCount}</span>`;
    });
}

function getDaysAtStep(program) {
    const stepDate = program.step_entered_date || program.first_seen;
    if (!stepDate) return 0;
    const d = new Date(stepDate);
    if (isNaN(d)) return 0;
    return Math.floor((new Date() - d) / 86400000);
}

function setSmartView(view) {
    smartView = view;
    document.querySelectorAll('.smart-view-btn').forEach(btn => {
        const btnView = btn.getAttribute('onclick').match(/'(\w+)'/)[1];
        btn.classList.toggle('active', btnView === view);
    });
    applyFilters();
}

async function loadScanStatus() {
    try {
        const res = await fetch('/api/scan/status');
        const data = await res.json();
        const el = document.getElementById('scan-status');
        if (data.running) {
            el.innerHTML = '<span class="spinner"></span> Scanning...';
            el.className = 'scan-status running';
            document.getElementById('scan-btn').disabled = true;
        } else if (data.last_scan) {
            const time = formatTime(data.last_scan.scan_time);
            el.textContent = `Last scan: ${time} (${data.last_scan.programs_with_workflow} programs, ${data.last_scan.changes_detected} changes)`;
            el.className = 'scan-status';
            document.getElementById('scan-btn').disabled = false;
        } else {
            el.textContent = 'No scans yet';
            el.className = 'scan-status';
            document.getElementById('scan-btn').disabled = false;
        }
    } catch (e) {
        console.error('Failed to load scan status:', e);
    }
}

// ==================== Rendering ====================

function renderPipeline(pipeline) {
    const bar = document.getElementById('pipeline-bar');
    bar.innerHTML = pipeline.map(step => {
        const hasItems = step.count > 0;
        const activeClass = pipelineFilter === step.role ? ' active' : '';
        return `
            <div class="pipeline-step ${hasItems ? 'has-items' : 'empty'}${activeClass}"
                 onclick="togglePipelineFilter('${step.role}')"
                 title="${step.role}: ${step.count} programs">
                <span class="step-count">${step.count}</span>
                <span class="step-name">${step.short_name}</span>
            </div>
        `;
    }).join('');
}

function populateStepFilter() {
    const select = document.getElementById('filter-step');
    const steps = new Set();
    allPrograms.forEach(p => {
        if (p.current_step) steps.add(p.current_step);
    });
    const sorted = Array.from(steps).sort();
    const options = sorted.map(s => `<option value="${s}">${s}</option>`).join('');
    select.innerHTML = '<option value="">All Steps</option>' + options;
}

async function applyFilters() {
    const stepFilter = document.getElementById('filter-step').value;
    const collegeFilter = document.getElementById('filter-college').value;
    const approverFilter = document.getElementById('filter-approver').value;
    const search = document.getElementById('filter-search').value.toLowerCase();
    const now = new Date();

    // If approver filter is active, fetch programs from API (or use static cache)
    let approverProgramIds = window._staticApproverIds || null;
    if (approverFilter && !approverProgramIds) {
        try {
            const res = await fetch(`/api/approver/${encodeURIComponent(approverFilter)}`);
            const data = await res.json();
            approverProgramIds = new Set((data.programs || []).map(p => p.id));
        } catch (e) {
            console.error('Failed to load approver programs:', e);
        }
    }

    let filtered = allPrograms.filter(p => {
        // Smart view filters
        if (smartView === 'recent') {
            const updated = new Date(p.last_updated);
            if ((now - updated) >= 7 * 86400000) return false;
        } else if (smartView === 'stuck') {
            if (getDaysAtStep(p) < STUCK_THRESHOLD_DAYS) return false;
        } else if (smartView === 'new') {
            const submitted = p.date_submitted ? new Date(p.date_submitted) : null;
            if (!submitted || (now - submitted) >= 30 * 86400000) return false;
        }

        // Type and proposal filters (from top buttons)
        if (typeFilter && p.program_type !== typeFilter) return false;
        if (proposalFilter && p.status !== proposalFilter) return false;

        // Regular filters
        if (pipelineFilter && p.current_step !== pipelineFilter) return false;
        if (stepFilter && p.current_step !== stepFilter) return false;
        if (collegeFilter && p.college !== collegeFilter) return false;
        if (approverProgramIds && !approverProgramIds.has(p.id)) return false;
        if (search && !p.name.toLowerCase().includes(search) &&
            !(p.banner_code && p.banner_code.toLowerCase().includes(search))) return false;
        return true;
    });

    // Sort
    filtered.sort((a, b) => {
        let va = a[currentSort.column] || '';
        let vb = b[currentSort.column] || '';
        if (currentSort.column === 'progress') {
            va = a.total_steps ? a.completed_steps / a.total_steps : 0;
            vb = b.total_steps ? b.completed_steps / b.total_steps : 0;
        } else if (currentSort.column === 'days') {
            va = getDaysAtStep(a);
            vb = getDaysAtStep(b);
        }
        if (typeof va === 'string') {
            va = va.toLowerCase();
            vb = vb.toLowerCase();
        }
        if (va < vb) return currentSort.direction === 'asc' ? -1 : 1;
        if (va > vb) return currentSort.direction === 'asc' ? 1 : -1;
        return 0;
    });

    document.getElementById('result-count').textContent = `${filtered.length} programs`;
    renderProgramTable(filtered);
}

function renderProgramTable(programs) {
    const container = document.getElementById('programs-table-container');

    if (!programs || programs.length === 0) {
        container.innerHTML = '<p class="empty-state">No programs match your filters. Try adjusting your selections.</p>';
        expandedRows.forEach(id => loadWorkflowDetail(id));
        return;
    }

    let html = `
        <div class="table-legend">
            <span class="legend-item"><span class="legend-swatch new"></span> New program</span>
            <span class="legend-item"><span class="legend-swatch change"></span> Program change</span>
            <span class="legend-item"><span class="legend-swatch inactivation"></span> Inactivation</span>
        </div>
        <table class="program-table">
            <thead>
                <tr>
                    <th onclick="sortBy('name')">
                        Program Name ${sortIcon('name')}
                    </th>
                    <th onclick="sortBy('college')" style="width: 70px">
                        College ${sortIcon('college')}
                    </th>
                    <th onclick="sortBy('current_step')">
                        Current Step ${sortIcon('current_step')}
                    </th>
                    <th onclick="sortBy('progress')" style="width: 120px">
                        Progress ${sortIcon('progress')}
                    </th>
                    <th onclick="sortBy('days')" style="width: 80px">
                        Days ${sortIcon('days')}
                    </th>
                </tr>
            </thead>
            <tbody>
    `;

    for (const p of programs) {
        const expanded = expandedRows.has(p.id);
        const progress = p.total_steps > 0 ? (p.completed_steps / p.total_steps * 100) : 0;
        const progressClass = progress < 33 ? 'early' : progress < 66 ? 'mid' : 'late';
        const rowClass = p.status === 'Added' ? 'row-added' : p.status === 'Edited' ? 'row-edited' : p.status === 'Deactivated' ? 'row-deactivated' : 'row-edited';
        const days = getDaysAtStep(p);
        const daysClass = days < 14 ? 'fresh' : days < STUCK_THRESHOLD_DAYS ? 'aging' : 'stuck';
        const collegeShort = abbreviateCollege(p.college);

        html += `
            <tr class="program-row ${rowClass} ${expanded ? 'expanded' : ''}"
                onclick="toggleRow(${p.id})">
                <td><strong>${escapeHtml(p.name)}</strong></td>
                <td title="${escapeHtml(p.college || '')}">${escapeHtml(collegeShort)}</td>
                <td>${escapeHtml(p.current_step || '—')}</td>
                <td>
                    <div class="progress-container">
                        <div class="progress-bar">
                            <div class="progress-fill ${progressClass}"
                                 style="width: ${progress}%"></div>
                        </div>
                        <span class="progress-text">${p.completed_steps}/${p.total_steps}</span>
                    </div>
                </td>
                <td><span class="days-at-step ${daysClass}" title="Days at current step">${days}d</span></td>
            </tr>
        `;

        if (expanded) {
            html += `
                <tr class="workflow-detail" id="detail-${p.id}">
                    <td colspan="5">
                        <div class="workflow-loading">Loading workflow...</div>
                    </td>
                </tr>
            `;
        }
    }

    html += '</tbody></table>';
    container.innerHTML = html;

    // Load workflow details for expanded rows
    expandedRows.forEach(id => loadWorkflowDetail(id));
}

async function loadWorkflowDetail(programId) {
    const detailRow = document.getElementById(`detail-${programId}`);
    if (!detailRow) return;

    try {
        const res = await fetch(`/api/program/${programId}/workflow`);
        const data = await res.json();
        const steps = data.steps || [];

        if (steps.length === 0) {
            detailRow.querySelector('td').innerHTML = '<div class="workflow-meta">No workflow data available. Run a full scan to collect workflow details.</div>';
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

        detailRow.querySelector('td').innerHTML = `
            <div class="workflow-steps">${stepsHtml}</div>
            ${metaHtml}
        `;
    } catch (e) {
        detailRow.querySelector('td').innerHTML = '<div class="workflow-meta">Failed to load workflow details.</div>';
    }
}

function renderChanges(changes) {
    const container = document.getElementById('changes-list');
    if (changes.length === 0) {
        container.innerHTML = '<p class="empty-state">No changes recorded yet. Run a scan to start tracking.</p>';
        return;
    }

    container.innerHTML = changes.slice(0, 50).map(c => {
        const icon = c.change_type === 'new_program' ? 'new-program' : 'step-change';
        const iconText = c.change_type === 'new_program' ? '+' : '&#8594;';
        const name = escapeHtml(c.program_name || `Program #${c.program_id}`);
        const time = formatTime(c.scan_time);

        let detail;
        if (c.change_type === 'new_program') {
            detail = `<strong>${name}</strong> entered pipeline at <em>${escapeHtml(c.new_step)}</em>`;
        } else {
            detail = `<strong>${name}</strong>: ${escapeHtml(c.previous_step)} <span class="change-arrow">&#8594;</span> ${escapeHtml(c.new_step)}`;
        }

        return `
            <div class="change-item">
                <div class="change-icon ${icon}">${iconText}</div>
                <div>${detail}</div>
                <div class="change-time">${time}</div>
            </div>
        `;
    }).join('');
}

// ==================== Interactions ====================

function toggleRow(programId) {
    if (expandedRows.has(programId)) {
        expandedRows.delete(programId);
    } else {
        expandedRows.add(programId);
    }
    applyFilters();
}

function sortBy(column) {
    if (currentSort.column === column) {
        currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
        currentSort.column = column;
        currentSort.direction = 'asc';
    }
    applyFilters();
}

function sortIcon(column) {
    if (currentSort.column !== column) return '<span class="sort-icon">&#8597;</span>';
    return currentSort.direction === 'asc'
        ? '<span class="sort-icon">&#9650;</span>'
        : '<span class="sort-icon">&#9660;</span>';
}

function togglePipelineFilter(role) {
    if (pipelineFilter === role) {
        pipelineFilter = null;
    } else {
        pipelineFilter = role;
    }
    // Refresh pipeline to update active state
    loadPipeline();
    applyFilters();
}

async function triggerScan() {
    const btn = document.getElementById('scan-btn');
    btn.disabled = true;
    document.getElementById('scan-status').innerHTML = '<span class="spinner"></span> Scanning...';
    document.getElementById('scan-status').className = 'scan-status running';

    try {
        await fetch('/api/scan/trigger', { method: 'POST' });
        // Poll for completion
        pollScanStatus();
    } catch (e) {
        console.error('Failed to trigger scan:', e);
        btn.disabled = false;
    }
}

function pollScanStatus() {
    const interval = setInterval(async () => {
        try {
            const res = await fetch('/api/scan/status');
            const data = await res.json();
            if (!data.running) {
                clearInterval(interval);
                loadDashboard(); // Refresh everything
            }
        } catch (e) {
            clearInterval(interval);
        }
    }, 5000);
}

// ==================== Utilities ====================

const COLLEGE_ABBREVS = {
    'College of Engineering': 'COE',
    'College of Science': 'COS',
    'Coll of Professional Studies': 'CPS',
    'Bouve College of Hlth Sciences': 'Bouve',
    'Khoury Coll of Comp Sciences': 'Khoury',
    "D'Amore-McKim School Business": 'DMSB',
    'School of Law': 'SOL',
    'Coll of Arts, Media & Design': 'CAMD',
    'Mills College at NU': 'MCNU',
    'Coll of Soc Sci & Humanities': 'CSSH',
    'Office of the Provost': 'Provost',
};

function abbreviateCollege(college) {
    if (!college) return '—';
    return COLLEGE_ABBREVS[college] || college;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatTime(isoString) {
    if (!isoString) return 'Never';
    const d = new Date(isoString);
    const now = new Date();
    const diff = now - d;

    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;

    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ==================== Init ====================

// DOMContentLoaded handled by static override

// Auto-refresh every 2 minutes (data display only, not scanning)
// Auto-refresh disabled in static mode


/* ======= STATIC SITE DATA LAYER ======= */
/* Overrides API calls to read from data.json */
let _cache = null;
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

        // Pipeline
        renderPipeline(D.pipeline);

        // Programs
        allPrograms = D.programs || [];
        populateStepFilter();

        // Colleges
        const cSel = document.getElementById('filter-college');
        cSel.innerHTML = '<option value="">All Colleges</option>' +
            (D.colleges||[]).map(c => `<option value="${c}">${c}</option>`).join('');

        // Approvers
        const aSel = document.getElementById('filter-approver');
        aSel.innerHTML = '<option value="">All Approvers</option>' +
            (D.approvers||[]).map(a => `<option value="${a.email}">${a.display} (${a.count})</option>`).join('');

        // Scan status
        const el = document.getElementById('scan-status');
        if (D.last_scan) {
            const t = formatTime(D.last_scan.scan_time);
            el.textContent = `Data from: ${t} (${D.last_scan.programs_with_workflow} programs)`;
        } else {
            el.textContent = 'Static snapshot';
        }

        // Changes
        renderChanges(D.changes || []);

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
        const detailRow = document.getElementById(`detail-${programId}`);
        if (!detailRow) return;

        if (steps.length === 0) {
            detailRow.querySelector('td').innerHTML = '<div class="workflow-meta">No workflow data.</div>';
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

        detailRow.querySelector('td').innerHTML = `
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

    // Disable scan
    window.triggerScan = function() {};

    // Remove auto-refresh interval (static data doesn't change)

    // Initial load
    loadDashboard();
});
