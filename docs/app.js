/* Program Approval Tracker - Frontend Logic */

let allPrograms = [];
let expandedRows = new Set();
let detailTabState = {}; // programId -> 'workflow' | 'curriculum'
let currentSort = { column: 'name', direction: 'asc' };
let pipelineFilter = null;
let smartView = 'all';
let typeFilter = '';
let proposalFilter = '';
let approverPrograms = null;
let cachedPipeline = [];
const STUCK_THRESHOLD_DAYS = 30;

// The 14 main tracked pipeline steps
const PIPELINE_STEPS = new Set([
    "Program PR Graduate Dean's Office",
    "Provost Initial Review",
    "Program Review 2",
    "Program UIP College Approval",
    "Program Graduate Provost Review",
    "Program Graduate Curriculum Committee",
    "Program Undergraduate Curriculum Committee - Tabled Proposals",
    "Program Provost Administrative and Budgetary Review",
    "Program Provost Approval",
    "Program Faculty Senate",
    "Program University Board of Trustees",
    "Program Banner Setup",
    "Program Editor",
    "Program Catalog Setup",
]);

function isCollegeStep(step) {
    if (!step) return false;
    if (PIPELINE_STEPS.has(step)) return false;
    // College steps have department codes like EN, SC, SH, AM, BA, etc.
    return step.match(/^Program (AFCS|AM |AMSL|ARCH|ASNS|BA |CS |EDU|EECE|EN |ENGL|HIST|HUSV|MSCI|PPUA|PS |SC |SH )/);
}

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
    // Re-render pipeline now that allPrograms is loaded (for college count)
    if (cachedPipeline.length) renderPipeline(cachedPipeline, allPrograms);
    updateSmartViewCounts();
    updateTypeCounts();
    updateProposalCounts();
}

async function loadPipeline() {
    try {
        const res = await fetch('/api/pipeline');
        const data = await res.json();
        cachedPipeline = data.pipeline;
        renderPipeline(cachedPipeline);
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
        populateCampusFilter();
        applyFilters();
    } catch (e) {
        console.error('Failed to load programs:', e);
    }
}

