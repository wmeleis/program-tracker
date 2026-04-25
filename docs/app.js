/* Program Approval Tracker - Frontend Logic */

let allPrograms = [];
let allCourses = [];
let allCatalogPages = [];
let cachedCatalogPipeline = [];
let currentView = 'programs'; // 'programs', 'courses', or 'catalog'
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
    const btnCat = document.getElementById('btn-catalog');
    if (btnCat) btnCat.classList.toggle('active', view === 'catalog');

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
    const subjectSel = document.getElementById('filter-subject');
    if (subjectSel) subjectSel.value = '';

    // Hide/show sections based on view
    const typeSection = document.querySelector('.view-group');
    const proposalSection = document.querySelectorAll('.view-group')[1];
    const campusFilter = document.getElementById('filter-campus');

    const subjectGroup = document.getElementById('filter-group-subject');
    if (view === 'courses') {
        typeSection.style.display = 'flex';
        proposalSection.style.display = 'flex';
        campusFilter.parentElement.parentElement.style.display = 'none';
        if (subjectGroup) subjectGroup.style.display = 'flex';
    } else if (view === 'catalog') {
        // Catalog has no degree types, no proposal types, no college/campus
        // metadata — hide all those filter groups. Just keep the search box
        // (filters by path/title) and the pipeline tile clicks.
        typeSection.style.display = 'none';
        proposalSection.style.display = 'none';
        campusFilter.parentElement.parentElement.style.display = 'none';
        if (subjectGroup) subjectGroup.style.display = 'none';
    } else {
        typeSection.style.display = 'flex';
        proposalSection.style.display = 'flex';
        campusFilter.parentElement.parentElement.style.display = 'flex';
        if (subjectGroup) subjectGroup.style.display = 'none';
    }

    // Update proposal button labels for Programs vs Courses
    const newBtn = document.getElementById('btn-proposal-new');
    if (newBtn) newBtn.textContent = view === 'courses' ? 'New Courses' : 'New Programs';
    // Continuing only applies to courses
    const contBtn = document.getElementById('btn-type-continuing');
    if (contBtn) contBtn.style.display = view === 'courses' ? 'inline-block' : 'none';
    // Update search placeholder
    const searchEl = document.getElementById('filter-search');
    if (searchEl) {
        searchEl.placeholder = view === 'courses'
            ? 'Search courses by code or title...'
            : 'Search programs by name or banner code...';
    }

    // Reload appropriate data
    if (view === 'programs') {
        loadDashboard();
    } else if (view === 'courses') {
        loadCoursesDashboard();
    } else if (view === 'catalog') {
        loadCatalogDashboard();
    }
}

// ==================== Catalog dashboard ====================

async function loadCatalogDashboard() {
    try {
        const [pipelineRes, pagesRes] = await Promise.all([
            fetch('/api/catalog_pipeline'),
            fetch('/api/catalog'),
        ]);
        cachedCatalogPipeline = (await pipelineRes.json()).pipeline || [];
        allCatalogPages = (await pagesRes.json()).catalog_pages || [];
        renderCatalogPipeline();
        renderCatalogTable();
    } catch (e) {
        console.error('catalog load failed', e);
    }
}

function renderCatalogPipeline() {
    const bar = document.getElementById('pipeline-bar');
    if (!bar) return;
    // Catalog has no "College" pseudo-tile — every catalog page IS in one of
    // the UCAT/GCAT roles or it isn't tracked.
    const html = cachedCatalogPipeline.map(step => {
        const hasItems = step.count > 0;
        const activeClass = pipelineFilter === step.role ? ' active' : '';
        return `
            <div class="pipeline-step ${hasItems ? 'has-items' : 'empty'}${activeClass}"
                 onclick="togglePipelineFilter('${step.role}')"
                 title="${step.role}: ${step.count} pages">
                <span class="step-count">${step.count}</span>
                <span class="step-name">${escapeHtml(step.short_name)}</span>
            </div>
        `;
    }).join('');
    bar.innerHTML = html;
    // Hide the Complete button on Catalog view (no completion concept yet)
    const completeBtn = document.getElementById('btn-proposal-complete');
    if (completeBtn) completeBtn.style.display = 'none';
}

function renderCatalogTable() {
    const container = document.getElementById('programs-table-container');
    if (!container) return;
    const search = (document.getElementById('filter-search')?.value || '').toLowerCase();
    let pages = (allCatalogPages || []).slice();
    if (pipelineFilter) {
        pages = pages.filter(p => p.current_step === pipelineFilter);
    }
    if (search) {
        pages = pages.filter(p =>
            (p.id || '').toLowerCase().includes(search) ||
            (p.title || '').toLowerCase().includes(search)
        );
    }
    document.getElementById('result-count').textContent = `${pages.length} pages`;
    if (pages.length === 0) {
        container.innerHTML = '<p class="empty-state">No catalog pages match your filters.</p>';
        return;
    }
    let html = `
        <table class="program-table">
            <thead><tr>
                <th>Page Path</th>
                <th>Title</th>
                <th>Current Role</th>
                <th>Approver</th>
            </tr></thead>
            <tbody>`;
    for (const p of pages) {
        const path = p.id || '';
        const url = `https://nextcatalog.northeastern.edu${path}/`;
        html += `<tr class="program-row">
            <td class="catalog-path"><a href="${escapeHtml(url)}" target="_blank">${escapeHtml(path)}</a></td>
            <td><strong>${escapeHtml(p.title || '')}</strong></td>
            <td>${escapeHtml(p.current_step || '')}</td>
            <td>${escapeHtml(p.user || '')}</td>
        </tr>`;
    }
    html += '</tbody></table>';
    container.innerHTML = html;
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
    // Header search clear button
    const hs = document.getElementById('filter-search');
    const clear = document.querySelector('.header-search-clear');
    if (hs && clear) {
        clear.classList.toggle('visible', !!hs.value);
    }
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
    "Provost Committee Assignment",
    "Provost Continuing Education Module Oversight Group",
    "Provost Continuing Education Module Oversight Group Hold",
    "Course Review 2",
    "Course Review 3",
    "Course Review Group",
    "Course Review Group Complete - Hold",
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
    "REGISTRAR Digital Badge Setup",
    "REGISTRAR Digital Badge Setup Hold",
    "REGISTRAR Scheduling Office",
    "Banner - Prereq 2 Letter Course Number",
    "Banner",
    "Editor",
]);

