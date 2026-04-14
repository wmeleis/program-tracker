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

function clearFilter(id) {
    const el = document.getElementById(id);
    if (el.tagName === 'SELECT') el.value = '';
    else el.value = '';
    updateClearButtons();
    applyFilters();
}

function updateClearButtons() {
    document.querySelectorAll('.filter-select-wrap').forEach(wrap => {
        const input = wrap.querySelector('select, input');
        if (input && input.value) {
            wrap.classList.add('has-value');
        } else {
            wrap.classList.remove('has-value');
        }
    });
}

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

// Apply all filters EXCEPT pipeline and any in the 'exclude' set
function getBaseFiltered(approverProgramIds, exclude) {
    const ex = exclude || {};
    const collegeFilter = document.getElementById('filter-college').value;
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
        if (!ex.college && collegeFilter && p.college !== collegeFilter) return false;
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

    // Base filtered set (all filters except pipeline)
    const baseFiltered = getBaseFiltered(approverProgramIds);

    // Update pipeline counts from base filtered set
    updatePipelineCounts(baseFiltered);

    // Update college dropdown excluding the college filter itself (so you see what's available)
    updateCollegeOptions(getBaseFiltered(approverProgramIds, {college: true}));

    // Each button group's counts exclude its own filter so you see what's available
    updateTypeCounts(getBaseFiltered(approverProgramIds, {type: true}));
    updateProposalCounts(getBaseFiltered(approverProgramIds, {proposal: true}));

    // Now apply pipeline filter for the table (college already applied in baseFiltered)
    let filtered = baseFiltered.filter(p => {
        if (pipelineFilter === '__college__' && !isCollegeStep(p.current_step)) return false;
        if (pipelineFilter && pipelineFilter !== '__college__' && p.current_step !== pipelineFilter) return false;
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
                            <button class="detail-tab ${activeTab === 'reference' ? 'active' : ''}"
                                onclick="event.stopPropagation(); switchDetailTab(${p.id}, 'reference')">Reference</button>
                            <button class="detail-tab ${activeTab === 'compare' ? 'active' : ''}"
                                onclick="event.stopPropagation(); switchDetailTab(${p.id}, 'compare')">Compare</button>
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
        else if (tab === 'reference') loadReferenceDetail(id);
        else if (tab === 'compare') loadCompareDetail(id);
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
            const cleaned = cleanCurriculumHtml(data.curriculum_html);
            contentEl.innerHTML = `<div class="curriculum-content">${cleaned}</div>`;
        } else {
            contentEl.innerHTML = '<div class="workflow-meta">No curriculum data available. Run a scan to collect curriculum details.</div>';
        }
    } catch (e) {
        contentEl.innerHTML = '<div class="workflow-meta">Failed to load curriculum.</div>';
    }
}

function cleanCurriculumHtml(html) {
    // Remove unwanted sections from reference/curriculum HTML
    const div = document.createElement('div');
    div.innerHTML = html;

    // Remove hidden elements (captions, noscript header rows) — CSS display:none doesn't apply in detached DOM
    div.querySelectorAll('.hidden, .noscript, caption').forEach(el => el.remove());

    // Strip all links — replace <a> with plain text
    div.querySelectorAll('a').forEach(el => {
        el.replaceWith(document.createTextNode(el.textContent));
    });

    // Replace "Course Not Found" error elements with plain text (keep the course code)
    div.querySelectorAll('.structuredcontenterror').forEach(el => {
        const text = el.textContent.replace(/\u00a0/g, ' ').trim();
        // In title column, "Course XXX Not Found" → show em dash (code is already in codecol)
        const notFound = text.match(/^Course\s+.+\s+Not Found$/);
        if (notFound) {
            el.replaceWith(document.createTextNode('—'));
        } else {
            // In code column, just unwrap to plain text
            el.replaceWith(document.createTextNode(text));
        }
    });

    // Remove "Program Overview" section (h2 + following content until next h2)
    div.querySelectorAll('h2').forEach(h2 => {
        if (h2.textContent.trim() === 'Program Overview') {
            // Remove everything from this h2 until the next h2 or end
            let node = h2.nextSibling;
            while (node) {
                const next = node.nextSibling;
                if (node.nodeName === 'H2') break;
                node.parentNode.removeChild(node);
                node = next;
            }
            h2.remove();
        }
    });

    // Remove Milestone sections (h4 or h3 with "Milestone" + following p)
    div.querySelectorAll('h3, h4').forEach(h => {
        if (h.textContent.trim() === 'Milestone') {
            let node = h.nextSibling;
            while (node) {
                const next = node.nextSibling;
                if (node.nodeName && node.nodeName.match(/^H[2-4]$/)) break;
                node.parentNode.removeChild(node);
                node = next;
            }
            h.remove();
        }
    });

    // Remove "Research Areas" and "Program Credit/GPA Requirements" sections
    div.querySelectorAll('h2, h3').forEach(h => {
        const text = h.textContent.trim();
        if (text === 'Research Areas' || text === 'Program Credit/GPA Requirements') {
            let node = h.nextSibling;
            while (node) {
                const next = node.nextSibling;
                if (node.nodeName === 'H2') break;
                node.parentNode.removeChild(node);
                node = next;
            }
            h.remove();
        }
    });

    return div.innerHTML;
}