async function loadChanges() {
    // Changes are now shown via the "Recent Changes" smart view button
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

function updateProposalCounts(programs) {
    const src = programs || allPrograms;
    const counts = { '': src.length, 'Added': 0, 'Edited': 0, 'Deactivated': 0 };
    src.forEach(p => {
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

function updateTypeCounts(programs) {
    const src = programs || allPrograms;
    const counts = { '': src.length };
    src.forEach(p => {
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
        const entered = p.step_entered_date ? new Date(p.step_entered_date) : null;
        return entered && (now - entered) < 14 * 86400000; // 14 days
    }).length;
    const stuckCount = allPrograms.filter(p => getDaysAtStep(p) >= STUCK_THRESHOLD_DAYS).length;
    const newCount = allPrograms.filter(p => {
        const submitted = p.date_submitted ? new Date(p.date_submitted) : null;
        return submitted && (now - submitted) < 30 * 86400000;
    }).length;

    document.querySelectorAll('.smart-view-btn').forEach(btn => {
        const view = btn.getAttribute('onclick').match(/'(\w+)'/)[1];
        if (view === 'recent') btn.innerHTML = `Recent Changes <span class="view-count">${recentCount}</span>`;
        else if (view === 'stuck') btn.innerHTML = `Potentially Stuck <span class="view-count">${stuckCount}</span>`;
        else if (view === 'new') btn.innerHTML = `New Submissions <span class="view-count">${newCount}</span>`;
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
        const statusEl = document.getElementById('scan-status');
        const updatedEl = document.getElementById('last-updated');
        if (data.running) {
            statusEl.innerHTML = '<span class="spinner"></span> Updating...';
            statusEl.className = 'scan-status running';
            document.getElementById('scan-btn').disabled = true;
        } else {
            statusEl.textContent = '';
            statusEl.className = 'scan-status';
            document.getElementById('scan-btn').disabled = false;
        }
        if (data.last_scan) {
            const d = new Date(data.last_scan.scan_time);
            updatedEl.textContent = `Updated: ${d.toLocaleDateString('en-US', {month: 'short', day: 'numeric', timeZone: 'America/New_York'})} at ${d.toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'})} ET`;
        }
    } catch (e) {
        console.error('Failed to load scan status:', e);
    }
}

// ==================== Rendering ====================

function updatePipelineCounts(baseFiltered) {
    if (!cachedPipeline.length) return;
    // Recount each pipeline step from filtered data
    const stepCounts = {};
    baseFiltered.forEach(p => {
        const step = p.current_step;
        if (step) stepCounts[step] = (stepCounts[step] || 0) + 1;
    });
    const updated = cachedPipeline.map(step => ({
        ...step,
        count: stepCounts[step.role] || 0
    }));
    renderPipeline(updated, baseFiltered);
}

function updateCollegeOptions(baseFiltered) {
    const select = document.getElementById('filter-college');
    const current = select.value;
    const counts = {};
    baseFiltered.forEach(p => {
        if (p.college) counts[p.college] = (counts[p.college] || 0) + 1;
    });
    const sorted = Object.keys(counts).sort();
    select.innerHTML = '<option value="">All Colleges</option>' +
        sorted.map(c => `<option value="${c}">${c} (${counts[c]})</option>`).join('');
    // Preserve selection if still valid
    if (counts[current]) select.value = current;
}

function renderPipeline(pipeline, baseFiltered) {
    const bar = document.getElementById('pipeline-bar');
    // Add College Review as the first step in the pipeline
    const source = baseFiltered || allPrograms;
    const collegeCount = source.filter(p => isCollegeStep(p.current_step)).length;
    const collegeActive = pipelineFilter === '__college__' ? ' active' : '';
    let html = `
        <div class="pipeline-step ${collegeCount > 0 ? 'has-items' : 'empty'}${collegeActive}"
             onclick="togglePipelineFilter('__college__')"
             title="College Review: ${collegeCount} programs">
            <span class="step-count">${collegeCount}</span>
            <span class="step-name">College</span>
        </div>
    `;
    html += pipeline.map(step => {
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
    bar.innerHTML = html;
}

function populateCampusFilter() {
    const campuses = new Set();
    allPrograms.forEach(p => {
        const c = extractCampus(p.name);
        if (c) campuses.add(c);
    });
    const sorted = Array.from(campuses).sort();
    const select = document.getElementById('filter-campus');
    select.innerHTML = '<option value="">All Campuses</option>' +
        sorted.map(c => `<option value="${c}">${c}</option>`).join('');
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

// Apply all filters EXCEPT pipeline, college, and any in the 'exclude' set
function getBaseFiltered(approverProgramIds, exclude) {
    const ex = exclude || {};
    const stepFilter = document.getElementById('filter-step').value;
    const campusFilter = document.getElementById('filter-campus').value;
    const approverFilter = document.getElementById('filter-approver').value;
    const search = document.getElementById('filter-search').value.toLowerCase();
    const now = new Date();

    return allPrograms.filter(p => {
        if (smartView === 'recent') {
            const entered = p.step_entered_date ? new Date(p.step_entered_date) : null;
            if (!entered || (now - entered) >= 14 * 86400000) return false;
        } else if (smartView === 'stuck') {
            if (getDaysAtStep(p) < STUCK_THRESHOLD_DAYS) return false;
        } else if (smartView === 'new') {
            const submitted = p.date_submitted ? new Date(p.date_submitted) : null;
            if (!submitted || (now - submitted) >= 30 * 86400000) return false;
        }
        if (!ex.type && typeFilter && p.program_type !== typeFilter) return false;
        if (!ex.proposal && proposalFilter && p.status !== proposalFilter) return false;
        if (stepFilter && p.current_step !== stepFilter) return false;
        if (campusFilter && extractCampus(p.name) !== campusFilter) return false;
        if (approverProgramIds && !approverProgramIds.has(p.id)) return false;
        if (search && !p.name.toLowerCase().includes(search) &&
            !(p.banner_code && p.banner_code.toLowerCase().includes(search))) return false;
        return true;
    });
}

async function applyFilters() {
    const collegeFilter = document.getElementById('filter-college').value;
    const approverFilter = document.getElementById('filter-approver').value;

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

    // Base filtered set (all filters except pipeline and college)
    const baseFiltered = getBaseFiltered(approverProgramIds);

    // Update pipeline counts from base filtered set
    updatePipelineCounts(baseFiltered);

    // Update college dropdown from base filtered set
    updateCollegeOptions(baseFiltered);

    // Each button group's counts exclude its own filter so you see what's available
    updateTypeCounts(getBaseFiltered(approverProgramIds, {type: true}));
    updateProposalCounts(getBaseFiltered(approverProgramIds, {proposal: true}));

    // Now apply pipeline and college filters for the table
    let filtered = baseFiltered.filter(p => {
        if (pipelineFilter === '__college__' && !isCollegeStep(p.current_step)) return false;
        if (pipelineFilter && pipelineFilter !== '__college__' && p.current_step !== pipelineFilter) return false;
        if (collegeFilter && p.college !== collegeFilter) return false;
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
            const activeTab = detailTabState[p.id] || 'workflow';
            html += `
                <tr class="workflow-detail" id="detail-${p.id}">
                    <td colspan="5">
                        <div class="detail-tabs">
                            <button class="detail-tab ${activeTab === 'workflow' ? 'active' : ''}"
                                onclick="event.stopPropagation(); switchDetailTab(${p.id}, 'workflow')">Workflow</button>
                            <button class="detail-tab ${activeTab === 'curriculum' ? 'active' : ''}"
                                onclick="event.stopPropagation(); switchDetailTab(${p.id}, 'curriculum')">Curriculum</button>
                        </div>
                        <div class="detail-content" id="detail-content-${p.id}">
                            <div class="workflow-loading">Loading...</div>
                        </div>
                    </td>
                </tr>
            `;
        }
    }

    html += '</tbody></table>';
    container.innerHTML = html;

    // Load details for expanded rows
    expandedRows.forEach(id => {
        const tab = detailTabState[id] || 'workflow';
        if (tab === 'workflow') loadWorkflowDetail(id);
        else loadCurriculumDetail(id);
    });
}

async function loadWorkflowDetail(programId) {
    const contentEl = document.getElementById(`detail-content-${programId}`);
    if (!contentEl) return;

    try {
        const res = await fetch(`/api/program/${programId}/workflow`);
        const data = await res.json();
        const steps = data.steps || [];

        if (steps.length === 0) {
            contentEl.innerHTML = '<div class="workflow-meta">No workflow data available.</div>';
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
    } catch (e) {
        contentEl.innerHTML = '<div class="workflow-meta">Failed to load workflow details.</div>';
    }
}

async function loadCurriculumDetail(programId) {
    const contentEl = document.getElementById(`detail-content-${programId}`);
    if (!contentEl) return;
    contentEl.innerHTML = '<div class="workflow-loading">Loading curriculum...</div>';

    try {
        const res = await fetch(`/api/program/${programId}/curriculum`);
        const data = await res.json();
        if (data.curriculum_html) {
            contentEl.innerHTML = `<div class="curriculum-content">${data.curriculum_html}</div>`;
        } else {
            contentEl.innerHTML = '<div class="workflow-meta">No curriculum data available. Run a scan to collect curriculum details.</div>';
        }
    } catch (e) {
        contentEl.innerHTML = '<div class="workflow-meta">Failed to load curriculum.</div>';
    }
}

function switchDetailTab(programId, tab) {
    detailTabState[programId] = tab;
    const detailRow = document.getElementById(`detail-${programId}`);
    if (!detailRow) return;
    detailRow.querySelectorAll('.detail-tab').forEach(btn => {
        btn.classList.toggle('active', btn.textContent.trim().toLowerCase() === tab);
    });
    if (tab === 'workflow') loadWorkflowDetail(programId);
    else loadCurriculumDetail(programId);
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
        delete detailTabState[programId];
    } else {
        expandedRows.add(programId);
        detailTabState[programId] = 'workflow';
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
    // Re-render pipeline to update active state (full recount happens in applyFilters)
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

function extractCampus(name) {
    const match = name.match(/\(([^)]+)\)\s*$/);
    if (!match) return '';
    const val = match[1];
    // Filter out non-campus parentheticals
    if (val.length > 20 || val.indexOf('template') !== -1 || val.indexOf('Copy') !== -1) return '';
    return val;
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