// Course pipeline buckets: several raw workflow steps collapse to one button.
// Display only — underlying DB step names are unchanged.
//
// Ordering: appears in the pipeline bar left-to-right in roughly chronological
// workflow order (Checkpoint and Course Review groups early; Data Entry /
// Registrar / Banner / Editor late). The "College" pseudo-bucket is rendered
// separately as the first tile.
const COURSE_BUCKETS = [
    {
        role: 'Checkpoint',
        short_name: 'Checkpoint',
        match: step => step === 'Checkpoint',
    },
    {
        role: 'Course Review',
        short_name: 'Course Review',
        match: step => step === 'Course Review 2' || step === 'Course Review 3' || step === 'PS Course Review',
    },
    {
        role: 'Course Review Group',
        short_name: 'Review Grp',
        match: step => typeof step === 'string' && step.startsWith('Course Review Group'),
    },
    {
        role: 'OTP',
        short_name: 'OTP',
        // "Provost ..." is the OTP family. "Program Provost ..." also covers
        // provost-level course steps that chain into program approval.
        match: step => typeof step === 'string' &&
            (step.startsWith('Provost') || step.startsWith('Program Provost')),
    },
    {
        role: 'Subcommittees',
        short_name: 'Subcommittees',
        // Graduate Council Subcommittees One/Two and Undergraduate UUCC
        // Subcommittees One/Two — committee-stage course reviews.
        match: step => typeof step === 'string' &&
            (step.startsWith('Graduate Council Subcommittee') ||
             step.startsWith('UUCC Subcommittee')),
    },
    {
        role: 'Grad Curric',
        short_name: 'Grad Curric',
        // Graduate Curriculum Committee Chair (and the Undergraduate Chair
        // for symmetry) — top-level curriculum committee review.
        match: step => step === 'Graduate Curriculum Committee Chair'
            || step === 'Undergraduate Curriculum Committee Chair',
    },
    {
        role: 'GRA Regulatory',
        short_name: 'GRA Reg',
        match: step => step === 'Course GRA Regulatory Validation',
    },
    {
        role: 'Data Entry',
        short_name: 'Data Entry',
        match: step => typeof step === 'string' && step.startsWith('Data Entry'),
    },
    {
        role: 'Registrar',
        short_name: 'Registrar',
        match: step => typeof step === 'string' &&
            (step.startsWith('REGISTRAR') || step === 'Degree Audit Courses'),
    },
    {
        role: 'Banner',
        short_name: 'Banner',
        match: step => typeof step === 'string' && (step === 'Banner' || step.startsWith('Banner ') || step.startsWith('Banner-')),
    },
    {
        role: 'Editor',
        short_name: 'Editor',
        match: step => typeof step === 'string' &&
            (step === 'Editor' || step.startsWith('Editor ') || step.startsWith('Editor-')),
    },
];

function isCourseCollegeStep(step) {
    // The "College" tile is a catch-all: any course step that is NOT matched
    // by one of the explicit COURSE_BUCKETS above (e.g. department chairs,
    // college committees, graduate council subcommittees, UUCC subcommittees,
    // individual reviewers assigned directly) falls here. Guarantees every
    // active course maps to exactly one pipeline tile.
    if (!step) return false;
    for (const b of COURSE_BUCKETS) {
        if (b.match(step)) return false;
    }
    return true;
}

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
        }
        // Unbucketed roles (e.g. Graduate Council Subcommittee One/Two,
        // Graduate Curriculum Committee Chair, individual reviewers) don't get
        // their own pipeline tile — they're caught by the College pseudo-tile
        // which counts via isCourseCollegeStep per course.
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
        populateCourseSubjectFilter();
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

function courseSubjectCode(course) {
    // Subject code = leading letters of the course code (e.g. "CAEP 6326" -> "CAEP")
    const code = (course.code || '').trim();
    const m = code.match(/^([A-Za-z]+)/);
    return m ? m[1].toUpperCase() : '';
}

function populateCourseSubjectFilter() {
    const select = document.getElementById('filter-subject');
    if (!select) return;
    const subjects = new Set();
    allCourses.forEach(c => {
        const s = courseSubjectCode(c);
        if (s) subjects.add(s);
    });
    const sorted = Array.from(subjects).sort();
    const current = select.value;
    const options = sorted.map(s => `<option value="${s}">${s}</option>`).join('');
    select.innerHTML = '<option value="">All Subjects</option>' + options;
    if (sorted.includes(current)) select.value = current;
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
    const src = programs || (currentView === 'courses' ? allCourses : allPrograms);
    const counts = { '': src.length, 'Added': 0, 'Edited': 0, 'Deactivated': 0 };
    src.forEach(p => {
        const s = p.status || '';
        if (counts[s] !== undefined) counts[s]++;
    });
    document.querySelectorAll('.proposal-btn').forEach(btn => {
        const s = btn.getAttribute('onclick').match(/'([^']*)'/)[1];
        // The Complete button shares this row visually but is a workflow-state
        // filter, not a proposal-type filter — show its own static count.
        if (btn.id === 'btn-proposal-complete') {
            const pool = currentView === 'courses' ? (allCourses || []) : (allPrograms || []);
            const completeCount = pool.filter(p => p.completion_date).length;
            btn.textContent = `Complete (${completeCount})`;
            return;
        }
        const count = counts[s] || 0;
        const newLabel = currentView === 'courses' ? 'New Courses' : 'New Programs';
        const labels = { '': 'All', 'Added': newLabel, 'Edited': 'Changes', 'Deactivated': 'Inactivations' };
        btn.textContent = `${labels[s]} (${count})`;
    });
}

// Classify a course as 'Undergraduate', 'Graduate', or 'Other'.
// Uses academic_level field from XML if present, else course number heuristic:
// 1000-4999 -> Undergraduate, 5000+ -> Graduate.
function classifyCourseLevel(course) {
    const lvl = (course.academic_level || '').toUpperCase();
    // CIM uses codes: UG = Undergraduate, GR = Graduate, CP = Continuing Professional, GR-UG = both
    if (lvl === 'UG') return 'Undergraduate';
    if (lvl === 'GR') return 'Graduate';
    if (lvl === 'CP') return 'Continuing';
    if (lvl === 'GR-UG' || lvl === 'UG-GR') return 'Graduate';
    if (lvl.includes('UNDERGRAD')) return 'Undergraduate';
    if (lvl.includes('GRAD')) return 'Graduate';
    const m = (course.code || '').match(/\b(\d{4})\b/);
    if (m) {
        const n = parseInt(m[1], 10);
        if (n >= 1000 && n < 5000) return 'Undergraduate';
        if (n >= 5000) return 'Graduate';
    }
    return 'Other';
}