async function loadReferenceDetail(programId) {
    const contentEl = document.getElementById(`detail-content-${programId}`);
    if (!contentEl) return;
    contentEl.innerHTML = '<div class="workflow-loading">Loading reference curriculum...</div>';

    try {
        const res = await fetch(`/api/program/${programId}/reference`);
        if (!res.ok) {
            contentEl.innerHTML = '<div class="workflow-meta">No reference curriculum available. This may be a new program with no prior approvals.</div>';
            return;
        }
        const data = await res.json();
        if (data.curriculum_html) {
            const cleaned = cleanCurriculumHtml(data.curriculum_html);
            const header = data.version_date
                ? `<div class="reference-header">Last approved version: ${escapeHtml(data.version_date)}</div>`
                : '';
            contentEl.innerHTML = `${header}<div class="curriculum-content">${cleaned}</div>`;
        } else {
            contentEl.innerHTML = '<div class="workflow-meta">No reference curriculum available.</div>';
        }
    } catch (e) {
        contentEl.innerHTML = '<div class="workflow-meta">Failed to load reference curriculum.</div>';
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
    else if (tab === 'reference') loadReferenceDetail(programId);
    else if (tab === 'compare') loadCompareDetail(programId);
    else loadCurriculumDetail(programId);
}

// Normalize whitespace: collapse all types (including &nbsp;) to single spaces,
// fix missing spaces around "and"/"or" between course codes, and lowercase for comparison
function normText(s) {
    let t = s.replace(/[\u00a0\s]+/g, ' ').trim();
    // Fix "CS 5001and" -> "CS 5001 and", "AIand" -> "AI and"
    t = t.replace(/(\d)(and|or)\b/g, '$1 $2');
    // Fix "andCS" -> "and CS", "and Recitation" is fine
    t = t.replace(/\b(and|or)([A-Z])/g, '$1 $2');
    return t;
}

// Normalize for comparison: lowercase so case differences don't create false diffs
function normForCompare(s) {
    return normText(s).toLowerCase();
}

// Extract course lines from curriculum HTML for comparison.
// Returns array of objects with display text and normalized comparison key.
function extractCourseLines(html) {
    const div = document.createElement('div');
    div.innerHTML = cleanCurriculumHtml(html);
    const lines = [];
    const courseCodePattern = /^[A-Z]{2,5}\s+\d{4}/i;

    div.querySelectorAll('tr').forEach(tr => {
        const cells = tr.querySelectorAll('td, th');
        if (cells.length === 0) return;
        const parts = Array.from(cells).map(c => normText(c.textContent)).filter(Boolean);
        if (parts.length === 0) return;

        const hasCode = parts.some(p => courseCodePattern.test(p));
        const isAreaHeader = tr.classList.contains('areaheader') || tr.querySelector('.areaheader') !== null;
        const hasOr = parts.some(p => /^or\s+[A-Z]{2,5}\s+\d{4}/i.test(p));

        // Only include rows with course codes, area headers, or "or" alternatives
        if (hasCode || isAreaHeader || hasOr) {
            lines.push(parts.join('\t'));
        }
    });
    return lines;
}

// Simple diff algorithm (longest common subsequence based)
// Compares using case-insensitive normalization but preserves original display text
function diffLines(oldLines, newLines) {
    const oldNorm = oldLines.map(l => normForCompare(l));
    const newNorm = newLines.map(l => normForCompare(l));
    const m = oldLines.length, n = newLines.length;
    const dp = Array.from({length: m + 1}, () => new Uint16Array(n + 1));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldNorm[i-1] === newNorm[j-1]) dp[i][j] = dp[i-1][j-1] + 1;
            else dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]);
        }
    }
    const result = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldNorm[i-1] === newNorm[j-1]) {
            result.unshift({type: 'same', left: oldLines[i-1], right: newLines[j-1]});
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
            result.unshift({type: 'added', left: '', right: newLines[j-1]});
            j--;
        } else {
            result.unshift({type: 'removed', left: oldLines[i-1], right: ''});
            i--;
        }
    }
    return result;
}

