/* Program Approval Tracker - Frontend Logic */

let allPrograms = [];
let allCourses = [];
let currentView = 'programs'; // 'programs' or 'courses'
let expandedRows = new Set();
let detailTabState = {}; // programId/courseId -> 'workflow' | 'curriculum'
let currentSort = { column: 'name', direction: 'asc' };
let pipelineFilter = null;
let smartView = 'all';
let typeFilter = '';
let proposalFilter = '';
let approverPrograms = null;
let cachedPipeline = [];
let cachedCoursePipeline = [];
const STUCK_THRESHOLD_DAYS = 30;

function switchView(view) {
    currentView = view;

    // Update button states
    document.getElementById('btn-programs').classList.toggle('active', view === 'programs');
    document.getElementById('btn-courses').classList.toggle('active', view === 'courses');

    // Reset filters when switching views
    pipelineFilter = null;
    typeFilter = '';
    proposalFilter = '';
    document.querySelectorAll('.type-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.proposal-btn').forEach(btn => btn.classList.remove('active-all', 'active-new', 'active-edit', 'active-inact'));
    document.querySelectorAll('.smart-view-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById('filter-college').value = '';
    document.getElementById('filter-campus').value = '';
    document.getElementById('filter-approver').value = '';
    document.getElementById('filter-step').value = '';
    document.getElementById('filter-search').value = '';

    // Hide/show sections based on view
    const typeSection = document.querySelector('.view-group');
    const proposalSection = document.querySelectorAll('.view-group')[1];
    const campusFilter = document.getElementById('filter-campus');

    if (view === 'courses') {
        typeSection.style.display = 'none';
        proposalSection.style.display = 'none';
        campusFilter.parentElement.parentElement.style.display = 'none';
    } else {
        typeSection.style.display = 'flex';
        proposalSection.style.display = 'flex';
        campusFilter.parentElement.parentElement.style.display = 'flex';
    }

    // Reload appropriate data
    if (view === 'programs') {
        loadDashboard();
    } else {
        loadCoursesDashboard();
    }
}

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

// Course pipeline steps (centralized, non-college course workflow roles)
const COURSE_PIPELINE_STEPS = new Set([
    "Checkpoint",
    "Provost Initial Review",
    "Course Review 2",
    "Course Review 3",
    "Course Review Group",
    "Course GRA Regulatory Validation",
    "PS Course Review",
    "Graduate Curriculum Committee Chair",
    "Graduate Council Subcommittee One",
    "Graduate Council Subcommittee Two",
    "Data Entry 1",
    "Data Entry 3",
    "Data Entry 3 - Awaiting Course Approval",
    "Data Entry 5 - Awaiting Program Approval",
    "Data Entry 8 - Hold PA courses",
    "Data Entry 9",
    "REGISTRAR Continuing Education Level Discussion",
    "Banner - Prereq 2 Letter Course Number",
    "Banner",
    "Editor",
]);

function isCourseCollegeStep(step) {
    if (!step) return false;
    // Anything not in the central course pipeline is a college/department role
    return !COURSE_PIPELINE_STEPS.has(step);
}

// Course pipeline buckets: several raw workflow steps collapse to one button.
// Display only — underlying DB step names are unchanged.
const COURSE_BUCKETS = [
    {
        role: 'Data Entry',
        short_name: 'Data Entry',
        match: step => typeof step === 'string' && step.startsWith('Data Entry'),
    },
    {
        role: 'Banner',
        short_name: 'Banner',
        match: step => typeof step === 'string' && (step === 'Banner' || step.startsWith('Banner ') || step.startsWith('Banner-')),
    },
    {
        role: 'Course Review',
        short_name: 'Course Review',
        match: step => step === 'Course Review 2' || step === 'Course Review 3',
    },
];

function getCourseBucket(step) {
    for (const b of COURSE_BUCKETS) {
        if (b.match(step)) return b.role;
    }
    return null;
}

// Collapse raw pipeline entries into bucket entries (first occurrence holds position, count is summed).
function collapseCoursePipeline(pipeline) {
    const seen = new Set();
    const result = [];
    for (const step of pipeline) {
        const bucket = getCourseBucket(step.role);
        if (bucket) {
            if (seen.has(bucket)) continue;
            seen.add(bucket);
            const def = COURSE_BUCKETS.find(b => b.role === bucket);
            const total = pipeline
                .filter(s => getCourseBucket(s.role) === bucket)
                .reduce((n, s) => n + (s.count || 0), 0);
            result.push({ role: def.role, short_name: def.short_name, count: total, _bucket: true });
        } else {
            result.push(step);
        }
    }
    return result;
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

// ==================== Course Loading ====================

async function loadCoursesDashboard() {
    await Promise.all([
        loadCoursePipeline(),
        loadCourses(),
        loadScanStatus(),
        loadCourseColleges(),
        loadCourseApprovers()
    ]);
    if (cachedCoursePipeline.length) renderPipeline(cachedCoursePipeline, allCourses);
    updateCourseSmartViewCounts();
}

async function loadCourseApprovers() {
    try {
        const res = await fetch('/api/course_approvers');
        const data = await res.json();
        const select = document.getElementById('filter-approver');
        const options = (data.approvers || []).map(a =>
            `<option value="${a.email}">${a.display} (${a.count})</option>`
        ).join('');
        select.innerHTML = '<option value="">All Approvers</option>' + options;
    } catch (e) {
        console.error('Failed to load course approvers:', e);
    }
}

async function loadCoursePipeline() {
    try {
        const res = await fetch('/api/course_pipeline');
        const data = await res.json();
        cachedCoursePipeline = collapseCoursePipeline(data.pipeline || []);
        renderPipeline(cachedCoursePipeline);
    } catch (e) {
        console.error('Failed to load course pipeline:', e);
    }
}

async function loadCourses() {
    try {
        const res = await fetch('/api/courses');
        const data = await res.json();
        allCourses = data.courses || [];
        populateCourseStepFilter();
        applyFilters();
    } catch (e) {
        console.error('Failed to load courses:', e);
    }
}

async function loadCourseColleges() {
    try {
        const res = await fetch('/api/course_colleges');
        const data = await res.json();
        const select = document.getElementById('filter-college');
        const options = (data.colleges || []).map(c => `<option value="${c}">${c}</option>`).join('');
        select.innerHTML = '<option value="">All Colleges</option>' + options;
    } catch (e) {
        console.error('Failed to load course colleges:', e);
    }
}

function populateCourseStepFilter() {
    const select = document.getElementById('filter-step');
    const steps = new Set();
    allCourses.forEach(c => {
        if (c.current_step) steps.add(c.current_step);
    });
    const sorted = Array.from(steps).sort();
    const options = sorted.map(s => `<option value="${s}">${s}</option>`).join('');
    select.innerHTML = '<option value="">All Steps</option>' + options;
}

function updateCourseSmartViewCounts() {
    const now = new Date();
    const recentCount = allCourses.filter(c => {
        const entered = c.step_entered_date ? new Date(c.step_entered_date) : null;
        return entered && (now - entered) < 14 * 86400000;
    }).length;
    const stuckCount = allCourses.filter(c => getDaysAtStep(c) >= STUCK_THRESHOLD_DAYS).length;
    const newCount = allCourses.filter(c => {
        const submitted = c.date_submitted ? new Date(c.date_submitted) : null;
        return submitted && (now - submitted) < 30 * 86400000;
    }).length;

    document.querySelectorAll('.smart-view-btn').forEach(btn => {
        const view = btn.getAttribute('onclick').match(/'(\w+)'/)[1];
        if (view === 'recent') btn.innerHTML = `Recent Changes <span class="view-count">${recentCount}</span>`;
        else if (view === 'stuck') btn.innerHTML = `Potentially Stuck <span class="view-count">${stuckCount}</span>`;
        else if (view === 'new') btn.innerHTML = `New Submissions <span class="view-count">${newCount}</span>`;
    });
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
        const progressContainer = document.getElementById('progress-container');

        if (data.running) {
            statusEl.innerHTML = '<span class="spinner"></span> Updating...';
            statusEl.className = 'scan-status running';
            document.getElementById('scan-btn').disabled = true;

            // Show progress phase text
            progressContainer.style.display = 'block';
            document.getElementById('progress-phase').textContent = data.phase || 'Scanning...';
        } else {
            statusEl.textContent = '';
            statusEl.className = 'scan-status';
            document.getElementById('scan-btn').disabled = false;

            // Hide progress phase
            progressContainer.style.display = 'none';
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
    const pipeline = currentView === 'courses' ? cachedCoursePipeline : cachedPipeline;
    if (!pipeline.length) return;
    // Recount each pipeline step from filtered data
    const stepCounts = {};
    baseFiltered.forEach(item => {
        const step = item.current_step;
        if (step) stepCounts[step] = (stepCounts[step] || 0) + 1;
    });
    const isCourses = currentView === 'courses';
    const updated = pipeline.map(step => {
        let count;
        if (isCourses && step._bucket) {
            const def = COURSE_BUCKETS.find(b => b.role === step.role);
            count = Object.keys(stepCounts)
                .filter(s => def.match(s))
                .reduce((n, s) => n + stepCounts[s], 0);
        } else {
            count = stepCounts[step.role] || 0;
        }
        return { ...step, count };
    });
    renderPipeline(updated, baseFiltered);
}

function updateCollegeOptions(baseFiltered) {
    const select = document.getElementById('filter-college');
    const current = select.value;
    const counts = {};
    baseFiltered.forEach(item => {
        if (item.college) counts[item.college] = (counts[item.college] || 0) + 1;
    });
    const sorted = Object.keys(counts).sort();
    select.innerHTML = '<option value="">All Colleges</option>' +
        sorted.map(c => `<option value="${c}">${c} (${counts[c]})</option>`).join('');
    // Preserve selection if still valid
    if (counts[current]) select.value = current;
}

function renderPipeline(pipeline, baseFiltered) {
    const bar = document.getElementById('pipeline-bar');
    const isCourseView = currentView === 'courses';
    // Add College Review as the first step in the pipeline
    const source = baseFiltered || (isCourseView ? allCourses : allPrograms);
    const detector = isCourseView ? isCourseCollegeStep : isCollegeStep;
    const collegeCount = source.filter(p => detector(p.current_step)).length;
    const collegeActive = pipelineFilter === '__college__' ? ' active' : '';
    const itemLabel = isCourseView ? 'courses' : 'programs';
    let html = `
        <div class="pipeline-step ${collegeCount > 0 ? 'has-items' : 'empty'}${collegeActive}"
             onclick="togglePipelineFilter('__college__')"
             title="College Review: ${collegeCount} ${itemLabel}">
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

    const sourceData = currentView === 'courses' ? allCourses : allPrograms;

    return sourceData.filter(item => {
        if (smartView === 'recent') {
            const entered = item.step_entered_date ? new Date(item.step_entered_date) : null;
            if (!entered || (now - entered) >= 14 * 86400000) return false;
        } else if (smartView === 'stuck') {
            if (getDaysAtStep(item) < STUCK_THRESHOLD_DAYS) return false;
        } else if (smartView === 'new') {
            const submitted = item.date_submitted ? new Date(item.date_submitted) : null;
            if (!submitted || (now - submitted) >= 30 * 86400000) return false;
        }
        if (!ex.type && typeFilter && item.program_type !== typeFilter) return false;
        if (!ex.proposal && proposalFilter && item.status !== proposalFilter) return false;
        if (!ex.college && collegeFilter && item.college !== collegeFilter) return false;
        if (stepFilter && item.current_step !== stepFilter) return false;
        if (currentView === 'programs' && campusFilter && extractCampus(item.name) !== campusFilter) return false;
        if (approverProgramIds && !approverProgramIds.has(item.id)) return false;

        // Search in name/title and code/banner_code
        if (search) {
            const searchField = currentView === 'courses' ? item.code : item.name;
            const searchSecond = currentView === 'courses' ? item.title : item.banner_code;
            if (!searchField.toLowerCase().includes(search) &&
                !(searchSecond && searchSecond.toLowerCase().includes(search))) return false;
        }
        return true;
    });
}

async function applyFilters() {
    const collegeFilter = document.getElementById('filter-college').value;
    const approverFilter = document.getElementById('filter-approver').value;

    // If approver filter is active, fetch programs/courses from API (or use static cache)
    let approverProgramIds = window._staticApproverIds || null;
    if (approverFilter && !approverProgramIds) {
        try {
            const endpoint = currentView === 'courses'
                ? `/api/course_approver/${encodeURIComponent(approverFilter)}`
                : `/api/approver/${encodeURIComponent(approverFilter)}`;
            const res = await fetch(endpoint);
            const data = await res.json();
            const items = currentView === 'courses' ? (data.courses || []) : (data.programs || []);
            approverProgramIds = new Set(items.map(p => p.id));
        } catch (e) {
            console.error('Failed to load approver items:', e);
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
    const collegeDetector = currentView === 'courses' ? isCourseCollegeStep : isCollegeStep;
    const isCoursesView = currentView === 'courses';
    const bucketDef = isCoursesView && pipelineFilter
        ? COURSE_BUCKETS.find(b => b.role === pipelineFilter)
        : null;
    let filtered = baseFiltered.filter(p => {
        if (pipelineFilter === '__college__' && !collegeDetector(p.current_step)) return false;
        if (pipelineFilter && pipelineFilter !== '__college__') {
            if (bucketDef) {
                if (!bucketDef.match(p.current_step)) return false;
            } else if (p.current_step !== pipelineFilter) return false;
        }
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

    const itemType = currentView === 'courses' ? 'courses' : 'programs';
    document.getElementById('result-count').textContent = `${filtered.length} ${itemType}`;
    renderTable(filtered);
}

function renderTable(items) {
    const container = document.getElementById('programs-table-container');
    const isCourseView = currentView === 'courses';

    if (!items || items.length === 0) {
        const emptyMsg = isCourseView ? 'No courses match your filters.' : 'No programs match your filters.';
        container.innerHTML = `<p class="empty-state">${emptyMsg} Try adjusting your selections.</p>`;
        expandedRows.forEach(id => loadWorkflowDetail(id, isCourseView));
        return;
    }

    const headerColLabel = isCourseView ? 'Code' : 'College';
    const titleLabel = isCourseView ? 'Course Title' : 'Program Name';
    const titleCol = isCourseView ? 'code' : 'name';
    const statusLabel = isCourseView ? '' : `
        <div class="table-legend">
            <span class="legend-item"><span class="legend-swatch new"></span> New program</span>
            <span class="legend-item"><span class="legend-swatch change"></span> Program change</span>
            <span class="legend-item"><span class="legend-swatch inactivation"></span> Inactivation</span>
        </div>`;

    let html = statusLabel + `
        <table class="program-table">
            <thead>
                <tr>
                    <th onclick="sortBy('${titleCol}')">
                        ${titleLabel} ${sortIcon(titleCol)}
                    </th>
                    <th onclick="sortBy('${isCourseView ? 'college' : 'college'}')" style="width: 70px">
                        ${headerColLabel} ${sortIcon('college')}
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

    for (const item of items) {
        // Normalize to string so the set lookup matches the string passed
        // via the onclick handler (toggleRow('${id}') always stringifies).
        const id = String(item.id);
        const expanded = expandedRows.has(id);
        const itemTitle = isCourseView ? item.code : item.name;
        const itemDisplay = isCourseView ? `${item.code}: ${item.title}` : item.name;
        const collegeDisplay = isCourseView ? item.college : abbreviateCollege(item.college);
        const progress = item.total_steps > 0 ? (item.completed_steps / item.total_steps * 100) : 0;
        const progressClass = progress < 33 ? 'early' : progress < 66 ? 'mid' : 'late';
        const rowClass = isCourseView ? 'row-edited' :
            item.status === 'Added' ? 'row-added' :
            item.status === 'Edited' ? 'row-edited' :
            item.status === 'Deactivated' ? 'row-deactivated' : 'row-edited';
        const days = getDaysAtStep(item);
        const daysClass = days < 14 ? 'fresh' : days < STUCK_THRESHOLD_DAYS ? 'aging' : 'stuck';

        html += `
            <tr class="program-row ${rowClass} ${expanded ? 'expanded' : ''}"
                onclick="toggleRow('${id}')">
                <td><strong>${escapeHtml(itemDisplay)}</strong></td>
                <td title="${escapeHtml(item.college || '')}">${escapeHtml(collegeDisplay)}</td>
                <td>${escapeHtml(item.current_step || '—')}</td>
                <td>
                    <div class="progress-container">
                        <div class="progress-bar">
                            <div class="progress-fill ${progressClass}"
                                 style="width: ${progress}%"></div>
                        </div>
                        <span class="progress-text">${item.completed_steps}/${item.total_steps}</span>
                    </div>
                </td>
                <td><span class="days-at-step ${daysClass}" title="Days at current step">${days}d</span></td>
            </tr>
        `;

        if (expanded) {
            const activeTab = detailTabState[id] || 'workflow';
            const tabs = isCourseView ?
                `<button class="detail-tab ${activeTab === 'workflow' ? 'active' : ''}"
                    onclick="event.stopPropagation(); switchDetailTab('${id}', 'workflow')">Workflow</button>` :
                `<button class="detail-tab ${activeTab === 'workflow' ? 'active' : ''}"
                    onclick="event.stopPropagation(); switchDetailTab(${id}, 'workflow')">Workflow</button>
                <button class="detail-tab ${activeTab === 'curriculum' ? 'active' : ''}"
                    onclick="event.stopPropagation(); switchDetailTab(${id}, 'curriculum')">Curriculum</button>
                <button class="detail-tab ${activeTab === 'reference' ? 'active' : ''}"
                    onclick="event.stopPropagation(); switchDetailTab(${id}, 'reference')">Reference</button>
                <button class="detail-tab ${activeTab === 'compare' ? 'active' : ''}"
                    onclick="event.stopPropagation(); switchDetailTab(${id}, 'compare')">Compare</button>`;

            html += `
                <tr class="workflow-detail" id="detail-${id}">
                    <td colspan="5">
                        <div class="detail-tabs">
                            ${tabs}
                        </div>
                        <div class="detail-content" id="detail-content-${id}">
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
        if (tab === 'workflow') loadWorkflowDetail(id, isCourseView);
        else if (!isCourseView) {
            if (tab === 'reference') loadReferenceDetail(id);
            else if (tab === 'compare') loadCompareDetail(id);
            else loadCurriculumDetail(id);
        }
    });
}

async function loadWorkflowDetail(id, isCourseView) {
    const contentEl = document.getElementById(`detail-content-${id}`);
    if (!contentEl) return;

    try {
        const endpoint = isCourseView ? `/api/course/${id}/workflow` : `/api/program/${id}/workflow`;
        const res = await fetch(endpoint);
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

        let courseMetaHtml = '';
        if (isCourseView) {
            const course = allCourses.find(c => String(c.id) === String(id));
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

    // Replace <br> with spaces so text doesn't concatenate across line breaks
    div.querySelectorAll('br').forEach(el => el.replaceWith(document.createTextNode(' ')));

    // Strip all links — replace <a> with plain text, preserving spacing
    div.querySelectorAll('a').forEach(el => {
        // Add a space before if the previous node doesn't end with whitespace
        const prev = el.previousSibling;
        if (prev && prev.nodeType === 3 && prev.textContent && !/\s$/.test(prev.textContent)) {
            prev.textContent += ' ';
        }
        el.replaceWith(document.createTextNode(el.textContent));
    });

    // Strip all inline styles (removes red borders, cursor:pointer, etc. from CIM HTML)
    div.querySelectorAll('[style]').forEach(el => el.removeAttribute('style'));

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
    // Fix missing spaces where "and"/"or" run into adjacent text from stripped HTML tags.
    // Only split when a digit is immediately followed by "and"/"or" (e.g., "5001and" -> "5001 and")
    t = t.replace(/(\d)(and|or)\b/g, '$1 $2');
    // Or when "and"/"or" is immediately followed by an uppercase letter (e.g., "andCS" -> "and CS")
    t = t.replace(/\b(and|or)([A-Z])/g, '$1 $2');
    return t;
}

// Normalize for comparison: lowercase so case differences don't create false diffs
function normForCompare(s) {
    return normText(s).toLowerCase();
}

// Standardize section heading text for consistent display in Compare tab.
// Maps common CIM variations to uniform labels while preserving meaningful distinctions.
// Returns '' for instructional preambles that don't define a new section.
function standardizeHeader(text) {
    const t = text.trim();
    const s = t.toLowerCase();
    // Suppress instructional preambles that don't define a new section
    // (these appear as courselistcomment rows under an existing h2/h3 heading)
    if (/^complete all courses/i.test(t)) return '';
    if (/^a grade of/i.test(t)) return '';
    if (/^(program )?credit\/?gpa require/i.test(s)) return '';
    if (/^(gpa|major gpa|business gpa) requirement/i.test(s)) return '';
    if (/^program credit require/i.test(s)) return '';
    if (/^\d+ total semester hours required/i.test(t)) return '';
    if (/^minimum \d+\.\d+ gpa required/i.test(t)) return '';
    if (/^must be taken in alignment/i.test(t)) return '';
    if (/^students must complete/i.test(t)) return '';
    if (/^nupath requirements/i.test(s)) return '';
    // Required/core variations → "Required Courses"
    if (/^(core requirements?|required courses?|program requirements?)$/i.test(t)) return 'Required Courses';
    // Elective variations → "Elective Courses"
    if (/^(electives?|general electives?|required general electives?)$/i.test(t)) return 'Elective Courses';
    // Restricted electives → keep distinct
    if (/^restricted electives?$/i.test(t)) return 'Restricted Electives';
    // Supporting courses → keep
    if (/^supporting courses/i.test(t)) return 'Supporting Courses';
    // "Complete the following:" is just a preamble, not a section
    if (/^complete the following[:.]/i.test(t)) return '';
    // "Complete one/two/three of the following..." → elective with count
    const wordCount = s.match(/^complete (one|two|three|four|five|six) of the following/);
    if (wordCount) {
        const nums = {one:'1',two:'2',three:'3',four:'4',five:'5',six:'6'};
        return 'Elective Courses (choose ' + (nums[wordCount[1]] || wordCount[1]) + ')';
    }
    // "Complete N semester hours from restricted electives..." → Restricted Electives (N hours)
    const restrictedHours = s.match(/^complete (\d+) semester hours? from (?:the )?restricted elective/);
    if (restrictedHours) return 'Restricted Electives (' + restrictedHours[1] + ' hours)';
    // "Complete N semester hours from other electives..." → Other Electives (N hours)
    const otherHours = s.match(/^complete (\d+) semester hours? from (?:the )?other elective/);
    if (otherHours) return 'Other Electives (' + otherHours[1] + ' hours)';
    // "Complete N semester hours from the following..." or "...of the following..." → Elective Courses (N hours)
    const semHours = s.match(/^complete (\d+) semester hours? (?:from|of)(?: the| within the)? following/);
    if (semHours) return 'Elective Courses (' + semHours[1] + ' hours)';
    // "Complete N semester hours of general electives" → Elective Courses (N hours)
    const genElec = s.match(/^complete (\d+) semester hours? of (?:general )?elective/);
    if (genElec) return 'Elective Courses (' + genElec[1] + ' hours)';
    // "Complete N semester hours from..." (other patterns) → Elective Courses (N hours)
    const anyHours = s.match(/^complete (\d+) semester hours/);
    if (anyHours) return 'Elective Courses (' + anyHours[1] + ' hours)';
    // "Complete at least one of the following..." → elective
    if (/^complete at least one/i.test(t)) return 'Elective Courses (choose 1+)';
    // "Complete one of the following options:" → keep as options header
    if (/^complete one of the following options/i.test(t)) return '';
    // "In consultation with advisor, complete N..." → Elective Courses (N hours)
    const advisorHours = s.match(/^in consultation with advisor,? complete (\d+)/);
    if (advisorHours) return 'Elective Courses (' + advisorHours[1] + ' hours)';
    // Everything else: keep original text
    return t;
}

// Extract course lines from curriculum HTML for comparison.
// Returns array of {key, code, title, hours, isHeader, section} objects.
// Processes both table rows (areaheader, course rows) and HTML headings (h2, h3, h4)
// that appear between tables in CIM curriculum HTML.
function extractCourseLines(html) {
    const div = document.createElement('div');
    div.innerHTML = cleanCurriculumHtml(html);
    const lines = [];
    const courseCodePattern = /^[A-Z]{2,5}\s+\d{4}/i;

    let currentSection = '';

    // Walk all elements in document order to catch both h2/h3 headings and table rows.
    // CIM HTML uses h2/h3 for section headers outside tables (e.g., "Core Requirements",
    // "Coursework Option") and areaheader class for headers inside tables.
    const allElements = div.querySelectorAll('h2, h3, h4, tr');
    allElements.forEach(el => {
        const tag = el.tagName.toLowerCase();

        // Handle h2/h3/h4 headings (section headers outside tables)
        if (tag === 'h2' || tag === 'h3' || tag === 'h4') {
            const text = standardizeHeader(normText(el.textContent));
            if (text && text.length > 1) {
                currentSection = text;
                lines.push({key: '', code: '', title: text, hours: '', isHeader: true, section: text});
            }
            return;
        }

        // Handle table rows (existing logic)
        const cells = el.querySelectorAll('td, th');
        if (cells.length === 0) return;
        const parts = Array.from(cells).map(c => normText(c.textContent)).filter(Boolean);
        if (parts.length === 0) return;

        const isAreaHeader = el.classList.contains('areaheader') || el.querySelector('.areaheader') !== null;
        const hasCode = parts.some(p => courseCodePattern.test(p));
        const hasOr = parts.some(p => /^or\s+[A-Z]{2,5}\s+\d{4}/i.test(p));

        // Skip column-header rows (Code/Title/Hours)
        if (parts.some(p => /^Code$/i.test(p)) && parts.some(p => /^Title$/i.test(p))) return;

        if (isAreaHeader) {
            const text = standardizeHeader(parts.join(' '));
            if (text) {
                currentSection = text;
                lines.push({key: '', code: '', title: text, hours: '', isHeader: true, section: text});
            }
        } else if (hasCode || hasOr) {
            const codecol = parts[0] || '';
            const titlecol = parts.length > 2 ? parts[1] : (parts.length === 2 && !/^\d+$/.test(parts[1]) ? parts[1] : '');
            const hourscol = parts.length > 2 ? parts[2] : (parts.length === 2 && /^\d+$/.test(parts[1]) ? parts[1] : '');
            lines.push({key: codecol + '\t' + titlecol, code: codecol, title: titlecol, hours: hourscol, isHeader: false, section: currentSection});
        } else {
            // Non-course context row — run through standardizeHeader to suppress
            // instructional preambles (returns '') and normalize meaningful headers
            const raw = parts.join(' ');
            if (raw.length > 2) {
                const text = standardizeHeader(raw);
                if (text) {
                    currentSection = text;
                    lines.push({key: '', code: '', title: text, hours: '', isHeader: true, section: text});
                }
            }
        }
    });
    return lines;
}

// Classify a section header as 'elective', 'required', or 'other'.
// Used to detect meaningful section moves (required↔elective) without
// false-flagging different wording for the same category.
function classifySection(sectionText) {
    const s = sectionText.toLowerCase();
    if (/\belective/.test(s) || /\bcomplete\s+one\s+of/.test(s) || /\bchoose\s/.test(s) || /\bselect\s/.test(s)) {
        return 'elective';
    }
    // "required", "core", "complete all", or generic instruction → required/core
    return 'required';
}

// Simple diff algorithm (longest common subsequence based)
// Compares using case-insensitive normalization but preserves original structured data
// Headers are excluded from diff matching and re-inserted as context rows
function diffLines(oldLines, newLines) {
    // Separate headers from courses, tracking which header precedes each course
    function splitHeadersAndCourses(lines) {
        const courses = [];
        const headerMap = {}; // courseIndex -> header item
        let lastHeader = null;
        for (const line of lines) {
            if (line.isHeader) {
                lastHeader = line;
            } else {
                headerMap[courses.length] = lastHeader;
                courses.push(line);
                lastHeader = null;
            }
        }
        return { courses, headerMap };
    }
    const oldSplit = splitHeadersAndCourses(oldLines);
    const newSplit = splitHeadersAndCourses(newLines);
    const oldCourses = oldSplit.courses, newCourses = newSplit.courses;

    const oldNorm = oldCourses.map(l => normForCompare(l.key));
    const newNorm = newCourses.map(l => normForCompare(l.key));
    const m = oldCourses.length, n = newCourses.length;
    const dp = Array.from({length: m + 1}, () => new Uint16Array(n + 1));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldNorm[i-1] === newNorm[j-1]) dp[i][j] = dp[i-1][j-1] + 1;
            else dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]);
        }
    }
    // Backtrack to build diff of courses only
    const courseDiff = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldNorm[i-1] === newNorm[j-1]) {
            courseDiff.unshift({type: 'same', leftIdx: i-1, rightIdx: j-1, left: oldCourses[i-1], right: newCourses[j-1]});
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
            courseDiff.unshift({type: 'added', leftIdx: null, rightIdx: j-1, left: null, right: newCourses[j-1]});
            j--;
        } else {
            courseDiff.unshift({type: 'removed', leftIdx: i-1, rightIdx: null, left: oldCourses[i-1], right: null});
            i--;
        }
    }
    // Re-insert headers before the first course in their section.
    // Each side's headers are shown independently on that side only, so that
    // courses stay under their correct heading even when sections differ.
    const result = [];
    const usedLeftHeaders = new Set();
    const usedRightHeaders = new Set();
    const emptyHeader = {key: '', code: '', title: '', hours: '', isHeader: true};
    for (const d of courseDiff) {
        const lh = d.leftIdx !== null ? oldSplit.headerMap[d.leftIdx] : null;
        const rh = d.rightIdx !== null ? newSplit.headerMap[d.rightIdx] : null;
        const showLeft = lh && !usedLeftHeaders.has(lh.title);
        const showRight = rh && !usedRightHeaders.has(rh.title);

        if (showLeft && showRight && normForCompare(lh.title) === normForCompare(rh.title)) {
            // Same header on both sides — single row
            result.push({type: 'same', left: lh, right: rh});
            usedLeftHeaders.add(lh.title);
            usedRightHeaders.add(rh.title);
        } else {
            if (showLeft) {
                result.push({type: 'same', left: lh, right: emptyHeader});
                usedLeftHeaders.add(lh.title);
            }
            if (showRight) {
                result.push({type: 'same', left: emptyHeader, right: rh});
                usedRightHeaders.add(rh.title);
            }
        }
        // Mark courses that match but moved between section categories
        // (e.g. required → elective). Different wording for the same category
        // (e.g. "Required Courses" vs "Complete all courses...") is not flagged.
        let type = d.type;
        if (type === 'same' && d.left && d.right && !d.left.isHeader && d.left.section && d.right.section &&
            classifySection(d.left.section) !== classifySection(d.right.section)) {
            type = 'moved';
        }
        result.push({type, left: d.left, right: d.right});
    }
    return result;
}

// Render a single side's cell content
function renderCourseCell(item, cls) {
    if (!item) return `<td class="${cls}" colspan="3"></td>`;
    if (item.isHeader) {
        return `<td class="${cls} cmp-header" colspan="3">${escapeHtml(item.title)}</td>`;
    }
    return `<td class="${cls} cmp-code">${escapeHtml(item.code)}</td>` +
           `<td class="${cls} cmp-title">${escapeHtml(item.title)}</td>` +
           `<td class="${cls} cmp-hours">${escapeHtml(item.hours)}</td>`;
}

// Render a side-by-side comparison table
function renderSideBySide(diff, leftLabel, rightLabel) {
    let rows = diff.map(d => {
        if (d.type === 'same') {
            return `<tr>${renderCourseCell(d.left, 'cmp-same')}` +
                   `<td class="cmp-divider"></td>` +
                   `${renderCourseCell(d.right, 'cmp-same')}</tr>`;
        } else if (d.type === 'moved') {
            return `<tr>${renderCourseCell(d.left, 'cmp-moved')}` +
                   `<td class="cmp-divider"></td>` +
                   `${renderCourseCell(d.right, 'cmp-moved')}</tr>`;
        } else if (d.type === 'removed') {
            return `<tr>${renderCourseCell(d.left, 'cmp-removed')}` +
                   `<td class="cmp-divider"></td>` +
                   `${renderCourseCell(null, 'cmp-empty')}</tr>`;
        } else {
            return `<tr>${renderCourseCell(null, 'cmp-empty')}` +
                   `<td class="cmp-divider"></td>` +
                   `${renderCourseCell(d.right, 'cmp-added')}</tr>`;
        }
    }).join('');

    return `<table class="compare-table">
        <thead><tr>
            <th colspan="3" class="cmp-left-header">${escapeHtml(leftLabel)}</th>
            <th class="cmp-divider"></th>
            <th colspan="3" class="cmp-right-header">${escapeHtml(rightLabel)}</th>
        </tr></thead>
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

            const {identical, diff} = compareCurricula(currHtml, refHtml);
            updateCompareButton(programId, identical);

            const header = refData.version_date
                ? `<div class="reference-header">Comparing against: ${escapeHtml(refData.version_date)}</div>`
                : '';

            if (identical) {
                contentEl.innerHTML = `${header}<div class="compare-identical">Curriculum is identical to the Boston reference.</div>`;
            } else {
                const table = renderSideBySide(diff, getProgramName(programId), 'Boston Reference');
                contentEl.innerHTML = `${header}
                    <div class="compare-legend">
                        <span class="compare-legend-item"><span class="legend-box diff-removed-bg"></span> Only in this version</span>
                        <span class="compare-legend-item"><span class="legend-box diff-added-bg"></span> Only in reference</span>
                        <span class="compare-legend-item"><span class="legend-box diff-moved-bg"></span> Moved between sections</span>
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

                const {identical, diff} = compareCurricula(depHtml, currHtml);
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
                        <span class="compare-legend-item"><span class="legend-box diff-removed-bg"></span> Only in ${escapeHtml(dep.name)}</span>
                        <span class="compare-legend-item"><span class="legend-box diff-added-bg"></span> Only in Boston</span>
                        <span class="compare-legend-item"><span class="legend-box diff-moved-bg"></span> Moved between sections</span>
                    </div>`;
                    html += renderSideBySide(dep.diff, dep.name, 'Boston');
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

            const {identical, diff} = compareCurricula(currHtml, refHtml);
            updateCompareButton(programId, identical);

            if (identical) {
                contentEl.innerHTML = '<div class="compare-identical">Current curriculum is identical to the last approved version.</div>';
            } else {
                const table = renderSideBySide(diff, 'Current Proposal', 'Last Approved');
                contentEl.innerHTML = `<div class="compare-legend">
                    <span class="compare-legend-item"><span class="legend-box diff-removed-bg"></span> Only in proposal</span>
                    <span class="compare-legend-item"><span class="legend-box diff-added-bg"></span> Only in approved</span>
                    <span class="compare-legend-item"><span class="legend-box diff-moved-bg"></span> Moved between sections</span>
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

// DOMContentLoaded handled by static override

// Auto-refresh every 2 minutes (data display only, not scanning)
// Auto-refresh disabled in static mode


/* ======= STATIC SITE DATA LAYER ======= */
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

    // Patch courses dashboard + loaders to use embedded data (no server).
    window.loadCoursesDashboard = async function() {
        const D = await _getData();
        allCourses = D.courses || [];
        cachedCoursePipeline = collapseCoursePipeline(D.course_pipeline || []);
        renderPipeline(cachedCoursePipeline, allCourses);
        populateCourseStepFilter();
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