function updateTypeCounts(programs) {
    const src = programs || (currentView === 'courses' ? allCourses : allPrograms);
    const counts = { '': src.length };
    src.forEach(p => {
        const t = currentView === 'courses' ? classifyCourseLevel(p) : (p.program_type || 'Other');
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

// Format a completion date for the Days column on completed rows.
// Accepts:
//   - ISO or the "Tue, 03 Feb 2026 17:21:11 GMT" CIM format → "Approved MM/DD/YYYY"
//   - "Catalog 2022-2023" surrogate (programs)            → returned as-is
//   - "Term 202630" surrogate (courses)                   → returned as-is
//   - "Approved" placeholder                              → returned as-is
function formatCompletionDate(s) {
    if (!s) return 'Approved';
    if (s.startsWith('Catalog ') || s.startsWith('Term ') || s === 'Approved') return s;
    const d = new Date(s);
    if (isNaN(d)) return 'Approved ' + s;
    return 'Approved ' + (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
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

    // The Complete filter button lives in the proposal-btn row (not the
    // pipeline bar) — keep its active state in sync with pipelineFilter.
    // Shown on both Programs and Courses views; the row-render logic handles
    // the different table shapes.
    const completeBtn = document.getElementById('btn-proposal-complete');
    if (completeBtn) {
        completeBtn.classList.toggle('active-complete', pipelineFilter === '__complete__');
        completeBtn.style.display = '';
    }
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
        if (!ex.type && typeFilter) {
            const lvl = currentView === 'courses' ? classifyCourseLevel(item) : item.program_type;
            if (lvl !== typeFilter) return false;
        }
        if (!ex.proposal && proposalFilter && item.status !== proposalFilter) return false;
        if (!ex.college && collegeFilter && item.college !== collegeFilter) return false;
        if (currentView === 'courses') {
            const subjSel = document.getElementById('filter-subject');
            const subjectFilter = subjSel ? subjSel.value : '';
            if (subjectFilter && courseSubjectCode(item) !== subjectFilter) return false;
        }
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
    // Catalog view has a fundamentally different schema (paths instead of
    // numeric IDs, no college/type/proposal/campus dimensions). It has its
    // own minimal renderer rather than going through the program/course
    // filter pipeline below.
    if (currentView === 'catalog') {
        renderCatalogPipeline();
        renderCatalogTable();
        return;
    }
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
        if (pipelineFilter === '__complete__') {
            return !!p.completion_date;
        }
        if (pipelineFilter && pipelineFilter !== '__college__') {
            if (bucketDef) {
                if (!bucketDef.match(p.current_step)) return false;
            } else if (p.current_step !== pipelineFilter) return false;
        }
        // Default: hide completed programs unless the Complete tile is active
        if (!pipelineFilter && p.completion_date && !p.current_step) return false;
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

    const headerColLabel = 'College';
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
        const collegeDisplay = abbreviateCollege(item.college);
        const isComplete = !!item.completion_date && !item.current_step;
        const progress = isComplete ? 100 :
            (item.total_steps > 0 ? (item.completed_steps / item.total_steps * 100) : 0);
        const progressClass = isComplete ? 'complete' :
            (progress < 33 ? 'early' : progress < 66 ? 'mid' : 'late');
        const rowClass =
            (item.status === 'Added' ? 'row-added' :
             item.status === 'Edited' ? 'row-edited' :
             item.status === 'Deactivated' ? 'row-deactivated' : 'row-edited') +
            (isComplete ? ' row-complete' : '');
        const days = getDaysAtStep(item);
        const daysClass = days < 14 ? 'fresh' : days < STUCK_THRESHOLD_DAYS ? 'aging' : 'stuck';

        const stepCellText = isComplete
            ? `<em class="muted">Approved</em>`
            : (item.current_step || '—');
        const progressCell = isComplete
            ? `<div class="progress-container">
                <div class="progress-bar"><div class="progress-fill complete" style="width:100%"></div></div>
                <span class="progress-text">${item.total_steps}/${item.total_steps}</span>
               </div>`
            : `<div class="progress-container">
                <div class="progress-bar"><div class="progress-fill ${progressClass}" style="width: ${progress}%"></div></div>
                <span class="progress-text">${item.completed_steps}/${item.total_steps}</span>
               </div>`;
        const daysCell = isComplete
            ? `<span class="days-at-step complete" title="Approved on ${escapeHtml(item.completion_date || '')}">${escapeHtml(formatCompletionDate(item.completion_date))}</span>`
            : `<span class="days-at-step ${daysClass}" title="Days at current step">${days}d</span>`;

        html += `
            <tr class="program-row ${rowClass} ${expanded ? 'expanded' : ''}"
                onclick="toggleRow('${id}')">
                <td><strong>${escapeHtml(itemDisplay)}</strong></td>
                <td title="${escapeHtml(item.college || '')}">${escapeHtml(collegeDisplay)}</td>
                <td>${stepCellText}</td>
                <td>${progressCell}</td>
                <td>${daysCell}</td>
            </tr>
        `;

        if (expanded) {
            const activeTab = detailTabState[id] || 'workflow';
            // Only show Regulatory tab when this program has an approved-courses
            // match on file (from the SharePoint regulatory workbooks).
            const hasReg = !isCourseView && item.has_regulatory === true;
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
                    onclick="event.stopPropagation(); switchDetailTab(${id}, 'compare')">Compare</button>` +
                (hasReg ? `
                <button class="detail-tab ${activeTab === 'regulatory' ? 'active' : ''}"
                    onclick="event.stopPropagation(); switchDetailTab(${id}, 'regulatory')">Regulatory</button>` : '');

            html += `
                <tr class="workflow-detail" id="detail-${id}">
                    <td colspan="5">
                        <div class="detail-tabs">
                            ${tabs}
                            <input type="text" class="detail-search"
                                id="detail-search-${id}"
                                placeholder="Search within this page..."
                                oninput="filterDetailContent(${id})"
                                onclick="event.stopPropagation()">
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
            else if (tab === 'regulatory') loadRegulatoryDetail(id);
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

    // Remove a labeled section: the heading itself plus following content until
    // the next heading of the same or higher level (or the next h2/h3/h4).
    // Stopping at any heading prevents greedy deletion of later sections that
    // use a different heading level (e.g., concentrations as <h3> after a
    // Program Credit/GPA Requirements <h2>).
    function removeLabeledSection(headingSelector, isMatch) {
        div.querySelectorAll(headingSelector).forEach(h => {
            if (!isMatch(h)) return;
            let node = h.nextSibling;
            while (node) {
                const next = node.nextSibling;
                if (node.nodeName && /^H[1-6]$/.test(node.nodeName)) break;
                node.parentNode.removeChild(node);
                node = next;
            }
            h.remove();
        });
    }

    removeLabeledSection('h2', h => h.textContent.trim() === 'Program Overview');
    removeLabeledSection('h3, h4', h => h.textContent.trim() === 'Milestone');
    removeLabeledSection('h2, h3', h => h.textContent.trim() === 'Research Areas');
    // NOTE: Program Credit/GPA Requirements is no longer stripped because in
    // umbrella programs that section also contains the Pathway Options form
    // (Program Pathway vs Project Pathway), which is part of the curriculum.

    // --- Heading/areaheader classification for visual hierarchy ---
    // Concentration headings: make them pop (bold + accent color)
    div.querySelectorAll('h2, h3, h4').forEach(h => {
        if (/\bconcentration\b/i.test(h.textContent)) {
            h.classList.add('ref-concentration');
        }
    });

    // Area headers inside course tables: classify then remove decorative-only ones.
    // A row is "decorative" if it just groups a list of courses visually ("Process
    // Sciences Focus", "Artificial Intelligence Focus") — no "Required", "Option",
    // "Complete N semester hours", "Electives", "Core".
    const CHOICE_RE = /\b(required|core|elective|option|choose|complete\s*\d|\d+\s*semester|must|in consultation|any\s+\d|pathway)\b/i;
    // "Focus / Track / Area / Group" are pure grouping labels in the curriculum
    // (e.g., "Process Sciences Focus"). "Pathway" is NOT in this list — pathways
    // (Program Pathway, Project Pathway) are meaningful structural choices.
    const DECORATIVE_SUFFIX_RE = /\b(focus|track|area|group)s?\s*$/i;
    // "Complete the 3 Semester Hours Project Course..." style preambles
    // that just describe the course row immediately following them.
    const REDUNDANT_COURSE_INTRO_RE = /^complete\s+(?:the|a)\s+\d+\s+semester\s+hour.*?\bcourse\b/i;
    div.querySelectorAll('tr.areaheader, tr.areasubheader').forEach(tr => {
        const text = (tr.textContent || '').trim();
        if (!text) return;
        if (REDUNDANT_COURSE_INTRO_RE.test(text)) {
            tr.remove();
            return;
        }
        const isChoice = CHOICE_RE.test(text);
        const isDecorative = !isChoice && DECORATIVE_SUFFIX_RE.test(text);
        if (isDecorative) {
            tr.remove();
            return;
        }
        // Option A/B/C and similar "you-pick-one" markers are choices but visually
        // quieter than required-vs-elective boundaries
        if (/^option\s+[A-Z]:?\s*/i.test(text) || /^complete\s+/i.test(text) || /^in consultation/i.test(text) || /^any\s+\d/i.test(text)) {
            tr.classList.add('ref-option');
        }
    });

    return div.innerHTML;
}

// ==================== Custom References ====================

let _customRefsCache = null;  // [{id, name, ...}]

async function loadCustomRefs(force) {
    if (_customRefsCache && !force) return _customRefsCache;
    try {
        const res = await fetch('/api/custom_references');
        const data = await res.json();
        _customRefsCache = data.references || [];
    } catch (e) {
        _customRefsCache = [];
    }
    return _customRefsCache;
}

function openReferencesModal() {
    document.getElementById('refs-modal').style.display = 'flex';
    renderRefsList();
}

function closeReferencesModal() {
    document.getElementById('refs-modal').style.display = 'none';
    // Reset upload form
    document.getElementById('ref-upload-form').reset();
    document.getElementById('ref-upload-status').textContent = '';
    document.getElementById('ref-upload-status').className = '';
}

function closeReferencesModalIfBackdrop(event) {
    if (event.target.id === 'refs-modal') closeReferencesModal();
}

async function renderRefsList() {
    const container = document.getElementById('refs-list');
    container.innerHTML = '<p class="empty-state">Loading...</p>';
    const refs = await loadCustomRefs(true);
    if (!refs.length) {
        container.innerHTML = '<p class="empty-state">No custom references yet. Upload a .docx above.</p>';
        return;
    }
    container.innerHTML = refs.map(r => {
        const meta = [
            r.source_filename || '',
            r.title ? `Title: ${escapeHtml(r.title)}` : '',
            r.notes ? `Notes: ${escapeHtml(r.notes)}` : '',
            r.created_at ? new Date(r.created_at).toLocaleString() : ''
        ].filter(Boolean).join(' · ');
        return `<div class="refs-list-item">
            <div class="refs-list-item-info">
                <div class="refs-list-item-name">${escapeHtml(r.name)}</div>
                <div class="refs-list-item-meta">${meta}</div>
            </div>
            <button class="refs-list-item-delete" onclick="deleteCustomRef(${r.id}, '${escapeHtml(r.name).replace(/'/g, "\\'")}')">Delete</button>
        </div>`;
    }).join('');
}

async function uploadCustomReference(event) {
    event.preventDefault();
    const fileEl = document.getElementById('ref-upload-file');
    const nameEl = document.getElementById('ref-upload-name');
    const notesEl = document.getElementById('ref-upload-notes');
    const submit = document.getElementById('ref-upload-submit');
    const status = document.getElementById('ref-upload-status');

    if (!fileEl.files || !fileEl.files[0]) return false;
    const fd = new FormData();
    fd.append('file', fileEl.files[0]);
    if (nameEl.value.trim()) fd.append('name', nameEl.value.trim());
    if (notesEl.value.trim()) fd.append('notes', notesEl.value.trim());

    submit.disabled = true;
    status.textContent = 'Parsing...';
    status.className = '';
    try {
        const res = await fetch('/api/custom_references', { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok) {
            status.textContent = data.detail || data.error || 'Upload failed';
            status.className = 'err';
            return false;
        }
        const nCourses = (data.sections || []).reduce((n, s) =>
            n + (s.courses || []).filter(c => !c.is_header).length, 0);
        const nSections = (data.sections || []).length;
        const warn = (data.warnings && data.warnings.length)
            ? ` (warnings: ${data.warnings.join('; ')})` : '';
        status.textContent = `Saved "${data.name}" — ${nSections} sections, ${nCourses} courses${warn}.`;
        status.className = 'ok';
        document.getElementById('ref-upload-form').reset();
        _customRefsCache = null;  // invalidate
        renderRefsList();
    } catch (e) {
        status.textContent = 'Upload failed: ' + (e.message || e);
        status.className = 'err';
    } finally {
        submit.disabled = false;
    }
    return false;
}

async function deleteCustomRef(refId, name) {
    if (!confirm(`Delete custom reference "${name}"? Any programs using it will revert to the auto reference.`)) return;
    try {
        const res = await fetch('/api/custom_references/' + refId, { method: 'DELETE' });
        if (!res.ok) {
            alert('Delete failed');
            return;
        }
        _customRefsCache = null;
        renderRefsList();
        // If any currently-expanded row was using this ref, it'll reload on next tab click
    } catch (e) {
        alert('Delete failed: ' + e.message);
    }
}

async function setProgramReferenceOverride(programId, customRefId) {
    try {
        await fetch(`/api/program/${programId}/reference_override`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ custom_reference_id: customRefId === 'auto' ? null : parseInt(customRefId, 10) })
        });
        // Reload the reference tab
        loadReferenceDetail(programId);
    } catch (e) {
        alert('Failed to set override: ' + e.message);
    }
}

async function buildRefSourcePickerHtml(programId, activeCustomRefId) {
    // Hide picker on the static site — no backend to accept the change
    if (window._staticMode) return '';
    const refs = await loadCustomRefs();
    if (!refs.length && !activeCustomRefId) return '';
    const options = ['<option value="auto"' + (!activeCustomRefId ? ' selected' : '') + '>Auto (Boston / CIM history)</option>'];
    for (const r of refs) {
        const sel = activeCustomRefId === r.id ? ' selected' : '';
        options.push(`<option value="${r.id}"${sel}>Custom: ${escapeHtml(r.name)}</option>`);
    }
    return `<div class="ref-source-picker">
        <label>Reference source:</label>
        <select onchange="setProgramReferenceOverride(${programId}, this.value)">${options.join('')}</select>
    </div>`;
}

// Format CIM's version_date for display. Input comes in a few shapes:
//   "Feb 24, 2023 by Nicole Davis (n.davis)"                         (own history)
//   "Jun 12, 2021 by Kate Klepper (k.klepper) (Boston version)"      (Boston counterpart)
//   "current proposal (Boston, in workflow)"                          (sentinel)
//   "Current curriculum (no prior approved version on file)"          (synthetic self-ref)
// For the two "approved" shapes we return "curriculum approved on <date> [suffix]";
// sentinels and self-refs pass through unchanged.
function formatReferenceVersionLabel(versionDate) {
    if (!versionDate) return '';
    const lower = versionDate.toLowerCase();
    if (lower.includes('in workflow') || lower.includes('no prior approved')) {
        return versionDate;
    }
    const m = versionDate.match(/^(.+?)\s+by\s+.+?\([^)]+\)(.*)$/);
    if (!m) return versionDate;
    const date = m[1].trim();
    const suffix = m[2].trim();
    return suffix ? `curriculum approved on ${date} ${suffix}` : `curriculum approved on ${date}`;
}

async function loadReferenceDetail(programId) {
    const contentEl = document.getElementById(`detail-content-${programId}`);
    if (!contentEl) return;
    contentEl.innerHTML = '<div class="workflow-loading">Loading reference curriculum...</div>';

    try {
        const res = await fetch(`/api/program/${programId}/reference`);
        const data = res.ok ? await res.json() : {};
        const activeCustomRefId = data.source === 'custom' ? data.custom_reference_id : null;
        const picker = await buildRefSourcePickerHtml(programId, activeCustomRefId);

        if (!res.ok || !data.curriculum_html) {
            contentEl.innerHTML = picker + '<div class="workflow-meta">No reference curriculum available. This may be a new program with no prior approvals. You can upload a custom reference from the "References" button at the top of the page.</div>';
            return;
        }
        const cleaned = cleanCurriculumHtml(data.curriculum_html);
        const label = data.source === 'custom' ? 'Custom reference' : 'Reference version';
        const displayDate = data.source === 'custom'
            ? data.version_date
            : formatReferenceVersionLabel(data.version_date);
        const header = displayDate
            ? `<div class="reference-header">${label}: ${escapeHtml(displayDate)}</div>`
            : '';
        contentEl.innerHTML = `${picker}${header}<div class="curriculum-content">${cleaned}</div>`;
    } catch (e) {
        contentEl.innerHTML = '<div class="workflow-meta">Failed to load reference curriculum.</div>';
    }
}

// Regulatory tab: render the current proposal with each course flagged against
// the SharePoint approved-course list for its regulatory campus. Flags:
//  - red   (regflag-missing) : course code not in the approved list at all
//  - amber (regflag-moved)   : course is approved but in a different section
//  - plain                   : course is approved in the same section
async function loadRegulatoryDetail(programId) {
    const contentEl = document.getElementById(`detail-content-${programId}`);
    if (!contentEl) return;
    contentEl.innerHTML = '<div class="workflow-loading">Loading regulatory data...</div>';

    try {
        const [currRes, regRes] = await Promise.all([
            fetch(`/api/program/${programId}/curriculum`),
            fetch(`/api/program/${programId}/regulatory`),
        ]);
        const currData = currRes.ok ? await currRes.json() : {};
        if (!regRes.ok) {
            contentEl.innerHTML = '<div class="workflow-meta">No regulatory approved-course list on file for this program.</div>';
            return;
        }
        const reg = await regRes.json();
        if (!reg.available || !Array.isArray(reg.courses) || reg.courses.length === 0) {
            contentEl.innerHTML = '<div class="workflow-meta">No regulatory approved-course list on file for this program.</div>';
            return;
        }

        // Build approved lookup: code -> Set of normalized sections it appears in.
        // Some SharePoint workbooks list the same course in multiple sections
        // (e.g. under both "Theory and Security" and a summary "CS 5100-CS 7880"
        // range). A proposal course is "in the same section" if it matches any
        // of the approved sections for that code.
        const approvedBySection = new Map();
        const approvedCount = reg.courses.length;
        const uniqueApprovedCodes = new Set();
        for (const c of reg.courses) {
            if (!c || !c.code) continue;
            const key = c.code.toUpperCase().replace(/\s+/g, ' ').trim();
            uniqueApprovedCodes.add(key);
            if (!approvedBySection.has(key)) approvedBySection.set(key, new Set());
            approvedBySection.get(key).add(normalizeSection(c.section || ''));
        }

        const proposalHtml = currData.curriculum_html || '';
        if (!proposalHtml) {
            contentEl.innerHTML = renderRegulatoryHeader(reg, 0, 0, 0, uniqueApprovedCodes.size)
                + '<div class="workflow-meta">No proposed curriculum to compare.</div>';
            return;
        }
        const items = extractCourseLines(cleanCurriculumHtml(proposalHtml));

        let totalProposed = 0, flaggedMissing = 0, flaggedMoved = 0;
        let rowsHtml = '';
        for (const it of items) {
            if (it.isHeader) {
                rowsHtml += `<tr><td class="reg-section" colspan="4">${escapeHtml(it.title)}</td></tr>`;
                continue;
            }
            if (!it.code) continue;
            totalProposed += 1;
            const codeKey = it.code.toUpperCase().replace(/\s+/g, ' ').trim();
            let flag = 'ok';
            let flagLabel = '';
            if (!approvedBySection.has(codeKey)) {
                flag = 'missing';
                flagLabel = 'Not on approved list';
                flaggedMissing += 1;
            } else {
                const approvedSections = approvedBySection.get(codeKey);
                const proposalSection = normalizeSection(it.section || '');
                // "Moved" only when proposal section is non-empty and none of
                // the approved sections match. Empty-approved sections (some
                // sheets have unlabeled course entries) are permissive.
                const anyMatch = !proposalSection ||
                    approvedSections.has(proposalSection) ||
                    approvedSections.has('');
                if (!anyMatch) {
                    flag = 'moved';
                    flagLabel = 'Approved, but in a different section';
                    flaggedMoved += 1;
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

        const header = renderRegulatoryHeader(reg, totalProposed, flaggedMissing, flaggedMoved, uniqueApprovedCodes.size);
        contentEl.innerHTML = header +
            '<table class="regulatory-table">' +
            '<thead><tr><th></th><th>Code</th><th>Title</th><th>Status</th></tr></thead>' +
            '<tbody>' + rowsHtml + '</tbody></table>';
    } catch (e) {
        contentEl.innerHTML = '<div class="workflow-meta">Failed to load regulatory data.</div>';
    }
}

// Normalize section strings for comparison. Uses standardizeHeader() if available,
// else falls back to lowercased trim. Both sides go through the same function so
// "Core Requirements" on one side matches "Required Courses" on the other.
// Returns '' for range-style labels like "CS 5100-CS 7880" — those are course
// groupings in the workbook, not semantic sections, and are treated permissively.
function normalizeSection(s) {
    if (!s) return '';
    const raw = String(s).trim();
    // Range-style labels: "CS 5100-CS 7880", "EECE 5000 - EECE 7000"
    if (/^[A-Z]{2,5}\s*\d{4}\s*[-–—]\s*[A-Z]{2,5}\s*\d{4}\s*$/i.test(raw)) return '';
    try {
        const std = (typeof standardizeHeader === 'function') ? standardizeHeader(raw) : '';
        return (std || raw).trim().toLowerCase();
    } catch (e) {
        return raw.toLowerCase();
    }
}

function renderRegulatoryHeader(reg, totalProposed, missing, moved, approvedCount) {
    const source = reg.source_file ? `<strong>${escapeHtml(reg.source_file)}</strong> &middot; ${escapeHtml(reg.sheet_name || '')}` : '';
    const edited = reg.edited_by ? ` &middot; ${escapeHtml(reg.edited_by)}` : '';
    const conf = reg.confidence && reg.confidence < 1 ? ` &middot; <span class="reg-low-confidence" title="${escapeHtml(reg.match_reason || '')}">match confidence ${Math.round(reg.confidence * 100)}%</span>` : '';
    const okCount = Math.max(0, totalProposed - missing - moved);
    return `<div class="regulatory-header">
        <div class="reg-source">${source}${edited}${conf}</div>
        <div class="reg-summary">
            <span class="reg-badge reg-badge-ok" title="Approved in same section">${okCount} approved</span>
            <span class="reg-badge reg-badge-moved" title="Approved but in a different section">${moved} in different section</span>
            <span class="reg-badge reg-badge-missing" title="Not found in approved list">${missing} not on approved list</span>
            <span class="reg-approved-count" title="Total courses in the approved list">&middot; approved list has ${approvedCount} course${approvedCount === 1 ? '' : 's'}</span>
        </div>
    </div>`;
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
    else if (tab === 'regulatory') loadRegulatoryDetail(programId);
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
// Diff match key for header titles. Used to align concentration headings
// regardless of whether the source used "X Concentration", "Concentration in X",
// or just "X". Display still preserves the word "Concentration".
function headerMatchKey(title) {
    return (title || '').trim()
        .replace(/^Concentration\s+in\s+/i, '')
        .replace(/\s+Concentration\s*$/i, '')
        .trim()
        .toLowerCase();
}

function standardizeHeader(text) {
    // Normalize concentration headings so their DISPLAY form consistently ends
    // with "Concentration". "Concentration in X" becomes "X Concentration".
    // Variants without "Concentration" get the suffix added when the heading
    // looks like a concentration name (ends a concentration-list context
    // detected later by headerMatchKey overlap). For now: only reword the
    // explicit "Concentration in X" prefix. Bare names keep their text as-is;
    // diff matching in diffLines relies on headerMatchKey, not title.
    let t = text.trim()
        .replace(/^Concentration\s+in\s+(.+)$/i, '$1 Concentration')
        .trim();
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

            // Some programs (especially AI / AI—Align Boston) put a PAIR of
            // required courses on a single row: "CS 5001 and CS 5003" in the
            // codecol with a combined title and combined credit hours. For
            // diffing to work against deployments that may list only one of
            // them, we split these into separate course lines here. Each
            // stacked code becomes its own item; the shared title is kept on
            // the first line (display only — diff key is code).
            const normalizedCode = codecol.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(?:or|and)\s+/i, '');
            const allCodes = normalizedCode.match(/[A-Z]{2,5}\s+\d{4}[A-Z]?/gi) || [];
            if (allCodes.length >= 2 && /\band\s+[A-Z]{2,5}\s+\d{4}/i.test(normalizedCode)) {
                allCodes.forEach((code, idx) => {
                    const upper = code.toUpperCase().replace(/\s+/g, ' ');
                    lines.push({
                        key: upper,
                        code: upper,
                        title: idx === 0 ? titlecol : '',
                        hours: idx === 0 ? hourscol : '',
                        isHeader: false,
                        section: currentSection,
                    });
                });
                return;
            }

            // Match on course code alone. Titles and hours can drift (renamed,
            // minor edits, different campus wording) without representing a real
            // curriculum change. If the code matches, the course matches.
            const normCode = normalizedCode.toUpperCase();
            lines.push({key: normCode, code: codecol, title: titlecol, hours: hourscol, isHeader: false, section: currentSection});
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
    // Explicit required/core markers win over elective keywords.
    if (/\brequired\s+core\b/.test(s) || /^required\s*$/i.test(s) || /^core\b/i.test(s)) {
        return 'required';
    }
    if (/\bcomplete\s+all\b/.test(s)) return 'required';
    // Elective patterns. A section is an "elective list" if it describes a
    // choice among multiple courses — choose/select/any/in consultation/from the
    // following/semester hours from, etc.
    if (/\belective/.test(s)) return 'elective';
    if (/\b(choose|select)\b/.test(s)) return 'elective';
    if (/\bcomplete\s+\w+\s+of\s+the\s+following/.test(s)) return 'elective';
    if (/\bcomplete\s+\d+\s+(?:semester\s+)?(?:sh|s\.h\.|hours?|credits?)\s+(?:from|based|in|with)/.test(s)) return 'elective';
    if (/\bin consultation\s+with/.test(s)) return 'elective';
    if (/\bfrom the following\b/.test(s)) return 'elective';
    if (/\bany\s+\d+/.test(s)) return 'elective';
    // Default to required for strict/unknown markers.
    return 'required';
}

// Simple diff algorithm (longest common subsequence based)
// Compares using case-insensitive normalization but preserves original structured data
// Headers are excluded from diff matching and re-inserted as context rows
function diffLines(oldLines, newLines) {
    // Within each stretch of consecutive non-header lines (i.e. an elective
    // list under a single subheading), sort courses by code. Elective lists
    // are semantically sets — the same courses in a different order is not a
    // real curriculum change — so canonicalizing order lets LCS match 1-to-1.
    function canonicalize(lines) {
        const out = [];
        let buffer = [];
        const flush = () => {
            if (buffer.length) {
                buffer.sort((a, b) =>
                    (a.key || a.code || '').localeCompare(b.key || b.code || ''));
                out.push(...buffer);
                buffer = [];
            }
        };
        for (const l of lines) {
            if (l.isHeader) { flush(); out.push(l); }
            else buffer.push(l);
        }
        flush();
        return out;
    }
    oldLines = canonicalize(oldLines);
    newLines = canonicalize(newLines);

    // Separate headers from courses, tracking ALL consecutive headers that
    // precede each course. (Previously only kept the last header, which lost
    // concentration-level headings when a sub-heading like "Required" followed.)
    function splitHeadersAndCourses(lines) {
        const courses = [];
        const headersMap = {}; // courseIndex -> array of header items
        let pendingHeaders = [];
        for (const line of lines) {
            if (line.isHeader) {
                pendingHeaders.push(line);
            } else {
                headersMap[courses.length] = pendingHeaders;
                courses.push(line);
                pendingHeaders = [];
            }
        }
        return { courses, headersMap };
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

    // Post-LCS: pair up any remaining "removed" entry with an "added" entry
    // that shares the same course code. LCS can't cross-match when courses
    // appear in non-overlapping sections on each side (e.g., BIOT 5810 in
    // Toronto's Biodefense concentration vs the reference's Biopharm
    // concentration). Since the user's mental model is "if the course code
    // matches, the courses match", we pair them as "same" after the fact.
    // Pair by scanning left-to-right to keep the output order sensible.
    const removedByKey = {};
    courseDiff.forEach((e, idx) => {
        if (e.type === 'removed') {
            const k = e.left.key;
            (removedByKey[k] = removedByKey[k] || []).push(idx);
        }
    });
    for (let idx = 0; idx < courseDiff.length; idx++) {
        const e = courseDiff[idx];
        if (e.type === 'added') {
            const k = e.right.key;
            const candidates = removedByKey[k];
            if (candidates && candidates.length) {
                // Pair this 'added' with the nearest earlier 'removed'
                const rIdx = candidates.shift();
                courseDiff[rIdx] = {
                    type: 'same',
                    leftIdx: courseDiff[rIdx].leftIdx,
                    rightIdx: e.rightIdx,
                    left: courseDiff[rIdx].left,
                    right: e.right,
                };
                // Remove the 'added' entry by marking for deletion
                courseDiff[idx] = null;
            }
        }
    }
    // Filter out the nulls
    for (let idx = courseDiff.length - 1; idx >= 0; idx--) {
        if (courseDiff[idx] === null) courseDiff.splice(idx, 1);
    }
    // Re-insert headers before the first course in their section.
    // Each side's headers are shown independently on that side only, so that
    // courses stay under their correct heading even when sections differ.
    const result = [];
    const usedLeftHeaders = new Set();
    const usedRightHeaders = new Set();
    const emptyHeader = {key: '', code: '', title: '', hours: '', isHeader: true};
    for (const d of courseDiff) {
        const lHdrs = d.leftIdx !== null ? (oldSplit.headersMap[d.leftIdx] || []) : [];
        const rHdrs = d.rightIdx !== null ? (newSplit.headersMap[d.rightIdx] || []) : [];
        // Emit each pre-course header in order. Headers with matching (normalized)
        // titles on both sides are rendered as a single combined row; otherwise
        // the side-specific header is rendered with an empty cell opposite.
        const maxH = Math.max(lHdrs.length, rHdrs.length);
        for (let k = 0; k < maxH; k++) {
            const lh = lHdrs[k] || null;
            const rh = rHdrs[k] || null;
            const showLeft = lh && !usedLeftHeaders.has(lh.title);
            const showRight = rh && !usedRightHeaders.has(rh.title);
            if (showLeft && showRight && headerMatchKey(lh.title) === headerMatchKey(rh.title)) {
                // When both sides' headers normalize to the same key, prefer the
                // title that contains the word "Concentration" so the rendered
                // output consistently shows "X Concentration" on both sides.
                const lHasConc = /\bconcentration\b/i.test(lh.title);
                const rHasConc = /\bconcentration\b/i.test(rh.title);
                let displayTitle;
                if (lHasConc && !rHasConc) displayTitle = lh.title;
                else if (rHasConc && !lHasConc) displayTitle = rh.title;
                else displayTitle = lh.title.length >= rh.title.length ? lh.title : rh.title;
                const lOut = {...lh, title: displayTitle};
                const rOut = {...rh, title: displayTitle};
                result.push({type: 'same', left: lOut, right: rOut});
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

// Render a single side's cell content. Two columns per side: code + title
// (with hours inlined into title as "(NSH)" by html_cleaner).
function renderCourseCell(item, cls) {
    if (!item) return `<td class="${cls}" colspan="2"></td>`;
    if (item.isHeader) {
        return `<td class="${cls} cmp-header" colspan="2">${escapeHtml(item.title)}</td>`;
    }
    const titleWithHours = item.hours
        ? `${item.title} (${item.hours}SH)`
        : item.title;
    return `<td class="${cls} cmp-code">${escapeHtml(item.code)}</td>` +
           `<td class="${cls} cmp-title">${escapeHtml(titleWithHours)}</td>`;
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
            <th colspan="2" class="cmp-left-header">${escapeHtml(leftLabel)}</th>
            <th class="cmp-divider"></th>
            <th colspan="2" class="cmp-right-header">${escapeHtml(rightLabel)}</th>
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

        // If a custom reference override is active, always compare proposed vs that custom ref,
        // regardless of the program's campus relationships.
        const refRes0 = await fetch(`/api/program/${programId}/reference`);
        const refData0 = refRes0.ok ? await refRes0.json() : {};
        const hasCustomOverride = refData0.source === 'custom';

        if (hasCustomOverride) {
            const refHtml = refData0.curriculum_html || '';
            if (!currHtml || !refHtml) {
                contentEl.innerHTML = '<div class="workflow-meta">Curriculum or custom reference data not available for comparison.</div>';
                updateCompareButton(programId, null);
                return;
            }
            const {identical, diff} = compareCurricula(currHtml, refHtml);
            updateCompareButton(programId, identical);
            const header = `<div class="reference-header">Comparing against custom reference: ${escapeHtml(refData0.name || refData0.version_date || '')}</div>`;
            if (identical) {
                contentEl.innerHTML = `${header}<div class="compare-identical">Proposed curriculum is identical to the custom reference.</div>`;
            } else {
                const table = renderSideBySide(diff, 'Proposed Curriculum', 'Reference Curriculum');
                contentEl.innerHTML = `${header}
                    <div class="compare-legend">
                        <span class="compare-legend-item"><span class="legend-box diff-removed-bg"></span> Only in proposal</span>
                        <span class="compare-legend-item"><span class="legend-box diff-added-bg"></span> Only in reference</span>
                        <span class="compare-legend-item"><span class="legend-box diff-moved-bg"></span> Moved between sections</span>
                    </div>${table}`;
            }
            return;
        }

        if (bostonId || isNonBoston) {
            // This is a non-Boston deployment — compare against Boston reference
            const refData = refData0;
            const refHtml = refData.curriculum_html || '';

            if (!currHtml || !refHtml) {
                contentEl.innerHTML = '<div class="workflow-meta">Curriculum or reference data not available for comparison.</div>';
                updateCompareButton(programId, null);
                return;
            }

            const {identical, diff} = compareCurricula(currHtml, refHtml);
            updateCompareButton(programId, identical);

            const inWorkflow = refData.version_date && refData.version_date.toLowerCase().includes('in workflow');
            const identicalMsg = inWorkflow
                ? 'Curriculum is identical to the current Boston proposal (in workflow).'
                : 'Curriculum is identical to the Boston reference.';

            const header = refData.version_date
                ? `<div class="reference-header">Comparing against: ${escapeHtml(formatReferenceVersionLabel(refData.version_date))}</div>`
                : '';

            if (identical) {
                contentEl.innerHTML = `${header}<div class="compare-identical">${identicalMsg}</div>`;
            } else {
                const table = renderSideBySide(diff, 'Proposed Curriculum', 'Reference Curriculum');
                contentEl.innerHTML = `${header}
                    <div class="compare-legend">
                        <span class="compare-legend-item"><span class="legend-box diff-removed-bg"></span> Only in proposal</span>
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
                        <span class="compare-legend-item"><span class="legend-box diff-removed-bg"></span> Only in proposal</span>
                        <span class="compare-legend-item"><span class="legend-box diff-added-bg"></span> Only in reference</span>
                        <span class="compare-legend-item"><span class="legend-box diff-moved-bg"></span> Moved between sections</span>
                    </div>`;
                    html += renderSideBySide(dep.diff, 'Proposed Curriculum', 'Reference Curriculum');
                }
                html += '</div>';
            }

            contentEl.innerHTML = html;

        } else {
            // No campus relationships — this is a standalone program
            // Compare against its own reference if available
            const refData = refData0;
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
                const table = renderSideBySide(diff, 'Proposed Curriculum', 'Reference Curriculum');
                contentEl.innerHTML = `<div class="compare-legend">
                    <span class="compare-legend-item"><span class="legend-box diff-removed-bg"></span> Only in proposal</span>
                    <span class="compare-legend-item"><span class="legend-box diff-added-bg"></span> Only in reference</span>
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

// In-page search for the expanded detail tabs. Filters <tr> rows in the
// content area down to those whose text contains the query. Heading/section
// rows (areaheader, h2/h3) are kept visible when any of their following
// rows match, to preserve context.
function filterDetailContent(programId) {
    const input = document.getElementById(`detail-search-${programId}`);
    const content = document.getElementById(`detail-content-${programId}`);
    if (!input || !content) return;
    const q = input.value.trim().toLowerCase();
    const rows = Array.from(content.querySelectorAll('tr'));
    if (!q) {
        rows.forEach(r => { r.style.display = ''; });
        // Clear any prior highlights
        content.querySelectorAll('mark.detail-hl').forEach(m => {
            const t = document.createTextNode(m.textContent);
            m.parentNode.replaceChild(t, m);
        });
        return;
    }
    // First pass: mark each row's own match status
    const rowMatches = rows.map(r => r.textContent.toLowerCase().includes(q));
    // Heading rows (areaheader / h2/h3/h4-equivalent): show if any following
    // non-heading row matches until the next heading.
    const isHeading = r =>
        r.classList.contains('areaheader') ||
        r.querySelector('.areaheader, h2, h3, h4') !== null;
    const show = new Array(rows.length).fill(false);
    for (let i = 0; i < rows.length; i++) {
        if (rowMatches[i]) show[i] = true;
    }
    // Propagate: a heading shows if any descendant row (up to next heading) matches
    for (let i = 0; i < rows.length; i++) {
        if (!isHeading(rows[i])) continue;
        let j = i + 1;
        let anyMatch = false;
        while (j < rows.length && !isHeading(rows[j])) {
            if (rowMatches[j]) { anyMatch = true; break; }
            j++;
        }
        if (anyMatch) show[i] = true;
    }
    rows.forEach((r, i) => { r.style.display = show[i] ? '' : 'none'; });
}

function toggleRow(programId) {
    if (expandedRows.has(programId)) {
        // Collapse this row
        expandedRows.delete(programId);
        delete detailTabState[programId];
    } else {
        // Close any other expanded rows (single-open accordion)
        expandedRows.clear();
        for (const k of Object.keys(detailTabState)) delete detailTabState[k];
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

function showErrorBanner(message) {
    const banner = document.getElementById('error-banner');
    const text = document.getElementById('error-banner-text');
    if (!banner || !text) return;
    text.textContent = message;
    banner.style.display = 'flex';
}

function dismissErrorBanner() {
    const banner = document.getElementById('error-banner');
    if (banner) banner.style.display = 'none';
}

async function checkSessionHealth() {
    // Fire-and-check: probe CourseLeaf connectivity. Called on page load and after
    // a failed scan trigger. Non-fatal if endpoint unreachable (just means the Flask
    // server is down and the page itself wouldn't load anyway).
    try {
        const res = await fetch('/api/session/check');
        const data = await res.json();
        if (!data.ok) {
            showErrorBanner('CourseLeaf session issue: ' + (data.detail || data.error || 'Unknown error'));
        } else {
            dismissErrorBanner();
        }
        return data.ok;
    } catch (e) {
        // Server unreachable; don't clobber existing banner
        return false;
    }
}

async function triggerScan() {
    const btn = document.getElementById('scan-btn');
    btn.disabled = true;
    document.getElementById('scan-status').innerHTML = '<span class="spinner"></span> Updating...';
    document.getElementById('scan-status').className = 'scan-status running';

    try {
        // "Update Now" runs the quick heal — re-fetches workflow HTML for
        // every active program + course and syncs current_step. ~4-5 min.
        // Auto-exports and pushes to GitHub Pages when done. The nightly
        // launchd run does the full scan that discovers new IDs and
        // refreshes reference + regulatory data.
        const res = await fetch('/api/heal', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({scope: 'both', active_only: true, deploy: true}),
        });
        if (!res.ok) {
            let detail = 'Update could not start.';
            try {
                const data = await res.json();
                detail = data.detail || data.error || detail;
            } catch (_) {}
            showErrorBanner('Cannot start update: ' + detail);
            btn.disabled = false;
            document.getElementById('scan-status').textContent = '';
            document.getElementById('scan-status').className = 'scan-status';
            return;
        }
        dismissErrorBanner();
        pollScanStatus();
    } catch (e) {
        console.error('Failed to trigger scan:', e);
        showErrorBanner('Failed to reach the tracker server.');
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

document.addEventListener('DOMContentLoaded', () => {
    loadDashboard();
    // Fast CourseLeaf session health probe so user sees "please log in" quickly,
    // not after a 10-minute scan that silently does nothing.
    // Only do this when the server is the Flask local server (not the static site).
    if (typeof window._staticMode === 'undefined') {
        checkSessionHealth();
    }
});

// Auto-refresh every 2 minutes (data display only, not scanning)
// Auto-refresh disabled in static mode


/* ======= STATIC SITE DATA LAYER ======= */
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

    // Catalog dashboard: read from embedded data instead of /api endpoints.
    window.loadCatalogDashboard = async function() {
        const D = await _getData();
        cachedCatalogPipeline = D.catalog_pipeline || [];
        allCatalogPages = D.catalog_pages || [];
        renderCatalogPipeline();
        renderCatalogTable();
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
            const displayDate = typeof formatReferenceVersionLabel === 'function'
                ? formatReferenceVersionLabel(ref.version_date)
                : ref.version_date;
            const header = displayDate
                ? `<div class="reference-header">Reference version: ${displayDate}</div>`
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

    // Update button: reach local Flask to trigger the quick heal (~4-5 min)
    // which refreshes active program + course current_step values from
    // workflow HTML and auto-pushes to GitHub Pages when done.
    window.triggerScan = async function() {
        const btn = document.getElementById('scan-btn');
        const statusEl = document.getElementById('scan-status');
        btn.disabled = true;
        statusEl.innerHTML = '<span class="spinner"></span> Connecting...';
        statusEl.className = 'scan-status running';
        try {
            const res = await fetch('http://localhost:5001/api/heal', {
                method: 'POST',
                mode: 'cors',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({scope: 'both', active_only: true, deploy: true}),
            });
            if (res.ok) {
                statusEl.innerHTML = '<span class="spinner"></span> Updating (this takes ~5 min)...';
                const poll = setInterval(async () => {
                    try {
                        const s = await fetch('http://localhost:5001/api/scan/status');
                        const d = await s.json();
                        if (!d.running) {
                            clearInterval(poll);
                            statusEl.textContent = 'Update complete! Refresh the page to see the new data.';
                            btn.disabled = false;
                        }
                    } catch(e) { clearInterval(poll); btn.disabled = false; }
                }, 10000);
            } else {
                let detail = 'Update could not start.';
                try { detail = (await res.json()).detail || detail; } catch (_) {}
                statusEl.textContent = detail;
                btn.disabled = false;
            }
        } catch(e) {
            statusEl.textContent = 'Cannot reach local server. Make sure Flask is running (python3 app.py) on your Mac.';
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