// Render a side-by-side comparison table
function renderSideBySide(diff, leftLabel, rightLabel) {
    function fmtCell(text, cls) {
        const escaped = escapeHtml(text).replace(/\t/g, '<span class="compare-tab"></span>');
        return `<td class="${cls}">${escaped || ''}</td>`;
    }
    let rows = diff.map(d => {
        if (d.type === 'same') {
            return `<tr>${fmtCell(d.left, 'cmp-same')}${fmtCell(d.right, 'cmp-same')}</tr>`;
        } else if (d.type === 'removed') {
            return `<tr>${fmtCell(d.left, 'cmp-removed')}${fmtCell('', 'cmp-empty')}</tr>`;
        } else {
            return `<tr>${fmtCell('', 'cmp-empty')}${fmtCell(d.right, 'cmp-added')}</tr>`;
        }
    }).join('');

    return `<table class="compare-table">
        <thead><tr><th>${escapeHtml(leftLabel)}</th><th>${escapeHtml(rightLabel)}</th></tr></thead>
        <tbody>${rows}</tbody>
    </table>`;
}

// Compare two curricula, return {identical, diff}
function compareCurricula(refHtml, currHtml) {
    const refLines = extractCourseLines(refHtml);
    const currLines = extractCourseLines(currHtml);
    const diff = diffLines(refLines, currLines);
    const identical = !diff.some(d => d.type !== 'same');
    return {identical, diff};
}

// Cache for campus groups
let _campusGroupsCache = null;
async function getCampusGroups() {
    if (_campusGroupsCache) return _campusGroupsCache;
    try {
        const res = await fetch('/api/campus_groups');
        _campusGroupsCache = await res.json();
    } catch(e) {
        _campusGroupsCache = {boston_to_deployments: {}, deployment_to_boston: {}};
    }
    return _campusGroupsCache;
}

// Get program name by ID from allPrograms cache
function getProgramName(id) {
    if (!allPrograms) return `Program #${id}`;
    const p = allPrograms.find(p => p.id === id);
    return p ? p.name : `Program #${id}`;
}

async function loadCompareDetail(programId) {
    const contentEl = document.getElementById(`detail-content-${programId}`);
    if (!contentEl) return;
    contentEl.innerHTML = '<div class="workflow-loading">Loading comparison...</div>';

    try {
        const [currRes, groups] = await Promise.all([
            fetch(`/api/program/${programId}/curriculum`),
            getCampusGroups()
        ]);
        const currData = currRes.ok ? await currRes.json() : {};
        const currHtml = currData.curriculum_html || '';

        const bostonId = groups.deployment_to_boston[String(programId)];
        const deploymentIds = groups.boston_to_deployments[String(programId)];

        // Also check if this is a non-Boston program by name even if no counterpart in pipeline
        const progName = getProgramName(programId);
        const campusMatch = progName.match(/\(([^)]+)\)\s*$/);
        const campus = campusMatch ? campusMatch[1] : null;
        const isNonBoston = campus && campus.toLowerCase() !== 'boston';

        if (bostonId || isNonBoston) {
            // This is a non-Boston deployment — compare against Boston reference
            const refRes = await fetch(`/api/program/${programId}/reference`);
            const refData = refRes.ok ? await refRes.json() : {};
            const refHtml = refData.curriculum_html || '';

            if (!currHtml || !refHtml) {
                contentEl.innerHTML = '<div class="workflow-meta">Curriculum or reference data not available for comparison.</div>';
                updateCompareButton(programId, null);
                return;
            }

            const {identical, diff} = compareCurricula(refHtml, currHtml);
            updateCompareButton(programId, identical);

            const header = refData.version_date
                ? `<div class="reference-header">Comparing against: ${escapeHtml(refData.version_date)}</div>`
                : '';

            if (identical) {
                contentEl.innerHTML = `${header}<div class="compare-identical">Curriculum is identical to the Boston reference.</div>`;
            } else {
                const table = renderSideBySide(diff, 'Boston Reference', getProgramName(programId));
                contentEl.innerHTML = `${header}
                    <div class="compare-legend">
                        <span class="compare-legend-item"><span class="legend-box diff-removed-bg"></span> Only in reference</span>
                        <span class="compare-legend-item"><span class="legend-box diff-added-bg"></span> Only in this version</span>
                    </div>${table}`;
            }

        } else if (deploymentIds && deploymentIds.length > 0) {
            // This is a Boston program — compare against all deployments
            const deploymentResults = [];
            let allIdentical = true;

            for (const depId of deploymentIds) {
                const depRes = await fetch(`/api/program/${depId}/curriculum`);
                const depData = depRes.ok ? await depRes.json() : {};
                const depHtml = depData.curriculum_html || '';
                const depName = getProgramName(depId);

                if (!currHtml || !depHtml) {
                    deploymentResults.push({name: depName, id: depId, noData: true});
                    continue;
                }

                const {identical, diff} = compareCurricula(currHtml, depHtml);
                if (!identical) allIdentical = false;
                deploymentResults.push({name: depName, id: depId, identical, diff});
            }

            updateCompareButton(programId, allIdentical);

            let html = `<div class="reference-header">Comparing Boston curriculum against ${deploymentIds.length} campus deployment${deploymentIds.length > 1 ? 's' : ''}</div>`;

            if (allIdentical) {
                html += '<div class="compare-identical">All campus deployments are identical to this curriculum.</div>';
            }

            for (const dep of deploymentResults) {
                html += `<div class="compare-deployment-section">`;
                html += `<h3 class="compare-deployment-name">${escapeHtml(dep.name)}</h3>`;
                if (dep.noData) {
                    html += '<div class="workflow-meta">Curriculum data not available.</div>';
                } else if (dep.identical) {
                    html += '<div class="compare-identical-small">Identical</div>';
                } else {
                    html += `<div class="compare-legend">
                        <span class="compare-legend-item"><span class="legend-box diff-removed-bg"></span> Only in Boston</span>
                        <span class="compare-legend-item"><span class="legend-box diff-added-bg"></span> Only in ${escapeHtml(dep.name)}</span>
                    </div>`;
                    html += renderSideBySide(dep.diff, 'Boston', dep.name);
                }
                html += '</div>';
            }

            contentEl.innerHTML = html;

        } else {
            // No campus relationships — this is a standalone program
            // Compare against its own reference if available
            const refRes = await fetch(`/api/program/${programId}/reference`);
            const refData = refRes.ok ? await refRes.json() : {};
            const refHtml = refData.curriculum_html || '';

            if (!currHtml || !refHtml) {
                contentEl.innerHTML = '<div class="workflow-meta">No comparison available. This program has no campus deployments and no reference curriculum.</div>';
                updateCompareButton(programId, null);
                return;
            }

            const {identical, diff} = compareCurricula(refHtml, currHtml);
            updateCompareButton(programId, identical);

            if (identical) {
                contentEl.innerHTML = '<div class="compare-identical">Current curriculum is identical to the last approved version.</div>';
            } else {
                const table = renderSideBySide(diff, 'Last Approved', 'Current Proposal');
                contentEl.innerHTML = `<div class="compare-legend">
                    <span class="compare-legend-item"><span class="legend-box diff-removed-bg"></span> Only in approved</span>
                    <span class="compare-legend-item"><span class="legend-box diff-added-bg"></span> Only in proposal</span>
                </div>${table}`;
            }
        }
    } catch (e) {
        contentEl.innerHTML = '<div class="workflow-meta">Failed to load comparison.</div>';
        updateCompareButton(programId, null);
    }
}

// Update the Compare button color based on comparison result
function updateCompareButton(programId, identical) {
    const detailRow = document.getElementById(`detail-${programId}`);
    if (!detailRow) return;
    const tabs = detailRow.querySelectorAll('.detail-tab');
    for (const tab of tabs) {
        if (tab.textContent.trim() === 'Compare') {
            tab.classList.remove('compare-identical-btn', 'compare-different-btn');
            if (identical === true) tab.classList.add('compare-identical-btn');
            else if (identical === false) tab.classList.add('compare-different-btn');
            break;
        }
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

document.addEventListener('DOMContentLoaded', loadDashboard);

// Auto-refresh every 2 minutes (data display only, not scanning)
setInterval(loadDashboard, 120000);
