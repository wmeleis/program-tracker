/* Program Approval Tracker - Frontend Logic */

let allPrograms = [];
let allCourses = [];
let allCatalogPages = [];
let cachedCatalogPipeline = [];
let currentView = 'programs'; // 'programs', 'courses', 'catalog', or 'portfolio'
let expandedRows = new Set();
let detailTabState = {}; // programId/courseId -> 'workflow' | 'curriculum'
let currentSort = { column: 'name', direction: 'asc' };
let pipelineFilter = null;
let smartView = 'all';
// Pipeline perspective: 'otp' (default, university pipeline) or 'college'
// (a college's internal roles, fine-grained, for ADs/coordinators). The
// chosen perspective AND the selected college persist per browser so each
// user reopens where they left off. There are no accounts, so "per user"
// means per browser/device.
let cimPerspective = (() => {
    let v = 'otp';
    try { v = localStorage.getItem('cim-perspective') || 'otp'; } catch (_) { v = 'otp'; }
    // 'em' (Enrollment Management) perspective was retired — its actionable
    // surface now lives in the Portfolio tab's GTM views. Coerce stale state.
    return v === 'college' ? 'college' : 'otp';
})();
let cimCollegeSelected = (() => {
    try { return localStorage.getItem('cim-college-selected') || ''; } catch (_) { return ''; }
})();
// College full name → CIM role-prefix code, used to pick a college's OWN roles
// out of the (noisy, cross-college) workflow-step union.
const _COLLEGE_CODE = {
    'Coll of Arts, Media & Design': 'AM',
    "D'Amore-McKim School Business": 'BA',
    'Bouve College of Hlth Sciences': 'BV',
    'Khoury Coll of Comp Sciences': 'CS',
    'College of Engineering': 'EN',
    'School of Law': 'LW',
    'Mills College at NU': 'MI',
    'Coll of Professional Studies': 'PS',
    'College of Science': 'SC',
    'Coll of Soc Sci & Humanities': 'SH',
};
// College perspective: which pipeline panel is showing — 'college' (the
// college's own role sequence) or 'downstream' (the full post-college
// university pipeline). Toggled by the arrow at the end of the bar.
let collegePanel = 'college';
let _collegePipeArgs = null;   // last {baseFiltered, isCourseView} for re-render
function setCollegePanel(p) {
    collegePanel = (p === 'downstream') ? 'downstream' : 'college';
    if (_collegePipeArgs) renderCollegePipeline(_collegePipeArgs.baseFiltered, _collegePipeArgs.isCourseView);
}
// Distinct (college, step_name) pairs from program + course workflow defs.
// Lets the College perspective show a college's FULL role sequence (every role
// its programs pass through), not just currently-occupied roles. Loaded once
// (fetched on Flask, embedded in data.json on the static site).
let cimRolePairs = null;
function _saveCimPerspective() {
    try {
        localStorage.setItem('cim-perspective', cimPerspective);
        localStorage.setItem('cim-college-selected', cimCollegeSelected || '');
    } catch (_) {}
}
// Order a college's internal roles by role type (the agreed template):
// Director → Chair → Program Review → Curriculum Committee → Dean's Office →
// Accreditor → anything else. "Curriculum Committee" is checked before the
// generic "Chair" so committee-chair roles don't rank as plain chairs.
function collegeRoleRank(step) {
    const s = step || '';
    if (/Checkpoint/i.test(s)) return 0;   // earliest course step; shown in both panels
    if (/Program Director/i.test(s)) return 1;
    if (/Program Review/i.test(s)) return 3;
    if (/Curriculum Committee/i.test(s)) return 4;
    if (/Dean'?s Office/i.test(s)) return 5;
    if (/Accreditor/i.test(s)) return 6;
    if (/Chair/i.test(s)) return 2;
    return 7;
}
// Short tile label for a college-internal role: drop "Program " and abbreviate
// common words so the granular roles fit in a pipeline tile.
function collegeRoleShort(step) {
    return (step || '')
        .replace(/^Program\s+/, '')
        .replace(/\bUndergraduate\b/g, 'UG')
        .replace(/\bGraduate\b/g, 'Grad')
        .replace(/\bCurriculum Committee\b/g, 'Curric Cmte')
        .replace(/\bDean'?s Office\b/g, 'Dean')
        .replace(/\bProgram Review\b/g, 'Review')
        .replace(/\bProgram Director\b/g, 'Director')
        .replace(/\s+/g, ' ').trim();
}
// Multi-select. Holds any combination of 'Undergraduate', 'Graduate',
// 'Continuing', 'Other', etc. Empty set = no type filter.
let typeFilter = new Set();
// Multi-select. Holds any combination of 'Added', 'Edited', 'Deactivated',
// and '__complete__'. Empty set = no proposal-type filter (show everything,
// with the default "hide completed" rule). '__complete__' is intentionally
// inside this set (rather than living in pipelineFilter as it used to) so
// the user can combine Complete with proposal-type buttons in any way.
let proposalFilter = new Set();
// Single-select: at most one kind active at a time. '' = no filter.
// Click the active button again to deselect (toggle).
let programKindFilter = '';
let approverPrograms = null;
let cachedPipeline = [];
let cachedCoursePipeline = [];
const STUCK_THRESHOLD_DAYS = 21;  // legacy default — see STUCK_THRESHOLDS for per-step overrides

// Per-step "possibly stuck" thresholds (in days). null = never marked stuck.
// Default for any step not listed here is 21 days. The values below override
// that default for steps that legitimately wait longer (committees that
// meet on a fixed cadence, batched setup steps, etc.).
const STUCK_THRESHOLDS = {
    'Program University Board of Trustees': null, // BoT meets ~quarterly; never flag stuck
    'Program Faculty Senate': 60,                  // Senate meets monthly
    'Program Catalog Setup': 30,                   // catalog batches
    'Program Banner Setup': 30,                    // batched processing
    'Program Editor': 14,                          // editor queue typically fast
};

function getStuckThreshold(step) {
    if (!step) return null;  // completed programs aren't "stuck"
    if (Object.prototype.hasOwnProperty.call(STUCK_THRESHOLDS, step)) {
        return STUCK_THRESHOLDS[step];
    }
    return STUCK_THRESHOLD_DAYS;
}

function isStuckProgram(p) {
    const threshold = getStuckThreshold(p.current_step);
    if (threshold === null) return false;
    return getDaysAtStep(p) >= threshold;
}

const NEW_SUBMISSION_DAYS = 30;
const RECENT_CHANGE_DAYS = 14;

// Program-kind classification. Mutually exclusive — name patterns checked
// before degree code so a "Concentration" or "Minor" with an incidental
// degree code still routes to the right bucket.
const PROGRAM_KINDS = [
    { id: 'bachelors',    label: "Bachelor's"    },
    { id: 'masters',      label: "Master's"      },
    { id: 'phd',          label: 'PhD'           },
    { id: 'profdoc',      label: 'Prof. Doctorate' },
    { id: 'certificate',  label: 'Certificate'   },
    { id: 'cags',         label: 'CAGS'          },
    { id: 'minor',        label: 'Minor'         },
    { id: 'plusone',      label: 'PlusOne'       },
    { id: 'concentration',label: 'Concentration' },
    { id: 'dual',         label: 'Dual Degree'   },
];

const PHD_DEGREES = new Set(['PhD','PHD']);
const PROF_DOCTORATE_DEGREES = new Set(['EdD','EDD','DNP','DPT','DPS','DLP','PharmD','PHARMD','DMSc','DMSC','JD']);

function isTemplateProgram(p) {
    // CourseLeaf "TEMPLATE: ..." rows aren't real programs — they're
    // starting-point templates left in CIM. Hide unconditionally.
    return /^TEMPLATE\s*:/i.test(p && p.name || '');
}

function classifyProgramKind(p) {
    const name = (p && p.name || '').trim();
    const lname = name.toLowerCase();
    const degree = (p && p.degree || '').trim();

    // Name patterns first — these win over degree code.
    if (lname.indexOf('minor') !== -1) return 'minor';
    if (lname.indexOf('plusone') !== -1) return 'plusone';
    if (lname.indexOf('concentration') !== -1) return 'concentration';
    // Dual: " / " joining two distinct degree-bearing program names,
    // e.g. "Law, JD / Public Health, MPH". Also matches ", JD/MS" style.
    if (/\s\/\s/.test(name) || /,\s*[A-Z]{2,7}\s*\/\s*[A-Z]{2,7}/.test(name)) return 'dual';
    // CAGS is its own bucket — checked before "certificate" so the name
    // "Certificate of Advanced Graduate Study" doesn't route to plain certs.
    if (degree === 'CAGS' || /,\s*CAGS\b/.test(name) || /Certificate of Advanced Graduate Study/i.test(name)) return 'cags';
    if (lname.indexOf('certificate') !== -1) return 'certificate';

    // Degree-code-driven buckets.
    if (degree === 'CERTP') return 'certificate';
    if (PHD_DEGREES.has(degree)) return 'phd';
    if (PROF_DOCTORATE_DEGREES.has(degree)) return 'profdoc';
    if (degree === 'LLM' || /,\s*MLS\b/.test(name)) return 'masters';
    if (/^B/.test(degree)) return 'bachelors';
    if (/^M/.test(degree)) return 'masters';
    return null;  // uncategorized — not in any bucket, never matches a kind filter
}

function setProgramKindFilter(kind) {
    programKindFilter = kind === programKindFilter ? '' : kind;
    document.querySelectorAll('.kind-btn').forEach(btn => {
        const k = btn.dataset.kind || '';
        btn.classList.toggle('active', k === programKindFilter);
    });
    applyFilters();
}

function switchView(view) {
    currentView = view;
    try { localStorage.setItem('cim-active-view', view); } catch(e) {}

    // Update button states
    document.getElementById('btn-programs').classList.toggle('active', view === 'programs');
    document.getElementById('btn-courses').classList.toggle('active', view === 'courses');
    const btnCat = document.getElementById('btn-catalog');
    if (btnCat) btnCat.classList.toggle('active', view === 'catalog');
    const btnPort = document.getElementById('btn-portfolio');
    if (btnPort) btnPort.classList.toggle('active', view === 'portfolio');

    // The "References" button (manage custom reference curricula) is only
    // relevant on the Programs view — hide on Courses / Catalog / Portfolio.
    const refsBtn = document.getElementById('refs-btn');
    if (refsBtn) refsBtn.style.display = view === 'programs' ? '' : 'none';

    // Reset filters when switching views
    pipelineFilter = null;
    typeFilter = new Set();
    proposalFilter = new Set();
    programKindFilter = '';
    document.querySelectorAll('.type-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.proposal-btn').forEach(btn => btn.classList.remove('active-all', 'active-new', 'active-edit', 'active-inact', 'active-complete'));
    document.querySelectorAll('.smart-view-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.kind-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById('filter-college').value = '';
    document.getElementById('filter-campus').value = '';
    document.getElementById('filter-approver').value = '';
    document.getElementById('filter-step').value = '';
    document.getElementById('filter-search').value = '';
    const subjectSel = document.getElementById('filter-subject');
    if (subjectSel) subjectSel.value = '';

    // Hide/show sections based on view
    // The Level switch moved into the filter bar, so smart-views-section now
    // holds only the proposal buttons (one .view-group). Both refs point to it.
    const typeSection = document.querySelector('.smart-views-section .view-group');
    const proposalSection = typeSection;
    const campusFilter = document.getElementById('filter-campus');

    const subjectGroup = document.getElementById('filter-group-subject');
    const portfolioFilters = document.getElementById('portfolio-filters');

    // Sections to hide entirely in portfolio view
    const pipelineSection   = document.getElementById('pipeline');
    const smartViewsSection = document.querySelector('.smart-views-section');
    const kindFilterRow     = document.getElementById('kind-filter-row');
    const smartActionsSection = document.querySelector('.smart-actions-section');
    const filtersSection    = document.querySelector('.filters-section:not(.scope-bar)');

    const portfolioToolbar  = document.getElementById('portfolio-table-toolbar');
    const portfolioHdrAct   = document.getElementById('portfolio-header-actions');
    // CIM-specific header buttons: hidden on portfolio view (replaced by
    // Export / Views / Columns) — EXCEPT the "● CIM connected" status button
    // (auth-btn), which stays visible everywhere since the connection status
    // is useful on every view. Non-portfolio views restore them all.
    const cimHdrBtns = ['scan-btn','auth-btn','console-btn','refs-btn']
        .map(id => document.getElementById(id)).filter(Boolean);
    const authBtn = document.getElementById('auth-btn');
    const lastUpdatedEl = document.getElementById('last-updated');
    const scanStatusEl  = document.getElementById('scan-status');
    const progressEl    = document.getElementById('progress-container');
    if (view === 'portfolio') {
        cimHdrBtns.forEach(b => b.style.display = 'none');
        if (authBtn) authBtn.style.display = '';   // keep CIM connection status visible
        if (lastUpdatedEl) lastUpdatedEl.style.display = 'none';
        if (scanStatusEl)  scanStatusEl.style.display  = 'none';
        if (progressEl)    progressEl.style.display    = 'none';
        if (portfolioFilters)    portfolioFilters.style.display = 'flex';
        if (portfolioToolbar)    portfolioToolbar.style.display = 'flex';
        if (portfolioHdrAct)     portfolioHdrAct.style.display = 'flex';
        if (pipelineSection)     pipelineSection.style.display = 'none';
        if (smartViewsSection)   smartViewsSection.style.display = 'none';
        if (kindFilterRow)       kindFilterRow.style.display = 'none';
        if (smartActionsSection) smartActionsSection.style.display = 'none';
        if (filtersSection)      filtersSection.style.display = 'none';
        if (subjectGroup)        subjectGroup.style.display = 'none';
    } else {
        cimHdrBtns.forEach(b => b.style.display = '');
        if (lastUpdatedEl) lastUpdatedEl.style.display = '';
        if (scanStatusEl)  scanStatusEl.style.display  = '';
        if (progressEl)    progressEl.style.display    = 'none';  // stays hidden until scan runs
        if (portfolioFilters)    portfolioFilters.style.display = 'none';
        if (portfolioToolbar)    portfolioToolbar.style.display = 'none';
        if (portfolioHdrAct)     portfolioHdrAct.style.display = 'none';
        if (pipelineSection)     pipelineSection.style.display = 'block';
        // Catalog view has neither type nor proposal buttons — hide the
        // whole row so the (now-tinted) band doesn't render as an empty
        // strip between the pipeline summary and the filter dropdowns.
        if (smartViewsSection)   smartViewsSection.style.display = view === 'catalog' ? 'none' : 'flex';
        if (kindFilterRow)       kindFilterRow.style.display = view === 'programs' ? 'flex' : 'none';
        if (smartActionsSection) smartActionsSection.style.display = view === 'catalog' ? 'none' : 'flex';
        if (filtersSection)      filtersSection.style.display = 'flex';

        if (view === 'courses') {
            typeSection.style.display = 'flex';
            proposalSection.style.display = 'flex';
            campusFilter.parentElement.parentElement.style.display = 'none';
            if (subjectGroup) subjectGroup.style.display = 'flex';
        } else if (view === 'catalog') {
            typeSection.style.display = 'none';
            proposalSection.style.display = 'none';
            campusFilter.parentElement.parentElement.style.display = 'none';
            if (subjectGroup) subjectGroup.style.display = 'none';
            const stepFilterGroup = document.getElementById('filter-step')?.parentElement?.parentElement;
            if (stepFilterGroup) stepFilterGroup.style.display = 'none';
        } else {
            const stepFilterGroup = document.getElementById('filter-step')?.parentElement?.parentElement;
            if (stepFilterGroup) stepFilterGroup.style.display = 'flex';
            typeSection.style.display = 'flex';
            proposalSection.style.display = 'flex';
            campusFilter.parentElement.parentElement.style.display = 'flex';
            if (subjectGroup) subjectGroup.style.display = 'none';
        }
    }

    // Update proposal button labels for Programs vs Courses
    const newBtn = document.getElementById('btn-proposal-new');
    if (newBtn) newBtn.textContent = view === 'courses' ? 'New Courses' : 'New Programs';
    // Update search placeholder. Wildcards: * matches any characters, ? matches one.
    const searchEl = document.getElementById('filter-search');
    if (searchEl) {
        if (view === 'courses')        searchEl.placeholder = 'Search courses by code or title (* and ? wildcards)…';
        else if (view === 'catalog')   searchEl.placeholder = 'Search catalog pages by path or title (* and ? wildcards)…';
        else if (view === 'portfolio') searchEl.placeholder = 'Search portfolio by program, college, campus (* and ? wildcards)…';
        else                            searchEl.placeholder = 'Search programs by name or banner code (* and ? wildcards)…';
    }

    // Show/hide the OTP/College perspective toggle for the new view.
    syncPerspectiveUI();

    // Reload appropriate data
    if (view === 'programs') {
        loadDashboard();
    } else if (view === 'courses') {
        loadCoursesDashboard();
    } else if (view === 'catalog') {
        loadCatalogDashboard();
    } else if (view === 'portfolio') {
        loadPortfolioDashboard();
    }
}

// ==================== Catalog dashboard ====================

// Catalog pipeline buckets. Everything before GCAT/UCAT Provost Approval is
// editor-level review and collapses into a single "College" tile, mirroring
// how Programs and Courses handle their college-level reviewers. Post-Provost
// roles (registrar steps, Editor, CAT Final Review) each get their own tile.
//
// Order = left-to-right pipeline order. Anything that doesn't match a bucket
// here falls into "College" via isCatalogCollegeStep().
const CATALOG_BUCKETS = [
    { role: 'GCAT Provost Approval',         short_name: 'GCAT Provost',  match: s => s === 'GCAT Provost Approval' },
    { role: 'UCAT Provost Approval',         short_name: 'UCAT Provost',  match: s => s === 'UCAT Provost Approval' },
    { role: 'REGISTRAR Records Review',      short_name: 'Records Review',match: s => s === 'REGISTRAR Records Review' },
    { role: 'Deputy Registrar - Operations', short_name: 'Deputy Reg',    match: s => s === 'Deputy Registrar - Operations' },
    { role: 'Registrar Approval',            short_name: 'Reg Approval',  match: s => s === 'Registrar Approval' },
    { role: 'Shared Content - Registrar Review', short_name: 'Shared Reg', match: s => s === 'Shared Content - Registrar Review' },
    { role: 'Editor',                        short_name: 'Editor',        match: s => s === 'Editor' },
    { role: 'CAT Final Review',              short_name: 'Final Review',  match: s => s === 'CAT Final Review' },
];

function isCatalogCollegeStep(step) {
    if (!step) return false;
    for (const b of CATALOG_BUCKETS) {
        if (b.match(step)) return false;
    }
    return true;
}

function getCatalogBucket(step) {
    for (const b of CATALOG_BUCKETS) {
        if (b.match(step)) return b.role;
    }
    return null;
}

// Map second-level path segment to canonical college name (matches the
// COLLEGE_NAMES dict used elsewhere). Catalog pages are filed under URL paths
// like /graduate/social-sciences-humanities/... — the second segment is the
// college. Anything that's not a college (academic-policies-procedures,
// university-academics, university-interdisciplinary-programs, shared/...,
// gordon-institute, etc.) groups into "University-wide".
const CATALOG_COLLEGE_MAP = {
    'social-sciences-humanities': 'Coll of Soc Sci & Humanities',
    'computer-information-science': 'Khoury Coll of Comp Sciences',
    'law': 'School of Law',
    'science': 'College of Science',
    'business': "D'Amore-McKim School Business",
    'engineering': 'College of Engineering',
    'arts-media-design': 'Coll of Arts, Media & Design',
    'mills': 'Mills College at NU',
    'health-sciences': 'Bouve College of Hlth Sciences',
    'bouve-college-of-health-sciences': 'Bouve College of Hlth Sciences',
    'professional-studies': 'Coll of Professional Studies',
};

function getCatalogCollege(page) {
    const parts = (page.id || '').split('/').filter(Boolean);
    // /shared/... pages are intentionally cross-college content.
    if (parts[0] === 'shared') return 'Shared Content';
    // /professional-studies/... is itself a CPS page.
    if (parts[0] === 'professional-studies') return 'Coll of Professional Studies';
    if (parts.length < 2) return 'University-wide';
    return CATALOG_COLLEGE_MAP[parts[1]] || 'University-wide';
}

function populateCatalogCollegeFilter() {
    const sel = document.getElementById('filter-college');
    if (!sel) return;
    const counts = new Map();
    for (const p of allCatalogPages || []) {
        const c = getCatalogCollege(p);
        counts.set(c, (counts.get(c) || 0) + 1);
    }
    const prev = sel.value;
    const opts = Array.from(counts.entries())
        .sort((a, b) => abbreviateCollege(a[0]).localeCompare(abbreviateCollege(b[0])))
        .map(([name, count]) => `<option value="${escapeHtml(name)}">${escapeHtml(abbreviateCollege(name))} (${count})</option>`)
        .join('');
    sel.innerHTML = '<option value="">All Colleges</option>' + opts;
    if (prev && Array.from(sel.options).some(o => o.value === prev)) {
        sel.value = prev;
    }
}

function populateCatalogApproverFilter() {
    const sel = document.getElementById('filter-approver');
    if (!sel) return;
    const counts = new Map();
    for (const p of allCatalogPages || []) {
        const u = (p.user || '').trim();
        if (!u) continue;
        counts.set(u, (counts.get(u) || 0) + 1);
    }
    const prev = sel.value;
    const opts = Array.from(counts.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, count]) => `<option value="${escapeHtml(name)}">${escapeHtml(name)} (${count})</option>`)
        .join('');
    sel.innerHTML = '<option value="">All Approvers</option>' + opts;
    if (prev && Array.from(sel.options).some(o => o.value === prev)) {
        sel.value = prev;
    }
}

async function loadCatalogDashboard() {
    try {
        const [pipelineRes, pagesRes] = await Promise.all([
            fetch('/api/catalog_pipeline'),
            fetch('/api/catalog'),
            loadScanStatus(),
        ]);
        cachedCatalogPipeline = (await pipelineRes.json()).pipeline || [];
        allCatalogPages = (await pagesRes.json()).catalog_pages || [];
        populateCatalogCollegeFilter();
        populateCatalogApproverFilter();
        renderCatalogPipeline();
        renderCatalogTable();
    } catch (e) {
        console.error('catalog load failed', e);
    }
}

// Pages matching every active catalog filter EXCEPT the pipeline tile and
// the named one. Used to compute cross-filter counts so each filter shows
// "what would I have if I switched to this option" rather than its own
// downstream-narrowed view.
// Build a case-insensitive search matcher that supports `*` (zero or more
// characters) and `?` (exactly one character) wildcards. Without wildcards,
// falls back to substring match (so existing user queries keep working).
// All other regex metacharacters in the query are escaped, so a search
// like "(MS)" or "x.y" is treated literally.
function buildSearchMatcher(query) {
    const q = (query || '').trim();
    if (!q) return () => true;
    const ql = q.toLowerCase();
    if (!ql.includes('*') && !ql.includes('?')) {
        // No wildcards — simple substring check (same as before).
        return (s) => (s || '').toLowerCase().includes(ql);
    }
    // Escape regex metacharacters EXCEPT * and ?, then translate those
    // to their regex equivalents. Anchoring is unanchored on purpose so
    // "*foo*" and "foo" behave the same way (substring-anywhere).
    let pat = '';
    for (const ch of ql) {
        if (ch === '*') pat += '.*';
        else if (ch === '?') pat += '.';
        else if ('.+^$|()[]{}\\\\'.includes(ch)) pat += '\\' + ch;
        else pat += ch;
    }
    let re;
    try { re = new RegExp(pat, 'i'); }
    catch (e) { return (s) => (s || '').toLowerCase().includes(ql); }
    return (s) => re.test(s || '');
}

function getCatalogBaseFiltered(excludeFilter) {
    const collegeFilter = excludeFilter === 'college' ? '' : (document.getElementById('filter-college')?.value || '');
    const approverFilter = excludeFilter === 'approver' ? '' : (document.getElementById('filter-approver')?.value || '');
    const searchRaw = excludeFilter === 'search' ? '' : (document.getElementById('filter-search')?.value || '');
    const matchSearch = buildSearchMatcher(searchRaw);
    let pages = (allCatalogPages || []).slice();
    if (collegeFilter) pages = pages.filter(p => getCatalogCollege(p) === collegeFilter);
    if (approverFilter) pages = pages.filter(p => (p.user || '').trim() === approverFilter);
    if (searchRaw.trim()) pages = pages.filter(p =>
        matchSearch(p.id) || matchSearch(p.title));
    return pages;
}

function renderCatalogPipeline() {
    const bar = document.getElementById('pipeline-bar');
    if (!bar) return;
    // Build a single "College" tile aggregating all pre-Provost editor roles,
    // then one tile per post-Provost workflow stage in CATALOG_BUCKETS order.
    // Counts respect every active filter EXCEPT the pipeline tile itself.
    const filtered = getCatalogBaseFiltered('pipeline');
    const collegeCount = filtered.filter(p => isCatalogCollegeStep(p.current_step)).length;
    const tiles = [{
        role: '__catalog_college__',
        short_name: 'College',
        count: collegeCount,
    }];
    for (const b of CATALOG_BUCKETS) {
        const count = filtered.filter(p => b.match(p.current_step)).length;
        tiles.push({
            role: b.role,
            short_name: b.short_name,
            count,
        });
    }
    const html = tiles.map(step => {
        const hasItems = step.count > 0;
        const activeClass = pipelineFilter === step.role ? ' active' : '';
        return `
            <div class="pipeline-step ${hasItems ? 'has-items' : 'empty'}${activeClass}"
                 onclick="togglePipelineFilter('${step.role}')"
                 title="${escapeHtml(step.short_name)}: ${step.count} pages">
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

let catalogSortKey = 'title';
let catalogSortDir = 1;

function sortCatalogBy(key) {
    if (catalogSortKey === key) catalogSortDir *= -1;
    else { catalogSortKey = key; catalogSortDir = 1; }
    renderCatalogTable();
}

function renderCatalogTable() {
    const container = document.getElementById('programs-table-container');
    if (!container) return;
    const searchRaw = (document.getElementById('filter-search')?.value || '');
    const matchSearch = buildSearchMatcher(searchRaw);
    const collegeFilter = document.getElementById('filter-college')?.value || '';
    const approverFilter = document.getElementById('filter-approver')?.value || '';
    let pages = (allCatalogPages || []).slice();
    if (collegeFilter) {
        pages = pages.filter(p => getCatalogCollege(p) === collegeFilter);
    }
    if (approverFilter) {
        pages = pages.filter(p => (p.user || '').trim() === approverFilter);
    }
    if (pipelineFilter) {
        if (pipelineFilter === '__catalog_college__') {
            pages = pages.filter(p => isCatalogCollegeStep(p.current_step));
        } else {
            pages = pages.filter(p => p.current_step === pipelineFilter);
        }
    }
    if (searchRaw.trim()) {
        pages = pages.filter(p =>
            matchSearch(p.id) || matchSearch(p.title)
        );
    }
    pages.sort((a, b) => {
        const av = (catalogSortKey === 'title') ? (a.title || a.id || '')
                : (catalogSortKey === 'step')  ? (a.current_step || '')
                : (a.user || '');
        const bv = (catalogSortKey === 'title') ? (b.title || b.id || '')
                : (catalogSortKey === 'step')  ? (b.current_step || '')
                : (b.user || '');
        return av.localeCompare(bv) * catalogSortDir;
    });
    document.getElementById('result-count').textContent = `${pages.length} pages`;
    if (pages.length === 0) {
        container.innerHTML = '<p class="empty-state">No catalog pages match your filters.</p>';
        return;
    }
    const arrow = k => catalogSortKey === k ? (catalogSortDir === 1 ? ' ▲' : ' ▼') : '';
    const cls   = k => 'sortable-header' + (catalogSortKey === k ? ' sort-active' : '');
    let html = `
        <table class="program-table">
            <thead><tr>
                <th class="${cls('title')}" onclick="sortCatalogBy('title')">Title${arrow('title')}</th>
                <th class="${cls('step')}"  onclick="sortCatalogBy('step')">Current Role${arrow('step')}</th>
                <th class="${cls('user')}"  onclick="sortCatalogBy('user')">Approver${arrow('user')}</th>
            </tr></thead>
            <tbody>`;
    for (const p of pages) {
        const path = p.id || '';
        const url = `https://nextcatalog.northeastern.edu${path}/`;
        const title = p.title || path;
        html += `<tr class="program-row">
            <td><strong><a href="${escapeHtml(url)}" target="_blank">${escapeHtml(title)}</a></strong></td>
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

// The main tracked pipeline steps (canonical display stages)
const PIPELINE_STEPS = new Set([
    "Program PR Graduate Dean's Office",
    "Provost Initial Review",
    "Program Review 2",
    "Program Graduate Provost Review",
    "Program GRA Regulatory",
    "Program Graduate Curriculum Committee",
    "Program Undergraduate Curriculum Committee - Tabled Proposals",
    "Program Provost Administrative and Budgetary Review",
    "Program Provost Approval",
    "Program Faculty Senate",
    "Program University Board of Trustees",
    "Program Setup",
    "Program Teach-Out",
]);

// Mirror of scraper.canonical_program_step: fold workflow-role variants into
// the canonical pipeline stage shown in the bar. Keep in sync with scraper.py.
function canonicalStep(step) {
    if (!step) return step;
    if (step.indexOf("Program GRA Regulatory") === 0) return "Program GRA Regulatory";
    if (step === "Program Banner Setup" || step === "Program Editor" ||
        step === "Program Workflow Setup" || step === "Program CIP Code Committee" ||
        step.indexOf("Program Catalog Setup") === 0 ||
        step.indexOf("Degree Audit") !== -1) return "Program Setup";
    return step;
}

function isCollegeStep(step) {
    if (!step) return false;
    if (PIPELINE_STEPS.has(canonicalStep(step))) return false;
    // UIP College Approval is the interdisciplinary college sign-off gate → College.
    if (step === "Program UIP College Approval") return true;
    // Department / college committee Chair roles go to the virtual College stage.
    if (step.indexOf("Chair") !== -1) return true;
    // College steps have department codes like EN, SC, SH, AM, BA, etc.
    return step.match(/^Program (AFCS|AM |AMSL|ARCH|ASNS|BA |CS |EDU|EECE|EN |ENGL|HIST|HUSV|MSCI|PPUA|PS |SC |SH )/);
}

// College-PERSPECTIVE detector (programs). Unlike isCollegeStep's prefix
// allowlist (which omits BV, LW, MI, …), this is the complement: since the
// College perspective is already scoped to one college, ANY step that isn't a
// university-pipeline stage (Provost/Setup/Senate/Trustees/Registrar/…) is one
// of that college's own internal roles — regardless of its prefix. This auto-
// captures every college's roles with no hardcoded list to maintain.
function isCollegeInternalStep(step) {
    if (!step) return false;
    if (PIPELINE_STEPS.has(canonicalStep(step))) return false;   // OTP/university stage
    if (/\b(Provost|Registrar|Global Launch|Faculty Senate|Board of Trustees)\b/i.test(step)) return false;
    return true;
}
// Pick the right "is this a college-internal step" detector for the current
// perspective + view. OTP keeps the historical isCollegeStep (drives the
// virtual College tile); College perspective uses the complement above.
function _cimCollegeDetector() {
    const isCourse = currentView === 'courses';
    if (cimPerspective === 'college') return isCourse ? isCourseCollegeStep : isCollegeInternalStep;
    return isCourse ? isCourseCollegeStep : isCollegeStep;
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
        loadApprovers(),
        ensureCimRolePairs()
    ]);
    // Render everything through applyFilters so the type/proposal/pipeline
    // counts and the table are all scoped to the active perspective + filters
    // (e.g. College perspective + a selected college). Calling the bare
    // update*Counts() here instead showed whole-DB counts — a Graduate button
    // reading 1036 (all grad, any state) instead of 14 (KHY grad in-workflow)
    // — until the user happened to click a filter that re-ran applyFilters.
    updateSmartViewCounts();
    applyFilters();
    loadSourceHealth();
}

// ── Source-data status bar ──────────────────────────────────────────────────
// ALWAYS visible (all views, local app): shows the last data-refresh time and
// the app build time. Turns amber and lists offenders when any upstream source
// hasn't had a successful refresh within the server's threshold. Driven by
// /api/source_health; on the static site the fetch fails and nothing renders.
async function loadSourceHealth() {
    try {
        const res = await fetch('/api/source_health');
        if (!res.ok) return;
        renderSourceHealthBanner(await res.json());
    } catch (_) { /* static site / server down: no bar */ }
}
function _fmtStaleAge(hrs) {
    if (hrs == null) return 'never';
    const d = Math.round(hrs / 24);
    if (hrs >= 24) return d + ' day' + (d === 1 ? '' : 's') + ' ago';
    return Math.max(1, Math.round(hrs)) + 'h ago';
}
function _fmtDT(iso) {
    if (!iso) return '—';
    try {
        return new Date(iso).toLocaleString('en-US', {
            timeZone: 'America/New_York', month: 'short', day: 'numeric',
            year: 'numeric', hour: 'numeric', minute: '2-digit'
        }) + ' ET';
    } catch (_) { return iso; }
}
function renderSourceHealthBanner(data) {
    let bar = document.getElementById('source-health-banner');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'source-health-banner';
        document.body.insertBefore(bar, document.body.firstChild);
    }
    const info = `Data last refreshed: <strong>${_fmtDT(data.last_refresh)}</strong>`
        + ` &nbsp;·&nbsp; App build: <strong>${_fmtDT(data.build_time)}</strong>`;
    const stale = ((data && data.sources) || []).filter(s => s.stale);
    if (stale.length) {
        const items = stale.map(s => `${escapeHtml(s.name)} (${_fmtStaleAge(s.age_hours)})`).join(', ');
        bar.className = 'shb-stale';
        bar.innerHTML = `<span class="shb-icon">⚠</span><span>${info} &nbsp;·&nbsp; `
            + `<strong>Out of date (>${data.threshold_days} days): ${items}</strong></span>`;
    } else {
        bar.className = 'shb-ok';
        bar.innerHTML = `<span>${info}</span>`;
    }
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
        loadCourseApprovers(),
        ensureCimRolePairs()
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
        const colleges = (data.colleges || []).slice()
            .sort((a, b) => abbreviateCollege(a).localeCompare(abbreviateCollege(b)));
        const options = colleges.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(abbreviateCollege(c))}</option>`).join('');
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
    const newCount = (allCourses || []).filter(c => {
        const submitted = c.date_submitted ? new Date(c.date_submitted) : null;
        return submitted && (now - submitted) < NEW_SUBMISSION_DAYS * 86400000;
    }).length;
    const recentCount = (allCourses || []).filter(c => {
        const entered = c.step_entered_date ? new Date(c.step_entered_date) : null;
        if (!entered || (now - entered) >= RECENT_CHANGE_DAYS * 86400000) return false;
        const submitted = c.date_submitted ? new Date(c.date_submitted) : null;
        return !submitted || (now - submitted) >= NEW_SUBMISSION_DAYS * 86400000;
    }).length;
    const stuckCount = (allCourses || []).filter(isStuckProgram).length;

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
    // Multi-select toggle: each click flips its type in the Set.
    if (typeFilter.has(type)) typeFilter.delete(type);
    else typeFilter.add(type);
    document.querySelectorAll('.type-btn').forEach(btn => {
        const btnType = btn.getAttribute('onclick').match(/'([^']*)'/)[1];
        btn.classList.toggle('active', typeFilter.has(btnType));
    });
    applyFilters();
}

function setProposalFilter(status) {
    // Multi-select toggle: each click flips that status in the Set.
    // 'Added' / 'Edited' / 'Deactivated' filter on item.status;
    // '__complete__' filters on completion_date (and disables the
    // default "hide completed" rule). Any combination is allowed.
    if (proposalFilter.has(status)) proposalFilter.delete(status);
    else proposalFilter.add(status);
    document.querySelectorAll('.proposal-btn').forEach(btn => {
        const btnStatus = btn.getAttribute('onclick').match(/'([^']*)'/)[1];
        btn.classList.remove('active-all', 'active-new', 'active-edit', 'active-inact', 'active-complete');
        if (proposalFilter.has(btnStatus)) {
            if (btnStatus === 'Added')             btn.classList.add('active-new');
            else if (btnStatus === 'Edited')       btn.classList.add('active-edit');
            else if (btnStatus === 'Deactivated')  btn.classList.add('active-inact');
            else if (btnStatus === '__complete__') btn.classList.add('active-complete');
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
            btn.classList.toggle('active-complete', proposalFilter.has('__complete__'));
            return;
        }
        const count = counts[s] || 0;
        const newLabel = currentView === 'courses' ? 'New Courses' : 'New Programs';
        const labels = { '': 'All', 'Added': newLabel, 'Edited': 'Changes', 'Deactivated': 'Inactivations' };
        btn.textContent = `${labels[s]} (${count})`;
        btn.classList.remove('active-all', 'active-new', 'active-edit', 'active-inact');
        if (proposalFilter.has(s)) {
            if (s === 'Added')            btn.classList.add('active-new');
            else if (s === 'Edited')      btn.classList.add('active-edit');
            else if (s === 'Deactivated') btn.classList.add('active-inact');
        }
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

// Counts for the program-kind row, cross-filtered against everything EXCEPT
// the kind itself (so each button shows "what would I have if I switched
// to this option" given the rest of the filter state). Also drives the
// row's visibility — hidden on Courses/Catalog views.
function updateProgramKindCounts() {
    const row = document.getElementById('kind-filter-row');
    if (!row) return;
    if (currentView !== 'programs') {
        row.style.display = 'none';
        return;
    }
    row.style.display = '';
    let baseExclKind = getBaseFiltered(window._staticApproverIds || null, { kind: true });
    // Apply the active pipeline-tile filter so kind counts match what's shown.
    if (pipelineFilter) {
        baseExclKind = baseExclKind.filter(p => {
            if (pipelineFilter === '__college__') return isCollegeStep(p.current_step);
            if (pipelineFilter === '__downstream__') { const d = _cimCollegeDetector(); return !!p.current_step && !d(p.current_step); }
            if (pipelineFilter === '__complete__') return !!p.completion_date;
            return canonicalStep(p.current_step) === pipelineFilter;
        });
    }
    const counts = { '': baseExclKind.length };
    baseExclKind.forEach(p => {
        const k = classifyProgramKind(p);
        if (k) counts[k] = (counts[k] || 0) + 1;
    });
    document.querySelectorAll('.kind-btn').forEach(btn => {
        const k = btn.dataset.kind || '';
        const def = PROGRAM_KINDS.find(d => d.id === k);
        const label = def ? def.label : 'All';
        const count = counts[k] || 0;
        btn.textContent = `${label} (${count})`;
        btn.classList.toggle('active', k === programKindFilter);
    });
}

async function loadColleges() {
    try {
        const res = await fetch('/api/colleges');
        const data = await res.json();
        const select = document.getElementById('filter-college');
        const colleges = (data.colleges || []).slice()
            .sort((a, b) => abbreviateCollege(a).localeCompare(abbreviateCollege(b)));
        const options = colleges.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(abbreviateCollege(c))}</option>`).join('');
        select.innerHTML = '<option value="">All Colleges</option>' + options;
    } catch (e) {
        console.error('Failed to load colleges:', e);
    }
}

function updateSmartViewCounts() {
    const now = new Date();
    const visiblePrograms = (allPrograms || []).filter(p => !isTemplateProgram(p));
    const newCount = visiblePrograms.filter(p => {
        const submitted = p.date_submitted ? new Date(p.date_submitted) : null;
        return submitted && (now - submitted) < NEW_SUBMISSION_DAYS * 86400000;
    }).length;
    const recentCount = visiblePrograms.filter(p => {
        const entered = p.step_entered_date ? new Date(p.step_entered_date) : null;
        if (!entered || (now - entered) >= RECENT_CHANGE_DAYS * 86400000) return false;
        // Exclude new submissions (they have their own bucket).
        const submitted = p.date_submitted ? new Date(p.date_submitted) : null;
        return !submitted || (now - submitted) >= NEW_SUBMISSION_DAYS * 86400000;
    }).length;
    const stuckCount = visiblePrograms.filter(isStuckProgram).length;

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
    // Toggle: clicking the active smart view clears it (back to 'all').
    smartView = (smartView === view) ? 'all' : view;
    document.querySelectorAll('.smart-view-btn').forEach(btn => {
        const btnView = btn.getAttribute('onclick').match(/'(\w+)'/)[1];
        btn.classList.toggle('active', btnView === smartView && smartView !== 'all');
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

        // Updates run continuously in the background — no need to show
        // a "Updating..." spinner or per-phase progress text. Just the
        // last-updated timestamp.
        statusEl.textContent = '';
        statusEl.className = 'scan-status';
        if (progressContainer) progressContainer.style.display = 'none';
        const btn = document.getElementById('scan-btn');
        if (btn) btn.disabled = false;

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
    // Initial-load race guard: /api/pipeline (tile counts) can resolve before
    // /api/programs populates allPrograms. If a tile is clicked in that window,
    // recounting from an empty source would zero EVERY tile and stick until the
    // next applyFilters. Skip the recount while the source data is still empty;
    // loadPrograms()/loadDashboard() re-run applyFilters once it arrives. (A
    // legitimately empty result set — e.g. a search that matches nothing — still
    // zeroes correctly because the source array itself is non-empty.)
    const srcData = currentView === 'courses' ? allCourses : allPrograms;
    if (!srcData.length) return;
    const isCourses = currentView === 'courses';
    // Recount each pipeline step from filtered data. Program tiles use canonical
    // stage names (e.g. "Program Setup" covers Catalog Setup / Editor / Banner /
    // Degree Audit; "Program GRA Regulatory" covers the Modifications-Submitted
    // variants), so the raw current_step MUST be canonicalized before matching
    // to a tile — otherwise a searched/filtered program sitting at a folded step
    // (Catalog Setup, Degree Audit, GRA Modifications) lands in no tile and the
    // pipeline summary shows 0s. Courses match raw steps via bucket .match below.
    const stepCounts = {};
    baseFiltered.forEach(item => {
        const raw = item.current_step;
        if (!raw) return;
        const key = isCourses ? raw : canonicalStep(raw);
        stepCounts[key] = (stepCounts[key] || 0) + 1;
    });
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
    const sorted = Object.keys(counts).sort((a, b) => abbreviateCollege(a).localeCompare(abbreviateCollege(b)));
    select.innerHTML = '<option value="">All Colleges</option>' +
        sorted.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(abbreviateCollege(c))} (${counts[c]})</option>`).join('');
    // Preserve selection if still valid
    if (counts[current]) select.value = current;
}

function renderPipeline(pipeline, baseFiltered) {
    const bar = document.getElementById('pipeline-bar');
    const isCourseView = currentView === 'courses';

    // College perspective: replace the OTP pipeline with the selected college's
    // own internal roles (ordered by role-type template) plus a trailing
    // "→ Provost" tile for everything that has left the college. The set is
    // already scoped to the college by getBaseFiltered.
    if (cimPerspective === 'college' && cimCollegeSelected) {
        renderCollegePipeline(baseFiltered, isCourseView);
        const cBtn = document.getElementById('btn-proposal-complete');
        if (cBtn) { cBtn.classList.toggle('active-complete', pipelineFilter === '__complete__'); cBtn.style.display = ''; }
        return;
    }
    // University perspective: single pipeline, no panel arrows.
    _setPanelArrows(false);
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
        // Escape backslashes/quotes so role names with apostrophes
        // (e.g. "Program PR Graduate Dean's Office") don't break the inline handler.
        const roleArg = step.role.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return `
            <div class="pipeline-step ${hasItems ? 'has-items' : 'empty'}${activeClass}"
                 onclick="togglePipelineFilter('${roleArg}')"
                 title="${escapeHtml(step.role)}: ${step.count} programs">
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

// Build the pipeline bar for the College perspective: the selected college's
// own in-workflow roles (ordered by collegeRoleRank) as fine-grained tiles,
// then a trailing "→ Provost" tile aggregating items that have moved past the
// college into the university pipeline.
// Fetch the (college, step) workflow-role pairs once (no-op on static, where
// data.json already populated cimRolePairs).
async function ensureCimRolePairs() {
    if (cimRolePairs) return;
    try {
        const res = await fetch('/api/workflow_roles');
        if (res.ok) cimRolePairs = await res.json();
    } catch (_) { /* leave null; renderCollegePipeline falls back */ }
}

function renderCollegePipeline(baseFiltered, isCourseView) {
    const bar = document.getElementById('pipeline-bar');
    // Self-scope to the selected college. renderPipeline is sometimes called
    // with the full unscoped set (initial load / post-scan), so never trust the
    // caller to have filtered — always restrict to this college here.
    const raw = baseFiltered || (isCourseView ? allCourses : allPrograms);
    const source = (raw || []).filter(p => p.college === cimCollegeSelected);
    const detector = _cimCollegeDetector();
    const code = _COLLEGE_CODE[cimCollegeSelected];
    // A step belongs to ANOTHER college if it carries a different college's code
    // prefix (e.g. "Program AM …" under Bouvé = CAMD's, via a cross-listed
    // program). Those don't belong on this college's bar — bucket them with the
    // trailing "not at one of our steps" tile. Un-prefixed dept chairs (ARTD,
    // PHSC, …) and this college's own prefix stay.
    const _foreign = step => {
        const m = step.match(/^Program (AM|BA|BV|CS|EN|LW|MI|PS|SC|SH) /);
        return code && m && m[1] !== code;
    };
    const roleCounts = {};
    let downstream = 0;
    source.forEach(p => {
        const step = p.current_step;
        if (!step) return;                       // not in workflow
        if (detector(step) && !_foreign(step)) roleCounts[step] = (roleCounts[step] || 0) + 1;
        else downstream += 1;                    // past the college, or at another college
        // Checkpoint is shown in BOTH panels: the detector excludes it (it's a
        // COURSE_BUCKET, so it lives in the university panel), but we also give
        // it a tile in the college panel since it's the earliest course step.
        if (isCourseView && step === 'Checkpoint') roleCounts['Checkpoint'] = (roleCounts['Checkpoint'] || 0) + 1;
    });
    // Tile SET = roles a program is CURRENTLY at (any role, real position) PLUS
    // this college's own roles from the workflow definitions so the sequence
    // shows even when a role is empty. The workflow union is noisy (joint
    // programs route through OTHER colleges' committees; ad-hoc reviewer /
    // checkpoint steps), so the empty-role additions are restricted to roles
    // carrying THIS college's code prefix (e.g. "Program BV …"). Currently-
    // occupied roles are always kept since they're the program's real position.
    const universe = new Set(Object.keys(roleCounts));
    if (cimRolePairs && code) {
        const pre = 'Program ' + code + ' ';
        const pairs = (isCourseView ? cimRolePairs.courses : cimRolePairs.programs) || [];
        pairs.forEach(([col, step]) => {
            if (col === cimCollegeSelected && detector(step) && step.indexOf(pre) === 0) universe.add(step);
        });
    }
    let roles = [...universe].sort((a, b) => {
        const ra = collegeRoleRank(a), rb = collegeRoleRank(b);
        return ra !== rb ? ra - rb : a.localeCompare(b);
    });
    // Graduate / Undergraduate switch prunes role tiles by the level token in
    // the role name; level-agnostic roles (dept chairs, Accreditor, Continuing-
    // Ed) stay visible under either level. (\bGraduate\b doesn't match
    // "Undergraduate", so the two are cleanly distinguished.) typeFilter is a
    // Set (multi-select); only prune when exactly one of Grad/UG is selected.
    const wantGrad = typeFilter.has('Graduate');
    const wantUg = typeFilter.has('Undergraduate');
    if (wantGrad !== wantUg) {
        roles = roles.filter(r => {
            const isUg = /\bUndergraduate\b/i.test(r);
            const isGrad = /\bGraduate\b/i.test(r) && !isUg;
            if (!isGrad && !isUg) return true;                  // agnostic → keep
            return wantGrad ? isGrad : isUg;
        });
    }
    const tile = (role, label, cnt) => {
        const active = pipelineFilter === role ? ' active' : '';
        const roleArg = role.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return `
            <div class="pipeline-step ${cnt > 0 ? 'has-items' : 'empty'}${active}"
                 onclick="togglePipelineFilter('${roleArg}')"
                 title="${escapeHtml(role)}: ${cnt}">
                <span class="step-count">${cnt}</span>
                <span class="step-name">${escapeHtml(label)}</span>
            </div>`;
    };
    // PANEL 1: the college's own internal roles (full sequence, even empty).
    const collegeHtml = roles.map(role =>
        tile(role, collegeRoleShort(role), roleCounts[role] || 0)).join('');
    // PANEL 2: the FULL university (OTP) pipeline stages, scoped to this college
    // (all stages shown, including empty, so ADs can gauge progress + timing).
    const stages = isCourseView ? collapseCoursePipeline(cachedCoursePipeline || []) : (cachedPipeline || []);
    const stageCount = (role) => {
        if (isCourseView) {
            const bd = COURSE_BUCKETS.find(b => b.role === role);
            return source.filter(p => p.current_step && (bd ? bd.match(p.current_step) : p.current_step === role)).length;
        }
        return source.filter(p => p.current_step && canonicalStep(p.current_step) === role).length;
    };
    const downHtml = stages.map(st => tile(st.role, st.short_name, stageCount(st.role))).join('');
    // The two panels swap via the toggle next to the "Pipeline Summary" heading
    // (always on-screen, unlike an arrow at the end of a scrollable bar).
    // collegePanel holds which is showing; renderCollegePipeline is re-run on
    // toggle (args stashed). The bar still slide-animates on each swap.
    _collegePipeArgs = { baseFiltered: raw, isCourseView };
    bar.innerHTML = (collegePanel === 'downstream') ? downHtml : collegeHtml;
    bar.classList.remove('pipe-slide-in'); void bar.offsetWidth; bar.classList.add('pipe-slide-in');
    // Flanking arrows on the pipeline row flip between panels: college sits
    // before university, so the college-steps panel shows a RIGHT arrow (▸ →
    // forward to university) and the university panel shows a LEFT arrow (◂ →
    // back to college). The arrows live outside the scrollable bar so they
    // never scroll off.
    _setPanelArrows(true, collegePanel);
}

// Show/hide the two flanking pipeline arrows. show=false hides both (University
// perspective / non-CIM views). When shown: college panel → right arrow only;
// university panel → left arrow only.
function _setPanelArrows(show, panel) {
    const L = document.getElementById('pipeline-arrow-left');
    const R = document.getElementById('pipeline-arrow-right');
    if (!L || !R) return;
    if (!show) { L.style.display = 'none'; R.style.display = 'none'; return; }
    if (panel === 'downstream') {
        R.style.display = 'none';
        L.style.display = '';
        L.onclick = () => setCollegePanel('college');
    } else {
        L.style.display = 'none';
        R.style.display = '';
        R.onclick = () => setCollegePanel('downstream');
    }
}

function setCimPerspective(mode) {
    cimPerspective = (mode === 'college') ? 'college' : 'otp';
    pipelineFilter = null;   // stage tiles differ between perspectives
    collegePanel = 'college';
    _saveCimPerspective();
    syncPerspectiveUI();
    applyFilters();
}
function setCimCollege(val) {
    cimCollegeSelected = val || '';
    pipelineFilter = null;
    collegePanel = 'college';
    _saveCimPerspective();
    applyFilters();
}
function populatePerspectiveCollege() {
    const sel = document.getElementById('perspective-college');
    if (!sel) return;
    const src = currentView === 'courses' ? allCourses : allPrograms;
    const colleges = [...new Set((src || []).map(p => p.college).filter(Boolean))].sort();
    if (cimCollegeSelected && !colleges.includes(cimCollegeSelected)) colleges.push(cimCollegeSelected);
    sel.innerHTML = '<option value="">Select a college…</option>' +
        colleges.sort().map(c => `<option value="${escapeHtml(c)}">${escapeHtml(abbreviateCollege(c))}</option>`).join('');
    sel.value = cimCollegeSelected || '';
}
function syncPerspectiveUI() {
    const onCimView = currentView === 'programs' || currentView === 'courses';
    // Perspective, Level, and the row-break are CIM-only scoping controls.
    ['cim-scope-bar'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = onCimView ? '' : 'none';
    });
    document.querySelectorAll('.perspective-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.persp === cimPerspective));
    const sel = document.getElementById('perspective-college');
    if (sel) sel.style.display = (cimPerspective === 'college' && onCimView) ? '' : 'none';
    // In College perspective the standalone College filter is redundant (scope
    // is set by the perspective college), so hide it to avoid a conflicting
    // double-filter that could blank the table.
    const cf = document.getElementById('filter-college');
    const cfGroup = cf && cf.closest('.filter-group');
    if (cfGroup) cfGroup.style.display = (cimPerspective === 'college' && onCimView) ? 'none' : '';
    // The panel toggle only applies in College perspective on a CIM view; hide
    // it elsewhere (renderPipeline also hides it on the Central path, but
    // catalog/portfolio don't call renderPipeline at all).
    if (!(cimPerspective === 'college' && onCimView)) _setPanelArrows(false);
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
    const searchRaw = document.getElementById('filter-search').value;
    const matchSearch = buildSearchMatcher(searchRaw);
    const now = new Date();

    const sourceData = currentView === 'courses' ? allCourses : allPrograms;

    const collegeScope = (cimPerspective === 'college' && cimCollegeSelected
        && (currentView === 'programs' || currentView === 'courses'))
        ? cimCollegeSelected : null;

    return sourceData.filter(item => {
        // TEMPLATE: ... entries are CIM scaffolding, never real programs.
        // Hide them from every program-side filter (courses don't have these).
        if (currentView === 'programs' && isTemplateProgram(item)) return false;
        // College perspective scopes everything to the selected college.
        if (collegeScope && item.college !== collegeScope) return false;
        // Smart-view definitions:
        //   new    = submitted in the last 30 days (no other qualifier)
        //   recent = step advanced in the last 14 days BUT NOT a new submission
        //            (i.e., date_submitted is older than 30 days)
        //   stuck  = days at current step >= per-step threshold (BoT excluded)
        if (smartView === 'recent') {
            const entered = item.step_entered_date ? new Date(item.step_entered_date) : null;
            if (!entered || (now - entered) >= RECENT_CHANGE_DAYS * 86400000) return false;
            const submitted = item.date_submitted ? new Date(item.date_submitted) : null;
            if (submitted && (now - submitted) < NEW_SUBMISSION_DAYS * 86400000) return false;
        } else if (smartView === 'stuck') {
            // Courses use the default 21-day fallback; programs use per-step
            // overrides from STUCK_THRESHOLDS (BoT = never, Senate = 60, ...).
            if (!isStuckProgram(item)) return false;
        } else if (smartView === 'new') {
            const submitted = item.date_submitted ? new Date(item.date_submitted) : null;
            if (!submitted || (now - submitted) >= NEW_SUBMISSION_DAYS * 86400000) return false;
        }
        if (!ex.type && typeFilter.size) {
            const lvl = currentView === 'courses' ? classifyCourseLevel(item) : item.program_type;
            if (!typeFilter.has(lvl)) return false;
        }
        if (!ex.proposal && proposalFilter.size) {
            // Multi-select OR: keep the item if its status matches ANY
            // selected proposal type, OR if Complete is selected and
            // the item has a completion_date.
            const statusMatch =
                (proposalFilter.has('Added')       && item.status === 'Added') ||
                (proposalFilter.has('Edited')      && item.status === 'Edited') ||
                (proposalFilter.has('Deactivated') && item.status === 'Deactivated');
            const completeMatch = proposalFilter.has('__complete__') && !!item.completion_date;
            if (!statusMatch && !completeMatch) return false;
        }
        if (!ex.kind && currentView === 'programs' && programKindFilter) {
            if (classifyProgramKind(item) !== programKindFilter) return false;
        }
        if (!ex.college && collegeFilter && item.college !== collegeFilter) return false;
        if (currentView === 'courses') {
            const subjSel = document.getElementById('filter-subject');
            const subjectFilter = subjSel ? subjSel.value : '';
            if (subjectFilter && courseSubjectCode(item) !== subjectFilter) return false;
        }
        if (stepFilter && item.current_step !== stepFilter) return false;
        if (currentView === 'programs' && campusFilter && extractCampus(item.name) !== campusFilter) return false;
        if (approverProgramIds && !approverProgramIds.has(item.id)) return false;

        // Search in name/title and code/banner_code. Supports `*` (any
        // chars) and `?` (one char) wildcards via buildSearchMatcher.
        if (searchRaw && searchRaw.trim()) {
            const searchField = currentView === 'courses' ? item.code : item.name;
            const searchSecond = currentView === 'courses' ? item.title : item.banner_code;
            if (!matchSearch(searchField) && !matchSearch(searchSecond)) return false;
        }
        // Hide completed (no current step) by default. Counts and table match.
        // Showing completed requires either the "Complete" proposal-row
        // button OR the legacy '__complete__' pipeline tile (kept for
        // backward compat in case anything still triggers it).
        const completedShown = proposalFilter.has('__complete__') || pipelineFilter === '__complete__';
        if (!completedShown && item.completion_date && !item.current_step) return false;
        return true;
    });
}

async function applyFilters() {
    // Keep the OTP/College perspective toggle + college picker in sync with
    // the current view and state on every render.
    if (currentView === 'programs' || currentView === 'courses') {
        syncPerspectiveUI();
        populatePerspectiveCollege();
    }
    // Catalog view has a fundamentally different schema (paths instead of
    // numeric IDs, no college/type/proposal/campus dimensions). It has its
    // own minimal renderer rather than going through the program/course
    // filter pipeline below.
    if (currentView === 'catalog') {
        renderCatalogPipeline();
        renderCatalogTable();
        return;
    }
    // Portfolio view also has its own filter pipeline. The header
    // #filter-search input is shared across all views, so route its value
    // into portfolioSearch and re-render the portfolio table. Without this,
    // typing in the header search on Portfolio caused the Programs filter
    // pipeline to run against Portfolio data (it doesn't know about
    // portfolio_programs) and emit the Programs "No programs match" empty
    // state into the table container.
    if (currentView === 'portfolio') {
        const hdr = document.getElementById('filter-search');
        if (typeof setPortfolioSearch === 'function') {
            setPortfolioSearch(hdr ? hdr.value : '');
        }
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

    // Update college dropdown excluding the college filter itself (so you see what's available).
    // ALSO apply the active pipeline tile filter — without this, when the user clicks e.g.
    // the College tile, the dropdown counts include programs at non-college steps and
    // disagree with the rendered table.
    const collegeBase = getBaseFiltered(approverProgramIds, {college: true});
    const collegeDetectorForCounts = _cimCollegeDetector();
    const collegeBaseAfterPipeline = pipelineFilter ? collegeBase.filter(p => {
        if (pipelineFilter === '__college__') return collegeDetectorForCounts(p.current_step);
        if (pipelineFilter === '__downstream__') return !!p.current_step && !collegeDetectorForCounts(p.current_step);
        if (pipelineFilter === '__complete__') return !!p.completion_date;
        if (currentView === 'courses') {
            const bd = COURSE_BUCKETS.find(b => b.role === pipelineFilter);
            if (bd) return bd.match(p.current_step);
            return p.current_step === pipelineFilter;
        }
        return canonicalStep(p.current_step) === pipelineFilter;
    }) : collegeBase;
    updateCollegeOptions(collegeBaseAfterPipeline);

    // Type / Proposal / Kind counts also need pipeline-tile awareness for the same reason.
    function applyPipelineTo(set) {
        if (!pipelineFilter) return set;
        return set.filter(p => {
            if (pipelineFilter === '__college__') return collegeDetectorForCounts(p.current_step);
            if (pipelineFilter === '__downstream__') return !!p.current_step && !collegeDetectorForCounts(p.current_step);
            if (pipelineFilter === '__complete__') return !!p.completion_date;
            if (currentView === 'courses') {
                const bd = COURSE_BUCKETS.find(b => b.role === pipelineFilter);
                if (bd) return bd.match(p.current_step);
                return p.current_step === pipelineFilter;
            }
            return canonicalStep(p.current_step) === pipelineFilter;
        });
    }
    updateTypeCounts(applyPipelineTo(getBaseFiltered(approverProgramIds, {type: true})));
    updateProposalCounts(applyPipelineTo(getBaseFiltered(approverProgramIds, {proposal: true})));
    updateProgramKindCounts();

    // Now apply pipeline filter for the table (college already applied in baseFiltered)
    const collegeDetector = _cimCollegeDetector();
    const isCoursesView = currentView === 'courses';
    const bucketDef = isCoursesView && pipelineFilter
        ? COURSE_BUCKETS.find(b => b.role === pipelineFilter)
        : null;
    let filtered = baseFiltered.filter(p => {
        if (pipelineFilter === '__college__' && !collegeDetector(p.current_step)) return false;
        if (pipelineFilter === '__downstream__') return !!p.current_step && !collegeDetector(p.current_step);
        if (pipelineFilter === '__complete__') {
            return !!p.completion_date;
        }
        if (pipelineFilter && pipelineFilter !== '__college__') {
            if (bucketDef) {
                if (!bucketDef.match(p.current_step)) return false;
            } else {
                const cmp = isCoursesView ? p.current_step : canonicalStep(p.current_step);
                if (cmp !== pipelineFilter) return false;
            }
        }
        // Note: completed programs are hidden by default in getBaseFiltered.
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
        // Days-color uses the step-specific stuck threshold so e.g. a BoT
        // entry doesn't render red after 30 days (BoT threshold is null).
        const stepThreshold = getStuckThreshold(item.current_step);
        let daysClass;
        if (stepThreshold === null) daysClass = 'fresh';
        else if (days < Math.min(14, stepThreshold)) daysClass = 'fresh';
        else if (days < stepThreshold) daysClass = 'aging';
        else daysClass = 'stuck';

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
                `<button class="detail-tab ${activeTab === 'workflow' ? 'active' : ''}" data-tab="workflow"
                    onclick="event.stopPropagation(); switchDetailTab(${id}, 'workflow')">Workflow</button>
                <button class="detail-tab ${activeTab === 'campuses' ? 'active' : ''}" data-tab="campuses"
                    onclick="event.stopPropagation(); switchDetailTab(${id}, 'campuses')">Campuses</button>
                <button class="detail-tab ${activeTab === 'curriculum' ? 'active' : ''}" data-tab="curriculum"
                    onclick="event.stopPropagation(); switchDetailTab(${id}, 'curriculum')">Curriculum</button>
                <button class="detail-tab ${activeTab === 'changes' ? 'active' : ''}" data-tab="changes"
                    onclick="event.stopPropagation(); switchDetailTab(${id}, 'changes')">Program Changes</button>
                <button class="detail-tab ${activeTab === 'reference' ? 'active' : ''}" data-tab="reference"
                    onclick="event.stopPropagation(); switchDetailTab(${id}, 'reference')">Alignment Reference</button>
                <button class="detail-tab ${activeTab === 'misaligned' ? 'active' : ''}" data-tab="misaligned"
                    onclick="event.stopPropagation(); switchDetailTab(${id}, 'misaligned')">Alignment Summary</button>
                <button class="detail-tab ${activeTab === 'compare' ? 'active' : ''}" data-tab="compare"
                    onclick="event.stopPropagation(); switchDetailTab(${id}, 'compare')">Alignment Details</button>` +
                (hasReg ? `
                <button class="detail-tab ${activeTab === 'regulatory' ? 'active' : ''}" data-tab="regulatory"
                    onclick="event.stopPropagation(); switchDetailTab(${id}, 'regulatory')">Regulatory Details</button>` : '');

            html += `
                <tr class="workflow-detail" id="detail-${id}">
                    <td colspan="5">
                        <div class="detail-tabs">
                            ${tabs}
                            <input type="text" class="detail-search"
                                id="detail-search-${id}"
                                placeholder="Search within this page (Enter = next)…"
                                oninput="filterDetailContent(${id})"
                                onkeydown="cycleDetailMatch(${id}, event)"
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
            if (tab === 'campuses') loadCampusesDetail(id);
            else if (tab === 'reference') loadReferenceDetail(id);
            else if (tab === 'compare') loadCompareDetail(id);
            else if (tab === 'misaligned') loadMisalignedDetail(id);
            else if (tab === 'changes') loadChangesDetail(id);
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

        const actionPanel = isCourseView ? '' : buildProgramActionPanel(id, steps);
        contentEl.innerHTML = `
            <div class="workflow-steps">${stepsHtml}</div>
            ${metaHtml}
            ${courseMetaHtml}
            ${actionPanel}
        `;
        if (actionPanel) revealActionPanelIfLocal(id);
    } catch (e) {
        contentEl.innerHTML = '<div class="workflow-meta">Failed to load workflow details.</div>';
    }
}

// ==================== Program actions (approve / send-back / comment) ====================
// These perform WRITE actions in CIM via the local tracker server. On the
// static (GitHub Pages) site they POST cross-origin to the user's own
// localhost:5001 — so the controls only appear (and only work) on the machine
// running the tracker with a valid CIM session. CIM still enforces who may
// approve; the panel just saves a trip to CIM.

function localApiBase() {
    return window._staticMode ? 'http://localhost:5001' : '';
}

let _localServerReachable = null;
async function ensureLocalServer() {
    if (_localServerReachable !== null) return _localServerReachable;
    if (!window._staticMode) { _localServerReachable = true; return true; }
    try {
        const res = await fetch(`${localApiBase()}/api/scan/status`, {method: 'GET'});
        _localServerReachable = res.ok;
    } catch (_) {
        _localServerReachable = false;
    }
    return _localServerReachable;
}

// Build the (initially hidden) approve/send-back/comment panel for a program
// row. Returns '' for courses or programs with no current step.
function buildProgramActionPanel(programId, steps) {
    // Approvals are local-only: the panel renders only on the Flask-served
    // dashboard (localhost), never on the public GitHub Pages static site.
    if (window._staticMode) return '';
    // The AUTHORITATIVE current step is the program's `current_step` (set from
    // the Approve Pages dump — the same value shown in the Current Step column
    // and re-checked live at action time). The per-step `current` marker in
    // the workflow div can lag behind it, so prefer current_step here; that
    // keeps `expected_role` consistent with the live check (otherwise a valid
    // program looks "moved" purely from a stale workflow marker).
    const prog = (typeof allPrograms !== 'undefined' ? allPrograms : [])
        .find(p => String(p.id) === String(programId));
    const role = (prog && prog.current_step)
        || ((steps || []).find(s => (s.step_status || '') === 'current') || {}).step_name
        || '';
    if (!role) return '';
    // Rollback targets: steps already approved, plus the workflow-marked
    // current step if it differs from the authoritative role (covers the lag
    // case where the div still marks the previous step current).
    const approved = (steps || []).filter(s =>
        (s.step_status || '') === 'approved' ||
        ((s.step_status || '') === 'current' && s.step_name !== role));
    const opts = approved.map(s => `<option value="${escapeHtml(s.step_name)}">${escapeHtml(s.step_name)}</option>`).join('');
    const sendback = approved.length
        ? `<div class="pa-row">
               <span class="pa-label">Roll back to:</span>
               <select id="pa-rejectto-${programId}" class="pa-select">${opts}</select>
               <button class="pa-btn pa-sendback" onclick="submitProgramAction(${programId}, 'sendback')">Rollback</button>
           </div>`
        : '';
    return `
        <div class="program-actions" id="program-actions-${programId}" style="display:none;"
             data-role="${escapeHtml(role)}">
            <div class="pa-title">Act on this program <span class="pa-step">(current step: ${escapeHtml(role)})</span></div>
            <textarea id="pa-comment-${programId}" class="pa-comment" rows="2"
                      placeholder="Optional comment (logged in CIM)…"></textarea>
            <div class="pa-row">
                <button class="pa-btn pa-approve" onclick="submitProgramAction(${programId}, 'approve')">Approve</button>
                <button class="pa-btn pa-comment-only" onclick="submitProgramAction(${programId}, 'comment')">Comment only</button>
            </div>
            ${sendback}
            <div class="pa-result" id="pa-result-${programId}"></div>
        </div>`;
}

// Reveal the panel only when the local tracker server is reachable.
async function revealActionPanelIfLocal(programId) {
    const el = document.getElementById(`program-actions-${programId}`);
    if (!el) return;
    if (await ensureLocalServer()) el.style.display = '';
}

async function submitProgramAction(programId, action) {
    const panel = document.getElementById(`program-actions-${programId}`);
    const resultEl = document.getElementById(`pa-result-${programId}`);
    if (!panel) return;
    const role = panel.getAttribute('data-role') || '';
    const comment = (document.getElementById(`pa-comment-${programId}`)?.value || '').trim();
    let rejectto = '';
    if (action === 'sendback') {
        rejectto = document.getElementById(`pa-rejectto-${programId}`)?.value || '';
        if (!rejectto) { resultEl.textContent = 'Pick a step to send back to.'; return; }
    }
    if (action === 'comment' && !comment) { resultEl.textContent = 'Enter a comment first.'; return; }

    const prog = (typeof allPrograms !== 'undefined' ? allPrograms : []).find(p => String(p.id) === String(programId));
    const name = prog ? prog.name : `program #${programId}`;
    let msg;
    if (action === 'approve') msg = `Approve “${name}” at step “${role}” in CIM?\n\nThis advances the program in the official workflow.`;
    else if (action === 'sendback') msg = `Roll “${name}” back to “${rejectto}” in CIM?\n\nThis returns the program to an earlier step in the official workflow.`;
    else msg = `Add a comment to “${name}” in CIM? (does not change its step)`;
    if (comment) msg += `\n\nComment: ${comment}`;
    if (!window.confirm(msg)) return;

    // Disable buttons during the request.
    panel.querySelectorAll('.pa-btn').forEach(b => b.disabled = true);
    resultEl.className = 'pa-result';
    resultEl.textContent = 'Submitting to CIM…';
    try {
        const res = await fetch(`${localApiBase()}/api/program/${programId}/action`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({action, comment, rejectto, expected_role: role, confirm: true}),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
            resultEl.className = 'pa-result pa-ok';
            resultEl.textContent = (data.detail || 'Done') +
                (data.new_step ? ` — now at “${data.new_step}”.` : '') +
                ' Refreshing…';
            setTimeout(() => loadDashboard(), 1500);
        } else {
            resultEl.className = 'pa-result pa-err';
            resultEl.textContent = (data.detail || 'Action failed.');
            panel.querySelectorAll('.pa-btn').forEach(b => b.disabled = false);
        }
    } catch (e) {
        resultEl.className = 'pa-result pa-err';
        resultEl.textContent = 'Could not reach the tracker server on this machine.';
        panel.querySelectorAll('.pa-btn').forEach(b => b.disabled = false);
    }
}

// CIM session indicator + one-click re-authenticate (local Flask site only).
async function refreshCimAuthStatus() {
    const btn = document.getElementById('auth-btn');
    if (!btn || window._staticMode) return;  // header controls are local-only
    try {
        const res = await fetch('/api/auth/status');
        const data = await res.json();
        btn.className = 'header-secondary-btn';
        if (data.ok) {
            btn.innerHTML = '<span class="auth-dot ok">●</span> CIM connected';
            btn.title = (data.detail || 'CIM session is valid') + ' — click to reopen CIM in Chrome';
        } else {
            btn.innerHTML = '<span class="auth-dot bad">●</span> Log in to CIM';
            btn.title = data.detail || 'CIM session invalid — click to log in';
        }
    } catch (_) {
        btn.textContent = 'Authenticate';
        btn.className = 'header-secondary-btn';
    }
}

async function cimAuthenticate() {
    const btn = document.getElementById('auth-btn');
    if (btn) btn.disabled = true;
    try {
        const res = await fetch('/api/auth/login', {method: 'POST'});
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
            if (btn) {
                btn.innerHTML = '<span class="auth-dot bad">●</span> could not open Chrome';
                btn.className = 'header-secondary-btn';
                btn.title = data.detail || '';
                btn.disabled = false;
            }
            return;
        }
        // Give the user a moment to complete SSO in Chrome, then re-check.
        if (btn) { btn.innerHTML = '<span class="auth-dot">●</span> log in to CIM in Chrome…'; btn.className = 'header-secondary-btn'; }
        let tries = 0;
        const iv = setInterval(async () => {
            tries++;
            await refreshCimAuthStatus();
            const ok = !!document.querySelector('#auth-btn .auth-dot.ok');
            if (ok) dismissErrorBanner();
            if (ok || tries > 40) { clearInterval(iv); if (btn) btn.disabled = false; }
        }, 3000);
    } catch (_) {
        if (btn) btn.disabled = false;
    }
}

// Mirror of scraper._parse_campus_from_name: split a program name into its
// base (subject + degree) and campus/deployment. Parenthetical campus wins
// ("Management, MS (Oakland)" → base "Management, MS", campus "Oakland");
// otherwise an em-dash delivery suffix ("…MS—Online" → campus "Online").
// Distinct-program suffixes like "—Align" are left in the base.
function parseCampusFromName(name) {
    name = (name || '').trim();
    let m = name.match(/\(([^)]+)\)\s*$/);
    if (m) return {base: name.slice(0, m.index).trim(), campus: m[1].trim()};
    m = name.match(/—(Online|Accelerated|Part-Time)\s*$/);
    if (m) return {base: name.slice(0, m.index).trim(), campus: m[1].trim()};
    return {base: name, campus: null};
}

// Campuses tab: list every campus/deployment that has a CIM record for this
// program (same base subject+degree), excluding inactivations. Computed from
// the loaded program data, so it works identically on the local and static
// sites without an API call.
function loadCampusesDetail(programId) {
    const contentEl = document.getElementById(`detail-content-${programId}`);
    if (!contentEl) return;
    const prog = (allPrograms || []).find(p => String(p.id) === String(programId));
    if (!prog) { contentEl.innerHTML = '<div class="workflow-meta">Program not found.</div>'; return; }
    const base = parseCampusFromName(prog.name).base;
    const baseKey = base.toLowerCase();

    // Group matching, non-inactivated records by campus label.
    const byCampus = {};   // campusLabel -> {step, completed}
    (allPrograms || []).forEach(p => {
        if (parseCampusFromName(p.name).base.toLowerCase() !== baseKey) return;
        if ((p.status || '') === 'Deactivated') return;              // exclude inactivations
        let campus = parseCampusFromName(p.name).campus;
        if (!campus) campus = (p.campus && p.campus.toUpperCase() !== 'BOS') ? p.campus : 'Boston';
        const slot = byCampus[campus] || (byCampus[campus] = {step: '', completed: false});
        if (p.current_step && p.current_step.trim()) slot.step = p.current_step.trim();
        else if (p.completion_date) slot.completed = true;
    });

    const campuses = Object.keys(byCampus).sort((a, b) => a.localeCompare(b));
    if (!campuses.length) {
        contentEl.innerHTML = '<div class="workflow-meta">No campus records found.</div>';
        return;
    }
    const body = campuses.map(c => {
        const s = byCampus[c];
        const status = s.step ? `In workflow — ${escapeHtml(s.step)}`
                     : s.completed ? 'Approved' : '—';
        const isThis = parseCampusFromName(prog.name).campus
            ? (parseCampusFromName(prog.name).campus === c)
            : (c === 'Boston');
        return `<tr><td>${escapeHtml(c)}${isThis ? ' <span class="campus-current">(this record)</span>' : ''}</td>`
             + `<td>${status}</td></tr>`;
    }).join('');
    contentEl.innerHTML = `
        <div class="workflow-meta">${campuses.length} campus${campuses.length === 1 ? '' : 'es'} with a CIM record for `
        + `<strong>${escapeHtml(base)}</strong> <span class="pa-step">(inactivations excluded)</span></div>
        <table class="campuses-table">
            <thead><tr><th>Campus</th><th>Status</th></tr></thead>
            <tbody>${body}</tbody>
        </table>`;
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
        const approved = r.ugcc_approved === 'Yes';
        const badge = approved
            ? `<span class="ugcc-badge ugcc-yes">UGCC approved${r.ugcc_date ? ' · ' + escapeHtml(r.ugcc_date) : ''}</span>`
            : `<span class="ugcc-badge ugcc-no">UGCC: not approved</span>`;
        return `<div class="refs-list-item">
            <div class="refs-list-item-info">
                <div class="refs-list-item-name">${escapeHtml(r.name)} ${badge}</div>
                <div class="refs-list-item-meta">${meta}</div>
                <div class="refs-ugcc-edit">
                    <label><input type="checkbox" id="ugcc-chk-${r.id}" ${approved ? 'checked' : ''}> UGCC approved</label>
                    <input type="date" id="ugcc-date-${r.id}" value="${escapeHtml(r.ugcc_date || '')}">
                    <button class="ugcc-save-btn" onclick="saveRefUgcc(${r.id})">Save</button>
                </div>
            </div>
            <div class="refs-list-item-actions">
                <button class="refs-list-item-download" onclick="downloadCustomRef(${r.id})">Download</button>
                <button class="refs-list-item-delete" onclick="deleteCustomRef(${r.id}, '${escapeHtml(r.name).replace(/'/g, "\\'")}')">Delete</button>
            </div>
        </div>`;
    }).join('');
}

function downloadCustomRef(refId) {
    // Hits the local Flask server, which regenerates a standardized .docx from
    // the stored parsed curriculum and streams it as a file download.
    window.open('http://localhost:5001/api/custom_references/' + refId + '/download', '_blank');
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
        if (data.count && data.count > 1) {
            const names = (data.created || []).map(c => c.modality || c.name).join(', ');
            status.textContent = `Saved ${data.count} references (split by modality: ${names}).`;
        } else {
            status.textContent = `Saved "${data.name}" — ${nSections} sections, ${nCourses} courses${warn}.`;
        }
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

async function saveRefUgcc(refId) {
    const approved = document.getElementById('ugcc-chk-' + refId).checked;
    const date = document.getElementById('ugcc-date-' + refId).value || '';
    try {
        await fetch('/api/custom_references/' + refId + '/ugcc', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ approved, date }),
        });
        _customRefsCache = null;   // invalidate so the badge refreshes
        renderRefsList();
    } catch (e) {
        alert('Could not save UGCC status: ' + (e.message || e));
    }
}

async function setProgramReferenceOverride(programId, selectorValue) {
    // selectorValue formats:
    //   "auto"        — clear all overrides
    //   "file:N"      — pick uploaded file with id=N
    //   "prog:N"      — pick another CIM program with id=N
    let body = {};
    if (selectorValue !== 'auto') {
        const [kind, idStr] = String(selectorValue).split(':');
        const id = parseInt(idStr, 10);
        if (kind === 'file') body = { custom_reference_id: id };
        else if (kind === 'prog') body = { reference_program_id: id };
    }
    try {
        await fetch(`/api/program/${programId}/reference_override`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        loadReferenceDetail(programId);
    } catch (e) {
        alert('Failed to set override: ' + e.message);
    }
}

// Cache of comparable-program candidates per program, populated lazily.
const _comparableCache = new Map();
async function loadComparableCandidates(programId, scope) {
    const key = `${programId}:${scope || 'family'}`;
    if (_comparableCache.has(key)) return _comparableCache.get(key);
    try {
        const res = await fetch(`/api/programs/comparable?program_id=${programId}&scope=${scope || 'family'}`);
        const data = res.ok ? await res.json() : { candidates: [] };
        _comparableCache.set(key, data.candidates || []);
        return data.candidates || [];
    } catch (e) {
        return [];
    }
}

async function buildRefSourcePickerHtml(programId, data) {
    // Hide picker on the static site — no backend to accept the change
    if (window._staticMode) return '';
    const source     = data && data.source;
    const activeFile = source === 'custom'  ? data.custom_reference_id   : null;
    const activeProg = source === 'program' ? data.reference_program_id  : null;

    const refs       = await loadCustomRefs();
    const candidates = await loadComparableCandidates(programId, 'family');

    // Context-aware "Auto" label. The Reference tab is for CROSS-program
    // comparisons; it never falls back to a program's own history. So:
    //   - Non-Boston deployment → Auto = Boston counterpart
    //   - Boston / standalone   → no Auto reference; user must pick a
    //                              peer program or upload a file
    const progName  = getProgramName(programId) || '';
    const campusM   = progName.match(/\(([^)]+)\)\s*$/);
    const isNonBoston = campusM && campusM[1].toLowerCase() !== 'boston';
    const autoLabel = isNonBoston
        ? 'Auto (Boston counterpart)'
        : 'None (pick a peer program or upload a file below)';

    const options = [
        `<option value="auto"${!activeFile && !activeProg ? ' selected' : ''}>${autoLabel}</option>`,
    ];
    if (candidates.length) {
        options.push('<optgroup label="Another program">');
        for (const c of candidates) {
            const sel = activeProg === c.id ? ' selected' : '';
            const campusTag = c.campus ? ` — ${escapeHtml(c.campus)}` : '';
            // State badge: "in workflow" (likely to keep changing — caveat
            // the user) or the completion catalog (stable target).
            let stateTag = '';
            if (c.state === 'in_workflow') {
                stateTag = ' ⟳ in workflow';
            } else if (c.state === 'completed' && c.completion_date) {
                stateTag = ` · ${escapeHtml(c.completion_date)}`;
            }
            options.push(`<option value="prog:${c.id}"${sel}>${escapeHtml(c.name)}${campusTag}${stateTag}</option>`);
        }
        options.push('</optgroup>');
    } else {
        // Group always present so the user can SEE the option exists; it's
        // disabled when no peer programs share this subject+degree, but the
        // visible placeholder makes the picker self-documenting instead of
        // silently empty.
        options.push('<optgroup label="Another program">' +
            '<option value="" disabled>(no peer programs found for this subject/degree)</option>' +
            '</optgroup>');
    }
    if (refs.length) {
        options.push('<optgroup label="Uploaded file">');
        for (const r of refs) {
            const sel = activeFile === r.id ? ' selected' : '';
            options.push(`<option value="file:${r.id}"${sel}>${escapeHtml(r.name)}</option>`);
        }
        options.push('</optgroup>');
    } else {
        options.push('<optgroup label="Uploaded file">' +
            '<option value="" disabled>(none uploaded — use References button at top)</option>' +
            '</optgroup>');
    }

    return `<div class="ref-source-picker">
        <label>Reference source:</label>
        <select onchange="setProgramReferenceOverride(${programId}, this.value)">${options.join('')}</select>
    </div>`;
}

// Reverse-lookup banner: shows "This program is the reference for: …".
// Returns '' when nobody points at this program.
async function buildReferencedByBanner(programId) {
    try {
        const res = await fetch(`/api/program/${programId}/referenced_by`);
        if (!res.ok) return '';
        const data = await res.json();
        const all = [...(data.explicit || []), ...(data.implicit || [])];
        if (!all.length) return '';
        // De-dup by id (a program can show up under both lists in edge cases)
        const seen = new Set();
        const items = [];
        for (const r of all) {
            if (seen.has(r.id)) continue;
            seen.add(r.id);
            items.push(`<li>${escapeHtml(r.name)}</li>`);
        }
        const count = items.length;
        return `<div class="referenced-by-banner">
            <strong>This program is the reference for ${count} other program${count === 1 ? '' : 's'}:</strong>
            <ul>${items.join('')}</ul>
        </div>`;
    } catch (e) {
        return '';
    }
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
        const picker = await buildRefSourcePickerHtml(programId, data);
        const banner = await buildReferencedByBanner(programId);

        if (!res.ok || !data.curriculum_html) {
            contentEl.innerHTML = banner + picker +
                '<div class="workflow-meta">No reference curriculum available. ' +
                'Pick another program or upload a file via the picker above, ' +
                'or via the "References" button at the top of the page.</div>';
            return;
        }
        const cleaned = cleanCurriculumHtml(data.curriculum_html);
        let label;
        if (data.source === 'custom')        label = 'Custom reference';
        else if (data.source === 'program')  label = 'Reference program';
        else                                  label = 'Reference version';
        const displayDate = data.source === 'auto'
            ? formatReferenceVersionLabel(data.version_date)
            : data.version_date;
        // For uploaded custom references, show whether UGCC has approved it.
        let ugccBadge = '';
        if (data.source === 'custom') {
            ugccBadge = (data.ugcc_approved === 'Yes')
                ? ` <span class="ugcc-badge ugcc-yes">UGCC approved${data.ugcc_date ? ' · ' + escapeHtml(data.ugcc_date) : ''}</span>`
                : ` <span class="ugcc-badge ugcc-no">UGCC: not approved</span>`;
        }
        const header = (displayDate || ugccBadge)
            ? `<div class="reference-header">${label}${displayDate ? ': ' + escapeHtml(displayDate) : ''}${ugccBadge}</div>`
            : '';
        contentEl.innerHTML = `${banner}${picker}${header}<div class="curriculum-content">${cleaned}</div>`;
    } catch (e) {
        contentEl.innerHTML = '<div class="workflow-meta">Failed to load reference curriculum.</div>';
    }
}

// Changes tab: diff this program's current curriculum against its OWN
// most-recent approved CIM history version. Separate from the Reference
// tab (which can point at another program / uploaded file).
async function loadChangesDetail(programId) {
    const contentEl = document.getElementById(`detail-content-${programId}`);
    if (!contentEl) return;
    contentEl.innerHTML = '<div class="workflow-loading">Loading change history...</div>';

    try {
        const [currRes, histRes] = await Promise.all([
            fetch(`/api/program/${programId}/curriculum`),
            fetch(`/api/program/${programId}/changes`),
        ]);
        const currData = currRes.ok ? await currRes.json() : {};
        const currHtml = currData.curriculum_html || '';

        if (!histRes.ok) {
            contentEl.innerHTML = '<div class="workflow-meta">' +
                'No prior approved version on file for this program — ' +
                'nothing to compare against yet. The Changes tab will become ' +
                'available once this program has been through CIM at least once.</div>';
            return;
        }
        const histData = await histRes.json();
        const histHtml = histData.curriculum_html || '';

        if (!currHtml || !histHtml) {
            contentEl.innerHTML = '<div class="workflow-meta">Curriculum data not available for change comparison.</div>';
            return;
        }

        // Old version on the LEFT, current proposal on the RIGHT, so the
        // colors follow the standard diff convention:
        //   red   ('removed') = in the previous version, removed from proposal
        //   green ('added')   = added in this proposal
        const {identical, diff} = compareCurricula(histHtml, currHtml);
        const dateLabel = formatReferenceVersionLabel(histData.version_date || '');
        const header = `<div class="reference-header">Comparing current proposal against: ${escapeHtml(dateLabel || 'previous approved version')}</div>`;

        if (identical) {
            contentEl.innerHTML = `${header}<div class="compare-identical">Current curriculum is identical to the previous approved version — no changes.</div>`;
        } else {
            const table = renderSideBySide(diff, 'Previous approved', 'Current proposal');
            contentEl.innerHTML = `${header}
                <div class="compare-legend">
                    <span class="compare-legend-item"><span class="legend-box diff-added-bg"></span> Added in this proposal</span>
                    <span class="compare-legend-item"><span class="legend-box diff-removed-bg"></span> Removed from previous version</span>
                    <span class="compare-legend-item"><span class="legend-box diff-moved-bg"></span> Moved between sections</span>
                </div>${table}`;
        }
    } catch (e) {
        contentEl.innerHTML = '<div class="workflow-meta">Failed to load change history.</div>';
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
        const btnTab = btn.dataset.tab || btn.textContent.trim().toLowerCase();
        btn.classList.toggle('active', btnTab === tab);
    });
    if (tab === 'workflow') loadWorkflowDetail(programId);
    else if (tab === 'campuses') loadCampusesDetail(programId);
    else if (tab === 'reference') loadReferenceDetail(programId);
    else if (tab === 'compare') loadCompareDetail(programId);
    else if (tab === 'misaligned') loadMisalignedDetail(programId);
    else if (tab === 'changes') loadChangesDetail(programId);
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
    // Heading hierarchy stack so each course's required/elective category can
    // be derived from its governing parent heading, not just the nearest
    // sub-header. Levels: h2=0, h3=1, h4=2, table areaheader/comment=3.
    let sectionStack = [];
    let currentCategory = 'required';
    function setSection(level, text) {
        sectionStack = sectionStack.filter(e => e.level < level);
        sectionStack.push({level, text});
        currentSection = text;
        currentCategory = classifySectionStack(sectionStack.map(e => e.text));
    }
    // Subject-wildcard mode: triggered by a course-list "comment" row whose
    // text matches "any of the following subject codes" (or similar). While
    // active, rows whose cell content is just a subject prefix
    // (e.g. "BINF" or "CS (except CS 5800 and CS 6140)") are emitted as
    // wildcard entries that absorb individual courses with that prefix
    // during the Compare diff. Reset when we hit a row that's not a
    // subject prefix or a new section header.
    let inSubjectWildcardSection = false;
    const subjectTriggerRe = /(any of the following subject codes|any of the following subjects|from the following subject codes|courses from the following subjects)/i;
    const subjectPrefixRowRe = /^([A-Z]{2,6})\s*(?:\(([^)]+)\))?\s*$/;

    // Inline wildcard patterns — single comment rows that ENUMERATE multiple
    // subject prefixes inline without setting up a subject-wildcard section.
    // Examples in the wild:
    //   "or any EMGT, IE, or OR courses"
    //   "any EMGT or IE courses"
    //   "Any INFO course in range 5000–7999"
    //   "Any IE or DADS course in range 5000–7999"
    // These get parsed into a single wildcard entry per row whose key
    // matches against any course with a listed subject prefix during the
    // diff's subject-wildcard absorption pass.
    //
    // Pattern A: "[or] any SUBJECT[, SUBJECT]* [, or SUBJECT] courses"
    // Separator between subjects: ", " OR ", or " OR ", and " OR " or " OR " and ".
    const _sep = '(?:\\s*,\\s*(?:or\\s+|and\\s+)?|\\s+(?:or|and)\\s+)';
    const inlineSubjectListRe = new RegExp(
        '^(?:or\\s+)?any\\s+((?:[A-Z]{2,6}' + _sep + ')*[A-Z]{2,6})\\s+courses?\\b', 'i'
    );
    // Pattern B: "Any SUBJECT[ or SUBJECT] course[s] in range NNNN[–-]NNNN"
    const inlineSubjectRangeRe = new RegExp(
        '^any\\s+((?:[A-Z]{2,6}' + _sep + ')*[A-Z]{2,6})\\s+courses?\\s+in\\s+range\\s+(\\d{4})\\s*[–-]\\s*(\\d{4})', 'i'
    );

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
                setSection(tag === 'h2' ? 0 : tag === 'h3' ? 1 : 2, text);
                lines.push({key: '', code: '', title: text, hours: '', isHeader: true, section: text});
            }
            inSubjectWildcardSection = false; // new section ends any wildcard run
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
        const joinedText = parts.join(' ').trim();

        // Skip column-header rows (Code/Title/Hours)
        if (parts.some(p => /^Code$/i.test(p)) && parts.some(p => /^Title$/i.test(p))) return;

        // Detect "Complete courses from any of the following subject codes:"
        // and similar comment rows that introduce a subject-wildcard run.
        if (subjectTriggerRe.test(joinedText)) {
            inSubjectWildcardSection = true;
            return;
        }

        // While inside a subject-wildcard run, accept rows whose single
        // cell text is a bare subject prefix (e.g. "BINF") or a prefix
        // with an exception annotation (e.g. "CS (except CS 5800 and
        // CS 6140)"). Emit them as wildcard entries that the Compare
        // diff's absorption pass will use to match individual courses.
        if (inSubjectWildcardSection && !hasCode && !hasOr) {
            const wm = joinedText.match(subjectPrefixRowRe);
            if (wm) {
                const prefix = wm[1].toUpperCase();
                const exclusions = [];
                if (wm[2]) {
                    const inner = wm[2];
                    // "except CS 5800 and CS 6140" → ["CS 5800", "CS 6140"]
                    const codes = inner.match(/[A-Z]{2,5}\s*\d{4}[A-Z]?/gi) || [];
                    codes.forEach(c => exclusions.push(c.toUpperCase().replace(/\s+/g, ' ')));
                }
                lines.push({
                    key: 'SUBJ:' + prefix,
                    code: prefix + (exclusions.length ? ' (except ' + exclusions.join(', ') + ')' : ''),
                    title: 'Any ' + prefix + ' course',
                    hours: '',
                    isHeader: false,
                    section: currentSection,
                    category: currentCategory,
                    subjectWildcard: {prefix: prefix, exclusions: exclusions},
                });
                return;
            }
            // Not a subject-prefix row but we're in the section — keep
            // the flag on unless the row looks like a new heading. (Most
            // such rows will be the next prefix or whitespace.)
        }

        if (isAreaHeader) {
            const text = standardizeHeader(parts.join(' '));
            if (text) {
                setSection(3, text);
                lines.push({key: '', code: '', title: text, hours: '', isHeader: true, section: text});
            }
            inSubjectWildcardSection = false; // new sub-section ends wildcard run
        } else if (hasCode || hasOr) {
            inSubjectWildcardSection = false; // explicit course code ends wildcard run
            const codecol = parts[0] || '';

            // Course-range row: "ECON 5200 to ECON 7772" (also "ECON 5200-7772"
            // / "ECON 5200–ECON 7772") — CourseLeaf shorthand for "any ECON
            // course in that number range". Emit a subject-range wildcard (same
            // shape as the inline "Any X course in range" handling) so a
            // specific course within the range on the other side is matched
            // instead of flagged.
            const rangeM = codecol.replace(/ /g, ' ').replace(/\s+/g, ' ').trim().match(
                /^([A-Z]{2,6})\s*(\d{4})\s*(?:to|through|[-–—])\s*(?:([A-Z]{2,6})\s*)?(\d{4})\b/i);
            if (rangeM && (!rangeM[3] || rangeM[3].toUpperCase() === rangeM[1].toUpperCase())) {
                const pre = rangeM[1].toUpperCase();
                const lo = parseInt(rangeM[2], 10), hi = parseInt(rangeM[4], 10);
                if (lo <= hi) {
                    lines.push({
                        key: 'SUBJ:' + pre,
                        code: `${pre} ${lo}-${hi}`,
                        title: `Any ${pre} course ${lo}–${hi}`,
                        hours: '', isHeader: false,
                        section: currentSection, category: currentCategory,
                        subjectWildcard: {prefix: pre, exclusions: [], range: [lo, hi]},
                    });
                    return;
                }
            }
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
                        category: currentCategory,
                    });
                });
                return;
            }

            // Match on course code alone. Titles and hours can drift (renamed,
            // minor edits, different campus wording) without representing a real
            // curriculum change. If the code matches, the course matches.
            const normCode = normalizedCode.toUpperCase();
            lines.push({key: normCode, code: codecol, title: titlecol, hours: hourscol, isHeader: false, section: currentSection, category: currentCategory});
        } else {
            // Inline subject-list wildcards FIRST — recognize patterns like
            // "or any EMGT, IE, or OR courses" or "Any INFO course in range
            // 5000-7999" as wildcard entries that subsume individual courses
            // with those subjects on the opposite side of the diff. Without
            // this, the row falls through to standardizeHeader which emits
            // it as an orphan header.
            const joinedRaw = parts.join(' ').trim();
            const splitSubjects = (s) => s.split(/\s*,\s*|\s+or\s+|\s+and\s+/i)
                .map(x => x.toUpperCase().trim()).filter(Boolean);
            const rangeM = joinedRaw.match(inlineSubjectRangeRe);
            const listM  = !rangeM && joinedRaw.match(inlineSubjectListRe);
            if (rangeM || listM) {
                const subs = splitSubjects((rangeM || listM)[1]);
                const rangeSuffix = rangeM
                    ? ' in range ' + rangeM[2] + '-' + rangeM[3]
                    : '';
                subs.forEach(prefix => {
                    lines.push({
                        key: 'SUBJ:' + prefix,
                        code: prefix + rangeSuffix,
                        title: 'Any ' + prefix + ' course' + rangeSuffix,
                        hours: '',
                        isHeader: false,
                        section: currentSection,
                        category: currentCategory,
                        subjectWildcard: {
                            prefix: prefix,
                            exclusions: [],
                            range: rangeM ? [parseInt(rangeM[2], 10), parseInt(rangeM[3], 10)] : null,
                        },
                    });
                });
                inSubjectWildcardSection = false;
                return;
            }
            // Non-course context row — run through standardizeHeader to suppress
            // instructional preambles (returns '') and normalize meaningful headers
            const raw = parts.join(' ');
            if (raw.length > 2) {
                const text = standardizeHeader(raw);
                if (text) {
                    setSection(3, text);
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
    // "Breadth Areas" / "Breadth Requirement" are choose-from lists in
    // practice — students pick courses across categories. Without this,
    // any course shared between a "Breadth Areas" section (Boston) and
    // an "Electives" section (regional deployment) is falsely flagged as
    // "moved" (yellow) even though both sides treat it as elective.
    if (/\bbreadth\b/.test(s)) return 'elective';
    if (/\bcomplete\s+\w+\s+of\s+the\s+following/.test(s)) return 'elective';
    if (/\bcomplete\s+\d+\s+(?:semester\s+)?(?:sh|s\.h\.|hours?|credits?)\s+(?:from|based|in|with)/.test(s)) return 'elective';
    if (/\bin consultation\s+with/.test(s)) return 'elective';
    if (/\bfrom the following\b/.test(s)) return 'elective';
    if (/\bany\s+\d+/.test(s)) return 'elective';
    // Default to required for strict/unknown markers.
    return 'required';
}

// Return 'required' | 'elective' | null for a single heading label, where
// null means "neutral" (no explicit category marker — e.g. "Practicum or
// Capstone", "Optional Co-op Experience"). Used to classify by heading
// HIERARCHY: a course under "Core Requirements › Practicum or Capstone" is
// required, while the same course under "Electives › Practicum or Capstone"
// is an elective. The category lives in the parent heading, not the
// neutral sub-header nearest the course.
function _explicitCategory(label) {
    const s = (label || '').toLowerCase();
    if (/\belective/.test(s) || /\b(choose|select)\b/.test(s) || /\bbreadth\b/.test(s)
        || /\bfrom the following\b/.test(s) || /\bcomplete\s+\w+\s+of\s+the\s+following/.test(s)
        || /\bin consultation\s+with/.test(s) || /\bany\s+\d+/.test(s)
        || /\bcomplete\s+\d+\s+(?:semester\s+)?(?:sh|s\.h\.|hours?|credits?)\s+(?:from|based|in|with)/.test(s)) {
        return 'elective';
    }
    if (/\brequired\s+core\b/.test(s) || /^required\b/.test(s) || /^core\b/.test(s)
        || /\bcore\s+requirement/.test(s) || /\brequired\s+courses?\b/.test(s)
        || /\bcomplete\s+all\b/.test(s)) {
        return 'required';
    }
    return null;
}

// Classify a heading stack (shallow→deep). The nearest explicit marker
// wins; neutral sub-headers are skipped so the governing parent decides.
function classifySectionStack(labels) {
    for (let i = labels.length - 1; i >= 0; i--) {
        const c = _explicitCategory(labels[i]);
        if (c) return c;
    }
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
    //
    // BUT: don't sort buffers that contain "or COURSE" / "and COURSE"
    // alternative rows. Those buffers are ordered primary→alternative
    // pairs (e.g., "MISM 6402" then "or DADS 6400") that read as a
    // single requirement; sorting them alphabetically moves DADS before
    // MISM and breaks the visual pairing in the rendered diff.
    function canonicalize(lines) {
        const ALT_RE = /^(or|and)\s+/i;
        const out = [];
        let buffer = [];
        const flush = () => {
            if (buffer.length) {
                const hasAlt = buffer.some(l => ALT_RE.test(l.code || ''));
                if (!hasAlt) {
                    buffer.sort((a, b) =>
                        (a.key || a.code || '').localeCompare(b.key || b.code || ''));
                }
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

    // Second post-LCS pass: pair removed/added entries by SET key
    // (primary code + all alt codes, normalized + sorted). This handles
    // mirror "or" pairings — e.g., proposal's "DADS 6400 or MISM 6402"
    // (DADS primary, MISM alt) vs reference's "MISM 6402 or DADS 6400"
    // (MISM primary, DADS alt). The primaries differ so the first pass
    // doesn't match them, but the set of choices ("take either course")
    // is identical and the user reads them as the same requirement.
    function entrySetKey(entry) {
        if (!entry) return '';
        const codes = [normForCompare(entry.code || '')];
        for (const a of (entry.alts || [])) {
            const stripped = (a.code || '').replace(/^(or|and)\s+/i, '');
            codes.push(normForCompare(stripped));
        }
        return codes.filter(Boolean).sort().join('|');
    }
    const removedBySetKey = {};
    courseDiff.forEach((e, idx) => {
        if (e && e.type === 'removed') {
            const k = entrySetKey(e.left);
            // Only consider multi-code sets — single-code entries would
            // have matched via the primary-key pass above.
            if (k.indexOf('|') >= 0) {
                (removedBySetKey[k] = removedBySetKey[k] || []).push(idx);
            }
        }
    });
    for (let idx = 0; idx < courseDiff.length; idx++) {
        const e = courseDiff[idx];
        if (e && e.type === 'added') {
            const k = entrySetKey(e.right);
            if (k.indexOf('|') >= 0) {
                const candidates = removedBySetKey[k];
                if (candidates && candidates.length) {
                    const rIdx = candidates.shift();
                    courseDiff[rIdx] = {
                        type: 'same',
                        leftIdx: courseDiff[rIdx].leftIdx,
                        rightIdx: e.rightIdx,
                        left: courseDiff[rIdx].left,
                        right: e.right,
                    };
                    courseDiff[idx] = null;
                }
            }
        }
    }

    // Third post-LCS pass: range-absorption. A row like "CS 5100 to CS 7980"
    // on one side semantically covers every CS course in that range. When
    // the other side enumerates individual courses (e.g. CS 5180, CS 5310)
    // that fall within the range, treat each one as matched against the
    // range entry. Eliminates spurious mismatches on programs (like
    // Computer Science MSCS) where Boston uses a wildcard range but
    // regional deployments enumerate the same electives explicitly.
    function _parseRangeEntry(entry) {
        if (!entry) return null;
        // Match either the key or the code text; "to" / "through" / dash.
        const text = (entry.code || entry.key || '');
        const m = text.match(
            /^([A-Z]{2,5})\s*(\d{4})\s*(?:to|through|[-–—])\s*[A-Z]{0,5}\s*(\d{4})\s*$/i);
        if (!m) return null;
        const lo = parseInt(m[2], 10), hi = parseInt(m[3], 10);
        return {prefix: m[1].toUpperCase(), min: Math.min(lo, hi), max: Math.max(lo, hi)};
    }
    function _parseCourseCode(entry) {
        if (!entry) return null;
        const m = (entry.code || '').match(/^([A-Z]{2,5})\s*(\d{4})/i);
        if (!m) return null;
        return {prefix: m[1].toUpperCase(), num: parseInt(m[2], 10)};
    }
    function _codeInRange(c, r) {
        return c && r && c.prefix === r.prefix && c.num >= r.min && c.num <= r.max;
    }
    // Collect range entries on each side along with their diff indices.
    const leftRanges  = [];  // [{rangeIdx (in courseDiff), range obj, entry}]
    const rightRanges = [];
    courseDiff.forEach((e, idx) => {
        if (!e) return;
        if (e.type === 'removed' && e.left) {
            const r = _parseRangeEntry(e.left);
            if (r) leftRanges.push({idx, range: r, entry: e.left});
        } else if (e.type === 'added' && e.right) {
            const r = _parseRangeEntry(e.right);
            if (r) rightRanges.push({idx, range: r, entry: e.right});
        }
    });
    // For each right-side range, absorb matching left-side 'removed' codes.
    rightRanges.forEach(({idx: rangeIdx, range, entry: rangeEntry}) => {
        let absorbed = 0;
        for (let i = 0; i < courseDiff.length; i++) {
            const e = courseDiff[i];
            if (!e || e.type !== 'removed') continue;
            const c = _parseCourseCode(e.left);
            if (_codeInRange(c, range)) {
                courseDiff[i] = {
                    type: 'same',
                    leftIdx: e.leftIdx,
                    rightIdx: rangeEntry === courseDiff[rangeIdx].right ? courseDiff[rangeIdx].rightIdx : null,
                    left: e.left,
                    right: rangeEntry,
                };
                absorbed++;
            }
        }
        // If we absorbed at least one course into this range, drop the
        // original solo 'added' range row — it's been re-emitted alongside
        // each absorbed left-side course.
        if (absorbed > 0) courseDiff[rangeIdx] = null;
    });
    // Symmetric pass: left-side ranges absorb right-side 'added' codes.
    leftRanges.forEach(({idx: rangeIdx, range, entry: rangeEntry}) => {
        let absorbed = 0;
        for (let i = 0; i < courseDiff.length; i++) {
            const e = courseDiff[i];
            if (!e || e.type !== 'added') continue;
            const c = _parseCourseCode(e.right);
            if (_codeInRange(c, range)) {
                courseDiff[i] = {
                    type: 'same',
                    leftIdx: rangeEntry === courseDiff[rangeIdx].left ? courseDiff[rangeIdx].leftIdx : null,
                    rightIdx: e.rightIdx,
                    left: rangeEntry,
                    right: e.right,
                };
                absorbed++;
            }
        }
        if (absorbed > 0) courseDiff[rangeIdx] = null;
    });

    // Fourth post-LCS pass: subject-wildcard absorption. Some CIM curricula
    // list "any course in subject X" (with optional exclusions) instead of
    // enumerating individual courses — e.g. Data Analytics Engineering MS
    // Boston lists BINF, BIOE, CHME, CS (except CS 5800 and CS 6140), …
    // as allowed elective prefixes. When a deployment enumerates individual
    // courses with those prefixes (CHME 5160, CS 7140, …), each such code
    // should match the wildcard rather than appear as a mismatch.
    function _matchSubjectWildcard(code, wildcard) {
        if (!code || !wildcard) return false;
        if (code.prefix !== wildcard.prefix) return false;
        // Range constraint: "Any X course in range 5000-7999" only absorbs
        // courses whose 4-digit number falls inside the inclusive range.
        if (wildcard.range && code.num) {
            const n = parseInt(code.num, 10);
            if (Number.isFinite(n)) {
                if (n < wildcard.range[0] || n > wildcard.range[1]) return false;
            }
        }
        // Exclusions: the wildcard explicitly excludes specific codes.
        if (wildcard.exclusions && wildcard.exclusions.length) {
            const codeStr = code.prefix + ' ' + code.num;
            for (const ex of wildcard.exclusions) {
                if (ex.replace(/\s+/g, ' ') === codeStr) return false;
            }
        }
        return true;
    }
    const leftWildcards  = [];  // entries with .subjectWildcard
    const rightWildcards = [];
    courseDiff.forEach((e, idx) => {
        if (!e) return;
        if (e.type === 'removed' && e.left && e.left.subjectWildcard) {
            leftWildcards.push({idx, wc: e.left.subjectWildcard, entry: e.left});
        } else if (e.type === 'added' && e.right && e.right.subjectWildcard) {
            rightWildcards.push({idx, wc: e.right.subjectWildcard, entry: e.right});
        }
    });
    // Right-side wildcards absorb left-side individual codes.
    rightWildcards.forEach(({idx: wcIdx, wc, entry: wcEntry}) => {
        let absorbed = 0;
        for (let i = 0; i < courseDiff.length; i++) {
            const e = courseDiff[i];
            if (!e || e.type !== 'removed') continue;
            const c = _parseCourseCode(e.left);
            if (_matchSubjectWildcard(c, wc)) {
                courseDiff[i] = {
                    type: 'same',
                    leftIdx: e.leftIdx,
                    rightIdx: null,
                    left: e.left,
                    right: wcEntry,
                };
                absorbed++;
            }
        }
        if (absorbed > 0) courseDiff[wcIdx] = null;
    });
    // Left-side wildcards absorb right-side individual codes (symmetric).
    leftWildcards.forEach(({idx: wcIdx, wc, entry: wcEntry}) => {
        let absorbed = 0;
        for (let i = 0; i < courseDiff.length; i++) {
            const e = courseDiff[i];
            if (!e || e.type !== 'added') continue;
            const c = _parseCourseCode(e.right);
            if (_matchSubjectWildcard(c, wc)) {
                courseDiff[i] = {
                    type: 'same',
                    leftIdx: null,
                    rightIdx: e.rightIdx,
                    left: wcEntry,
                    right: e.right,
                };
                absorbed++;
            }
        }
        if (absorbed > 0) courseDiff[wcIdx] = null;
    });

    // Fifth post-LCS pass: duplicate-code reconciliation. A course code can
    // appear multiple times across a curriculum — e.g. once as a required
    // core course and again as an elective option, or repeated across
    // concentration tracks. The LCS diff matches occurrences 1-to-1, so when
    // one side lists a code N times and the other M times (N != M), the
    // surplus |N-M| occurrences get flagged removed/added even though the
    // course is plainly present on both sides. (Observed: INNO 6418 listed
    // twice in MBA Online but once in the MBA umbrella reference → the
    // second copy showed red "missing".)
    //
    // For curriculum comparison the right question is "is this course present
    // on both sides?" (set semantics), not "the same number of times?"
    // (multiset). So: drop any 'removed' whose code also appears anywhere on
    // the right, and any 'added' whose code also appears anywhere on the
    // left. A course that is genuinely on only one side keeps its code out of
    // the other side's set and stays correctly flagged.
    const leftCodeSet = new Set();
    const rightCodeSet = new Set();
    courseDiff.forEach(e => {
        if (!e) return;
        if (e.left && e.left.key)  leftCodeSet.add(normForCompare(e.left.key));
        if (e.right && e.right.key) rightCodeSet.add(normForCompare(e.right.key));
    });
    courseDiff.forEach((e, i) => {
        if (!e) return;
        if (e.type === 'removed' && e.left && e.left.key) {
            const k = normForCompare(e.left.key);
            if (k && rightCodeSet.has(k)) courseDiff[i] = null;
        } else if (e.type === 'added' && e.right && e.right.key) {
            const k = normForCompare(e.right.key);
            if (k && leftCodeSet.has(k)) courseDiff[i] = null;
        }
    });

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
        // Mark courses that match but moved between section CATEGORIES
        // (required ↔ elective). Category is derived from the heading
        // hierarchy (the governing parent heading wins over a neutral
        // nearest sub-header like "Practicum or Capstone"), so e.g. a
        // course under "Core Requirements › Practicum or Capstone" in one
        // program and "Electives › Practicum or Capstone" in the other is
        // correctly flagged as moved. Falls back to classifySection(section)
        // for entries without a category (e.g. wildcard rows).
        let type = d.type;
        if (type === 'same' && d.left && d.right && !d.left.isHeader) {
            const lc = d.left.category || (d.left.section ? classifySection(d.left.section) : null);
            const rc = d.right.category || (d.right.section ? classifySection(d.right.section) : null);
            if (lc && rc && lc !== rc) type = 'moved';
        }
        result.push({type, left: d.left, right: d.right});
    }
    return result;
}

// Render a single side's cell content. Two columns per side: code + title
// (with hours inlined into title as "(NSH)" by html_cleaner).
// Render one side's cells of a Compare row. `otherItem` is the diff entry
// from the OPPOSITE side (if any) — we use its primary code AND its alts
// list to detect any alt on this side that doesn't appear anywhere on
// the other (matched as either primary or alt). `mySide`
// ('left'|'right'|undefined) drives the asymmetric color: a right-only
// alt reads as "added relative to proposal" (green); a left-only alt
// reads as "in proposal but not reference" (red).
// Is `codeStr` present on a side described by its discrete code set + ranges?
// Three cases: (1) exact discrete match; (2) a discrete code that falls inside
// one of the side's ranges; (3) `codeStr` is itself a range ("PREFIX lo-hi")
// that contains one of the side's discrete codes. Used so a specific course
// and a "PREFIX lo to hi" range on opposite sides count as the same.
function _codePresent(codeStr, discreteSet, ranges) {
    const c = normForCompare((codeStr || '').replace(/^(or|and)\s+/i, ''));
    if (!c) return true;                       // no real code → don't flag
    if (discreteSet && discreteSet.has(c)) return true;
    const selfRange = c.match(/^([a-z]{2,6})\s*(\d{4})\s*[-–—]\s*(?:[a-z]{2,6}\s*)?(\d{4})/);
    if (selfRange) {
        const pre = selfRange[1], lo = +selfRange[2], hi = +selfRange[3];
        for (const oc of (discreteSet || [])) {
            const om = oc.match(/^([a-z]{2,6})\s*(\d{4})/);
            if (om && om[1] === pre) { const n = +om[2]; if (n >= lo && n <= hi) return true; }
        }
        return false;
    }
    const m = c.match(/^([a-z]{2,6})\s*(\d{4})/);
    if (m && ranges) {
        const pre = m[1], n = +m[2];
        for (const r of ranges) {
            if ((r.prefix || '').toLowerCase() === pre && n >= r.range[0] && n <= r.range[1]) {
                // A subject wildcard covers this code unless it's an explicit exception.
                const excluded = (r.exclusions || []).some(
                    ex => normForCompare((ex || '').replace(/\s+/g, ' ')) === c);
                if (!excluded) return true;
            }
        }
    }
    return false;
}

function renderCourseCell(item, cls, otherItem, mySide, oppositeAll, oppositeRanges) {
    if (!item) return `<td class="${cls}" colspan="2"></td>`;
    if (item.isHeader) {
        return `<td class="${cls} cmp-header" colspan="2">${escapeHtml(item.title)}</td>`;
    }
    // PRESENCE-BASED coloring. A course code present ANYWHERE on the opposite
    // side (as a leader OR an "or"-alternative) is treated as shared and shown
    // neutral — never flagged. Only a code truly absent from the other side is
    // colored, per the established convention:
    //   left column  = Proposed  → cmp-c-left  = RED   = in proposal, not in reference
    //   right column = Reference → cmp-c-right = GREEN = in reference, not in proposal
    // This fixes the false-red on courses like CS 5200 / DS 5220 that are a
    // leader on one side and an alternative on the other because the two
    // campuses word the same "X or Y or Z" requirement with a different
    // leading course.
    function pcls(code) {
        if (!oppositeAll) return '';
        if (_codePresent(code, oppositeAll, oppositeRanges)) return '';  // shared → neutral
        return mySide === 'right' ? 'cmp-c-right' : 'cmp-c-left';
    }

    const titleWithHours = item.hours ? `${item.title} (${item.hours}SH)` : item.title;
    const isAlt = /^(or|and)\s+/i.test(item.code || '');
    const codeCls = isAlt ? `${cls} cmp-code cmp-alt` : `${cls} cmp-code`;

    // A subject-wildcard entry ("Any CSYE course") is a match-anything
    // placeholder, not a specific course — render it neutral, never red/green.
    const isWild = !!item.subjectWildcard;

    // Render the primary + any alternatives in the same cell so they can never
    // be visually separated by the LCS diff layout. Each code (primary + each
    // alt) is colored independently by its own presence on the opposite side.
    const p = isWild ? '' : pcls(item.code);
    let codeHtml = `<span class="${p}">${escapeHtml(item.code)}</span>`;
    let titleHtml = `<span class="${p}">${escapeHtml(titleWithHours)}</span>`;
    if (item.alts && item.alts.length) {
        for (const a of item.alts) {
            const altTitleWithHours = a.hours ? `${a.title} (${a.hours}SH)` : a.title;
            const ap = isWild ? '' : pcls(a.code);
            codeHtml += `<div class="cmp-alt-line ${ap}">${escapeHtml(a.code)}</div>`;
            titleHtml += `<div class="cmp-alt-line ${ap}">${escapeHtml(altTitleWithHours)}</div>`;
        }
    }
    return `<td class="${codeCls}">${codeHtml}</td>` +
           `<td class="${cls} cmp-title">${titleHtml}</td>`;
}

// Render a side-by-side comparison table
function renderSideBySide(diff, leftLabel, rightLabel) {
    // Global presence sets: every code (leader + alternatives) on each side.
    // Used for presence-based per-code coloring so a course present on both
    // sides is never flagged, regardless of which "or-group" the LCS paired.
    const leftAll = new Set(), rightAll = new Set();
    const leftRanges = [], rightRanges = [];   // {prefix, range:[lo,hi]} per side
    const collect = (set, ranges, item) => {
        if (!item || item.isHeader) return;
        const norm = c => normForCompare((c || '').replace(/^(or|and)\s+/i, ''));
        if (item.subjectWildcard) {
            // Range wildcards ("Any INFO course 5000–7999") carry an explicit
            // range; OPEN wildcards ("Any CSYE course") cover the whole subject,
            // so treat them as [0, 9999] and carry the exclusions so an excepted
            // course (e.g. "except CSYE 6220") still flags if present.
            ranges.push({
                prefix: item.subjectWildcard.prefix,
                range: item.subjectWildcard.range || [0, 9999],
                exclusions: item.subjectWildcard.exclusions || [],
            });
        }
        if (item.code) set.add(norm(item.code));
        for (const a of (item.alts || [])) set.add(norm(a.code));
    };
    diff.forEach(d => { collect(leftAll, leftRanges, d.left); collect(rightAll, rightRanges, d.right); });

    let rows = diff.map(d => {
        if (d.type === 'same') {
            return `<tr>${renderCourseCell(d.left, 'cmp-same', d.right, 'left', rightAll, rightRanges)}` +
                   `<td class="cmp-divider"></td>` +
                   `${renderCourseCell(d.right, 'cmp-same', d.left, 'right', leftAll, leftRanges)}</tr>`;
        } else if (d.type === 'moved') {
            return `<tr>${renderCourseCell(d.left, 'cmp-moved', d.right, 'left', rightAll, rightRanges)}` +
                   `<td class="cmp-divider"></td>` +
                   `${renderCourseCell(d.right, 'cmp-moved', d.left, 'right', leftAll, leftRanges)}</tr>`;
        } else if (d.type === 'removed') {
            return `<tr>${renderCourseCell(d.left, 'cmp-removed', null, 'left', rightAll, rightRanges)}` +
                   `<td class="cmp-divider"></td>` +
                   `${renderCourseCell(null, 'cmp-empty')}</tr>`;
        } else {
            return `<tr>${renderCourseCell(null, 'cmp-empty')}` +
                   `<td class="cmp-divider"></td>` +
                   `${renderCourseCell(d.right, 'cmp-added', null, 'right', leftAll, leftRanges)}</tr>`;
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

// Merge "or COURSE 1234" / "and COURSE 1234" rows into their primary's
// `alts` array so each primary+alt(s) group becomes a single diff entry.
// Without this, LCS can interleave unrelated left-only or right-only
// rows between a primary and its alternative, breaking the visual
// pairing in the rendered side-by-side table.
//
// Only applied to Compare's diff input — extractCourseLines itself keeps
// or-rows as standalone entries so the Regulatory tab can still flag
// each alternative course individually.
function mergeAlts(lines) {
    const ALT_RE = /^(or|and)\s+/i;
    const out = [];
    for (const l of lines) {
        if (!l.isHeader && ALT_RE.test(l.code || '')) {
            // Attach to the most recent non-header entry in `out`.
            for (let i = out.length - 1; i >= 0; i--) {
                if (!out[i].isHeader) {
                    if (!out[i].alts) out[i] = {...out[i], alts: []};
                    out[i].alts.push({code: l.code, title: l.title, hours: l.hours});
                    break;
                }
            }
            continue;  // do not push the alt as its own diff entry
        }
        out.push(l);
    }
    return out;
}

// Compare two curricula, return {identical, diff}
function compareCurricula(refHtml, currHtml) {
    const refLines = mergeAlts(extractCourseLines(refHtml));
    const currLines = mergeAlts(extractCourseLines(currHtml));
    const diff = diffLines(refLines, currLines);
    // identical only if every diff entry is 'same' AND each 'same' entry's
    // combined code set (primary + alts) matches on both sides. The set-key
    // post-pass in diffLines may have matched mirror-or pairs (proposal
    // "DADS 6400 or MISM 6402" ≡ reference "MISM 6402 or DADS 6400") —
    // those genuinely are identical even though the primary codes differ,
    // so we compare the full set rather than primary-then-alts separately.
    function entrySet(entry) {
        if (!entry) return '';
        const codes = [normForCompare(entry.code || '')];
        for (const a of (entry.alts || [])) {
            codes.push(normForCompare((a.code || '').replace(/^(or|and)\s+/i, '')));
        }
        return codes.filter(Boolean).sort().join('|');
    }
    const identical = diff.every(d => {
        if (d.type !== 'same') return false;
        return entrySet(d.left) === entrySet(d.right);
    });
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

        // If an EXPLICIT reference override is active — either an uploaded
        // file (source 'custom') OR another program chosen via the picker
        // (source 'program') — always compare the proposal against that
        // override, regardless of the program's campus relationships.
        const refRes0 = await fetch(`/api/program/${programId}/reference`);
        const refData0 = refRes0.ok ? await refRes0.json() : {};
        const hasOverride = refData0.source === 'custom' || refData0.source === 'program';

        if (hasOverride) {
            const isProg = refData0.source === 'program';
            const kind = isProg ? 'reference program' : 'custom reference';
            const refName = refData0.name || refData0.version_date || '';
            const refHtml = refData0.curriculum_html || '';
            if (!currHtml || !refHtml) {
                contentEl.innerHTML = `<div class="workflow-meta">Curriculum or ${kind} data not available for comparison.</div>`;
                updateCompareButton(programId, null);
                return;
            }
            const {identical, diff} = compareCurricula(currHtml, refHtml);
            updateCompareButton(programId, identical);
            const header = `<div class="reference-header">Comparing against ${kind}: ${escapeHtml(refName)}</div>`;
            if (identical) {
                contentEl.innerHTML = `${header}<div class="compare-identical">Proposed curriculum is identical to the ${kind}.</div>`;
            } else {
                const refLabel = `${isProg ? 'Reference: ' : 'Custom reference: '}${refName}`;
                const table = renderSideBySide(diff, 'This proposal', refLabel);
                contentEl.innerHTML = `${header}
                    <div class="compare-legend">
                        <span class="compare-legend-item"><span class="legend-box diff-removed-bg"></span> Only in this proposal</span>
                        <span class="compare-legend-item"><span class="legend-box diff-added-bg"></span> Only in ${kind}</span>
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

            // Self-reference fallback: when no Boston counterpart could
            // be found AND no prior approved version of this program
            // exists in CIM's history, fetch_reference_curricula stores
            // a sentinel ref with version_id = -1 and version_date =
            // "Current curriculum (no prior approved version on file)".
            // The reference HTML in that case is the program's own
            // current curriculum — so a diff would trivially be
            // identical and labelling it "Boston reference" is wrong.
            // Show an honest "nothing to compare" message instead.
            const isSelfRef = refData.version_id === -1 ||
                (refData.version_date || '').toLowerCase().includes('no prior approved');
            if (isSelfRef) {
                updateCompareButton(programId, null);
                contentEl.innerHTML = '<div class="workflow-meta">No prior approved version on file for this program and no Boston counterpart found — nothing to compare against.</div>';
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
                const thisLabel = progName || 'This deployment';
                const refLabel = inWorkflow ? 'Boston (in workflow)' : 'Boston (last approved)';
                const table = renderSideBySide(diff, thisLabel, refLabel);
                contentEl.innerHTML = `${header}
                    <div class="compare-legend">
                        <span class="compare-legend-item"><span class="legend-box diff-removed-bg"></span> Only in ${escapeHtml(thisLabel)}</span>
                        <span class="compare-legend-item"><span class="legend-box diff-added-bg"></span> Only in ${escapeHtml(refLabel)}</span>
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

                // Deployment on the LEFT, Boston (the reference) on the RIGHT.
                // This way the diff color semantics line up with intuition:
                //   red on LEFT  = course in the deployment but not in Boston
                //   green on RIGHT = course in Boston but not in the deployment
                // compareCurricula(left, right) — first arg = left side.
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
                    html += renderSideBySide(dep.diff, dep.name, 'Boston (reference)');
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
                const table = renderSideBySide(diff, 'This proposal', 'Last approved version');
                contentEl.innerHTML = `<div class="compare-legend">
                    <span class="compare-legend-item"><span class="legend-box diff-removed-bg"></span> Only in this proposal</span>
                    <span class="compare-legend-item"><span class="legend-box diff-added-bg"></span> Only in last approved</span>
                    <span class="compare-legend-item"><span class="legend-box diff-moved-bg"></span> Moved between sections</span>
                </div>${table}`;
            }
        }
    } catch (e) {
        contentEl.innerHTML = '<div class="workflow-meta">Failed to load comparison.</div>';
        updateCompareButton(programId, null);
    }
}

// ---- Misaligned tab helpers ----
// "Misaligned" courses = courses present on the LEFT (old) side of a diff
// but not on the right — i.e. type 'removed'. Callers orient
// compareCurricula() so the program-of-interest is the LEFT operand, so
// 'removed' means "in this program, not in the reference."
function _redCoursesFromDiff(diff) {
    const out = [];
    for (const d of (diff || [])) {
        if (d && d.type === 'removed' && d.left && !d.left.isHeader) {
            const code = (d.left.code || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
            const title = (d.left.title || '').trim();
            if (code) out.push({code, title});
        }
    }
    return out;
}

// Green: courses present on the RIGHT (new) side of a diff but not the
// left — type 'added'.
function _greenCoursesFromDiff(diff) {
    const out = [];
    for (const d of (diff || [])) {
        if (d && d.type === 'added' && d.right && !d.right.isHeader) {
            const code = (d.right.code || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
            const title = (d.right.title || '').trim();
            if (code) out.push({code, title});
        }
    }
    return out;
}

// Render one headed section: "<heading>" then a course list (or "None").
// `heading` is already-escaped HTML.
function _renderMisalignSection(heading, items) {
    let html = `<h4 class="mis-heading">${heading}</h4>`;
    if (!items.length) { html += '<div class="mis-none">None</div>'; return html; }
    html += '<table class="misaligned-table"><tbody>';
    for (const it of items) {
        html += `<tr><td class="mis-code">${escapeHtml(it.code)}</td>`
              + `<td class="mis-title">${escapeHtml(it.title || '')}</td></tr>`;
    }
    html += '</tbody></table>';
    return html;
}

// Render the red-flagged direction of a comparison: courses present in the
// left operand (the program) but missing from the right (the reference),
// under an explicit program-named heading. `diff` must be oriented
// compareCurricula(leftHtml, rightHtml) so 'removed' == left-only.
// (Only this direction is shown — the reverse, "in reference not in
// program", is not a misalignment we flag.)
function _renderMisalignPair(leftName, rightName, diff) {
    const L = escapeHtml(leftName), R = escapeHtml(rightName);
    return _renderMisalignSection(`Present in ${L} but missing from ${R}`,
                                  _redCoursesFromDiff(diff));
}

// Misaligned tab: per-comparison, both directions, each with a heading that
// names the two programs ("Present in X but missing from Y"). Mirrors
// loadCompareDetail's reference-resolution branches.
async function loadMisalignedDetail(programId) {
    const contentEl = document.getElementById(`detail-content-${programId}`);
    if (!contentEl) return;
    contentEl.innerHTML = '<div class="workflow-loading">Loading misaligned courses...</div>';
    const note = c => `<div class="workflow-meta">${c}</div>`;
    try {
        const [currRes, groups] = await Promise.all([
            fetch(`/api/program/${programId}/curriculum`),
            getCampusGroups()
        ]);
        const currData = currRes.ok ? await currRes.json() : {};
        const currHtml = currData.curriculum_html || '';
        const bostonId = groups.deployment_to_boston[String(programId)];
        const deploymentIds = groups.boston_to_deployments[String(programId)];
        const progName = getProgramName(programId) || 'this program';
        const campusMatch = progName.match(/\(([^)]+)\)\s*$/);
        const campus = campusMatch ? campusMatch[1] : null;
        const isNonBoston = campus && campus.toLowerCase() !== 'boston';
        const refRes0 = await fetch(`/api/program/${programId}/reference`);
        const refData0 = refRes0.ok ? await refRes0.json() : {};
        const hasCustomOverride = refData0.source === 'custom';

        // Single-reference branches (custom override / non-Boston deployment / standalone)
        if (hasCustomOverride || bostonId || isNonBoston || !(deploymentIds && deploymentIds.length)) {
            const refHtml = refData0.curriculum_html || '';
            const isSelfRef = refData0.version_id === -1 ||
                (refData0.version_date || '').toLowerCase().includes('no prior approved');
            if (!currHtml || !refHtml || isSelfRef) {
                contentEl.innerHTML = note('No reference curriculum available to compare against.');
                return;
            }
            let refName;
            if (hasCustomOverride)      refName = refData0.name || 'the custom reference';
            else if (bostonId)          refName = getProgramName(bostonId) || 'the Boston reference';
            else if (isNonBoston)       refName = 'the Boston reference';
            else                        refName = 'the last approved version';
            const {diff} = compareCurricula(currHtml, refHtml);
            contentEl.innerHTML = _renderMisalignPair(progName, refName, diff);
            return;
        }

        // Boston program with deployments: one labeled pair per deployment.
        let html = note(`Comparing ${escapeHtml(progName)} against ${deploymentIds.length} deployment${deploymentIds.length > 1 ? 's' : ''}:`);
        for (const depId of deploymentIds) {
            const depRes = await fetch(`/api/program/${depId}/curriculum`);
            const depData = depRes.ok ? await depRes.json() : {};
            const depHtml = depData.curriculum_html || '';
            const depName = getProgramName(depId);
            if (!currHtml || !depHtml) {
                html += `<h4 class="mis-heading">${escapeHtml(depName)}</h4>` + note('Curriculum data not available.');
                continue;
            }
            // compareCurricula(depHtml, currHtml) → left=deployment, right=Boston.
            const {diff} = compareCurricula(depHtml, currHtml);
            html += `<div class="compare-deployment-section">`
                  + _renderMisalignPair(depName, progName, diff)
                  + `</div>`;
        }
        contentEl.innerHTML = html;
    } catch (e) {
        contentEl.innerHTML = note('Failed to load misaligned courses.');
    }
}

// Update the Compare button color based on comparison result
function updateCompareButton(programId, identical) {
    const detailRow = document.getElementById(`detail-${programId}`);
    if (!detailRow) return;
    const tabs = detailRow.querySelectorAll('.detail-tab');
    for (const tab of tabs) {
        if (tab.dataset.tab === 'compare') {  // the "Alignment Summary" tab
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
// In-page search: HIGHLIGHT matches and scroll to the first one — do NOT
// filter/hide content. (Previously this hid non-matching rows.) Typing
// re-highlights live; Enter cycles to the next match.
function filterDetailContent(programId) {
    const input = document.getElementById(`detail-search-${programId}`);
    const content = document.getElementById(`detail-content-${programId}`);
    if (!input || !content) return;

    // Clear prior highlights (unwrap each <mark class="detail-hl">) and merge
    // the split text back so re-searching works cleanly.
    content.querySelectorAll('mark.detail-hl').forEach(m => {
        m.replaceWith(document.createTextNode(m.textContent));
    });
    content.normalize();

    const q = input.value.trim();
    if (!q) { delete content.dataset.hlIndex; return; }
    const ql = q.toLowerCase();

    // Collect text nodes that contain the query (skip script/style/existing marks).
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(ql)) return NodeFilter.FILTER_REJECT;
            const p = node.parentNode;
            if (p && (p.tagName === 'SCRIPT' || p.tagName === 'STYLE')) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        }
    });
    const nodes = [];
    let n; while ((n = walker.nextNode())) nodes.push(n);

    const marks = [];
    nodes.forEach(node => {
        const text = node.nodeValue, lower = text.toLowerCase();
        const frag = document.createDocumentFragment();
        let idx = 0, pos;
        while ((pos = lower.indexOf(ql, idx)) !== -1) {
            if (pos > idx) frag.appendChild(document.createTextNode(text.slice(idx, pos)));
            const mark = document.createElement('mark');
            mark.className = 'detail-hl';
            mark.textContent = text.slice(pos, pos + ql.length);
            frag.appendChild(mark);
            marks.push(mark);
            idx = pos + ql.length;
        }
        if (idx < text.length) frag.appendChild(document.createTextNode(text.slice(idx)));
        node.parentNode.replaceChild(frag, node);
    });

    if (!marks.length) { delete content.dataset.hlIndex; return; }
    // On plain typing, jump to the first match; reset cycle position.
    const cur = marks[0];
    content.dataset.hlIndex = '0';
    marks.forEach(m => m.classList.remove('detail-hl-current'));
    cur.classList.add('detail-hl-current');
    cur.scrollIntoView({block: 'center', behavior: 'smooth'});
}

// Enter in the in-page search cycles to the next highlighted match.
function cycleDetailMatch(programId, ev) {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    const content = document.getElementById(`detail-content-${programId}`);
    if (!content) return;
    const marks = Array.from(content.querySelectorAll('mark.detail-hl'));
    if (!marks.length) return;
    let i = (parseInt(content.dataset.hlIndex || '0', 10) + 1) % marks.length;
    content.dataset.hlIndex = String(i);
    marks.forEach(m => m.classList.remove('detail-hl-current'));
    marks[i].classList.add('detail-hl-current');
    marks[i].scrollIntoView({block: 'center', behavior: 'smooth'});
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
    // Don't show "Updating..." text — scans run continuously in the
    // background, the last-updated timestamp tells the user when they
    // last received fresh data.

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
    'Bouve College of Hlth Sciences': 'BVE',
    'Khoury Coll of Comp Sciences': 'KHY',
    "D'Amore-McKim School Business": 'DMSB',
    'School of Law': 'SOL',
    'Coll of Arts, Media & Design': 'CAMD',
    'Mills College at NU': 'MCNU',
    'Coll of Soc Sci & Humanities': 'CSSH',
    'Office of the Provost': 'Provost',
};

const CAMPUS_ABBREVS = {
    'Boston':          'BOS',
    'Oakland':         'OAK',
    'Vancouver':       'VAN',
    'Toronto':         'TOR',
    'Miami':           'MIA',
    'Arlington':       'ARL',
    'Portland':        'PTL',
    'Silicon Valley':  'SV',
    'Charlotte':       'CLT',
    'Seattle':         'SEA',
    'New York':        'NYC',
    'London':          'LON',
    'Online':          'ONL',
    'Primarily Online':'POL',
};

function abbreviateCollege(college) {
    if (!college) return '—';
    return COLLEGE_ABBREVS[college] || college;
}

function abbreviateCampus(campus) {
    if (!campus) return '—';
    return CAMPUS_ABBREVS[campus] || campus;
}

// ── Console modal ──────────────────────────────────────────────────────────────

function openConsoleModal() {
    const modal = document.getElementById('console-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    loadConsoleData();
}

function closeConsoleModal() {
    const modal = document.getElementById('console-modal');
    if (modal) modal.style.display = 'none';
}

function closeConsoleModalIfBackdrop(event) {
    if (event.target.id === 'console-modal') closeConsoleModal();
}

async function loadConsoleData() {
    const body = document.getElementById('console-modal-body');
    body.innerHTML = 'Loading…';
    try {
        const resp = await fetch('/api/console');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        body.innerHTML = renderConsoleContent(data);
    } catch (e) {
        body.innerHTML = `<p style="color:#b91c1c">Could not load console data: ${e.message}</p>`;
    }
}

function renderConsoleContent(data) {
    const scanLog    = (data.scan_log || []).slice().reverse();
    const mm         = data.mismatches || {};
    const updatedAt  = mm.updated_at;
    const nonPrograms   = mm.non_programs   || [];
    const ipdAdded      = mm.ipd_added      || [];
    const svtMismatches = mm.svt_mismatches || [];
    const ipdMismatches = mm.ipd_mismatches || [];
    const otpMismatches = mm.otp_mismatches || [];
    const glsMismatches = mm.gls_mismatches || [];

    // ---- Portfolio feed health ----
    const feedHealth = data.feed_health || {};
    let html = '';
    const feedNames = Object.keys(feedHealth);
    if (feedNames.length) {
        const fmtTs = s => { try { return new Date(s).toLocaleString('en-US', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) + ' ET'; } catch(_) { return s || '—'; } };
        const now = Date.now();
        const STALE_MS = 36 * 3600 * 1000;   // flag a feed with no success in 36h
        let anyBad = false;
        let rows = '';
        for (const name of feedNames.sort()) {
            const f = feedHealth[name] || {};
            const lastOkMs = f.last_success ? new Date(f.last_success).getTime() : 0;
            const stale = !lastOkMs || (now - lastOkMs) > STALE_MS;
            const bad = !f.ok || stale;
            if (bad) anyBad = true;
            const color = bad ? '#b91c1c' : '#15803d';
            const statusTxt = f.ok ? 'OK' : 'FAILED';
            rows += `<tr style="border-top:1px solid #e2e8f0;background:${bad ? '#fff5f5' : ''}">
                <td style="padding:5px 8px">${escapeHtml(name)}</td>
                <td style="padding:5px 8px;color:${color}">${(bad ? '✗ ' : '✓ ') + statusTxt}</td>
                <td style="padding:5px 8px;white-space:nowrap">${fmtTs(f.last_success)}</td>
                <td style="padding:5px 8px;white-space:nowrap">${fmtTs(f.last_attempt)}</td>
                <td style="padding:5px 8px;color:#64748b">${escapeHtml(f.detail || '')}</td>
            </tr>`;
        }
        html += `<h3 style="margin:0 0 6px">Feed Health${anyBad ? ' <span style="color:#b91c1c">⚠ attention needed</span>' : ''}</h3>`;
        html += '<p style="color:#64748b;font-size:11px;margin:0 0 8px">A feed marked FAILED or with no recent success usually means its source session (SharePoint / Smartsheet) is logged out — the last good copy is kept until it succeeds again.</p>';
        html += '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:20px">'
             + '<thead><tr style="background:#f1f5f9;text-align:left">'
             + '<th style="padding:5px 8px">Feed</th>'
             + '<th style="padding:5px 8px">Status</th>'
             + '<th style="padding:5px 8px">Last success</th>'
             + '<th style="padding:5px 8px">Last attempt</th>'
             + '<th style="padding:5px 8px">Detail</th>'
             + '</tr></thead><tbody>' + rows + '</tbody></table>';
    }

    // ---- Action audit (approve / rollback / comment) ----
    const audit = data.action_audit || [];
    html += '<h3 style="margin:0 0 10px">My Actions (approve / rollback / comment)</h3>';
    if (!audit.length) {
        html += '<p class="empty-state">No actions taken yet.</p>';
    } else {
        const actLabel = {approve: 'Approve', sendback: 'Rollback', comment: 'Comment'};
        const fmtTs = s => { try { return new Date(s).toLocaleString('en-US', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) + ' ET'; } catch(_) { return s || '—'; } };
        html += '<table style="width:100%;border-collapse:collapse;font-size:12px">';
        html += '<thead><tr style="background:#f1f5f9;text-align:left">'
             + '<th style="padding:5px 8px">When</th>'
             + '<th style="padding:5px 8px">Program</th>'
             + '<th style="padding:5px 8px">Action</th>'
             + '<th style="padding:5px 8px">Step / target</th>'
             + '<th style="padding:5px 8px">Comment</th>'
             + '<th style="padding:5px 8px">Result</th>'
             + '</tr></thead><tbody>';
        for (const a of audit) {
            const label = actLabel[a.action] || a.action || '—';
            const target = a.action === 'sendback'
                ? `${escapeHtml(a.role || '')} → ${escapeHtml(a.rejectto || '')}`
                : escapeHtml(a.role || '');
            const rowColor = a.ok ? '' : '#fff5f5';
            html += `<tr style="border-top:1px solid #e2e8f0;background:${rowColor}">
                <td style="padding:5px 8px;white-space:nowrap">${fmtTs(a.ts)}</td>
                <td style="padding:5px 8px">${escapeHtml(a.name || ('#' + a.program_id))}</td>
                <td style="padding:5px 8px">${escapeHtml(label)}</td>
                <td style="padding:5px 8px">${target || '—'}</td>
                <td style="padding:5px 8px">${escapeHtml(a.comment || '')}</td>
                <td style="padding:5px 8px;color:${a.ok ? '#15803d' : '#b91c1c'}">${a.ok ? '✓ ' : '✗ '}${escapeHtml(a.detail || '')}</td>
            </tr>`;
        }
        html += '</tbody></table>';
    }

    html += '<h3 style="margin:20px 0 10px">Scan History</h3>';
    if (!scanLog.length) {
        html += '<p class="empty-state">No scans recorded yet.</p>';
    } else {
        html += '<table style="width:100%;border-collapse:collapse;font-size:12px">';
        html += '<thead><tr style="background:#f1f5f9;text-align:left">'
             + '<th style="padding:5px 8px">Started</th>'
             + '<th style="padding:5px 8px">Completed</th>'
             + '<th style="padding:5px 8px">Duration</th>'
             + '<th style="padding:5px 8px">Programs</th>'
             + '<th style="padding:5px 8px">Changes</th>'
             + '<th style="padding:5px 8px">Status</th>'
             + '</tr></thead><tbody>';
        for (const entry of scanLog) {
            const started   = entry.started_at   ? new Date(entry.started_at)   : null;
            const completed = entry.completed_at ? new Date(entry.completed_at) : null;
            const dur = (started && completed)
                ? Math.round((completed - started) / 60000) + ' min' : '—';
            const fmtDate = d => d ? d.toLocaleString('en-US', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
            const rowColor = entry.error ? '#fff5f5' : '';
            html += `<tr style="border-top:1px solid #e2e8f0;background:${rowColor}">
                <td style="padding:5px 8px;white-space:nowrap">${fmtDate(started)}</td>
                <td style="padding:5px 8px;white-space:nowrap">${fmtDate(completed)}</td>
                <td style="padding:5px 8px">${dur}</td>
                <td style="padding:5px 8px">${entry.programs_scanned ?? '—'}</td>
                <td style="padding:5px 8px">${entry.changes ?? '—'}</td>
                <td style="padding:5px 8px;color:${entry.error ? '#b91c1c' : '#15803d'}">${entry.error ? '✗ ' + escapeHtml(entry.error) : '✓ OK'}</td>
            </tr>`;
        }
        html += '</tbody></table>';
    }

    html += '<h3 style="margin:20px 0 6px">Portfolio Ingest Report</h3>';
    if (updatedAt) {
        html += `<p style="color:#64748b;font-size:11px;margin:0 0 12px">Last ingest: ${new Date(updatedAt).toLocaleString()}</p>`;
    }

    function _mismatchTable(rows, bgColor) {
        if (!rows.length) return '<p style="color:#64748b;font-size:12px;margin:0 0 12px">None.</p>';
        let t = `<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px">`;
        t += `<thead><tr style="background:${bgColor};text-align:left">`
           + '<th style="padding:4px 8px">Name</th>'
           + '<th style="padding:4px 8px">Campus</th>'
           + '<th style="padding:4px 8px">Best Guess</th>'
           + '</tr></thead><tbody>';
        for (const m of rows) {
            const name   = m.source_name || m.name || '';
            const campus = m.source_campus || m.campus || '';
            const guess  = m.best_guess ? escapeHtml(m.best_guess) : '<span style="color:#94a3b8">—</span>';
            t += `<tr style="border-top:1px solid #e2e8f0">
                <td style="padding:4px 8px">${escapeHtml(name)}</td>
                <td style="padding:4px 8px;color:#64748b">${escapeHtml(campus)}</td>
                <td style="padding:4px 8px;color:#64748b;font-size:11px">${guess}</td>
            </tr>`;
        }
        t += '</tbody></table>';
        return t;
    }

    const svtAdded = mm.svt_added || [];
    html += `<h4 style="margin:0 0 4px;font-size:13px;color:#1e40af">Added to portfolio from SVT (${svtAdded.length})</h4>`;
    if (!svtAdded.length) {
        html += '<p style="color:#64748b;font-size:12px;margin:0 0 12px">None.</p>';
    } else {
        html += '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px">';
        html += '<thead><tr style="background:#eff6ff;text-align:left">'
             + '<th style="padding:4px 8px">SVT Name</th>'
             + '<th style="padding:4px 8px">SVT Campus</th>'
             + '<th style="padding:4px 8px">CIM Format</th>'
             + '</tr></thead><tbody>';
        for (const p of svtAdded) {
            html += `<tr style="border-top:1px solid #e2e8f0">
                <td style="padding:4px 8px">${escapeHtml(p.original_name || '')}</td>
                <td style="padding:4px 8px;color:#64748b">${escapeHtml(p.campus || 'Boston')}</td>
                <td style="padding:4px 8px;color:#64748b;font-size:11px">${escapeHtml(p.cim_format || '')}</td>
            </tr>`;
        }
        html += '</tbody></table>';
    }

    // IPD sections removed — overlay disabled, source no longer consulted.

    html += `<h4 style="margin:0 0 4px;font-size:13px;color:#991b1b">SVT entries with no CIM match (${svtMismatches.length})</h4>`;
    html += _mismatchTable(svtMismatches, '#fff1f2');

    html += `<h4 style="margin:0 0 4px;font-size:13px;color:#991b1b">OTP entries with no CIM match (${otpMismatches.length})</h4>`;
    html += _mismatchTable(otpMismatches, '#fff1f2');

    if (glsMismatches.length) {
        html += `<h4 style="margin:0 0 4px;font-size:13px;color:#991b1b">GLS entries with no match (${glsMismatches.length})</h4>`;
        html += _mismatchTable(glsMismatches, '#fff1f2');
    }

    if (nonPrograms.length) {
        const bySource = {};
        for (const e of nonPrograms) {
            (bySource[e.source] = bySource[e.source] || []).push(e);
        }
        html += `<details style="margin-top:16px"><summary style="cursor:pointer;font-size:13px;font-weight:600;color:#64748b">Non-program entries (${nonPrograms.length})</summary>`;
        for (const [src, rows] of Object.entries(bySource)) {
            html += `<h5 style="margin:10px 0 4px;font-size:12px;color:#64748b">${escapeHtml(src)} (${rows.length})</h5>`;
            html += '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:10px">';
            html += '<thead><tr style="background:#f8fafc;text-align:left"><th style="padding:3px 8px">Name</th></tr></thead><tbody>';
            for (const e of rows) {
                html += `<tr style="border-top:1px solid #e2e8f0"><td style="padding:3px 8px;color:#64748b">${escapeHtml(e.source_name)}</td></tr>`;
            }
            html += '</tbody></table>';
        }
        html += '</details>';
    }

    return html;
}

// ── Info-tooltip overlay (drives <span class="info-tip"> elements) ──────────
// Tooltips are CSS-styled but positioned via JS so they escape any
// overflow:hidden ancestor. Hovering a .tip-icon shows #tip-overlay with the
// .tip-bubble text content, anchored just below the icon.
(function initTipOverlay() {
    if (typeof document === 'undefined') return;
    const start = () => {
        let overlay = document.getElementById('tip-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'tip-overlay';
            document.body.appendChild(overlay);
        }
        let hideTimer = null;
        const show = (icon) => {
            const wrap = icon.closest('.info-tip');
            if (!wrap) return;
            const bubble = wrap.querySelector('.tip-bubble');
            if (!bubble) return;
            overlay.textContent = bubble.textContent;
            const r = icon.getBoundingClientRect();
            overlay.style.display = 'block';
            // After display we can measure; position after a microtask
            requestAnimationFrame(() => {
                const ow = overlay.offsetWidth;
                let left = r.left + r.width / 2 - ow / 2;
                left = Math.max(8, Math.min(left, window.innerWidth - ow - 8));
                overlay.style.left = left + 'px';
                overlay.style.top  = (r.bottom + 8) + 'px';
            });
        };
        const hide = () => { overlay.style.display = 'none'; };
        document.addEventListener('mouseover', (e) => {
            const icon = e.target.closest && e.target.closest('.tip-icon');
            if (icon) {
                if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
                show(icon);
            }
        });
        document.addEventListener('mouseout', (e) => {
            const icon = e.target.closest && e.target.closest('.tip-icon');
            if (icon) {
                hideTimer = setTimeout(hide, 120);
            }
        });
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();

// Strip trailing campus parenthetical from a portfolio program name for display.
// e.g. "Analytics, MS (Oakland)" → "Analytics, MS"
// Keeps non-campus parentheticals like "(non-degree)" intact.
// "Bachelor of Science in Nursing" → "Nursing, BS"
// "Bachelor of Science in Nursing, New York" → "Nursing, BS, New York"
// "Bachelor of Science - Transfer Track, New York" → "BS—Transfer Track, New York"
const _DEGREE_EXPAND = [
    [/^(?:Accelerated\s+)?Bachelor of Science in (.+)$/i,  (_, s) => `${s.trim()}, BS`],
    [/^(?:Accelerated\s+)?Bachelor of Arts in (.+)$/i,     (_, s) => `${s.trim()}, BA`],
    [/^Bachelor of Science\s*[-–]\s*(.+)$/i,               (_, s) => `BS—${s.trim()}`],
    [/^Bachelor['']?s Degree\b(.*)$/i,                     (_, s) => `BS${s}`],
];
function normalizePortfolioName(name) {
    if (!name) return name;
    for (const [re, fn] of _DEGREE_EXPAND) {
        if (re.test(name)) return name.replace(re, fn);
    }
    // Canonicalize "Master of Architecture—N-Year Program" → "Architecture, MArch—N-Year"
    let m = name.match(/^Master\s+of\s+Architecture\s*(?:[—\-]\s*([^,]+?))?\s*$/i);
    if (m) {
        const suf = m[1] ? '—' + m[1].replace(/\s*Program\s*$/i, '').trim() : '';
        return 'Architecture, MArch' + suf;
    }
    // Strip a trailing standalone " Program" word — it's redundant
    // in names like "Pharmaceutical Engineering Bridge Program, MS" or
    // "Master of Architecture—Two-Year Program".  Don't touch "Nursing—…
    // Accelerated Program for …" (still readable), etc.  Just remove the
    // bare " Program" before a comma or end-of-string.
    name = name.replace(/\s+Program(\s*,|\s*$)/i, '$1');
    return name;
}

const _CAMPUS_PARENS = new Set(Object.keys(CAMPUS_ABBREVS).map(s => s.toLowerCase()));
function stripCampusFromName(name) {
    if (!name) return name;
    return name.replace(/\s*\(([^)]+)\)\s*$/, (match, inner) =>
        _CAMPUS_PARENS.has(inner.toLowerCase()) ? '' : match
    ).trim();
}

function extractCampus(name) {
    const match = name.match(/\(([^)]+)\)\s*$/);
    if (!match) return '';
    const val = match[1];
    // Filter out non-campus parentheticals
    if (val.length > 20 || val.indexOf('template') !== -1 || val.indexOf('Copy') !== -1) return '';
    // Collapse all online variants into a single "Online" campus, matching
    // the portfolio's _normalize_campus() policy. "Primarily Online",
    // "Online - Vancouver Requirements", etc. all roll up to "Online" so
    // the Programs / Courses campus filter shows one Online option, not
    // separate ones for each suffix.
    const low = val.toLowerCase();
    if (low === 'online' || low.startsWith('primarily online') || low.startsWith('online -')) {
        return 'Online';
    }
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

function _initDashboard() {
    // Restore last active view (so navigating away and back keeps your context).
    let savedView = 'programs';
    try { savedView = localStorage.getItem('cim-active-view') || 'programs'; } catch(e) {}
    const validViews = ['programs', 'courses', 'catalog', 'portfolio'];
    if (!validViews.includes(savedView)) savedView = 'programs';
    if (savedView === 'programs') {
        loadDashboard();
    } else {
        switchView(savedView);
    }
    // Fast CourseLeaf session health probe so user sees "please log in" quickly,
    // not after a 10-minute scan that silently does nothing.
    // Only do this when the server is the Flask local server (not the static site).
    if (typeof window._staticMode === 'undefined') {
        checkSessionHealth();
        refreshCimAuthStatus();
    }
}

document.addEventListener('DOMContentLoaded', _initDashboard);

// Auto-refresh every 2 minutes — refreshes whichever view is active
setInterval(() => {
    if (currentView === 'programs') loadDashboard();
    else if (currentView === 'courses') loadCoursesDashboard();
    else if (currentView === 'catalog') loadCatalogDashboard();
    else if (currentView === 'portfolio') loadPortfolioDashboard();
}, 120000);

// Keep the CIM session badge + error banner self-correcting on the local
// dashboard, so re-authenticating reflects within a minute without a reload.
if (typeof window._staticMode === 'undefined') {
    setInterval(() => { refreshCimAuthStatus(); checkSessionHealth(); }, 60000);
}

// ==================== Portfolio view ====================

const PORTFOLIO_COLUMNS = [
    {key: 'degree',       label: 'Credential',
        help: 'Academic credential the program leads to (BS / MS / PhD / Prof Doctorate / CAGS / Certificate / Minor / Dual Degree / Concentration). Detected from the program name in CIM "Subject, Degree" format; SVT/IPD-added rows are normalized to that format at ingest so this column is filled for every program.'},
    {key: 'college',      label: 'College',
        help: 'Owning college. From CIM XML for tracked programs; SVT/IPD-supplied values are normalized to the canonical CIM name so duplicates and abbreviations are merged.'},
    {key: 'campus',       label: 'Campus',
        help: 'Deployment campus. All online variants (Online, Primarily Online, "Online - Vancouver Requirements", etc.) are merged into a single "Online" campus.'},
    {key: 'market2025',      label: '2025 Market Category', defaultHidden: true,
        help: 'Market category from the 2025 portfolio scoring workbook (Boston programs only).'},
    {key: 'perf2025',        label: '2025 Performance Category', defaultHidden: true,
        help: 'Performance category from the 2025 portfolio scoring workbook (Boston programs only).'},
    {key: 'marketscore2025', label: '2025 Market Score', defaultHidden: true,
        help: 'Numeric market score from the 2025 portfolio scoring workbook (Boston programs only).'},
    {key: 'perfscore2025',   label: '2025 Performance Score', defaultHidden: true,
        help: 'Numeric performance score from the 2025 portfolio scoring workbook (Boston programs only).'},
    {key: 'otp',          label: 'OTP Status',
        help: 'Status from the "OTP Program Tracking" sheet of the Optimization, Withdrawal, and Deactivation Tracker (Boston-only; being deprecated).'},
    {key: 'svt',          label: 'SVT Status',
        help: 'Status from the SVT Source Data Smartsheet (Intake, Discovery, Approved for Development by College, Launch in Progress, Complete, Inactivation In Progress, etc.).'},
    {key: 'substatus',    label: 'Sub-status',
        help: 'Launch sub-status from the SVT Source Data Smartsheet (e.g. "Regulatory Submission in Progress", "Post-Launch & Monitor - IPD").'},
    {key: 'speed',        label: 'Speed to Market',
        help: 'Speed to Market flag from the SVT Source Data Smartsheet (checkbox).'},
    {key: 'gls',          label: 'GLS Status',
        help: 'Per-campus status from the GLS Tableau dashboard (campus deployment health).'},
    {key: 'launch',       label: 'SVT Launch Date',
        help: 'Actual Launch Date from the SVT Source Data Smartsheet. Stored as a term/free-text value (e.g. "Fall 2026", "TBD"), not a calendar date.'},
    {key: 'cim',          label: 'CIM Step',
        help: 'Current CourseLeaf CIM workflow step (the review role currently holding the proposal). Blank when the program is not in active workflow.'},
    {key: 'cimcatalog',   label: 'CIM Catalog', defaultHidden: true,
        help: 'Effective catalog year CIM approved the program for (e.g. "Catalog 2026-2027"), from the completion surrogate. Blank while still in active workflow. This is the value the "SVT launch ≠ CIM catalog" check compares against.'},
    {key: 'cimterm',      label: 'CIM Effective Term', defaultHidden: true,
        help: 'Effective term from CIM XML <eff_term> (decoded from the Banner code per NU\'s official scheme, e.g. "Fall 2027").'},
    {key: 'svtnote',      label: 'SVT Coordination Note', defaultHidden: true,
        help: 'Heuristic note for the "Needs SVT coordination" view: why an SVT entry with no CIM record is problematic — no CIM match, a possible match to an existing CIM program (likely a match failure / duplicate), or a bundled name that may need splitting.'},
    {key: 'cimchange',    label: 'CIM Change',
        help: 'CIM proposal type for the current edit cycle: New (added), Change (edited), or Inactivation.'},
    {key: 'inworkflow',   label: 'In CIM',
        help: 'Yes if the program exists in CourseLeaf CIM at all — either active in workflow, or already approved/historical. No if the portfolio entry comes only from an external feed (SVT, IPD, OTP) with no CIM record.'},
    {key: 'inactadmit',  label: 'Inactivation of Admission',
        help: 'Term beginning when the program will no longer admit new students (from CIM’s inactivation proposal fields).'},
    {key: 'inacttoday',  label: 'Admitting Today',
        help: 'Yes if the program is admitting students this term, No if its Inactivation of Admission term has already started.'},
    {key: 'offering',    label: 'New Offering', defaultHidden: true,
        help: 'Whether this graduate program is a new offering or an inactivation, derived from CIM proposal fields: New concentration (a concentration marked not-existing in the proposal), New degree (a new degree type), or Inactivation (whole-program deactivation).'},
    {key: 'gtmentered',  label: 'GTM Entered', defaultHidden: true,
        help: 'Date the record entered the GTM stage — when it first became GTM-relevant (a new offering completed governance, or an inactivation began). Preserved across scans; existing records at launch were seeded from their CIM step-entered date.'},
    {key: 'gtmtype',     label: 'GTM Type', defaultHidden: true,
        help: 'Type from the Go To Market Roster 2.0 (Net new, Redeployment, Major Program Update, Inactivation, etc.). Joined to CIM by the roster’s CIM url + Banner Code.'},
    {key: 'gtmdate',     label: 'GTM Date', defaultHidden: true,
        help: 'GTM Launch or Inactivation Date from the Go To Market Roster 2.0.'},
    {key: 'gtmfirst',    label: 'GTM First Intake', defaultHidden: true,
        help: 'First Effective Intake Term from the Go To Market Roster 2.0.'},
    {key: 'gtmlast',     label: 'GTM Last Term', defaultHidden: true,
        help: 'Last Available Term from the Go To Market Roster 2.0.'},
    {key: 'gtmintake',   label: 'GTM Intake Terms', defaultHidden: true,
        help: 'Available intake terms from the Go To Market Roster 2.0.'},
    {key: 'exitmasters', label: "Exit master's only", defaultHidden: true,
        help: "Whether the program is a designated exit-master's-only program (curated by banner code)."},
    {key: 'notes',        label: 'Notes',
        help: 'Free-form notes from the source feeds (CIM justification, IPD comments, etc.).'},
    {key: 'emplreview',   label: 'April 2026 EMPL Review',
        help: 'Notes (column M) from the "OTP Program Tracking" sheet of the Optimization, Withdrawal, and Deactivation Tracker — the April 2026 EMPL review notes (Boston-only).'},
];

// Tracks which column keys have ever existed in PORTFOLIO_COLUMNS at the
// time a user last saved their picker selection. When new columns are added
// to PORTFOLIO_COLUMNS, they default to visible (rather than being
// silently hidden because the stored Set didn't list them yet).
function _loadPortfolioCols() {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem('cim-portfolio-cols') || 'null'); } catch(e) {}
    let known = [];
    try { known = JSON.parse(localStorage.getItem('cim-portfolio-cols-known') || '[]'); } catch(e) {}
    const knownSet = new Set(known);

    const visible = Array.isArray(stored)
        ? new Set(stored)
        : new Set(PORTFOLIO_COLUMNS.filter(c => !c.defaultHidden).map(c => c.key));
    // Any column key the user has never seen before defaults to visible —
    // unless it's flagged defaultHidden (e.g. low-signal market/perf columns).
    PORTFOLIO_COLUMNS.forEach(c => {
        if (!knownSet.has(c.key) && !c.defaultHidden) visible.add(c.key);
    });
    return visible;
}
let portfolioVisibleCols = _loadPortfolioCols();

// Portfolio layout mode: 'table' (default) or 'matrix' (program × campus grid).
let portfolioLayout = (() => {
    try { return localStorage.getItem('cim-portfolio-layout') || 'table'; }
    catch (_) { return 'table'; }
})();
// Matrix: which parent programs have their concentration rows expanded
// (collapsed by default — concentrations hidden until you expand the program).
let portfolioMatrixExpanded = new Set();

function setPortfolioLayout(mode) {
    portfolioLayout = (mode === 'matrix') ? 'matrix' : 'table';
    try { localStorage.setItem('cim-portfolio-layout', portfolioLayout); } catch (_) {}
    document.querySelectorAll('.portfolio-layout-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.layout === portfolioLayout);
    });
    renderPortfolioTable();
}

function togglePortfolioMatrixRow(baseKey) {
    if (portfolioMatrixExpanded.has(baseKey)) portfolioMatrixExpanded.delete(baseKey);
    else portfolioMatrixExpanded.add(baseKey);
    renderPortfolioMatrix();
}

// Matrix row sorting. Key is 'name', 'college', or 'c:<Campus>' (sort programs
// by their status in that campus column). Clicking the active header flips dir.
let matrixSortKey = 'name';
let matrixSortDir = 1;
function sortPortfolioMatrix(key) {
    if (matrixSortKey === key) matrixSortDir = -matrixSortDir;
    else { matrixSortKey = key; matrixSortDir = 1; }
    renderPortfolioMatrix();
}

// Per-column width overrides for the Portfolio table — {colKey: widthPx}.
// Persisted to localStorage so user-resized columns survive reloads.
function _loadPortfolioColWidths() {
    try {
        const s = localStorage.getItem('cim-portfolio-col-widths');
        const obj = s ? JSON.parse(s) : {};
        return (obj && typeof obj === 'object') ? obj : {};
    } catch (e) { return {}; }
}
let portfolioColWidths = _loadPortfolioColWidths();
function _savePortfolioColWidths() {
    try { localStorage.setItem('cim-portfolio-col-widths', JSON.stringify(portfolioColWidths)); }
    catch (e) {}
}

// Matrix column widths, keyed by 'prog' | 'college' | 'c:<Campus>'.
let matrixColWidths = (() => {
    try { const s = localStorage.getItem('cim-matrix-col-widths'); const o = s ? JSON.parse(s) : {};
          return (o && typeof o === 'object') ? o : {}; } catch (_) { return {}; }
})();
function _saveMatrixColWidths() {
    try { localStorage.setItem('cim-matrix-col-widths', JSON.stringify(matrixColWidths)); } catch (_) {}
}

// Resize a matrix column via its header's drag handle. Adjusts the matching
// <col> width and grows/shrinks the table by the same delta so the other
// columns keep their widths (table-layout: fixed). For the two sticky columns
// it also updates the CSS vars that drive the sticky `left` offsets.
function startMatrixColResize(e, key) {
    e.stopPropagation();
    e.preventDefault();
    const th = e.target.closest('th');
    const table = e.target.closest('table');
    if (!th || !table) return;
    const col = table.querySelector(`col[data-mxcol="${(window.CSS && CSS.escape) ? CSS.escape(key) : key}"]`);
    const startX = e.clientX;
    const startW = th.getBoundingClientRect().width;
    const startTableW = table.getBoundingClientRect().width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const apply = (ev) => {
        const newW = Math.max(40, Math.round(startW + (ev.clientX - startX)));
        if (col) col.style.width = newW + 'px';
        table.style.width = (startTableW + (newW - startW)) + 'px';
        if (key === 'prog') table.style.setProperty('--mx-prog-w', newW + 'px');
        if (key === 'college') table.style.setProperty('--mx-college-w', newW + 'px');
        return newW;
    };
    const onMove = (ev) => apply(ev);
    const onUp = (ev) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        matrixColWidths[key] = apply(ev);
        _saveMatrixColWidths();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}
if (typeof window !== 'undefined') window.startMatrixColResize = startMatrixColResize;

// Mouse-drag column resizer. Called from the inline onmousedown on each
// header's <span class="col-resize"> handle. The handle's stopPropagation
// prevents the click from also firing the header's sort handler.
function startPortfolioColResize(e) {
    e.stopPropagation();
    e.preventDefault();
    const th = e.target.closest('th');
    if (!th) return;
    const key = th.dataset.colKey;
    if (!key) return;
    const startX = e.clientX;
    const startW = th.getBoundingClientRect().width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev) => {
        const newW = Math.max(40, Math.round(startW + (ev.clientX - startX)));
        th.style.width = newW + 'px';
    };
    const onUp = (ev) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        const newW = Math.max(40, Math.round(startW + (ev.clientX - startX)));
        portfolioColWidths[key] = newW;
        _savePortfolioColWidths();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}
if (typeof window !== 'undefined') window.startPortfolioColResize = startPortfolioColResize;

function _rebuildColDropdownItems(dd) {
    dd.innerHTML =
        `<div class="portfolio-col-selectall">
            <button onclick="toggleAllPortfolioCols(true)">Select All</button>
            <button onclick="toggleAllPortfolioCols(false)">Unselect All</button>
        </div>` +
        PORTFOLIO_COLUMNS.map(c => `
        <label class="portfolio-col-check">
            <input type="checkbox" ${portfolioVisibleCols.has(c.key) ? 'checked' : ''}
                   onchange="togglePortfolioCol('${c.key}',this.checked)">
            ${c.label}
        </label>`).join('');
}

function _savePortfolioCols() {
    localStorage.setItem('cim-portfolio-cols', JSON.stringify([...portfolioVisibleCols]));
    localStorage.setItem('cim-portfolio-cols-known',
        JSON.stringify(PORTFOLIO_COLUMNS.map(c => c.key)));
}

function toggleAllPortfolioCols(visible) {
    if (visible) PORTFOLIO_COLUMNS.forEach(c => portfolioVisibleCols.add(c.key));
    else portfolioVisibleCols.clear();
    _savePortfolioCols();
    const dd = document.getElementById('portfolio-col-dropdown');
    if (dd && dd.classList.contains('open')) _rebuildColDropdownItems(dd);
    renderPortfolioTable();
}

function togglePortfolioColPicker(e) {
    e.stopPropagation();
    const dd = document.getElementById('portfolio-col-dropdown');
    if (!dd) return;
    if (dd.classList.contains('open')) { dd.classList.remove('open'); return; }
    _rebuildColDropdownItems(dd);
    dd.classList.add('open');
}

function togglePortfolioCol(key, visible) {
    if (visible) portfolioVisibleCols.add(key);
    else portfolioVisibleCols.delete(key);
    _savePortfolioCols();
    renderPortfolioTable();
}

document.addEventListener('click', e => {
    // Close multi-select filter dropdowns on outside click
    document.querySelectorAll('.filter-multi-dropdown.open').forEach(el => {
        const wrap = el.closest('.filter-multi-wrap');
        if (wrap && !wrap.contains(e.target)) el.classList.remove('open');
    });
    // Close column picker dropdown on outside click
    const picker = document.getElementById('portfolio-col-picker');
    if (picker && !picker.contains(e.target)) {
        const dd = document.getElementById('portfolio-col-dropdown');
        if (dd) dd.classList.remove('open');
    }
});

// Returns <td> for a portfolio column, or '' if hidden.
function _pc(key, content, cls, titleAttr) {
    if (!portfolioVisibleCols.has(key)) return '';
    const t = titleAttr ? ` title="${escapeHtml(titleAttr)}"` : '';
    return cls ? `<td class="${cls}"${t}>${content}</td>` : `<td${t}>${content}</td>`;
}

// ── Portfolio views (named presets) ────────────────────────────────────────
// A view bundles column visibility + filter state into a named snapshot.
// Built-in views are defined here; personal views are stored in localStorage.
//
// visibleCols: array of PORTFOLIO_COLUMNS keys to show, or null (= all)
// gtmOnly: true → show identifying cols + every col whose key starts 'gtm'
//          (auto-picks up GTM columns when they are added)
// filters: snapshot of all filter state (empty = no restrictions)

const _PORTFOLIO_VIEWS_LS  = 'cim-portfolio-views-v1';
const _PORTFOLIO_ACTIVE_LS = 'cim-portfolio-active-view';

// The one permanent, system view: always present for everyone, always shown as
// a tile, and can't be deleted or unstarred. Shows all programs, all columns.
const ALL_PROGRAMS_VIEW = {
    id: 'all', name: 'All Programs', team: true, system: true,
    state: { visibleCols: null, filters: {}, tree: null },
};

// Two permanent GTM (enrollment-management) system views. Graduate-only signals
// derived from CIM: new offerings (concentration/degree) that cleared governance,
// plus inactivations. The columns focus on identity + offering + GTM roster data.
const _GTM_VIEW_COLS = ['degree', 'college', 'campus', 'offering', 'cim',
    'svt', 'gtmtype', 'gtmdate', 'gtmfirst', 'gtmlast', 'gtmintake'];
const _GTM_RELEVANT_GROUP = {
    type: 'group', conj: 'any', children: [
        { type: 'rule', field: 'ready_gtm', op: 'in', value: ['Y'] },
        { type: 'rule', field: 'gtm_inact', op: 'in', value: ['Y'] },
    ],
};
// "GTM" — everything EM needs to be aware of: grad new offerings ready for GTM
// (governance cleared / current-or-upcoming) plus grad inactivations.
const GTM_VIEW = {
    id: 'gtm', name: 'GTM', team: true, system: true,
    tip: 'Graduate new offerings that have completed governance (a new concentration or certificate past the Graduate Curriculum Committee, a new degree past the Board of Trustees, or completed effective in the 2025-2026 catalog or later), plus graduate inactivations in workflow or effective in that catalog window.',
    state: {
        visibleCols: _GTM_VIEW_COLS,
        filters: {},
        tree: JSON.parse(JSON.stringify(_GTM_RELEVANT_GROUP)),
    },
};
// "GTM — Needs Action" — the GTM-relevant set with no GTM action on file yet
// (no GTM Type from the Go To Market Roster).
const GTM_NEEDS_ACTION_VIEW = {
    id: 'gtm_needs_action', name: 'GTM — Needs Action', team: true, system: true,
    tip: 'The GTM set (graduate new offerings ready for go-to-market plus graduate inactivations) filtered to programs with no GTM Type recorded in the Go To Market Roster 2.0 — i.e. no GTM action started yet.',
    state: {
        visibleCols: _GTM_VIEW_COLS,
        filters: {},
        tree: {
            type: 'group', conj: 'all', children: [
                JSON.parse(JSON.stringify(_GTM_RELEVANT_GROUP)),
                { type: 'rule', field: 'gtm_type', op: 'is_empty', value: [] },
            ],
        },
    },
};
// "GTM — New This Period" — records that entered the GTM stage recently, by the
// GTM Entered date field. Default window 30 days; editable via the view's filter
// (GTM Entered Date · in the last … days).
const GTM_RECENT_VIEW = {
    id: 'gtm_recent', name: 'GTM — Recent', team: true, system: true,
    tip: 'Graduate records that entered the GTM stage in the last 30 days — i.e. first became GTM-relevant (a new offering completed governance, or an inactivation began) within the window, by GTM Entered date. Adjust the day count in the view’s filter.',
    state: {
        visibleCols: ['degree', 'college', 'campus', 'offering', 'gtmentered', 'cim',
            'svt', 'gtmtype', 'gtmdate', 'gtmfirst', 'gtmlast', 'gtmintake'],
        filters: {},
        tree: {
            type: 'group', conj: 'all', children: [
                { type: 'rule', field: 'gtm_entered', op: 'within_days', value: '30' },
            ],
        },
    },
};

// ── Administrative data-quality views ───────────────────────────────────────
// Hidden behind the "⚙ Admin views" toggle in the Views modal (per-browser,
// localStorage). Graduate data-validation queues; CIM is authoritative.
const _ADMIN_VIEW_COLS = ['degree', 'college', 'campus', 'cim', 'cimchange', 'svt', 'substatus', 'launch', 'inactadmit'];
const ADMIN_PLANNING_AHEAD_VIEW = {
    id: 'admin_planning_ahead', name: 'Admin · Planning ahead of CIM', team: true, system: true, admin: true,
    tip: 'Portfolio rows with no CIM record whose SVT status is Launch in Progress or Regulatory Validation In Progress — launch is underway but no approved CIM proposal is linked. Some may be CIM match failures (the program exists in CIM under a different name); treat as an investigation queue.',
    state: { visibleCols: _ADMIN_VIEW_COLS, filters: {}, tree: { type: 'group', conj: 'all', children: [
        { type: 'rule', field: 'level', op: 'in', value: ['Graduate'] },
        { type: 'rule', field: 'in_cim', op: 'in', value: ['N'] },
        { type: 'rule', field: 'svt', op: 'in', value: ['Launch in Progress', 'Regulatory Validation In Progress'] },
    ] } },
};
const ADMIN_CIM_INACT_SVT_ACTIVE_VIEW = {
    id: 'admin_cim_inact_svt_active', name: 'Admin · CIM inactivation vs SVT active', team: true, system: true, admin: true,
    tip: 'Programs CIM is inactivating, but whose SVT status is anything other than Inactivation In Progress (e.g. Complete, Launch in Progress, On Hold) — the planning record disagrees with the authoritative CIM inactivation.',
    state: { visibleCols: _ADMIN_VIEW_COLS, filters: {}, tree: { type: 'group', conj: 'all', children: [
        { type: 'rule', field: 'level', op: 'in', value: ['Graduate'] },
        { type: 'rule', field: 'cim_change', op: 'in', value: ['Inactivation'] },
        { type: 'rule', field: 'svt', op: 'is_set', value: [] },
        { type: 'rule', field: 'svt', op: 'not_in', value: ['Inactivation In Progress'] },
        // Suppress agreement: when the SVT row is ITSELF an inactivation, SVT's
        // "Complete"/"Intake" means the inactivation is in progress/done, which
        // AGREES with CIM — not a conflict (e.g. Applied Physics, Cloud Software).
        { type: 'rule', field: 'svt_type', op: 'not_in', value: ['Inactivation'] },
    ] } },
};
const ADMIN_CIM_DONE_SVT_BEHIND_VIEW = {
    id: 'admin_cim_done_svt_behind', name: 'Admin · CIM done, SVT behind', team: true, system: true, admin: true,
    tip: 'Programs CIM has fully approved (in CIM, no active workflow step) but whose SVT status is still an early development stage (Discovery, Intake, Approved for Development, Economic Model, Leadership Review, EDGE) — SVT is behind the authoritative CIM state.',
    state: { visibleCols: _ADMIN_VIEW_COLS, filters: {}, tree: { type: 'group', conj: 'all', children: [
        { type: 'rule', field: 'level', op: 'in', value: ['Graduate'] },
        { type: 'rule', field: 'in_cim', op: 'in', value: ['Y'] },
        { type: 'rule', field: 'cim_step', op: 'is_empty', value: [] },
        { type: 'rule', field: 'svt', op: 'in', value: ['Discovery', 'Intake', 'Economic Model',
            'Leadership Review Pending', 'Approved for Development by College', 'Approved for Development by IPD',
            'EDGE - Development', 'EDGE - Development & Delivery', 'EDGE - Content Consultation'] },
    ] } },
};
const _ADMIN_DATE_COLS = ['degree', 'college', 'campus', 'svt', 'launch', 'gtmfirst', 'cimcatalog', 'cimterm', 'cimchange'];
const ADMIN_LAUNCH_OVERDUE_VIEW = {
    id: 'admin_launch_overdue', name: 'Admin · Launch overdue', team: true, system: true, admin: true,
    tip: 'Programs whose SVT launch term has already passed but that are not Complete (and not On Hold or inactivating) — planned to launch by a term that has gone by, but not yet launched. Free-text/TBD launch dates are excluded.',
    state: { visibleCols: _ADMIN_DATE_COLS, filters: {}, tree: { type: 'group', conj: 'all', children: [
        { type: 'rule', field: 'level', op: 'in', value: ['Graduate'] },
        { type: 'rule', field: 'launch_overdue', op: 'in', value: ['Y'] },
    ] } },
};
const ADMIN_LAUNCH_VS_GTM_VIEW = {
    id: 'admin_launch_vs_gtm', name: 'Admin · SVT launch ≠ GTM intake', team: true, system: true, admin: true,
    tip: 'Programs whose SVT launch term and GTM first-intake term disagree — the two planning sources name different launch terms. Only rows where both terms are present and parseable are shown.',
    state: { visibleCols: _ADMIN_DATE_COLS, filters: {}, tree: { type: 'group', conj: 'all', children: [
        { type: 'rule', field: 'level', op: 'in', value: ['Graduate'] },
        { type: 'rule', field: 'launch_vs_gtm', op: 'in', value: ['Y'] },
    ] } },
};
const ADMIN_LAUNCH_VS_CIM_VIEW = {
    id: 'admin_launch_vs_cim', name: 'Admin · SVT launch before CIM term', team: true, system: true, admin: true,
    tip: 'Programs whose SVT launch term is EARLIER than CIM\'s effective term (eff_term, decoded from the Banner code — CIM authoritative) — i.e. planned to launch before the program is effective in CIM. Launching at or after the CIM term is fine (programs can be in the catalog before they launch), so those are not flagged. Only rows where both terms are present are shown.',
    state: { visibleCols: _ADMIN_DATE_COLS, filters: {}, tree: { type: 'group', conj: 'all', children: [
        { type: 'rule', field: 'level', op: 'in', value: ['Graduate'] },
        { type: 'rule', field: 'launch_before_cimterm', op: 'in', value: ['Y'] },
    ] } },
};
const _ADMIN_SVT_COLS = ['degree', 'college', 'campus', 'svt', 'substatus', 'launch', 'svtnote'];
const ADMIN_SVT_COORD_VIEW = {
    id: 'admin_svt_coord', name: 'Admin · Needs SVT coordination', team: true, system: true, admin: true,
    tip: 'SVT entries that do not cleanly map to one CIM program and need reconciliation with the SVT team — there is an SVT status but no CIM record. The SVT Coordination Note classifies each (heuristic): no CIM match, a possible match to an existing CIM program (likely a match failure / duplicate, e.g. "Applied Sustainability - new concentration, MS"), or a bundled name that may need splitting.',
    state: { visibleCols: _ADMIN_SVT_COLS, filters: {}, tree: { type: 'group', conj: 'all', children: [
        { type: 'rule', field: 'level', op: 'not_in', value: ['Undergraduate'] },
        { type: 'rule', field: 'svt_coord', op: 'in', value: ['Y'] },
    ] } },
};
const ADMIN_VIEWS = [ADMIN_PLANNING_AHEAD_VIEW, ADMIN_CIM_INACT_SVT_ACTIVE_VIEW, ADMIN_CIM_DONE_SVT_BEHIND_VIEW,
    ADMIN_LAUNCH_OVERDUE_VIEW, ADMIN_LAUNCH_VS_GTM_VIEW, ADMIN_LAUNCH_VS_CIM_VIEW, ADMIN_SVT_COORD_VIEW];

const _PORTFOLIO_ADMIN_LS = 'cim-portfolio-admin-views';
function _pvAdminViewsOn() { try { return localStorage.getItem(_PORTFOLIO_ADMIN_LS) === '1'; } catch (_) { return false; } }
function togglePvAdminViews() {
    const on = !_pvAdminViewsOn();
    try { localStorage.setItem(_PORTFOLIO_ADMIN_LS, on ? '1' : '0'); } catch (_) {}
    if (typeof renderPvModal === 'function') renderPvModal();
    renderPortfolioViewTiles();
}
if (typeof window !== 'undefined') window.togglePvAdminViews = togglePvAdminViews;

// State
let portfolioActiveViewId = null;
let portfolioActiveViewDirty = false;  // filters changed since view was applied
let portfolioTeamViews = [];           // shared team views (API-hydrated, local; baked on static)

function getPortfolioPersonalViews() {
    try { return JSON.parse(localStorage.getItem(_PORTFOLIO_VIEWS_LS) || '[]'); }
    catch(_) { return []; }
}
function setPortfolioPersonalViews(views) {
    try { localStorage.setItem(_PORTFOLIO_VIEWS_LS, JSON.stringify(views)); } catch(_) {}
}
function getAllPortfolioViews() {
    const base = [ALL_PROGRAMS_VIEW, GTM_VIEW, GTM_NEEDS_ACTION_VIEW, GTM_RECENT_VIEW,
            ...getPortfolioTeamViews(), ...getPortfolioPersonalViews()];
    return _pvAdminViewsOn() ? base.concat(ADMIN_VIEWS) : base;
}
function getPortfolioViewById(id) {
    return getAllPortfolioViews().find(v => v.id === id) || null;
}

// Resolve which column keys are visible for a given view state.
function _resolveViewCols(state) {
    if (!state) return null;
    if (state.gtmOnly) {
        const identCols = ['degree', 'college', 'campus'];
        const gtmCols   = PORTFOLIO_COLUMNS.filter(c => c.key.startsWith('gtm')).map(c => c.key);
        return [...identCols, ...gtmCols];
    }
    return state.visibleCols || null;   // null = all
}

// Snapshot current filter state (all filter variables → plain JSON-safe object).
function _snapshotPortfolioFilters() {
    return {
        levels:     [...portfolioLevelFilter],
        degrees:    [...portfolioDegreeFilter],
        statuses:   [...portfolioStatusFilter],
        colleges:   [...portfolioCollegeFilter],
        campuses:   [...portfolioCampusFilter],
        otp:        [...portfolioOtpFilter],
        ipd:        [...portfolioIpdFilter],
        roster:     [...portfolioRosterFilter],
        substatus:  [...portfolioSubStatusFilter],
        speed:      [...portfolioSpeedFilter],
        gls:        [...portfolioGlsFilter],
        cim:        [...portfolioCimFilter],
        cimchange:  [...portfolioCimChangeFilter],
        inworkflow: [...portfolioInWorkflowFilter],
        inactadmit: [...portfolioInactAdmitFilter],
        inacttoday: portfolioInactTodayFilter,
        search:     portfolioSearch,
    };
}

function _snapshotEq(a, b) {
    // Shallow equality check on two filter snapshots.
    return JSON.stringify(a) === JSON.stringify(b);
}

// Apply a filter snapshot — resets all filters then restores the snapshot.
function _applyPortfolioFilters(f) {
    f = f || {};
    portfolioLevelFilter    = new Set(f.levels    || []);
    portfolioDegreeFilter   = new Set(f.degrees   || []);
    portfolioStatusFilter   = new Set(f.statuses  || []);
    portfolioCollegeFilter  = new Set(f.colleges  || []);
    portfolioCampusFilter   = new Set(f.campuses  || []);
    portfolioOtpFilter      = new Set(f.otp       || []);
    portfolioIpdFilter      = new Set(f.ipd       || []);
    portfolioRosterFilter   = new Set(f.roster    || []);
    portfolioSubStatusFilter = new Set(f.substatus || []);
    portfolioSpeedFilter    = new Set(f.speed     || []);
    portfolioGlsFilter      = new Set(f.gls       || []);
    portfolioCimFilter      = new Set(f.cim       || []);
    portfolioCimChangeFilter = new Set(f.cimchange || []);
    portfolioInWorkflowFilter = new Set(f.inworkflow || []);
    portfolioInactAdmitFilter = new Set(f.inactadmit || []);
    portfolioInactTodayFilter = f.inacttoday || '';
    portfolioSearch           = f.search    || '';
    // Sync all UI controls to the restored state
    _syncPortfolioFilterUi();
}

// Sync all filter UI widgets to the current filter state variables.
// Called after programmatically restoring filter state.
function _syncPortfolioFilterUi() {
    const multiIds = {
        'portfolio-filter-college':   portfolioCollegeFilter,
        'portfolio-filter-campus':    portfolioCampusFilter,
        'portfolio-filter-otp':       portfolioOtpFilter,
        'portfolio-filter-ipd':       portfolioIpdFilter,
        'portfolio-filter-roster':    portfolioRosterFilter,
        'portfolio-filter-substatus': portfolioSubStatusFilter,
        'portfolio-filter-speed':     portfolioSpeedFilter,
        'portfolio-filter-gls':       portfolioGlsFilter,
        'portfolio-filter-cim':       portfolioCimFilter,
        'portfolio-filter-cimchange': portfolioCimChangeFilter,
        'portfolio-filter-inworkflow':portfolioInWorkflowFilter,
        'portfolio-filter-inactadmit':portfolioInactAdmitFilter,
    };
    Object.entries(multiIds).forEach(([id, set]) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        // Re-render the dropdown checkboxes to reflect the restored state.
        // Use the existing renderPortfolioMultiFilterDropdown if available.
        if (typeof renderPortfolioMultiFilterDropdown === 'function') {
            renderPortfolioMultiFilterDropdown(id, set);
        }
    });
    // Inact today select
    const itSel = document.getElementById('portfolio-filter-inacttoday');
    if (itSel) itSel.value = portfolioInactTodayFilter;
    // Search box
    const sb = document.getElementById('filter-search');
    if (sb && currentView === 'portfolio') sb.value = portfolioSearch;
    // Level / degree / status toggle buttons
    document.querySelectorAll('.portfolio-lvl-btn').forEach(b =>
        b.classList.toggle('active', portfolioLevelFilter.has(b.dataset.lvl)));
    document.querySelectorAll('.portfolio-deg-btn').forEach(b =>
        b.classList.toggle('active', portfolioDegreeFilter.has(b.dataset.deg)));
    document.querySelectorAll('.portfolio-status-btn').forEach(b =>
        b.classList.toggle('active', portfolioStatusFilter.has(b.dataset.status)));
    document.querySelectorAll('.portfolio-incim-btn').forEach(b =>
        b.classList.toggle('active', portfolioInWorkflowFilter.has(b.dataset.incim)));
    document.querySelectorAll('.portfolio-cimchg-btn').forEach(b =>
        b.classList.toggle('active', portfolioCimChangeFilter.has(b.dataset.cimchg)));
    updateClearButtons();
}

// ══════════════════════════════════════════════════════════════════════════
// Portfolio filter-tree engine (adapted from the student tracker's builder)
// ══════════════════════════════════════════════════════════════════════════
// A view's advanced filter is a recursive tree of AND/OR groups + rules.
// Each rule = {field, op, value}. Fields are defined in PORTFOLIO_FILTER_FIELDS
// with a value(p) accessor returning the row's value as a display string.

// ── SVT coordination queue ──────────────────────────────────────────────────
// SVT entries that don't cleanly map to one CIM program — need reconciliation
// with the SVT team. A row qualifies when it has an SVT status but no CIM record.
function _svtNeedsCoord(p) {
    return !!(p && (p.svt_status || '') && !p.cim_program_id);
}
const _SVT_STOP = new Set(['the','of','in','for','and','a','an','to','with','program','online','new']);
function _svtSubjectWords(name) {
    let s = (name || '').toLowerCase();
    s = s.replace(/\([^)]*\)/g, ' ').replace(/—.*/, ' ');     // drop (campus) + em-dash deployment
    s = s.split(',')[0];                                       // subject = before the first comma (degree)
    s = s.replace(/\bnew concentration\b|\bdirect entry\b|\bcertificate\b/g, ' ');
    return new Set(s.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w && !_SVT_STOP.has(w)));
}
function _svtDegKey(name) { return (extractPortfolioDegree(name) || '').toLowerCase().trim(); }
let _svtCimSubjCache = null, _svtCimSubjLen = -1;
function _svtCimSubjects() {
    const all = allPortfolioPrograms || [];
    if (_svtCimSubjCache && _svtCimSubjLen === all.length) return _svtCimSubjCache;
    _svtCimSubjCache = all.filter(p => p.cim_program_id)
        .map(p => ({ name: p.program_name, w: _svtSubjectWords(p.program_name), deg: _svtDegKey(p.program_name) }));
    _svtCimSubjLen = all.length;
    return _svtCimSubjCache;
}
// Heuristic note explaining why an SVT row needs coordination.
function _svtCoordNote(p) {
    if (!_svtNeedsCoord(p)) return '';
    const name = p.program_name || '';
    const degs = name.match(/\b(MS|MA|MBA|MPS|MPH|MPA|MPP|MSCS|MSIS|PhD|EdD|DNP|DMSc|CAGS|Certificate)\b/gi) || [];
    if (name.includes(';') || (/\band\b/i.test(name) && degs.length >= 2))
        return 'May bundle multiple programs — consider splitting';
    const w = _svtSubjectWords(name), deg = _svtDegKey(name);
    if (w.size) {
        let best = null, bestScore = 0;
        for (const c of _svtCimSubjects()) {
            if (!c.w.size || c.deg !== deg) continue;          // require same credential
            let inter = 0; for (const x of w) if (c.w.has(x)) inter++;
            const j = inter / (w.size + c.w.size - inter);
            if (j > bestScore) { bestScore = j; best = c.name; }
        }
        if (bestScore >= 0.6) return 'Possible match to CIM: ' + best;
    }
    return 'No CIM match';
}

// Human label for a portfolio row's GTM offering signal (grad programs only).
function portfolioOfferingLabel(p) {
    const v = p.new_offering || '';
    if (v) {
        const has = t => v.indexOf(t) !== -1;
        if (has('new_concentration') && has('new_degree')) return 'New concentration + degree';
        if (has('new_degree'))        return 'New degree';
        if (has('new_concentration')) return 'New concentration';
        return v;
    }
    return p.gtm_inactivation === 'Yes' ? 'Inactivation' : '';
}

// ── Term/date parsing for data-quality date-mismatch checks ─────────────────
// Portfolio "dates" are mostly free-text academic terms ("Fall 2026", "SP 25",
// "Summer 25"). Parse to a comparable rank = year*10 + season(Winter0/Spring1/
// Summer2/Fall3); null when unparseable (TBD, soft-launch prose, etc.).
function _pfTermRank(s) {
    if (!s) return null;
    const m = String(s).match(/(Fall|Spring|Summer|Winter|FA|SP|SU|WI)\s*'?\s*((?:20)?\d{2})\b/i);
    if (!m) return null;
    let yr = parseInt(m[2], 10); if (yr < 100) yr += 2000;
    const rank = {winter:0, wi:0, spring:1, sp:1, summer:2, su:2, fall:3, fa:3}[m[1].toLowerCase()];
    return rank == null ? null : yr * 10 + rank;
}
function _pfCurrentTermRank() {
    const d = new Date(), mo = d.getMonth();          // 0=Jan
    const rank = mo <= 3 ? 1 : mo <= 7 ? 2 : 3;        // Jan–Apr Spring, May–Aug Summer, Sep–Dec Fall
    return d.getFullYear() * 10 + rank;
}
// #1 launch term has passed but program isn't launched (and isn't on-hold/inactivating).
function _pfLaunchOverdue(p) {
    const r = _pfTermRank(p.roster_launch_date);
    if (r == null || r >= _pfCurrentTermRank()) return false;
    const s = (p.svt_status || '').toLowerCase();
    if (!s || s.includes('complete') || s.includes('hold') || s.includes('inactiv')) return false;
    return true;
}
// #2 SVT launch term disagrees with the GTM first-intake term.
function _pfLaunchVsGtm(p) {
    const a = _pfTermRank(p.roster_launch_date), b = _pfTermRank(p.gtm_first_term);
    return a != null && b != null && a !== b;
}
// #3b SVT launch term is EARLIER than CIM's effective term — planning to launch
// before the program is effective in CIM. (Launching at/after the CIM term is
// fine: programs can be in the catalog before they launch.)
function _pfLaunchBeforeCimTerm(p) {
    const a = _pfTermRank(p.roster_launch_date), b = _pfEffTermRank(p);
    return a != null && b != null && a < b;
}
// #3 SVT launch term falls outside CIM's approved effective catalog year.
// Fall Y -> catalog Y/(Y+1) (start Y); Spring/Summer/Winter Y -> catalog (Y-1)/Y (start Y-1).
function _pfLaunchVsCimCatalog(p) {
    const r = _pfTermRank(p.roster_launch_date);
    if (r == null) return false;
    const m = /Catalog\s+(\d{4})-\d{4}/.exec(p.cim_completion_date || '');
    if (!m) return false;
    const yr = Math.floor(r / 10), implied = (r % 10) >= 3 ? yr : yr - 1;
    return implied !== parseInt(m[1], 10);
}

// Decode a Banner term code (e.g. "202710") to a readable term, per NU's official
// term-code scheme. The leading 4 digits are the year the academic year ENDS, so
// Fall = leading-1 and Winter/Spring/Summer = leading. The 2-digit suffix encodes
// season AND program type: UG/Grad 10/30/40-60; CPS Sem 14/34/54; CPS Qtr
// 15/25/35/55; Law Sem 12/32/52; Law Qtr 18/28/38/58.
const _PF_TERM_SUFFIX = {
    '10':'Fall','12':'Fall','14':'Fall','15':'Fall','18':'Fall',
    '25':'Winter','28':'Winter',
    '30':'Spring','32':'Spring','34':'Spring','35':'Spring','38':'Spring',
    '40':'Summer','50':'Summer','52':'Summer','54':'Summer','55':'Summer','58':'Summer','60':'Summer',
};
function _pfDecodeBannerTerm(code) {
    const c = String(code || '').trim();
    if (!/^\d{6}$/.test(c)) return '';
    const s = _PF_TERM_SUFFIX[c.slice(4)];
    if (!s) return '';
    const lead = parseInt(c.slice(0, 4), 10);
    return `${s} ${s === 'Fall' ? lead - 1 : lead}`;
}
// Comparable rank for a program's CIM effective term (from the Banner code).
function _pfEffTermRank(p) { return _pfTermRank(_pfDecodeBannerTerm(p && p.cim_eff_term)); }
function _pfEffTermLabel(p) {
    const c = (p && p.cim_eff_term) || '';
    if (!c) return '';
    return _pfDecodeBannerTerm(c) || c;   // decoded term only (e.g. "Fall 2027"); raw code only if undecodable
}

const PORTFOLIO_FILTER_FIELDS = [
    {key: 'program',     label: 'Program',          type: 'text',   value: p => p.program_name || ''},
    {key: 'level',       label: 'Level',            type: 'select', value: p => classifyPortfolioLevel(p.program_name) || ''},
    {key: 'credential',  label: 'Credential',       type: 'select', value: p => extractPortfolioDegree(p.program_name) || ''},
    {key: 'college',     label: 'College',          type: 'select', value: p => p.college || ''},
    {key: 'campus',      label: 'Campus',           type: 'select', value: p => p.campus || ''},
    {key: 'in_cim',      label: 'In CIM',           type: 'boolean', value: p => p.cim_program_id ? 'Y' : 'N'},
    {key: 'cim_step',    label: 'CIM Step',         type: 'select', value: p => p.cim_step || ''},
    {key: 'cim_change',  label: 'CIM Change',       type: 'select', value: p => p.cim_change_type || ''},
    {key: 'svt',         label: 'SVT Status',       type: 'select', value: p => p.svt_status || ''},
    {key: 'svt_type',    label: 'SVT Proposal Type', type: 'select', value: p => p.roster_proposal_type || ''},
    {key: 'launch',      label: 'SVT Launch Date',  type: 'select', value: p => p.roster_launch_date || ''},
    {key: 'cimterm',     label: 'CIM Effective Term', type: 'text',  value: p => _pfEffTermLabel(p)},
    {key: 'launch_overdue', label: 'SVT launch overdue',     type: 'boolean', value: p => _pfLaunchOverdue(p) ? 'Y' : 'N'},
    {key: 'launch_vs_gtm',  label: 'SVT launch ≠ GTM intake', type: 'boolean', value: p => _pfLaunchVsGtm(p) ? 'Y' : 'N'},
    {key: 'launch_vs_cim',  label: 'SVT launch ≠ CIM catalog', type: 'boolean', value: p => _pfLaunchVsCimCatalog(p) ? 'Y' : 'N'},
    {key: 'launch_before_cimterm', label: 'SVT launch before CIM term', type: 'boolean', value: p => _pfLaunchBeforeCimTerm(p) ? 'Y' : 'N'},
    {key: 'svt_coord',   label: 'Needs SVT coordination', type: 'boolean', value: p => _svtNeedsCoord(p) ? 'Y' : 'N'},
    {key: 'svtnote',     label: 'SVT coordination note', type: 'text',    value: p => _svtCoordNote(p)},
    {key: 'substatus',   label: 'SVT Sub-status',   type: 'select', value: p => p.roster_sub_status || ''},
    {key: 'speed',       label: 'Speed to Market',  type: 'boolean', value: p => p.speed_to_market === 'True' ? 'Y' : p.speed_to_market === 'False' ? 'N' : ''},
    {key: 'gls',         label: 'GLS Status',       type: 'select', value: p => p.gls_status || ''},
    {key: 'otp',         label: 'OTP Status',       type: 'select', value: p => p.otp_status || ''},
    {key: 'inact_admit', label: 'Inactivation of Admission', type: 'select', value: p => p.inactivation_admission || ''},
    {key: 'admit_today', label: 'Admitting Today',  type: 'boolean', value: p => { const v = _inactAdmittingToday(p); return v === 'Yes' ? 'Y' : v === 'No' ? 'N' : ''; }},
    {key: 'offering',    label: 'New Offering',     type: 'select', value: p => portfolioOfferingLabel(p)},
    {key: 'ready_gtm',   label: 'Ready for GTM',    type: 'boolean', value: p => p.ready_for_gtm === 'Yes' ? 'Y' : 'N'},
    {key: 'gtm_inact',   label: 'GTM Inactivation', type: 'boolean', value: p => p.gtm_inactivation === 'Yes' ? 'Y' : 'N'},
    {key: 'gtm_entered', label: 'GTM Entered Date', type: 'date',   value: p => p.gtm_entered_date || ''},
    {key: 'gtm_type',    label: 'GTM Type',         type: 'select', value: p => p.gtm_type || ''},
    {key: 'gtm_date',    label: 'GTM Date',         type: 'text',   value: p => p.gtm_date || ''},
    {key: 'gtm_first',   label: 'GTM First Intake', type: 'select', value: p => p.gtm_first_term || ''},
    {key: 'gtm_last',    label: 'GTM Last Term',    type: 'select', value: p => p.gtm_last_term || ''},
    {key: 'gtm_intake',  label: 'GTM Intake Terms', type: 'text',   value: p => p.gtm_intake_terms || ''},
    {key: 'exit_masters',label: "Exit master's only", type: 'select', value: p => p.exit_masters || ''},
    {key: 'note',        label: 'Notes',            type: 'text',   value: p => p.note || ''},
];
function _pvField(key) { return PORTFOLIO_FILTER_FIELDS.find(f => f.key === key); }

// Distinct values for a select field (across all portfolio rows), sorted.
function getPortfolioFieldValues(key) {
    const f = _pvField(key);
    if (!f) return [];
    const set = new Set();
    (allPortfolioPrograms || []).forEach(p => set.add(f.value(p)));
    return [...set].sort((a, b) => String(a).localeCompare(String(b)));
}

// Tree model + evaluation
let portfolioFilterTree = null;   // currently-applied advanced filter (or null)
function makeEmptyPvGroup(conj) { return {type: 'group', conj: conj || 'all', children: []}; }

function evalPortfolioNode(p, node) {
    if (!node) return true;
    if (node.type === 'group') {
        const kids = node.children || [];
        if (!kids.length) return true;
        return node.conj === 'any' ? kids.some(c => evalPortfolioNode(p, c))
                                   : kids.every(c => evalPortfolioNode(p, c));
    }
    if (node.type === 'rule') return evalPortfolioRule(p, node);
    return true;
}
function evalPortfolioRule(p, rule) {
    const f = _pvField(rule.field);
    if (!f) return true;
    let v = String(f.value(p) == null ? '' : f.value(p));
    const op = rule.op || '';
    if (op === 'is_set')   return v !== '';
    if (op === 'is_empty') return v === '';
    if (f.type === 'date') {
        const d = v.slice(0, 10);                 // YYYY-MM-DD
        if (!d) return false;
        if (op === 'within_days') {
            const n = parseInt(rule.value, 10);
            if (!(n > 0)) return true;            // no window set yet → don't restrict
            const cutoff = new Date(); cutoff.setHours(0, 0, 0, 0);
            cutoff.setDate(cutoff.getDate() - n);
            const dv = new Date(d + 'T00:00:00');
            return !isNaN(dv) && dv >= cutoff;
        }
        if (op === 'on_after')  return rule.value ? d >= rule.value : true;
        if (op === 'on_before') return rule.value ? d <= rule.value : true;
        return true;
    }
    if (f.type === 'text') {
        if (!rule.value) return true;
        const q = String(rule.value).toLowerCase(), hay = v.toLowerCase();
        if (op === 'equals')      return hay === q;
        if (op === 'starts_with') return hay.startsWith(q);
        return hay.includes(q);   // contains (default)
    }
    // select / boolean (value is an array of allowed tokens)
    const arr = Array.isArray(rule.value) ? rule.value : (rule.value ? [rule.value] : []);
    if (!arr.length) return true;
    const hit = new Set(arr).has(v);
    return op === 'not_in' ? !hit : hit;
}

function _opsForPvType(t) {
    if (t === 'text')    return [['contains','contains'],['equals','equals'],['starts_with','starts with'],['is_set','is set'],['is_empty','is not set']];
    if (t === 'boolean') return [['in','is'],['is_set','is set'],['is_empty','is not set']];
    if (t === 'date')    return [['within_days','in the last … days'],['on_after','on or after'],['on_before','on or before'],['is_set','is set'],['is_empty','is not set']];
    return [['in','is one of'],['not_in','is not one of'],['is_set','is set'],['is_empty','is not set']];
}
function _defaultPvRule(key) {
    const f = _pvField(key) || PORTFOLIO_FILTER_FIELDS[0];
    if (f.type === 'text')    return {type:'rule', field:f.key, op:'contains', value:''};
    if (f.type === 'boolean') return {type:'rule', field:f.key, op:'in', value:['Y']};
    if (f.type === 'date')    return {type:'rule', field:f.key, op:'within_days', value:'30'};
    return {type:'rule', field:f.key, op:'in', value:[]};
}

// Apply a named view: restore column visibility + filters, mark active.
function applyPortfolioView(id) {
    const view = getPortfolioViewById(id);
    if (!view) return;
    portfolioActiveViewId    = id;
    portfolioActiveViewDirty = false;
    try { localStorage.setItem(_PORTFOLIO_ACTIVE_LS, id); } catch(_) {}
    // Column visibility
    const cols = _resolveViewCols(view.state);
    if (cols === null) {
        PORTFOLIO_COLUMNS.forEach(c => portfolioVisibleCols.add(c.key));
    } else {
        portfolioVisibleCols = new Set(cols);
    }
    try { localStorage.setItem('cim-portfolio-cols', JSON.stringify([...portfolioVisibleCols])); } catch(_) {}
    // Top-bar filters
    _applyPortfolioFilters(view.state.filters || {});
    // Advanced filter tree
    portfolioFilterTree = view.state.tree ? JSON.parse(JSON.stringify(view.state.tree)) : null;
    renderPortfolioViewTiles();
    renderPortfolioTable();
}

// ══════════════════════════════════════════════════════════════════════════
// Portfolio Views modal — full filter-tree builder (mirrors student tracker)
// ══════════════════════════════════════════════════════════════════════════
// Sidebar: + New view, Team views (built-in + saved team), My views (personal),
//          each with delete. Clicking a view applies it AND loads it for editing.
// Main:    recursive AND/OR group + rule builder with per-field operators and
//          nested groups; edits apply LIVE so the count + table update as you go.
// Footer:  <selected name> | ☆Star | ↑ | ↓ | Delete | Save as My/Team View |
//          ↻Update (when dirty) | Cancel | Apply. Edits stay in a draft until Apply.
// Header:  live "N programs match".

let _pvDraftTree    = null;  // tree being edited in the modal (NOT applied until Apply)
let _pvLoadedViewId = null;  // the view currently selected/loaded in the editor
let _pvMultiOpen    = null;  // path-string of the open select popup
let _pvSavingScope  = null;  // null | 'personal' | 'team' (Save-as naming mode)
const _PORTFOLIO_STARS_LS = 'cim-portfolio-starred-v1';
// Local Flask = full edit rights (the dean's own machine); static site = read-only.
// Admin = running on the local Flask app (never the static GitHub Pages site).
// Only admins can create / edit / reorder / delete TEAM views. There's no URL
// flag — being on the local app IS the admin credential.
function _pvIsAdmin() {
    return !window._staticMode;
}

// Stars are LOCAL ONLY (per browser) — intentionally not synced to the server
// or the published site. Only the team-view order syncs (it lives in the
// server's portfolio_views.json array and is baked into the export in order).
function getPortfolioStarredIds() {
    try { return new Set(JSON.parse(localStorage.getItem(_PORTFOLIO_STARS_LS) || '[]')); }
    catch (_) { return new Set(); }
}
function setPortfolioStarredIds(set) {
    try { localStorage.setItem(_PORTFOLIO_STARS_LS, JSON.stringify([...set])); } catch (_) {}
}
function togglePortfolioStar(id) {
    const s = getPortfolioStarredIds();
    s.has(id) ? s.delete(id) : s.add(id);
    setPortfolioStarredIds(s);
}

function openPortfolioViewsModal() {
    const bd = document.getElementById('pv-modal-backdrop');
    if (!bd) return;
    // Seed the editor draft from the applied tree (or empty group). Editing the
    // draft does NOT touch the table until the user clicks Apply.
    _pvDraftTree = portfolioFilterTree
        ? JSON.parse(JSON.stringify(portfolioFilterTree))
        : makeEmptyPvGroup('all');
    _pvLoadedViewId = portfolioActiveViewId;
    _pvMultiOpen = null;
    _pvSavingScope = null;
    bd.classList.add('open');
    renderPvModal();
}

function closePortfolioViewsModal() {
    const bd = document.getElementById('pv-modal-backdrop');
    if (bd) bd.classList.remove('open');
    _pvMultiOpen = null;
}

// Re-render the modal (sidebar + editor + footer + live preview count). The
// table is NOT touched here — only Apply commits the draft.
function renderPvModal() {
    _renderPvSidebar();
    _renderPvBuilder();
    _renderPvFooter();
    _renderPvCount();
    renderPortfolioViewTiles();
}

// Preview how many programs the DRAFT tree matches (temporarily swap it in).
function _pvPreviewCount() {
    const saved = portfolioFilterTree;
    portfolioFilterTree = (_pvDraftTree && (_pvDraftTree.children || []).length) ? _pvDraftTree : null;
    let n;
    try { n = getPortfolioFiltered().length; } finally { portfolioFilterTree = saved; }
    return n;
}

function _renderPvCount() {
    const el = document.getElementById('pv-modal-count');
    if (!el) return;
    const n = _pvPreviewCount();
    el.textContent = `${n} program${n === 1 ? '' : 's'} match`;
}

function _renderPvSidebar() {
    const host = document.getElementById('pv-modal-sidebar');
    if (!host) return;
    const personal = getPortfolioPersonalViews();
    const team     = getPortfolioTeamViews();
    const stars    = getPortfolioStarredIds();
    // Clicking a row SELECTS it (loads into the editor). Per-view actions —
    // star, move up/down, delete — appear as hover controls on the row itself.
    // Star is available to everyone; move/delete only for editable views
    // (own personal views, or any team view when admin).
    const item = (v) => {
        const sel    = v.id === _pvLoadedViewId;
        const isStar = stars.has(v.id);
        // The permanent "All Programs" view shows no controls (always present,
        // always a tile, can't be starred/unstarred, moved, or deleted).
        if (v.system) {
            return `<div class="pv-side-item pv-side-system${sel ? ' selected' : ''}" onclick="pvLoadView('${v.id}')">
                <span class="pv-side-name">${escapeHtml(v.name)}</span>
                <span class="pv-side-acts"><span class="pv-side-star on" title="Always shown">★</span></span></div>`;
        }
        // Move/delete (hover-only, editable views) come first; the star is the
        // LAST action so it's pinned to the row's right edge — aligning with the
        // permanent All Programs row's star above.
        const canModify = v.team ? _pvIsAdmin() : true;
        let acts = '';
        if (canModify) {
            acts += `<button class="pv-side-act" title="Move up" onclick="pvMoveById('${v.id}',-1,event)">↑</button>`;
            acts += `<button class="pv-side-act" title="Move down" onclick="pvMoveById('${v.id}',1,event)">↓</button>`;
            acts += `<button class="pv-side-act pv-side-act-del" title="Delete view" onclick="pvDeleteById('${v.id}',event)">✕</button>`;
        }
        acts += `<button class="pv-side-act pv-side-act-star${isStar ? ' on' : ''}" title="${isStar ? 'Unstar' : 'Star — show as a top tile'}" onclick="pvStarById('${v.id}',event)">${isStar ? '★' : '☆'}</button>`;
        return `<div class="pv-side-item${sel ? ' selected' : ''}" onclick="pvLoadView('${v.id}')">
            <span class="pv-side-name">${escapeHtml(v.name)}</span>
            <span class="pv-side-acts">${acts}</span></div>`;
    };
    let html = `<button class="pv-side-newbtn" onclick="pvNewView()">+ New view</button>`;
    html += `<div class="pv-side-section">Team ${_pvIsAdmin() ? '<span class="pv-admin-pill">ADMIN</span>' : ''}</div>`;
    html += item(ALL_PROGRAMS_VIEW);
    html += item(GTM_VIEW);
    html += item(GTM_NEEDS_ACTION_VIEW);
    html += item(GTM_RECENT_VIEW);
    html += team.length ? team.map(item).join('') : '';
    html += `<div class="pv-side-section">Personal</div>`;
    html += personal.length ? personal.map(item).join('') : '<div class="pv-side-empty">None saved yet</div>';
    if (_pvAdminViewsOn()) {
        html += `<div class="pv-side-section">Admin</div>`;
        html += ADMIN_VIEWS.map(item).join('');
    }
    html += `<button class="pv-side-admintoggle${_pvAdminViewsOn() ? ' on' : ''}" onclick="togglePvAdminViews()"
        title="Show/hide administrative data-quality views">⚙ Admin views${_pvAdminViewsOn() ? ' ✓' : ''}</button>`;
    host.innerHTML = html;
}

function _renderPvBuilder() {
    const host = document.getElementById('pv-modal-main');
    if (!host) return;
    host.innerHTML = _renderPvGroup(_pvDraftTree, '');
}

function _renderPvGroup(group, path) {
    const kids = group.children || [];
    const conjSel = `<select class="pv-conj" onchange="pvbSetConj('${path}', this.value)">
        <option value="all"${group.conj === 'all' ? ' selected' : ''}>all</option>
        <option value="any"${group.conj === 'any' ? ' selected' : ''}>any</option>
    </select>`;
    const head = `<div class="pvb-group-head">Match ${conjSel} of the following:
        ${path ? `<button class="pvb-iconbtn" title="Remove group" onclick="pvbRemove('${path}')">✕</button>` : ''}
    </div>`;
    const body = kids.map((c, i) => {
        const childPath = path ? `${path}.${i}` : `${i}`;
        return c.type === 'group'
            ? `<div class="pvb-group">${_renderPvGroup(c, childPath)}</div>`
            : _renderPvRule(c, childPath);
    }).join('');
    const add = `<div class="pvb-add-row">
        <button onclick="pvbAddRule('${path}')">+ Add rule</button>
        <button onclick="pvbAddGroup('${path}')">⊕ Add nested group</button>
    </div>`;
    return head + body + add;
}

function _renderPvRule(rule, path) {
    const f = _pvField(rule.field) || PORTFOLIO_FILTER_FIELDS[0];
    const fieldSel = `<select onchange="pvbSetField('${path}', this.value)">${
        PORTFOLIO_FILTER_FIELDS.map(x => `<option value="${x.key}"${x.key === rule.field ? ' selected' : ''}>${escapeHtml(x.label)}</option>`).join('')
    }</select>`;
    const opSel = `<select onchange="pvbSetOp('${path}', this.value)">${
        _opsForPvType(f.type).map(([op, lbl]) => `<option value="${op}"${op === rule.op ? ' selected' : ''}>${lbl}</option>`).join('')
    }</select>`;
    return `<div class="pvb-rule">${fieldSel}${opSel}${_renderPvRuleValue(rule, f, path)}
        <button class="pvb-iconbtn" title="Remove rule" onclick="pvbRemove('${path}')">✕</button></div>`;
}

function _renderPvRuleValue(rule, f, path) {
    if (rule.op === 'is_set' || rule.op === 'is_empty') return '';
    if (f.type === 'text') {
        return `<input type="text" class="pvb-text" value="${escapeHtml(rule.value || '')}"
                 oninput="pvbSetValue('${path}', this.value)" placeholder="search…">`;
    }
    if (f.type === 'date') {
        if (rule.op === 'within_days') {
            return `<input type="number" min="1" class="pvb-text" style="width:72px" value="${escapeHtml(rule.value || '')}"
                     oninput="pvbSetValue('${path}', this.value)" placeholder="days"> days`;
        }
        return `<input type="date" class="pvb-text" value="${escapeHtml(rule.value || '')}"
                 oninput="pvbSetValue('${path}', this.value)">`;
    }
    if (f.type === 'boolean') {
        const vals = Array.isArray(rule.value) ? rule.value : (rule.value ? [rule.value] : []);
        return `<label class="pvb-bool"><input type="checkbox" ${vals.includes('Y') ? 'checked' : ''} onchange="pvbToggleMulti('${path}','Y')"> Yes</label>
                <label class="pvb-bool"><input type="checkbox" ${vals.includes('N') ? 'checked' : ''} onchange="pvbToggleMulti('${path}','N')"> No</label>`;
    }
    // select — chips + popup
    const vals = Array.isArray(rule.value) ? rule.value : [];
    const chips = vals.length
        ? vals.map(v => `<span class="pvb-chip">${escapeHtml(v || '(blank)')}</span>`).join('')
        : '<span class="pvb-values-empty">choose values…</span>';
    let pop = '';
    if (_pvMultiOpen === path) {
        const all = getPortfolioFieldValues(rule.field);
        pop = `<div class="pvb-multi-pop" onclick="event.stopPropagation()">${
            all.map(v => `<label><input type="checkbox" ${vals.includes(v) ? 'checked' : ''}
                 onchange="pvbToggleMulti('${path}', '${_escJsPv(v)}')"> ${escapeHtml(v || '(blank)')}</label>`).join('')
        }</div>`;
    }
    return `<span class="pvb-valwrap"><span class="pvb-values" onclick="pvbOpenMulti('${path}', event)">${chips}</span>${pop}</span>`;
}

function _escJsPv(s) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

function _renderPvFooter() {
    const host = document.getElementById('pv-modal-footer');
    if (!host) return;

    // ── Save-as naming mode takes over the footer ──────────────────────────
    if (_pvSavingScope) {
        host.innerHTML = `<span class="pv-save-form">
            <input id="pv-name-input" class="pv-name-input" type="text" maxlength="60" placeholder="Name this view…"
                   onkeydown="if(event.key==='Enter')pvConfirmSave();else if(event.key==='Escape')pvCancelSave()">
            <button class="pv-btn pv-btn-primary" onclick="pvConfirmSave()">Save ${_pvSavingScope === 'team' ? 'as Team View' : 'as My View'}</button>
            <button class="pv-btn pv-btn-ghost" onclick="pvCancelSave()">Cancel</button></span>`;
        setTimeout(() => document.getElementById('pv-name-input')?.focus(), 30);
        return;
    }

    const loaded   = _pvLoadedViewId ? getPortfolioViewById(_pvLoadedViewId) : null;
    // Team views are editable only by admins; personal views are always
    // editable by their owner. Drives ↑/↓/Delete/Update.
    const canEdit  = loaded && !loaded.system && (loaded.team ? _pvIsAdmin() : true);
    const starred  = loaded && getPortfolioStarredIds().has(loaded.id);
    // "Dirty" reflects ANY difference from the saved view — filter tree, the
    // visible columns, or the top-bar filters — so the dot shows when only
    // columns changed. (Update is always offered for editable views regardless.)
    const draftJson = JSON.stringify((_pvDraftTree && (_pvDraftTree.children || []).length) ? _pvDraftTree : null);
    const savedJson = loaded ? JSON.stringify((loaded.state && loaded.state.tree) || null) : null;
    let dirty = false;
    if (loaded) {
        const treeDirty = draftJson !== savedJson;
        const curCols  = [...portfolioVisibleCols].sort();
        const viewCols = (_resolveViewCols(loaded.state) || PORTFOLIO_COLUMNS.map(c => c.key)).slice().sort();
        const colsDirty = JSON.stringify(curCols) !== JSON.stringify(viewCols);
        const filtersDirty = !_snapshotEq(_snapshotPortfolioFilters(), (loaded.state && loaded.state.filters) || {});
        dirty = treeDirty || colsDirty || filtersDirty;
    }

    // Cancel sits at the far left. Per-view actions (star/move/delete) now live
    // as hover controls on each sidebar row, so the footer only holds the
    // save / apply actions.
    // "Close" (not "Cancel") — it just closes the window; it does not undo
    // star/move/delete/save/update, which take effect immediately when clicked.
    const left = `<button class="pv-btn pv-btn-ghost" onclick="closePortfolioViewsModal()">Close</button>`;

    let acts = '';
    acts += `<button class="pv-btn pv-btn-ghost" onclick="pvStartSave('personal')" title="Save as a new personal view">Save as My View</button>`;
    if (_pvIsAdmin()) acts += `<button class="pv-btn pv-btn-ghost" onclick="pvStartSave('team')" title="Save as a new team view">Save as Team View</button>`;
    // Update is offered for any editable view (not just when "dirty") so the
    // current columns + top-bar filters can be saved even if the tree is unchanged.
    if (canEdit) acts += `<button class="pv-btn pv-btn-ghost" onclick="pvUpdateLoaded()" title="Save current columns, filters & rules to this view">↻ Update</button>`;
    acts += `<button class="pv-btn pv-btn-primary" onclick="pvApplyDraft()" title="Apply to the table">Apply</button>`;

    host.innerHTML = `${left}<span style="flex:1"></span><span class="pv-footer-actions">${acts}</span>`;
}

// Commit whatever's in the editor to the table, then close. When a saved view
// is loaded, first restore that view's columns + top-bar filters, then override
// its tree with the (possibly edited) draft.
function pvApplyDraft() {
    if (_pvLoadedViewId && getPortfolioViewById(_pvLoadedViewId)) {
        applyPortfolioView(_pvLoadedViewId);   // restores cols + top-bar + tree + active id
    } else {
        portfolioActiveViewId = null;
        try { localStorage.setItem(_PORTFOLIO_ACTIVE_LS, ''); } catch (_) {}
    }
    portfolioFilterTree = (_pvDraftTree && (_pvDraftTree.children || []).length)
        ? JSON.parse(JSON.stringify(_pvDraftTree)) : null;
    closePortfolioViewsModal();
    renderPortfolioViewTiles();
    renderPortfolioTable();
}

// Footer actions on the selected view.
// Per-view hover-control handlers (operate on the given view id, not the
// loaded one). Each stops propagation so it doesn't also select the row.
function pvStarById(id, ev) {
    if (ev) ev.stopPropagation();
    if (id === 'all') return;            // permanent view — always shown, can't toggle
    togglePortfolioStar(id);
    renderPvModal();
}
function pvDeleteById(id, ev) {
    if (ev) ev.stopPropagation();
    if (id === 'all') return;            // permanent view — can't delete
    pvDeleteView(id);
}
function pvMoveById(id, dir, ev) {
    if (ev) ev.stopPropagation();
    if (id === 'all') return;            // permanent view — fixed position
    const view = getPortfolioViewById(id); if (!view) return;
    if (view.team) {
        if (!_pvIsAdmin()) return;
        const arr = portfolioTeamViews, i = arr.findIndex(v => v.id === id), j = i + dir;
        if (i < 0 || j < 0 || j >= arr.length) return;
        [arr[i], arr[j]] = [arr[j], arr[i]];
        _persistTeamViews('reorder', id);
    } else {
        const arr = getPortfolioPersonalViews(), i = arr.findIndex(v => v.id === id), j = i + dir;
        if (i < 0 || j < 0 || j >= arr.length) return;
        [arr[i], arr[j]] = [arr[j], arr[i]];
        setPortfolioPersonalViews(arr);
    }
    renderPvModal();
}

// ── Tree mutators (path = child indices like "0.2.1"; "" = root) ──────────────
function _pvWalk(path) {
    if (!_pvDraftTree) return null;
    if (!path) return {node: _pvDraftTree, parent: null, index: -1};
    const parts = path.split('.').map(n => parseInt(n, 10));
    let node = _pvDraftTree, parent = null, idx = -1;
    for (const i of parts) {
        if (!node || node.type !== 'group') return null;
        parent = node; idx = i; node = (node.children || [])[i];
    }
    return {node, parent, index: idx};
}
function pvbAddRule(path)  { const w = _pvWalk(path); if (w && w.node.type === 'group') { w.node.children.push(_defaultPvRule(PORTFOLIO_FILTER_FIELDS[0].key)); renderPvModal(); } }
function pvbAddGroup(path) { const w = _pvWalk(path); if (w && w.node.type === 'group') { w.node.children.push(makeEmptyPvGroup(w.node.conj === 'all' ? 'any' : 'all')); renderPvModal(); } }
function pvbRemove(path)   { const w = _pvWalk(path); if (w && w.parent) { w.parent.children.splice(w.index, 1); renderPvModal(); } }
function pvbSetConj(path, conj) { const w = _pvWalk(path); if (w && w.node.type === 'group') { w.node.conj = conj === 'any' ? 'any' : 'all'; renderPvModal(); } }
function pvbSetField(path, key) { const w = _pvWalk(path); if (w && w.node.type === 'rule' && w.node.field !== key) { Object.assign(w.node, _defaultPvRule(key)); renderPvModal(); } }
function pvbSetOp(path, op)      { const w = _pvWalk(path); if (w && w.node.type === 'rule') { w.node.op = op; const t = (_pvField(w.node.field) || {}).type; if (op === 'is_set' || op === 'is_empty') w.node.value = null; else if (t === 'date') w.node.value = (op === 'within_days') ? '30' : ''; else if (!w.node.value || (Array.isArray(w.node.value) && !w.node.value.length)) w.node.value = (t === 'text') ? '' : []; renderPvModal(); } }
// Text-input edits: update the model + live count ONLY. Do NOT re-render the
// builder — rebuilding the DOM would destroy the <input> and drop focus after
// each keystroke. The input already holds the value visually.
function pvbSetValue(path, val) { const w = _pvWalk(path); if (w && w.node.type === 'rule') { w.node.value = val; _renderPvCount(); } }
function pvbToggleMulti(path, v) { const w = _pvWalk(path); if (w && w.node.type === 'rule') { const a = Array.isArray(w.node.value) ? w.node.value.slice() : []; const i = a.indexOf(v); i === -1 ? a.push(v) : a.splice(i, 1); w.node.value = a; renderPvModal(); } }
function pvbOpenMulti(path, ev) { ev && ev.stopPropagation(); _pvMultiOpen = (_pvMultiOpen === path ? null : path); _renderPvBuilder(); }
document.addEventListener('click', e => {
    if (!_pvMultiOpen) return;
    if (!e.target.closest('.pvb-multi-pop') && !e.target.closest('.pvb-values')) { _pvMultiOpen = null; _renderPvBuilder(); }
});

function pvNewView() { _pvDraftTree = makeEmptyPvGroup('all'); _pvLoadedViewId = null; _pvSavingScope = null; renderPvModal(); }

// Click a sidebar view → SELECT it (load its tree into the editor). Does not
// touch the table until Apply.
function pvLoadView(id) {
    const view = getPortfolioViewById(id);
    if (!view) return;
    _pvDraftTree = (view.state && view.state.tree)
        ? JSON.parse(JSON.stringify(view.state.tree))
        : makeEmptyPvGroup('all');
    _pvLoadedViewId = id;
    _pvSavingScope = null;
    _pvMultiOpen = null;
    renderPvModal();
}

function pvDeleteView(id, ev) {
    ev && ev.stopPropagation();
    if (id.startsWith('team_')) {
        portfolioTeamViews = portfolioTeamViews.filter(v => v.id !== id);
        _persistTeamViews('delete', id);
    } else {
        setPortfolioPersonalViews(getPortfolioPersonalViews().filter(v => v.id !== id));
    }
    if (portfolioActiveViewId === id) { portfolioActiveViewId = null; }
    if (_pvLoadedViewId === id) { _pvLoadedViewId = null; }
    renderPvModal();
}

function pvStartSave(scope) { _pvSavingScope = scope; _renderPvFooter(); }
function pvCancelSave()     { _pvSavingScope = null;  _renderPvFooter(); }

function pvConfirmSave() {
    const inp = document.getElementById('pv-name-input');
    const name = (inp && inp.value || '').trim();
    if (!name) { inp && inp.focus(); return; }
    const scope = _pvSavingScope || 'personal';
    const state = {
        visibleCols: [...portfolioVisibleCols],
        filters: _snapshotPortfolioFilters(),
        tree: (_pvDraftTree && (_pvDraftTree.children || []).length) ? JSON.parse(JSON.stringify(_pvDraftTree)) : null,
    };
    let id;
    if (scope === 'team') {
        id = 'team_' + Date.now();
        portfolioTeamViews.push({id, name, team: true, state});
        _persistTeamViews('save', id);
    } else {
        id = 'personal_' + Date.now();
        const views = getPortfolioPersonalViews();
        views.push({id, name, team: false, state});
        setPortfolioPersonalViews(views);
    }
    _pvLoadedViewId = id;
    _pvSavingScope = null;
    pvApplyDraft();   // save + apply + close (mirrors student tracker)
}

function pvUpdateLoaded() {
    const id = _pvLoadedViewId;
    if (!id) return;
    const state = {
        visibleCols: [...portfolioVisibleCols],
        filters: _snapshotPortfolioFilters(),
        tree: (_pvDraftTree && (_pvDraftTree.children || []).length) ? JSON.parse(JSON.stringify(_pvDraftTree)) : null,
    };
    if (id.startsWith('team_')) {
        const v = portfolioTeamViews.find(x => x.id === id);
        if (v) { v.state = state; _persistTeamViews('save', id); }
    } else {
        const views = getPortfolioPersonalViews();
        const v = views.find(x => x.id === id);
        if (v) { v.state = state; setPortfolioPersonalViews(views); }
    }
    pvApplyDraft();   // save changes + apply + close
}

// Team views: in-memory list, hydrated from the API (local) or baked data
// (static). Personal stays in localStorage. (declared near portfolioActiveViewId)
function getPortfolioTeamViews() { return portfolioTeamViews; }

// Hydrate team views: from the baked payload on the static site, otherwise
// from the /api/portfolio/views endpoint (local Flask).
async function _hydratePortfolioTeamViews(portfolioPayload) {
    try {
        if (window._staticMode) {
            portfolioTeamViews = (portfolioPayload && portfolioPayload.team_views) || window._portfolioTeamViews || [];
            return;
        }
        const r = await fetch('/api/portfolio/views');
        if (r.ok) { const d = await r.json(); portfolioTeamViews = d.views || []; }
    } catch (e) { portfolioTeamViews = portfolioTeamViews || []; }
}
async function _persistTeamViews(action, id) {
    if (window._staticMode) return;   // no backend on the static site
    try {
        await fetch('/api/portfolio/views', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({action, id, views: portfolioTeamViews}),
        });
    } catch (e) { console.error('team view persist failed', e); }
}

// No-op left for the filter-change hooks (top-bar edits no longer mark a view
// dirty now that views are managed in the modal builder).
function _portfolioViewTouch() {}

// Update the Views button label + render the starred-view tile bar.
function renderPortfolioViewTiles() {
    // Views button — always "★ Views" (active view shown by the highlighted
    // tile, not the button text), plus an ADMIN pill when ?admin=1 is set.
    const btn = document.getElementById('portfolio-views-btn');
    if (btn) {
        btn.innerHTML = '★ Views' + (_pvIsAdmin() ? ' <span class="pv-admin-pill">ADMIN</span>' : '');
    }

    const bar = document.getElementById('portfolio-view-tiles');
    if (!bar) return;
    if (currentView !== 'portfolio') { bar.style.display = 'none'; return; }

    const stars   = getPortfolioStarredIds();
    // The permanent "All Programs" view is always first; then starred team/
    // personal views. The bar is therefore always visible.
    const starredViews = [...getPortfolioTeamViews(), ...getPortfolioPersonalViews()]
                            .filter(v => stars.has(v.id));
    const tileViews = [ALL_PROGRAMS_VIEW, GTM_VIEW, GTM_NEEDS_ACTION_VIEW, GTM_RECENT_VIEW,
        ...(_pvAdminViewsOn() ? ADMIN_VIEWS : []), ...starredViews];
    bar.style.display = 'flex';

    // Count of TOP-LEVEL programs matching a view's saved tree + filters — same
    // number the table header shows. Swaps the filter globals in place (never
    // calls applyPortfolioView, which would re-render the tiles and recurse).
    function countForView(v) {
        try {
            const savedTree = portfolioFilterTree;
            const savedSnap = _snapshotPortfolioFilters();
            _applyPortfolioFilters((v && v.state && v.state.filters) || {});
            portfolioFilterTree = (v && v.state && v.state.tree) ? v.state.tree : null;
            const n = _portfolioTopLevelCount(getPortfolioFiltered());
            _applyPortfolioFilters(savedSnap);     // restore filter globals + UI
            portfolioFilterTree = savedTree;
            return n;
        } catch(_) { return '—'; }
    }

    bar.innerHTML = tileViews.map(v => {
        const cnt = countForView(v);
        const active = (v.id === 'all')
            ? (!portfolioActiveViewId || portfolioActiveViewId === 'all')
            : (v.id === portfolioActiveViewId);
        const tipHtml = v.tip
            ? `<span class="info-tip" onclick="event.stopPropagation()"><i class="tip-icon">i</i><span class="tip-bubble">${escapeHtml(v.tip)}</span></span>`
            : '';
        return `<button class="pv-tile${active ? ' active' : ''}"
            onclick="applyPortfolioView('${v.id}'); renderPortfolioTable();"
            title="${escapeHtml(v.name)}">
            <span class="pv-tile-count">${typeof cnt === 'number' ? cnt.toLocaleString() : cnt}</span>
            <span class="pv-tile-label">${escapeHtml(v.name)}${tipHtml}</span>
        </button>`;
    }).join('');
}

// Back-compat aliases
function saveCurrentAsPortfolioView() { openPortfolioViewsModal(); }
function deletePortfolioView(id)      { pvDeleteView(id); }

let allPortfolioPrograms   = [];
let portfolioExpandedIds   = new Set();
// IDs the user has explicitly collapsed. Used to override a search-driven
// auto-expand: if the user clicks a chevron on an auto-expanded row, the
// row should collapse even though `autoExpand` still wants it open.
let portfolioCollapsedIds  = new Set();
// Snapshot of the autoExpand set computed during the last renderPortfolio
// render, so the toggle handler (outside the render closure) can see it.
let _portfolioAutoExpand   = new Set();
let portfolioCollegeFilter   = new Set();
let portfolioCampusFilter    = new Set();

// Shortcut: clear the Campus multi-select and set it to just "Boston".
// If Boston is already the sole active value, toggle it off (clear).
function setPortfolioCampusBoston() {
    const s = portfolioCampusFilter;
    const onlyBoston = (s.size === 1 && s.has('Boston'));
    s.clear();
    if (!onlyBoston) s.add('Boston');
    _updateMultiFilterBtn('portfolio-filter-campus', s);
    updateClearButtons();
    renderPortfolioTable();
}
if (typeof window !== 'undefined') window.setPortfolioCampusBoston = setPortfolioCampusBoston;
let portfolioOtpFilter       = new Set();
let portfolioIpdFilter       = new Set();
let portfolioRosterFilter    = new Set();  // SVT Status filter (legacy id)
let portfolioSubStatusFilter = new Set();  // SVT Sub-status (Launch Sub-Status)
let portfolioSpeedFilter     = new Set();  // Speed to Market
let portfolioGlsFilter       = new Set();
let portfolioCimFilter       = new Set();
let portfolioCimChangeFilter  = new Set();
let portfolioInWorkflowFilter = new Set();

// Toggle-button bridges to the existing multi-select filter Sets. The
// dropdowns and the buttons share the same Set, so changing one updates
// the other on the next render. Button visual state synced via
// _syncPortfolioButtonRows().
function setPortfolioInCim(btn, val) {
    const s = portfolioInWorkflowFilter;
    if (s.has(val)) s.delete(val); else s.add(val);
    _updateMultiFilterBtn('portfolio-filter-inworkflow', s);
    _syncPortfolioButtonRows();
    updateClearButtons();
    _portfolioViewTouch();
    renderPortfolioTable();
}
function setPortfolioCimChange(btn, val) {
    const s = portfolioCimChangeFilter;
    if (s.has(val)) s.delete(val); else s.add(val);
    _updateMultiFilterBtn('portfolio-filter-cimchange', s);
    _syncPortfolioButtonRows();
    updateClearButtons();
    _portfolioViewTouch();
    renderPortfolioTable();
}
function _syncPortfolioButtonRows() {
    document.querySelectorAll('.portfolio-incim-btn').forEach(b => {
        b.classList.toggle('active', portfolioInWorkflowFilter.has(b.dataset.incim));
    });
    document.querySelectorAll('.portfolio-cimchg-btn').forEach(b => {
        b.classList.toggle('active', portfolioCimChangeFilter.has(b.dataset.cimchg));
    });
}
if (typeof window !== 'undefined') {
    window.setPortfolioInCim       = setPortfolioInCim;
    window.setPortfolioCimChange   = setPortfolioCimChange;
}
let portfolioInactAdmitFilter = new Set();
let portfolioInactTodayFilter = '';

// "Fall 2026" → Date object for Sep 1 of that year (approximate start of Fall semester).
function _semesterToDate(s) {
    if (!s) return null;
    const m = s.match(/^(Fall|Spring|Summer)\s+(\d{4})$/i);
    if (!m) return null;
    const year = parseInt(m[2], 10);
    const month = /fall/i.test(m[1]) ? 8 : /spring/i.test(m[1]) ? 0 : 5; // Sep=8, Jan=0, Jun=5
    return new Date(year, month, 1);
}

// Returns 'Yes' if the program is still admitting today, 'No' if admission has closed,
// or '' if there is no inactivation admission date.
function _inactAdmittingToday(p) {
    if (!p.inactivation_admission) return '';
    const cutoff = _semesterToDate(p.inactivation_admission);
    if (!cutoff) return '';
    return cutoff > new Date() ? 'Yes' : 'No';
}

// A program is only "Inactive" once its inactivation workflow has fully completed.
// While an inactivation proposal is still moving through CIM (cim_step is set),
// the program is still running (teach-out phase) and should show as "Active".
// Multi-select sets for the Portfolio button-row filters. Each Set
// holds the currently-active values; clicking a button toggles its
// value in the set, and the row's filter is OR'd across the set.
let portfolioLevelFilter   = new Set();   // 'Undergraduate', 'Graduate'
let portfolioStatusFilter  = new Set();   // 'inworkflow', 'catalog'
let portfolioDegreeFilter  = new Set();   // "Bachelor's", "Master's", ...

function setPortfolioStatus(val) {
    if (portfolioStatusFilter.has(val)) portfolioStatusFilter.delete(val);
    else portfolioStatusFilter.add(val);
    document.querySelectorAll('.portfolio-status-btn').forEach(b =>
        b.classList.toggle('active', portfolioStatusFilter.has(b.dataset.status)));
    _portfolioViewTouch();
    renderPortfolioTable();
}
if (typeof window !== 'undefined') window.setPortfolioStatus = setPortfolioStatus;
let portfolioSortKey = '';   // '' = default (college/name), or a PORTFOLIO_COLUMNS key or 'name'
let portfolioSortDir = 1;    // 1 = asc, -1 = desc
let portfolioSearch        = '';

// Inline `oninput`/`onclick` event handlers cannot assign to `let`-scoped
// script variables (they run in a wrapped scope that ends up creating a
// `window.portfolioSearch` property instead). This function bridges the
// gap — handlers call it, and it writes to the actual script-scope binding
// that getPortfolioFiltered() reads.
function setPortfolioSearch(v) {
    portfolioSearch = v || '';
    const hdr = document.getElementById('filter-search');
    if (hdr && hdr.value !== portfolioSearch) hdr.value = portfolioSearch;
    if (typeof updateClearButtons === 'function') updateClearButtons();
    _portfolioViewTouch();
    if (typeof renderPortfolioTable === 'function') renderPortfolioTable();
}
// Belt-and-suspenders: explicit window-level export so inline handlers
// always resolve setPortfolioSearch regardless of script-scope nuances.
if (typeof window !== 'undefined') window.setPortfolioSearch = setPortfolioSearch;

function classifyPortfolioLevel(name) {
    const n = name || '';
    if (/\b(MS|MA|MBA|MFA|MPS|MPA|MPP|MPH|MEd|MArch|MDes|MSCS|MSIS|MSOR|MSFMBA|MSEnvE|MSSBS|DNP|DPT|DMSC|EdD|PhD|LLM|JD|CERTG)\b/.test(n) ||
        /\b(Master|Doctor|Graduate)\b/i.test(n)) return 'Graduate';
    if (/\b(BS|BA|BFA|BArch|BSN|BSBA|BSCF)\b/.test(n) ||
        /\b(Bachelor|Undergrad|Minor)\b/i.test(n)) return 'Undergraduate';
    return null;
}

// Credential = the academic award the program leads to (BS, MS, PhD, CAGS,
// Graduate Certificate, etc.). Field on the Portfolio used to be called
// "Degree"; it is now displayed as "Credential" everywhere but the internal
// key stays 'degree' so column-visibility localStorage entries continue to work.

// _CRED_SETS group every known degree abbreviation into one of the
// dashboard's filter buckets. Used by both extract (per-row label) and
// classify (filter-button match).
const _CRED_SETS = {
    "Bachelor's":    new Set(['BS','BA','BFA','BARCH','BSN','BSBA','BSCF','BACS','BSCS','BSCE','BSCHE','BSCMPE','BSIE','BSME','BSIS','AA']),
    "Master's":      new Set(['MS','MA','MBA','MFA','MPS','MPA','MPP','MPH','MED','MARCH','MDES','MSCS','MSIS','MSOR','MSCP','MSML','MSBA','MENG','MSJ','MSW','MAT','MSCIVE','MSECE','MSCH E','MSFMBA','MSENVE','MSSBS','LLM']),
    "PhD":           new Set(['PHD','PH.D']),
    "Prof Doctorate":new Set(['DNP','DPT','DPS','DLP','EDD','DMSC','PHARMD','JD','JSSD','LLM']),
    "CAGS":          new Set(['CAGS']),
    "Certificate":   new Set(['CERTG','CERTU','CERTP','CERT']),
    "Minor":         new Set(['MINOR']),
};

function _credentialFromCode(rawIn) {
    const raw = (rawIn || '').toUpperCase().replace(/\./g, '');
    if (_CRED_SETS["CAGS"].has(raw))           return 'CAGS';
    if (_CRED_SETS["PhD"].has(raw))            return 'PhD';
    if (_CRED_SETS["Prof Doctorate"].has(raw)) return 'Prof Doctorate';
    if (_CRED_SETS["Minor"].has(raw))          return 'Minor';
    if (_CRED_SETS["Master's"].has(raw))       return "Master's";
    if (_CRED_SETS["Bachelor's"].has(raw))     return "Bachelor's";
    if (_CRED_SETS["Certificate"].has(raw) || raw.startsWith('CERT')) return 'Certificate';
    // Heuristic fallbacks for unknown but pattern-consistent codes.
    // Reject English words that happen to start with M/B (Minor, Major,
    // Bachelor when bare, etc.) — they're not degree codes.
    if (raw === 'MINOR' || raw === 'MAJOR' || raw === 'BACHELOR' || raw === 'MASTER' || raw === 'MASTERS') return '';
    if (raw.startsWith('M') && raw.length >= 2 && raw.length <= 10) return "Master's";
    if (raw.startsWith('B') && raw.length >= 2 && raw.length <= 10) return "Bachelor's";
    return '';
}

function extractPortfolioDegree(name) {
    // Strip campus parentheticals.  DO NOT strip em-dash here because many
    // legitimate CIM names use em-dash mid-string (e.g.
    // "Nursing—Adult-Gerontology Nurse Practitioner, Acute Care, MS").
    // Em-dash deployment suffixes ("MSCS—Align") are handled later when
    // matching the trailing degree code.
    const n = (name || '').replace(/\s*\([^)]*\)\s*/g, '').trim();
    // 1) Multi-word phrases (most specific first)
    if (/\bCertificate of Advanced Graduate Study|\bCAGS\b/i.test(n)) return 'CAGS';
    if (/\b(Graduate\s+Certificate|CERTG|Undergraduate\s+Certificate|Certificate)\b/i.test(n)) return 'Certificate';
    if (/\bMaster\s+of\s+(Science|Arts|Public\s+Health|Public\s+Administration|Public\s+Policy|Fine\s+Arts|Education|Architecture|Design|Business\s+Administration|Professional\s+Studies)\b/i.test(n)) return "Master's";
    if (/\bMasters?\s+(of|in)\b|\bMastes\s+of\b/i.test(n)) return "Master's";
    if (/\bBachelor\s+of\b|\bBachelors?\b/i.test(n)) return "Bachelor's";
    if (/\bDoctor\s+of\s+Philosophy\b/i.test(n)) return 'PhD';
    if (/\bDoctor\s+of\b/i.test(n))              return 'Prof Doctorate';
    if (/\bDoctorate\b/i.test(n))                return 'Prof Doctorate';
    // 2) Degree code AFTER last comma — primary CIM convention.
    // Allow optional em-dash/hyphen deployment suffix (Align / Connect /
    // Post-Master's / Bridge—Online / etc.).
    const m = n.match(/,\s*([A-Za-z][A-Za-z0-9\.]{0,9})\s*(?:[—\-]\s*[A-Za-z][A-Za-z\-'’ ]*)*\s*$/);
    if (m) {
        const out = _credentialFromCode(m[1]);
        if (out) return out;
    }
    // 2b) Slash-joined dual codes: ", MS/MBA" → Master's
    const md = n.match(/,\s*([A-Z]{2,6})\s*\/\s*([A-Z]{2,6})\s*$/);
    if (md) {
        const a = _credentialFromCode(md[1]);
        const b = _credentialFromCode(md[2]);
        if (a || b) return 'Dual Degree';
    }
    // 2c) Hyphen-joined codes: "RN-to-BSN" → Bachelor's; capture the last code
    const mh = n.match(/[\s,\-]([A-Z]{2,6})(?:\s*$)/);
    if (mh) {
        const out = _credentialFromCode(mh[1]);
        if (out) return out;
    }
    // 2d) Comma-degree followed by "with"/"—"/"/" extras:
    // "Marine Biology, BS with Three Seas", "Management, MS with Major in …",
    // "Finance, MSF—Evening / Part-Time Program"
    const mw = n.match(/,\s*([A-Z]{2,6})\b/);
    if (mw) {
        const out = _credentialFromCode(mw[1]);
        if (out) return out;
    }
    // 3) Degree code at START of name (external feeds: "MS Genetic Counseling", "LLM International Law")
    const m2 = n.match(/^\s*(LLM|MS|MA|MBA|MFA|MPS|MPA|MPP|MPH|MEd|MArch|MDes|MSCS|MSIS|MSOR|MSCP|MSML|MSBA|MEng|MSW|MAT|BS|BA|BFA|BSN|BArch|PhD|EdD|DNP|DPT|JD|CAGS|CERTG|Cert)\b/i);
    if (m2) {
        const out = _credentialFromCode(m2[1]);
        if (out) return out;
    }
    // 4) Other word patterns
    if (/\bMinor\b/i.test(n))         return 'Minor';
    if (/\bConcentration\b/i.test(n)) return 'Concentration';
    if (/\bPlusOne\b|4\+1/i.test(n))  return "Master's";
    return '';
}

function classifyPortfolioDegree(name) {
    // Same logic as extract, so the filter button matches the column value
    // exactly. Dual-Degree detection added as an override.
    const n = name || '';
    if (/\bDual.?Degree\b/i.test(n) ||
        /\b(MS|MPH|MA|MBA|PharmD)\b.{1,20}&.{1,20}\b(MS|MPH|MA|MBA|PharmD|DNP)\b/.test(n)) return 'Dual Degree';
    return extractPortfolioDegree(name) || null;
}

function setPortfolioLevel(btn, val) {
    if (portfolioLevelFilter.has(val)) portfolioLevelFilter.delete(val);
    else portfolioLevelFilter.add(val);
    document.querySelectorAll('.portfolio-lvl-btn').forEach(b =>
        b.classList.toggle('active', portfolioLevelFilter.has(b.dataset.lvl)));
    _portfolioViewTouch();
    renderPortfolioTable();
}

function setPortfolioDegree(btn, val) {
    if (portfolioDegreeFilter.has(val)) portfolioDegreeFilter.delete(val);
    else portfolioDegreeFilter.add(val);
    document.querySelectorAll('.portfolio-deg-btn').forEach(b =>
        b.classList.toggle('active', portfolioDegreeFilter.has(b.dataset.deg)));
    _portfolioViewTouch();
    renderPortfolioTable();
}

function sortPortfolioBy(key) {
    if (portfolioSortKey === key) {
        portfolioSortDir *= -1;
    } else {
        portfolioSortKey = key;
        portfolioSortDir = 1;
    }
    renderPortfolioTable();
}

function togglePortfolioConcentrations(id) {
    // Flip current effective state (which may come from autoExpand, not
    // just portfolioExpandedIds). Maintain a parallel collapsed-set so a
    // user-collapsed-during-search row stays collapsed.
    const wasExpanded = (portfolioExpandedIds.has(id) || _portfolioAutoExpand.has(id))
        && !portfolioCollapsedIds.has(id);
    if (wasExpanded) {
        portfolioExpandedIds.delete(id);
        portfolioCollapsedIds.add(id);
    } else {
        portfolioExpandedIds.add(id);
        portfolioCollapsedIds.delete(id);
    }
    renderPortfolioTable();
}

async function loadPortfolioDashboard() {
    const container = document.getElementById('programs-table-container');
    // On a periodic refresh (data already loaded) we must NOT reset the view the
    // user is looking at — snapshot the current applied view + filter tree +
    // top-bar filters and restore them after reloading, instead of re-deriving
    // from localStorage (which would drop an unsaved/ad-hoc filter).
    const isRefresh   = (allPortfolioPrograms && allPortfolioPrograms.length > 0);
    const _prevActive = portfolioActiveViewId;
    const _prevTree   = portfolioFilterTree ? JSON.parse(JSON.stringify(portfolioFilterTree)) : null;
    const _prevFilters = _snapshotPortfolioFilters();
    if (container && !isRefresh) container.innerHTML = '';
    try {
        const [res] = await Promise.all([
            fetch('/api/portfolio'),
            loadScanStatus(),
        ]);
        const pj = await res.json();
        allPortfolioPrograms = pj.programs || [];
        allPortfolioPrograms.forEach(p => {
            p.concentrations = p.concentrations_json ? JSON.parse(p.concentrations_json) : [];
        });
        await _hydratePortfolioTeamViews(pj);
        portfolioExpandedIds = new Set();
        portfolioCollapsedIds = new Set();
        populatePortfolioFilters();
        if (isRefresh) {
            // Restore exactly what was on screen before the refresh.
            portfolioActiveViewId = _prevActive;
            portfolioFilterTree   = _prevTree;
            _applyPortfolioFilters(_prevFilters);
            renderPortfolioViewTiles();
            renderPortfolioTable();
        } else {
            // First load: restore the previously-active view from localStorage.
            const savedView = (() => { try { return localStorage.getItem(_PORTFOLIO_ACTIVE_LS); } catch(_) { return null; } })();
            if (savedView && getPortfolioViewById(savedView)) {
                applyPortfolioView(savedView);
            } else {
                renderPortfolioViewTiles();
                renderPortfolioTable();
            }
        }
    } catch(e) {
        console.error('portfolio load failed', e);
    }
}

function _getPortfolioFilterValues() {
    const programs = allPortfolioPrograms;
    return {
        'portfolio-filter-college':    [...new Set(programs.map(p => p.college).filter(Boolean))].sort(),
        'portfolio-filter-campus':     [...new Set(programs.map(p => p.campus).filter(Boolean))].sort(),
        'portfolio-filter-otp':        [...new Set(programs.map(p => p.otp_status).filter(Boolean))].sort(),
        'portfolio-filter-ipd':        [...new Set(programs.map(p => p.ipd_status).filter(Boolean))].sort(),
        'portfolio-filter-roster':     [...new Set(programs.map(p => p.svt_status).filter(Boolean))].sort(),
        'portfolio-filter-substatus':  [...new Set(programs.map(p => p.roster_sub_status).filter(Boolean))].sort(),
        'portfolio-filter-speed':      ['True', 'False'],
        'portfolio-filter-gls':        [...new Set(programs.map(p => p.gls_status).filter(Boolean))].sort(),
        'portfolio-filter-cim':        [...new Set(programs.map(p => p.cim_step).filter(Boolean))].sort(),
        'portfolio-filter-cimchange':  [...new Set(programs.map(p => p.cim_change_type).filter(Boolean))].sort(),
        'portfolio-filter-inworkflow': ['Yes', 'No'],
        'portfolio-filter-inactadmit': [...new Set(programs.map(p => p.inactivation_admission).filter(Boolean))].sort(
            (a, b) => (_semesterToDate(a)||0) - (_semesterToDate(b)||0)),
    };
}

function _updateMultiFilterBtn(id, filterSet) {
    const btn = document.getElementById(id);
    if (!btn) return;
    const wrap = document.getElementById('fmw-' + id);
    const labelFor = (id === 'portfolio-filter-college')
        ? (v => abbreviateCollege(v))
        : (v => v);
    // Default label = "All X ▾" (where X is the column name) for parity
    // with the CIM-tab "All Colleges" / "All Campuses" / etc. dropdowns.
    const ALL_LABEL = {
        'portfolio-filter-college':    'All Colleges',
        'portfolio-filter-campus':     'All Campuses',
        'portfolio-filter-otp':        'All OTP',
        'portfolio-filter-ipd':        'All IPD',
        'portfolio-filter-roster':     'All Statuses',
        'portfolio-filter-substatus':  'All Sub-statuses',
        'portfolio-filter-speed':      'All',
        'portfolio-filter-gls':        'All GLS',
        'portfolio-filter-cim':        'All Steps',
        'portfolio-filter-cimchange':  'All Changes',
        'portfolio-filter-inworkflow': 'All',
        'portfolio-filter-inactadmit': 'All Semesters',
    };
    if (filterSet.size === 0) {
        btn.textContent = (ALL_LABEL[id] || 'All') + ' ▾';
        if (wrap) wrap.classList.remove('has-value');
    } else if (filterSet.size === 1) {
        btn.textContent = labelFor([...filterSet][0]) + ' ▾';
        if (wrap) wrap.classList.add('has-value');
    } else {
        btn.textContent = filterSet.size + ' selected ▾';
        if (wrap) wrap.classList.add('has-value');
    }
}

function populatePortfolioFilters() {
    const multiIds = [
        'portfolio-filter-college', 'portfolio-filter-campus',
        'portfolio-filter-otp', 'portfolio-filter-ipd', 'portfolio-filter-roster',
        'portfolio-filter-substatus', 'portfolio-filter-speed',
        'portfolio-filter-gls',
        'portfolio-filter-cim', 'portfolio-filter-cimchange',
        'portfolio-filter-inworkflow', 'portfolio-filter-inactadmit',
    ];
    const filterSetMap = {
        'portfolio-filter-college':    portfolioCollegeFilter,
        'portfolio-filter-campus':     portfolioCampusFilter,
        'portfolio-filter-otp':        portfolioOtpFilter,
        'portfolio-filter-ipd':        portfolioIpdFilter,
        'portfolio-filter-roster':     portfolioRosterFilter,
        'portfolio-filter-substatus':  portfolioSubStatusFilter,
        'portfolio-filter-speed':      portfolioSpeedFilter,
        'portfolio-filter-gls':        portfolioGlsFilter,
        'portfolio-filter-cim':        portfolioCimFilter,
        'portfolio-filter-cimchange':  portfolioCimChangeFilter,
        'portfolio-filter-inworkflow': portfolioInWorkflowFilter,
        'portfolio-filter-inactadmit': portfolioInactAdmitFilter,
    };
    multiIds.forEach(id => _updateMultiFilterBtn(id, filterSetMap[id] || new Set()));
    // Keep the button rows in sync with the underlying filter Sets.
    if (typeof _syncPortfolioButtonRows === 'function') _syncPortfolioButtonRows();

    // Admitting Today stays as single-select
    const inactTodayVals = [...new Set(allPortfolioPrograms.map(p => _inactAdmittingToday(p)).filter(Boolean))].sort();
    const sel = document.getElementById('portfolio-filter-inacttoday');
    if (sel) {
        sel.innerHTML = `<option value="" disabled${portfolioInactTodayFilter ? '' : ' selected'}> — select — </option>` +
            inactTodayVals.map(v => `<option value="${escapeHtml(v)}" ${v === portfolioInactTodayFilter ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('');
        sel.closest('.filter-select-wrap').classList.toggle('has-value', !!portfolioInactTodayFilter);
    }
}

const _portfolioFilterVars = {
    'portfolio-filter-college':    () => { portfolioCollegeFilter.clear();    _updateMultiFilterBtn('portfolio-filter-college',    portfolioCollegeFilter); },
    'portfolio-filter-campus':     () => { portfolioCampusFilter.clear();     _updateMultiFilterBtn('portfolio-filter-campus',     portfolioCampusFilter); },
    'portfolio-filter-otp':        () => { portfolioOtpFilter.clear();        _updateMultiFilterBtn('portfolio-filter-otp',        portfolioOtpFilter); },
    'portfolio-filter-ipd':        () => { portfolioIpdFilter.clear();        _updateMultiFilterBtn('portfolio-filter-ipd',        portfolioIpdFilter); },
    'portfolio-filter-roster':     () => { portfolioRosterFilter.clear();     _updateMultiFilterBtn('portfolio-filter-roster',     portfolioRosterFilter); },
    'portfolio-filter-substatus':  () => { portfolioSubStatusFilter.clear();  _updateMultiFilterBtn('portfolio-filter-substatus',  portfolioSubStatusFilter); },
    'portfolio-filter-speed':      () => { portfolioSpeedFilter.clear();      _updateMultiFilterBtn('portfolio-filter-speed',      portfolioSpeedFilter); },
    'portfolio-filter-gls':        () => { portfolioGlsFilter.clear();        _updateMultiFilterBtn('portfolio-filter-gls',        portfolioGlsFilter); },
    'portfolio-filter-cim':        () => { portfolioCimFilter.clear();        _updateMultiFilterBtn('portfolio-filter-cim',        portfolioCimFilter); },
    'portfolio-filter-cimchange':  () => { portfolioCimChangeFilter.clear();  _updateMultiFilterBtn('portfolio-filter-cimchange',  portfolioCimChangeFilter); },
    'portfolio-filter-inworkflow': () => { portfolioInWorkflowFilter.clear(); _updateMultiFilterBtn('portfolio-filter-inworkflow', portfolioInWorkflowFilter); },
    'portfolio-filter-inactadmit': () => { portfolioInactAdmitFilter.clear(); _updateMultiFilterBtn('portfolio-filter-inactadmit', portfolioInactAdmitFilter); },
    'portfolio-filter-inacttoday': () => { portfolioInactTodayFilter = ''; },
};

function clearPortfolioFilter(id) {
    const dd = document.getElementById('fmd-' + id);
    if (dd) dd.classList.remove('open');
    const sel = document.getElementById(id);
    if (sel && sel.tagName === 'SELECT') sel.value = '';
    if (_portfolioFilterVars[id]) _portfolioFilterVars[id]();
    updateClearButtons();
    _portfolioViewTouch();
    renderPortfolioTable();
}

function togglePortfolioMultiFilter(id, e) {
    e.stopPropagation();
    const dd = document.getElementById('fmd-' + id);
    if (!dd) return;
    if (dd.classList.contains('open')) { dd.classList.remove('open'); return; }
    // Close other open dropdowns
    document.querySelectorAll('.filter-multi-dropdown.open').forEach(el => el.classList.remove('open'));
    const filterSetMap = {
        'portfolio-filter-college':    portfolioCollegeFilter,
        'portfolio-filter-campus':     portfolioCampusFilter,
        'portfolio-filter-otp':        portfolioOtpFilter,
        'portfolio-filter-ipd':        portfolioIpdFilter,
        'portfolio-filter-roster':     portfolioRosterFilter,
        'portfolio-filter-substatus':  portfolioSubStatusFilter,
        'portfolio-filter-speed':      portfolioSpeedFilter,
        'portfolio-filter-gls':        portfolioGlsFilter,
        'portfolio-filter-cim':        portfolioCimFilter,
        'portfolio-filter-cimchange':  portfolioCimChangeFilter,
        'portfolio-filter-inworkflow': portfolioInWorkflowFilter,
        'portfolio-filter-inactadmit': portfolioInactAdmitFilter,
    };
    const filterSet = filterSetMap[id];
    const valuesMap = _getPortfolioFilterValues();
    const vals = valuesMap[id] || [];
    const labelFor = (id === 'portfolio-filter-college')
        ? (v => abbreviateCollege(v))
        : (v => v);
    // Re-sort by label for college so acronyms sort alphabetically
    const display = (id === 'portfolio-filter-college')
        ? vals.slice().sort((a, b) => labelFor(a).localeCompare(labelFor(b)))
        : vals;
    // JSON.stringify emits double-quoted strings, which would terminate the
    // outer onchange="..." HTML attribute prematurely. The existing
    // escapeHtml() only escapes <,>,& (not "), so it doesn't help here.
    // _attr() escapes " → &quot; for HTML attribute context; the browser
    // decodes the entity back to " before evaluating the handler at click time.
    const _attr = s => s.replace(/"/g, '&quot;');
    dd.innerHTML = display.map(v => `
        <label class="portfolio-col-check">
            <input type="checkbox" ${filterSet && filterSet.has(v) ? 'checked' : ''}
                   onchange="togglePortfolioMultiValue(${_attr(JSON.stringify(id))}, ${_attr(JSON.stringify(v))}, this.checked)">
            ${escapeHtml(labelFor(v))}
        </label>`).join('');
    dd.classList.add('open');
}

function togglePortfolioMultiValue(id, value, checked) {
    const filterSetMap = {
        'portfolio-filter-college':    portfolioCollegeFilter,
        'portfolio-filter-campus':     portfolioCampusFilter,
        'portfolio-filter-otp':        portfolioOtpFilter,
        'portfolio-filter-ipd':        portfolioIpdFilter,
        'portfolio-filter-roster':     portfolioRosterFilter,
        'portfolio-filter-substatus':  portfolioSubStatusFilter,
        'portfolio-filter-speed':      portfolioSpeedFilter,
        'portfolio-filter-gls':        portfolioGlsFilter,
        'portfolio-filter-cim':        portfolioCimFilter,
        'portfolio-filter-cimchange':  portfolioCimChangeFilter,
        'portfolio-filter-inworkflow': portfolioInWorkflowFilter,
        'portfolio-filter-inactadmit': portfolioInactAdmitFilter,
    };
    const filterSet = filterSetMap[id];
    if (!filterSet) return;
    if (checked) filterSet.add(value);
    else filterSet.delete(value);
    _updateMultiFilterBtn(id, filterSet);
    if (typeof _syncPortfolioButtonRows === 'function') _syncPortfolioButtonRows();
    updateClearButtons();
    _portfolioViewTouch();
    renderPortfolioTable();
}

function getPortfolioFiltered() {
    let rows = allPortfolioPrograms.slice();
    if (portfolioLevelFilter.size)
        rows = rows.filter(p => portfolioLevelFilter.has(classifyPortfolioLevel(p.program_name)));
    if (portfolioDegreeFilter.size)
        rows = rows.filter(p => portfolioDegreeFilter.has(classifyPortfolioDegree(p.program_name)));
    // Lifecycle status button row:
    //   inworkflow = active CIM workflow step set
    //   catalog    = approved at least once — either we observed completion
    //                (cim_completion_date set), OR the program is currently
    //                undergoing a Change/Inactivation proposal (which implies
    //                a prior approval that predates our scrape history).
    //                Re-entering workflow with a new proposal still counts
    //                here AND also matches inworkflow until completion.
    //   Multi-select OR — passing rows match ANY active status.
    if (portfolioStatusFilter.size) {
        const wantWf  = portfolioStatusFilter.has('inworkflow');
        const wantCat = portfolioStatusFilter.has('catalog');
        rows = rows.filter(p =>
            (wantWf  && p.cim_step) ||
            (wantCat && (p.cim_completion_date ||
                         p.cim_change_type === 'Change' ||
                         p.cim_change_type === 'Inactivation'))
        );
    }
    if (portfolioCollegeFilter.size)    rows = rows.filter(p => portfolioCollegeFilter.has(p.college || ''));
    if (portfolioCampusFilter.size)     rows = rows.filter(p => portfolioCampusFilter.has(p.campus || ''));
    if (portfolioOtpFilter.size)        rows = rows.filter(p => portfolioOtpFilter.has(p.otp_status || ''));
    if (portfolioIpdFilter.size)        rows = rows.filter(p => portfolioIpdFilter.has(p.ipd_status || ''));
    if (portfolioRosterFilter.size)     rows = rows.filter(p => portfolioRosterFilter.has(p.svt_status || ''));
    if (portfolioSubStatusFilter.size)  rows = rows.filter(p => portfolioSubStatusFilter.has(p.roster_sub_status || ''));
    if (portfolioSpeedFilter.size)      rows = rows.filter(p => portfolioSpeedFilter.has(p.speed_to_market || ''));
    if (portfolioGlsFilter.size)        rows = rows.filter(p => portfolioGlsFilter.has(p.gls_status || ''));
    if (portfolioCimFilter.size)        rows = rows.filter(p => portfolioCimFilter.has(p.cim_step || ''));
    if (portfolioCimChangeFilter.size)  rows = rows.filter(p => portfolioCimChangeFilter.has(p.cim_change_type || ''));
    if (portfolioInWorkflowFilter.size) rows = rows.filter(p => portfolioInWorkflowFilter.has(p.cim_program_id ? 'Yes' : 'No'));
    if (portfolioInactAdmitFilter.size) rows = rows.filter(p => portfolioInactAdmitFilter.has(p.inactivation_admission || ''));
    if (portfolioInactTodayFilter)      rows = rows.filter(p => _inactAdmittingToday(p) === portfolioInactTodayFilter);
    // Advanced filter tree (from the Views builder) — ANDed with everything above.
    if (portfolioFilterTree && (portfolioFilterTree.children || []).length)
        rows = rows.filter(p => evalPortfolioNode(p, portfolioFilterTree));
    if (portfolioSearch && portfolioSearch.trim()) {
        // Supports `*` (any chars) and `?` (one char) wildcards.
        const match = buildSearchMatcher(portfolioSearch);
        // Build a set of parent IDs whose curriculum-extracted concentrations
        // OR linked concentration sub-rows match the search. We need parents
        // in the filtered result so the renderer's nest logic (which only
        // shows a sub-row under a parent that ALSO survives the filter) can
        // surface the matching child. Without this, searching "Robotics"
        // would hide "Artificial Intelligence, MS (Boston)" (whose curric
        // includes "Robotics and Agent-Based Systems" and whose linked
        // sub-row is "AI - Robotics Concentration, MS") even though the
        // concentration topic clearly matches.
        const parentIdsViaConc = new Set();
        allPortfolioPrograms.forEach(p => {
            if (p.concentrations && p.concentrations.some(c => {
                const n = (typeof c === 'string') ? c : (c && c.name) || '';
                return match(n);
            })) {
                parentIdsViaConc.add(p.id);
            }
            if (p.concentration_of && match(p.program_name)) {
                parentIdsViaConc.add(p.concentration_of);
            }
        });
        rows = rows.filter(p =>
            match(p.program_name) ||
            match(p.college) ||
            match(p.campus) ||
            parentIdsViaConc.has(p.id)
        );
    }
    return rows;
}

// Count of TOP-LEVEL programs in a filtered set — mirrors the row-splitting in
// renderPortfolioTable (concentration sub-rows nest under a matching parent and
// don't count; a sub-row whose parent fails the filter is promoted to top-level).
// Used by the view tiles so their counts match the table header exactly.
function _portfolioTopLevelCount(filtered) {
    const allById = {};
    allPortfolioPrograms.forEach(p => { allById[p.id] = p; });
    const filteredIds = new Set(filtered.map(r => r.id));
    const topLevelIds = new Set();
    const concsByParent = {};
    filtered.forEach(p => {
        if (p.concentration_of && allById[p.concentration_of]) {
            (concsByParent[p.concentration_of] = concsByParent[p.concentration_of] || []).push(p);
        } else {
            topLevelIds.add(p.id);
        }
    });
    Object.keys(concsByParent).forEach(parentId => {
        if (topLevelIds.has(parentId)) return;
        if (filteredIds.has(parentId) && allById[parentId]) {
            topLevelIds.add(parentId);                       // parent hosts the nesting
        } else {
            concsByParent[parentId].forEach(c => topLevelIds.add(c.id));  // promote orphans
        }
    });
    return topLevelIds.size;
}

// ── Portfolio Matrix view (program × campus) ───────────────────────────────
// Preferred campus column order; anything else falls in alphabetically after.
const _MATRIX_CAMPUS_ORDER = [
    'Boston', 'Oakland', 'Online', 'Toronto', 'Vancouver',
    'Seattle', 'Portland', 'Arlington', 'Miami', 'Charlotte',
];

const _CIM_STAGE_SHORT = {
    "Program PR Graduate Dean's Office": 'Grad Dean',
    'Provost Initial Review': 'Provost Init',
    'Program Review 2': 'Review 2',
    'Program Graduate Provost Review': 'Grad Provost',
    'Program GRA Regulatory': 'GRA',
    'Program Graduate Curriculum Committee': 'Grad Curric',
    'Program Undergraduate Curriculum Committee - Tabled Proposals': 'Tabled',
    'Program Provost Administrative and Budgetary Review': 'Provost A&B',
    'Program Provost Approval': 'Provost Appr',
    'Program Faculty Senate': 'Faculty Sen',
    'Program University Board of Trustees': 'Trustees',
    'Program Setup': 'Setup',
    'Program Teach-Out': 'Teach-Out',
};

function _matrixStageLabel(step) {
    if (!step) return '';
    if (typeof isCollegeStep === 'function' && isCollegeStep(step)) return 'College';
    const c = (typeof canonicalStep === 'function') ? canonicalStep(step) : step;
    return _CIM_STAGE_SHORT[c] || c.replace(/^Program /, '');
}

// One program (deployment) cell: CIM stage + portfolio (SVT/GTM) status.
function _matrixProgramCell(p) {
    if (!p) return '<td class="mx-cell mx-empty"></td>';
    let stage = '', tintClass = '';
    if (p.cim_completion_date) {
        stage = 'Approved';
        tintClass = 'mx-approved';
    } else if (p.cim_step) {
        stage = _matrixStageLabel(p.cim_step);
        tintClass = p.cim_change_type === 'New' ? 'mx-new'
            : p.cim_change_type === 'Inactivation' ? 'mx-inact'
            : 'mx-change';
    }
    const svt = p.svt_status || p.gtm_type || '';
    const stageHtml = stage ? `<span class="mx-stage">${escapeHtml(stage)}</span>` : '';
    const svtHtml = svt ? `<span class="mx-sub">${escapeHtml(svt)}</span>` : '';
    if (!stageHtml && !svtHtml) return '<td class="mx-cell mx-present"></td>';
    return `<td class="mx-cell ${tintClass}">${stageHtml}${svtHtml}</td>`;
}

// One concentration cell for a given campus deployment.
function _matrixConcCell(info) {
    if (!info) return '<td class="mx-cell mx-empty"></td>';
    const badge = info.status === 'new'
        ? '<span class="conc-status conc-workflow">In workflow</span>'
        : '<span class="conc-status conc-existing">Existing</span>';
    const svt = info.svt_status ? `<span class="mx-sub">${escapeHtml(info.svt_status)}</span>` : '';
    return `<td class="mx-cell mx-present">${badge}${svt}</td>`;
}

function renderPortfolioMatrix() {
    const container = document.getElementById('programs-table-container');
    if (!container) return;

    // Only top-level deployment rows participate (concentrations come from each
    // deployment's own parsed concentration list, not from sub-rows).
    const rows = getPortfolioFiltered().filter(p => !p.concentration_of);

    const campusOf = p => p.campus || extractCampus(p.program_name || '') || 'Boston';
    const baseOf = p => normalizePortfolioName(stripCampusFromName(p.program_name || ''));

    // Group deployments by base program name.
    const groups = {};            // baseName → {name, deployments:{campus:row}, concs:{conc:{campus:info}}}
    const campusSet = new Set();
    rows.forEach(p => {
        const base = baseOf(p);
        if (!base) return;
        const camp = campusOf(p);
        campusSet.add(camp);
        const g = groups[base] || (groups[base] = { name: base, deployments: {}, concs: {}, college: '', concCollege: {} });
        if (!g.college && p.college) g.college = p.college;
        // If two records map to the same base+campus, prefer one in active workflow.
        const existing = g.deployments[camp];
        if (!existing || (!existing.cim_step && p.cim_step)) g.deployments[camp] = p;
        (p.concentrations || []).forEach(c => {
            const cn = (typeof c === 'string') ? c : (c && c.name) || '';
            if (!cn) return;
            const cg = g.concs[cn] || (g.concs[cn] = {});
            cg[camp] = {
                status: (typeof c === 'object' && c.status) || 'existing',
                svt_status: (typeof c === 'object' && c.svt_status) || '',
            };
            // Concentration's own college (subject-specific), if declared.
            const cc = (typeof c === 'object' && c.college) || '';
            if (cc && !g.concCollege[cn]) g.concCollege[cn] = cc;
        });
    });

    // Column order: preferred list first, then any extras alphabetically.
    const campuses = [...campusSet].sort((a, b) => {
        const ia = _MATRIX_CAMPUS_ORDER.indexOf(a), ib = _MATRIX_CAMPUS_ORDER.indexOf(b);
        if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        return a.localeCompare(b);
    });

    // Sort value per program for the active column. Campus columns sort by the
    // deployment's status there (offered-with-stage first, not-offered last).
    const _mxSortVal = (g) => {
        if (matrixSortKey === 'college') return (g.college || '').toLowerCase();
        if (matrixSortKey.indexOf('c:') === 0) {
            const dep = g.deployments[matrixSortKey.slice(2)];
            if (!dep) return '￿';                       // not offered → last
            if (dep.cim_completion_date) return '1_approved';
            if (dep.cim_step) return '0_' + _matrixStageLabel(dep.cim_step).toLowerCase();
            return '2_' + ((dep.svt_status || dep.gtm_type || '')).toLowerCase();
        }
        return (g.name || '').toLowerCase();               // 'name'
    };
    const baseNames = Object.keys(groups).sort((a, b) => {
        const va = _mxSortVal(groups[a]), vb = _mxSortVal(groups[b]);
        if (va < vb) return -matrixSortDir;
        if (va > vb) return matrixSortDir;
        return groups[a].name.localeCompare(groups[b].name);  // stable tiebreak
    });

    const countEl = document.getElementById('portfolio-result-count');
    if (countEl) countEl.textContent =
        `${baseNames.length} program${baseNames.length === 1 ? '' : 's'} · ${campuses.length} campus${campuses.length === 1 ? '' : 'es'}`;

    if (!baseNames.length) {
        container.innerHTML = '<p class="empty-state">No programs match the current filters.</p>';
        return;
    }

    const _mxHandle = (key) =>
        `<span class="col-resize" onmousedown="startMatrixColResize(event,'${key}')" onclick="event.stopPropagation()"></span>`;
    const progW = matrixColWidths.prog || 260;
    const collegeW = matrixColWidths.college || 64;
    const campusW = c => matrixColWidths['c:' + c] || 100;
    const totalW = progW + collegeW + campuses.reduce((s, c) => s + campusW(c), 0);
    const colGroup = '<colgroup>'
        + `<col data-mxcol="prog" style="width:${progW}px">`
        + `<col data-mxcol="college" style="width:${collegeW}px">`
        + campuses.map(c => `<col data-mxcol="c:${escapeHtml(c)}" style="width:${campusW(c)}px">`).join('')
        + '</colgroup>';
    const _mxArrow = (k) => matrixSortKey === k ? (matrixSortDir === 1 ? ' ▲' : ' ▼') : '';
    const headCells = campuses.map(c => {
        const ck = 'c:' + escapeHtml(c).replace(/'/g, "\\'");
        return `<th class="mx-campus-col mx-sortable" onclick="sortPortfolioMatrix('${ck}')">${escapeHtml(abbreviateCampus(c))}${_mxArrow('c:' + c)}${_mxHandle(ck)}</th>`;
    }).join('');
    const _collegeCell = (col) => col
        ? `<td class="mx-college-cell" title="${escapeHtml(col)}">${escapeHtml(abbreviateCollege(col))}</td>`
        : '<td class="mx-college-cell"></td>';
    const bodyRows = [];
    baseNames.forEach(base => {
        const g = groups[base];
        const concNames = Object.keys(g.concs).sort((a, b) => a.localeCompare(b));
        const hasConcs = concNames.length > 0;
        const expanded = portfolioMatrixExpanded.has(base);
        const caret = hasConcs
            ? `<span class="mx-caret">${expanded ? '▾' : '▸'}</span>`
            : '<span class="mx-caret-spacer"></span>';
        const nameClick = hasConcs ? ` onclick="togglePortfolioMatrixRow('${escapeHtml(base).replace(/'/g, "\\'")}')"` : '';
        const progCells = campuses.map(c => _matrixProgramCell(g.deployments[c])).join('');
        bodyRows.push(
            `<tr class="mx-prog-row">
                <th class="mx-rowhead${hasConcs ? ' mx-clickable' : ''}"${nameClick}>${caret}<span class="mx-name">${escapeHtml(base)}</span></th>
                ${_collegeCell(g.college)}
                ${progCells}
            </tr>`);
        if (hasConcs && expanded) {
            concNames.forEach(cn => {
                const cells = campuses.map(c => _matrixConcCell(g.concs[cn][c])).join('');
                // Concentration's own college, falling back to the program's.
                const col = g.concCollege[cn] || g.college || '';
                bodyRows.push(
                    `<tr class="mx-conc-row">
                        <th class="mx-rowhead mx-conc-name"><span class="mx-name">${escapeHtml(cn)}</span></th>
                        ${_collegeCell(col)}
                        ${cells}
                    </tr>`);
            });
        }
    });

    container.innerHTML = `
        <div class="mx-scroll">
        <table class="program-table matrix-table" style="table-layout:fixed; width:${totalW}px; --mx-prog-w:${progW}px; --mx-college-w:${collegeW}px">
            ${colGroup}
            <thead><tr>
                <th class="mx-corner mx-sortable" onclick="sortPortfolioMatrix('name')">Program${_mxArrow('name')}${_mxHandle('prog')}</th>
                <th class="mx-corner2 mx-sortable" onclick="sortPortfolioMatrix('college')">College${_mxArrow('college')}${_mxHandle('college')}</th>
                ${headCells}
            </tr></thead>
            <tbody>${bodyRows.join('')}</tbody>
        </table>
        </div>`;
}

function _syncLayoutButtons() {
    document.querySelectorAll('.portfolio-layout-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.layout === portfolioLayout);
    });
    // The ⊞ Columns picker governs the TABLE's data columns, which don't apply
    // to the matrix (whose columns are campuses, controlled by the Campus
    // filter). Hide it in matrix mode so it isn't a dead control.
    const colPicker = document.getElementById('portfolio-col-picker');
    if (colPicker) colPicker.style.display = (portfolioLayout === 'matrix') ? 'none' : '';

    // In matrix mode, hide the per-deployment status filters — they're
    // redundant with what the cells already show and they fragment the grid
    // (a status that varies by campus blanks out cells rather than pruning
    // rows cleanly). Keep the CIM scope buttons and Admitting Today, which
    // narrow the program set without that problem. Left structural filters
    // (Level / Degree / College / Campus) always stay.
    const matrix = portfolioLayout === 'matrix';
    const hideIds = ['portfolio-filter-inactadmit', 'portfolio-filter-roster',
        'portfolio-filter-substatus', 'portfolio-filter-speed',
        'portfolio-filter-gls', 'portfolio-filter-otp'];
    hideIds.forEach(id => {
        const el = document.getElementById(id);
        const grp = el && el.closest('.filter-group');
        if (grp) grp.style.display = matrix ? 'none' : '';
    });
    const statusBreak = document.getElementById('pf-status-break');
    if (statusBreak) statusBreak.style.display = matrix ? 'none' : '';

    // Matrix mode: collapse the CIM buttons + Admitting Today onto one compact
    // row (CSS keys off this class) instead of the table layout's stacked rows.
    const filterSection = document.getElementById('portfolio-filters');
    if (filterSection) filterSection.classList.toggle('matrix-mode', matrix);
}

function renderPortfolioTable() {
    _syncLayoutButtons();
    if (portfolioLayout === 'matrix') return renderPortfolioMatrix();
    const container = document.getElementById('programs-table-container');
    if (!container) return;

    const filtered = getPortfolioFiltered();

    // Index all programs by id for parent lookups
    const allById = {};
    allPortfolioPrograms.forEach(p => { allById[p.id] = p; });

    // Index portfolio concentration rows (concentration_of links) by parent
    const allConcsByParent = {};
    allPortfolioPrograms.forEach(p => {
        if (p.concentration_of) {
            if (!allConcsByParent[p.concentration_of]) allConcsByParent[p.concentration_of] = [];
            allConcsByParent[p.concentration_of].push(p);
        }
    });

    // Split filtered rows into top-level and portfolio concentration rows
    const topLevel = [];
    const topLevelIds = new Set();
    const matchingConcsByParent = {};

    filtered.forEach(p => {
        if (p.concentration_of && allById[p.concentration_of]) {
            if (!matchingConcsByParent[p.concentration_of]) matchingConcsByParent[p.concentration_of] = [];
            matchingConcsByParent[p.concentration_of].push(p);
        } else {
            topLevel.push(p);
            topLevelIds.add(p.id);
        }
    });

    // Parents of matching concentration sub-rows: only force-include the
    // parent when the parent itself ALSO passes the filter (i.e. it's in
    // `filtered`). Otherwise promote the matching children to top-level
    // standalone rows — don't surface a parent that fails the filter just
    // because one of its sub-rows passes. Without this, filtering
    // 'In CIM = Yes' surfaced amber not-in-CIM synthetic parents simply
    // because one of their real-CIM children matched.
    const filteredIds = new Set(filtered.map(r => r.id));
    Object.keys(matchingConcsByParent).forEach(parentId => {
        if (topLevelIds.has(parentId)) return;
        if (filteredIds.has(parentId) && allById[parentId]) {
            // Parent ALSO passes the filter — include it as a nesting host.
            topLevel.push(allById[parentId]);
            topLevelIds.add(parentId);
        } else {
            // Parent fails the filter — promote children to top-level rows
            // and drop the nesting (they appear standalone in the table).
            (matchingConcsByParent[parentId] || []).forEach(child => {
                if (!topLevelIds.has(child.id)) {
                    topLevel.push(child);
                    topLevelIds.add(child.id);
                }
            });
            delete matchingConcsByParent[parentId];
        }
    });

    topLevel.sort((a, b) => {
        let av = '', bv = '';
        if (!portfolioSortKey || portfolioSortKey === 'name') {
            return ((a.college || '').localeCompare(b.college || '') ||
                    (a.program_name || '').localeCompare(b.program_name || '')) * portfolioSortDir;
        }
        switch (portfolioSortKey) {
            case 'degree':    av = extractPortfolioDegree(a.program_name); bv = extractPortfolioDegree(b.program_name); break;
            case 'college':   av = a.college || '';  bv = b.college || '';  break;
            case 'campus':    av = a.campus  || '';  bv = b.campus  || '';  break;
            case 'otp':       av = a.otp_status || ''; bv = b.otp_status || ''; break;
            case 'ipd':       av = a.ipd_status || ''; bv = b.ipd_status || ''; break;
            case 'svt':       av = a.svt_status || ''; bv = b.svt_status || ''; break;
            case 'substatus': av = a.roster_sub_status || ''; bv = b.roster_sub_status || ''; break;
            case 'speed':     av = a.speed_to_market || ''; bv = b.speed_to_market || ''; break;
            case 'gls':       av = a.gls_status || ''; bv = b.gls_status || ''; break;
            case 'launch':    av = a.roster_launch_date || ''; bv = b.roster_launch_date || ''; break;
            case 'cim':       av = a.cim_step || ''; bv = b.cim_step || ''; break;
            case 'cimcatalog': av = a.cim_completion_date || ''; bv = b.cim_completion_date || ''; break;
            case 'cimterm':   av = a.cim_eff_term || ''; bv = b.cim_eff_term || ''; break;
            case 'svtnote':   av = _svtCoordNote(a); bv = _svtCoordNote(b); break;
            case 'cimchange':   av = a.cim_change_type || ''; bv = b.cim_change_type || ''; break;
            case 'inworkflow':  av = a.cim_program_id ? 'Yes' : 'No'; bv = b.cim_program_id ? 'Yes' : 'No'; break;
            case 'inactadmit':  av = a.inactivation_admission || ''; bv = b.inactivation_admission || ''; break;
            case 'inacttoday':  av = _inactAdmittingToday(a); bv = _inactAdmittingToday(b); break;
            case 'offering':    av = portfolioOfferingLabel(a); bv = portfolioOfferingLabel(b); break;
            case 'gtmentered':  av = a.gtm_entered_date || '';  bv = b.gtm_entered_date || '';  break;
            case 'gtmtype':     av = a.gtm_type || '';        bv = b.gtm_type || '';        break;
            case 'gtmdate':     av = a.gtm_date || '';        bv = b.gtm_date || '';        break;
            case 'gtmfirst':    av = a.gtm_first_term || '';  bv = b.gtm_first_term || '';  break;
            case 'gtmlast':     av = a.gtm_last_term || '';   bv = b.gtm_last_term || '';   break;
            case 'gtmintake':   av = a.gtm_intake_terms || ''; bv = b.gtm_intake_terms || ''; break;
            case 'exitmasters': av = a.exit_masters || '';     bv = b.exit_masters || '';     break;
            case 'emplreview':  av = a.otp_notes || '';        bv = b.otp_notes || '';        break;
            case 'market2025':    av = a.market_2025 || '';    bv = b.market_2025 || '';    break;
            case 'perf2025':      av = a.performance_2025 || ''; bv = b.performance_2025 || ''; break;
            case 'marketscore2025': av = parseFloat(a.market_score_2025) || 0; bv = parseFloat(b.market_score_2025) || 0;
                return (av - bv) * portfolioSortDir;
            case 'perfscore2025':   av = parseFloat(a.performance_score_2025) || 0; bv = parseFloat(b.performance_score_2025) || 0;
                return (av - bv) * portfolioSortDir;
            default: av = a.program_name || ''; bv = b.program_name || '';
        }
        return av.localeCompare(bv) * portfolioSortDir;
    });

    const anyFilterActive = portfolioLevelFilter.size || portfolioDegreeFilter.size || portfolioStatusFilter.size ||
        portfolioCollegeFilter.size || portfolioCampusFilter.size ||
        portfolioOtpFilter.size || portfolioIpdFilter.size ||
        portfolioRosterFilter.size || portfolioSubStatusFilter.size || portfolioSpeedFilter.size ||
        portfolioGlsFilter.size || portfolioCimFilter.size ||
        portfolioCimChangeFilter.size || portfolioInWorkflowFilter.size ||
        portfolioInactAdmitFilter.size || portfolioInactTodayFilter || portfolioSearch;

    // Determine which programs should be auto-expanded (search matches a
    // curriculum concentration OR a linked concentration sub-row).
    const autoExpand = new Set();
    if (portfolioSearch && portfolioSearch.trim()) {
        const match = buildSearchMatcher(portfolioSearch);
        allPortfolioPrograms.forEach(p => {
            if (p.concentrations && p.concentrations.some(c => {
                const n = (typeof c === 'string') ? c : (c && c.name) || '';
                return match(n);
            })) {
                autoExpand.add(p.id);
            }
            if (p.concentration_of && match(p.program_name)) {
                autoExpand.add(p.concentration_of);
            }
        });
    }
    // Mirror to module scope so togglePortfolioConcentrations() can read it.
    _portfolioAutoExpand = autoExpand;

    const countEl = document.getElementById('portfolio-result-count');
    if (countEl) countEl.textContent = `${topLevel.length} programs`;

    if (topLevel.length === 0 && Object.keys(matchingConcsByParent).length === 0) {
        container.innerHTML = '<p class="empty-state">No programs match your filters.</p>';
        return;
    }

    const rowHtml = [];
    topLevel.forEach(p => {
        const portfolioConcs = anyFilterActive
            ? (matchingConcsByParent[p.id] || [])
            : (allConcsByParent[p.id] || []);
        const curriculumConcs = p.concentrations || [];
        const isExpanded = !portfolioCollapsedIds.has(p.id)
            && (portfolioExpandedIds.has(p.id) || autoExpand.has(p.id));
        // Show arrow if there's ANYTHING to reveal — curriculum concentrations
        // OR linked sub-rows (Bridge Programs, "X Concentration in Y" CIM
        // records, IPD concentration proposals, etc.). Previously the arrow
        // only fired on curriculum concs, so parents like "Bioengineering, MS
        // (Portland)" that have linked sub-rows but no curriculum HTML had
        // no arrow even though sub-rows were rendered beneath them.
        const hasAnyChildren = curriculumConcs.length > 0 || portfolioConcs.length > 0;

        rowHtml.push(renderPortfolioRow(p, {
            hasConcentrations: hasAnyChildren,
            isExpanded,
        }));

        if (isExpanded) {
            // Curriculum concentrations (entries may be strings (legacy)
            // or {name, college} objects (current)). Inherit the parent
            // program's college (unless the concentration declares its
            // own — typical for Provost-owned programs whose
            // concentrations live in subject-specific colleges) and the
            // parent's campus (always — concentrations are bound to the
            // parent's deployment).
            const curriculumConcKeys = new Set();
            curriculumConcs.forEach(c => {
                const name    = (typeof c === 'string') ? c : (c && c.name)    || '';
                const college = (typeof c === 'string') ? ''  : (c && c.college) || '';
                const status  = (typeof c === 'string') ? ''  : (c && c.status) || '';
                const svtStatus = (typeof c === 'string') ? '' : (c && c.svt_status) || '';
                curriculumConcKeys.add(_concNorm(name));
                rowHtml.push(renderPortfolioConcRow(
                    name, portfolioSearch, college,
                    p.college || '', p.campus || '', status, svtStatus));
            });
            // Linked portfolio sub-rows — pass the parent so the sub-row
            // can inherit college/campus the same way and force the
            // credential cell to "Concentration". Suppress any whose name
            // matches a curriculum concentration already shown above (its
            // development status is overlaid on that row) so it isn't listed
            // twice; the survivors are SVT/IPD-only (in development, not yet
            // in the catalog).
            portfolioConcs
                .filter(c => !curriculumConcKeys.has(_concNorm(c.program_name || '')))
                .forEach(c => rowHtml.push(renderPortfolioRow(
                    c, {isPortfolioConc: true, parent: p})));
        }
    });

    // Use the page's existing info-tip overlay system (JS-driven, no native
    // title= delay). The IIFE near the top of the file watches for mouseover
    // on .tip-icon elements and renders the .tip-bubble text in #tip-overlay.
    const _help = (text) => text
        ? `<span class="info-tip" onclick="event.stopPropagation()"><i class="tip-icon">i</i><span class="tip-bubble">${escapeHtml(text)}</span></span>`
        : '';
    const _savedWidth = (key) => {
        const w = portfolioColWidths[key];
        return (typeof w === 'number' && w > 0) ? ` style="width:${w}px"` : '';
    };
    const _resizeHandle = '<span class="col-resize" onmousedown="startPortfolioColResize(event)" onclick="event.stopPropagation()"></span>';
    const visibleHeaders = PORTFOLIO_COLUMNS
        .filter(c => portfolioVisibleCols.has(c.key))
        .map(c => {
            const active = portfolioSortKey === c.key;
            const arrow = active ? (portfolioSortDir === 1 ? ' ▲' : ' ▼') : '';
            return `<th class="sortable-header${active ? ' sort-active' : ''}" data-col-key="${c.key}"${_savedWidth(c.key)} onclick="sortPortfolioBy('${c.key}')">${escapeHtml(c.label)}${_help(c.help)}${arrow}${_resizeHandle}</th>`;
        }).join('');
    const nameArrow = (!portfolioSortKey || portfolioSortKey === 'name') ? (portfolioSortDir === 1 ? ' ▲' : ' ▼') : '';
    const nameActive = !portfolioSortKey || portfolioSortKey === 'name';
    const nameHelp = _help('Canonical program name from CIM. Combined-major and concentration rows are nested under their parent and revealed with the expand caret.');
    // Legend matches the CIM Programs tab — same class, same structure,
    // rendered just above the table inside the container.
    const portfolioLegend = `
        <div class="table-legend">
            <span class="legend-item"><span class="legend-swatch new"></span> New program</span>
            <span class="legend-item"><span class="legend-swatch change"></span> Program change</span>
            <span class="legend-item"><span class="legend-swatch inactivation"></span> Inactivation</span>
            <span class="legend-item"><span class="legend-swatch not-in-cim"></span> Not in CIM</span>
        </div>`;
    container.innerHTML = portfolioLegend + `
        <table class="program-table">
            <thead><tr>
                <th class="sortable-header${nameActive ? ' sort-active' : ''}" data-col-key="name"${_savedWidth('name')} onclick="sortPortfolioBy('name')">Program${nameHelp}${nameArrow}${_resizeHandle}</th>
                ${visibleHeaders}
            </tr></thead>
            <tbody>${rowHtml.join('')}</tbody>
        </table>`;
}

// Loose key for matching a concentration across the curriculum, the
// last-approved reference, and the SVT roster. Mirror of portfolio_ingest._conc_norm.
function _concNorm(s) {
    s = (s || '').toLowerCase().replace(/\bconcentrations?\b/g, '').replace(/\bsystems?\b/g, '');
    return s.replace(/[^a-z0-9]+/g, ' ').trim();
}

function renderPortfolioConcRow(name, search, college, parentCollege, parentCampus, status, svtStatus) {
    const hl = search
        ? escapeHtml(name).replace(new RegExp(`(${escapeHtml(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'),
            '<mark>$1</mark>')
        : escapeHtml(name);
    // College: prefer the concentration's own (typical for Provost
    // programs whose concentrations belong to other colleges); fall
    // back to the parent's.
    const effectiveCollege = college || parentCollege || '';
    const collegeAbbrev = effectiveCollege ? escapeHtml(abbreviateCollege(effectiveCollege)) : '—';
    const collegeTitle  = effectiveCollege ? ` title="${escapeHtml(effectiveCollege)}"` : '';
    // Campus always inherits from the parent program.
    const campusAbbrev = parentCampus ? escapeHtml(abbreviateCampus(parentCampus)) : '—';
    const campusTitle  = parentCampus ? ` title="${escapeHtml(parentCampus)}"` : '';
    const cellHtml = PORTFOLIO_COLUMNS
        .filter(c => portfolioVisibleCols.has(c.key))
        .map(c => {
            if (c.key === 'college') return `<td${collegeTitle}>${collegeAbbrev}</td>`;
            if (c.key === 'campus')  return `<td${campusTitle}>${campusAbbrev}</td>`;
            // Credential cell is fixed to "Concentration" for concentration sub-rows.
            if (c.key === 'degree')  return '<td>Concentration</td>';
            return '<td>—</td>';
        })
        .join('');
    // Status badge: "Existing" (in the last-approved curriculum) vs
    // "In workflow" (added in the current proposal), with the SVT development
    // status appended when we have one for this concentration.
    let badge = '';
    if (status === 'existing') {
        badge = ' <span class="conc-status conc-existing">Existing</span>';
    } else if (status === 'new') {
        const svt = svtStatus ? ` · SVT: ${escapeHtml(svtStatus)}` : '';
        badge = ` <span class="conc-status conc-workflow">In workflow${svt}</span>`;
    } else if (svtStatus) {
        badge = ` <span class="conc-status conc-workflow">SVT: ${escapeHtml(svtStatus)}</span>`;
    }
    return `<tr class="portfolio-row portfolio-curriculum-conc-row">
        <td class="program-name-cell">${hl}${badge}</td>
        ${cellHtml}
    </tr>`;
}

function renderPortfolioRow(p, opts = {}) {
    const {hasConcentrations = false, isExpanded = false, isPortfolioConc = false, parent = null} = opts;
    // For linked concentration sub-rows, inherit college from parent when
    // the sub-row's own college is blank; inherit campus from parent
    // always (concentrations live in the parent's deployment). Credential
    // cell is forced to "Concentration" below.
    let effectiveCollege = p.college || '';
    let effectiveCampus  = p.campus  || '';
    if (isPortfolioConc && parent) {
        if (!effectiveCollege) effectiveCollege = parent.college || '';
        effectiveCampus = parent.campus || effectiveCampus;
    }

    const otpBadge    = p.otp_status
        ? `<span class="portfolio-badge otp-badge">${escapeHtml(p.otp_status)}</span>` : '—';
    const ipdBadge    = p.ipd_status
        ? `<span class="portfolio-badge ipd-badge">${escapeHtml(p.ipd_status)}</span>` : '—';
    // SVT "Status" column. Sub-status used to be shown as a subtitle here;
    // it now lives in its own column (key 'substatus') with its own filter.
    const svtBadge = p.svt_status
        ? `<span class="portfolio-badge roster-badge">${escapeHtml(p.svt_status)}</span>` : '—';
    const subStatusBadge = p.roster_sub_status
        ? escapeHtml(p.roster_sub_status) : '—';
    const speedBadge = p.speed_to_market === 'True'
        ? '<span class="portfolio-badge badge-good">Yes</span>'
        : (p.speed_to_market === 'False'
            ? '<span class="portfolio-badge badge-bad">No</span>'
            : '—');
    const glsBadge = p.gls_status
        ? `<span class="portfolio-badge gls-badge">${escapeHtml(p.gls_status)}</span>` : '—';
    const cimStep  = p.cim_step ? escapeHtml(p.cim_step) : '';
    const note = escapeHtml(p.note || '');
    const isStatic = typeof window._staticMode !== 'undefined';
    const noteCell = isStatic
        ? `<span class="portfolio-note-text">${note || '<span class="muted">—</span>'}</span>`
        : `<span class="portfolio-note-text" onclick="editPortfolioNote(this, '${escapeHtml(p.id)}')">${note || '<span class="muted add-note">+ add note</span>'}</span>`;

    const subStatus    = '';  // subtitles removed per user request
    const market2025Badge = p.market_2025
        ? `<span class="portfolio-badge ${p.market_2025 === 'Good' ? 'badge-good' : 'badge-bad'}">${escapeHtml(p.market_2025)}</span>` : '—';
    const perf2025Badge = p.performance_2025
        ? `<span class="portfolio-badge ${p.performance_2025 === 'Good' ? 'badge-good' : 'badge-bad'}">${escapeHtml(p.performance_2025)}</span>` : '—';

    const isSynthetic = (p.id || '').startsWith('synth_');
    const concBadge = isPortfolioConc
        ? `<span class="portfolio-conc-badge">Conc.</span> ` : '';
    // CIM-change-type row tint:
    //   New          → green   (row-added)
    //   Change       → blue    (row-edited)
    //   Inactivation → red     (row-deactivated)
    // ONLY applies when the program is currently in an active workflow
    // (cim_step set). Programs whose workflow has completed retain the
    // historical cim_change_type in the database (so the Completed
    // Approval filter can use it as a "prior approval" proxy for legacy
    // entries), but the row is rendered with no tint and the CIM Change
    // cell shows '—' — see the cimchange override below. Otherwise we'd
    // visually flag a completed program as if it were still being edited.
    const activeInWorkflow = !!p.cim_step;
    const changeClass = activeInWorkflow ? (
        p.cim_change_type === 'New'          ? ' row-added' :
        p.cim_change_type === 'Change'       ? ' row-edited' :
        p.cim_change_type === 'Inactivation' ? ' row-deactivated' : ''
    ) : '';
    const notInCim = !p.cim_program_id ? ' portfolio-not-in-cim' : '';
    const rowClass = (isPortfolioConc
        ? 'portfolio-row portfolio-concentration-row'
        : isSynthetic ? 'portfolio-row portfolio-synthetic-row' : 'portfolio-row')
        + changeClass + notInCim;

    // Expansion affordance: no dedicated arrow column. The program name
    // itself is clickable when the row has concentrations, with a tiny
    // chevron appended after the name (rotates on expand) plus cursor
    // pointer + hover tint via CSS. Zero extra column width.
    const toggleChevron = hasConcentrations
        ? ` <span class="portfolio-conc-chevron${isExpanded ? ' expanded' : ''}">${isExpanded ? '▾' : '▸'}</span>`
        : '';
    const nameCellAttrs = hasConcentrations
        ? ` class="program-name-cell portfolio-parent-name" onclick="togglePortfolioConcentrations('${escapeHtml(p.id)}')"`
        : ' class="program-name-cell"';

    // For nested concentration sub-rows, prefer a short display name that
    // shows just the concentration topic (not the parent program's name).
    // Falls back to the full program name when no pattern matches.
    function _shortConcName(full) {
        const n = (full || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
        let m;
        // ORDER MATTERS — more specific patterns must come before generic
        // "X Y Concentration" because the latter is greedy enough to match
        // (and mis-capture) the former. See "Robotics with Concentration
        // in Mechanical Engineering, MS" where the generic pattern would
        // grab "with" as the capture group.
        // "X, concentration in Y, DEG"  →  "Y"
        m = n.match(/^.+?,\s*concentration\s+in\s+(.+?),\s*[A-Z]{1,7}\s*$/i);
        if (m) return m[1].trim();
        // "X with Concentration in Y, DEG"  →  "Y"
        m = n.match(/^.+?\s+with\s+Concentration\s+in\s+(.+?),\s*[A-Z]{1,7}\s*$/i);
        if (m) return m[1].trim();
        // "X - Y Concentration, DEG"  →  "Y"
        m = n.match(/^.+?\s*[-—]\s*(.+?)\s+Concentration,?\s+[A-Z]{1,7}\s*$/i);
        if (m) return m[1].trim();
        // Generic fallback: "X CONCENTRATION_NAME Concentration ..., DEG"
        //   →  "CONCENTRATION_NAME"
        // e.g. "Bioengineering Biomedical Devices and Bioimaging Concentration Bridge Program, MS"
        m = n.match(/^\S+\s+(.+?)\s+Concentration\b.*?,\s*[A-Z]{1,7}\s*$/i);
        if (m) return m[1].trim();
        return n;
    }
    const displayName = isPortfolioConc
        ? _shortConcName(p.program_name)
        : normalizePortfolioName(stripCampusFromName(p.program_name));
    return `<tr class="${rowClass}" title="${escapeHtml(p.program_name)}">
        <td${nameCellAttrs}>${concBadge}${escapeHtml(displayName)}${toggleChevron}${subStatus}</td>
        ${_pc('degree',     isPortfolioConc ? 'Concentration' : extractPortfolioDegree(p.program_name))}
        ${_pc('college',    abbreviateCollege(effectiveCollege), null, effectiveCollege || '')}
        ${_pc('campus',     abbreviateCampus(effectiveCampus))}
        ${_pc('market2025',      market2025Badge)}
        ${_pc('perf2025',        perf2025Badge)}
        ${_pc('marketscore2025', escapeHtml(p.market_score_2025 || ''))}
        ${_pc('perfscore2025',   escapeHtml(p.performance_score_2025 || ''))}
        ${_pc('otp',        otpBadge)}
        ${_pc('svt',     svtBadge)}
        ${_pc('substatus', subStatusBadge)}
        ${_pc('speed',   speedBadge)}
        ${_pc('gls',     glsBadge)}
        ${_pc('launch',  escapeHtml(p.roster_launch_date || ''))}
        ${_pc('cim',       cimStep, 'step-cell')}
        ${_pc('cimcatalog', escapeHtml(p.cim_completion_date || ''))}
        ${_pc('cimterm',   escapeHtml(_pfEffTermLabel(p)))}
        ${_pc('svtnote',   escapeHtml(_svtCoordNote(p)))}
        ${_pc('cimchange',   (activeInWorkflow && p.cim_change_type) ? escapeHtml(p.cim_change_type) : (p.cim_program_id ? '—' : ''))}
        ${_pc('inworkflow',  p.cim_program_id ? 'Yes' : 'No')}
        ${_pc('inactadmit',  escapeHtml(p.inactivation_admission || ''))}
        ${_pc('inacttoday', (() => {
            const v = _inactAdmittingToday(p);
            if (!v) return '';
            return `<span class="portfolio-badge ${v === 'Yes' ? 'badge-good' : 'badge-bad'}">${v}</span>`;
        })())}
        ${_pc('offering',  escapeHtml(portfolioOfferingLabel(p)))}
        ${_pc('gtmentered', escapeHtml(p.gtm_entered_date || ''))}
        ${_pc('gtmtype',   escapeHtml(p.gtm_type || ''))}
        ${_pc('gtmdate',   escapeHtml(p.gtm_date || ''))}
        ${_pc('gtmfirst',  escapeHtml(p.gtm_first_term || ''))}
        ${_pc('gtmlast',   escapeHtml(p.gtm_last_term || ''))}
        ${_pc('gtmintake', escapeHtml(p.gtm_intake_terms || ''))}
        ${_pc('exitmasters', escapeHtml(p.exit_masters || ''))}
        ${_pc('notes',   noteCell, 'portfolio-note-cell')}
        ${_pc('emplreview', escapeHtml(p.otp_notes || ''))}
    </tr>`;
}

// Export the currently-visible, currently-filtered Portfolio rows to CSV.
// Mirrors the student-tracker pattern: visible columns × filtered rows,
// UTF-8 BOM for Excel, RFC-4180 quoting, timestamped filename.
function exportPortfolioCsv() {
    const filtered = getPortfolioFiltered();

    // Build a flat list of rows exactly as they appear in the table (top-level
    // programs + any currently-expanded concentration children).
    const rows = [];
    const concsByParent = {};
    allPortfolioPrograms.forEach(p => {
        if (p.concentration_of) {
            (concsByParent[p.concentration_of] = concsByParent[p.concentration_of] || []).push(p);
        }
    });
    const filteredIds = new Set(filtered.map(p => p.id));
    filtered.forEach(p => {
        rows.push({prog: p, isConc: false, parent: null});
        (concsByParent[p.id] || [])
            .filter(c => filteredIds.has(c.id) || true)  // concentrations follow parent
            .forEach(c => rows.push({prog: c, isConc: true, parent: p}));
    });

    // Per-column plain-text accessor (strips HTML, resolves values) -------
    function colText(p, key, isConc, parent) {
        const ep = isConc && parent ? parent : p;  // effective parent for inherited cols
        switch (key) {
            case 'degree':      return isConc ? 'Concentration' : extractPortfolioDegree(p.program_name);
            case 'college':     return (isConc && !p.college && parent) ? parent.college || '' : p.college || '';
            case 'campus':      return isConc && parent ? parent.campus || p.campus || '' : p.campus || '';
            case 'otp':         return p.otp_status || '';
            case 'svt':         return p.svt_status || '';
            case 'substatus':   return p.roster_sub_status || '';
            case 'speed':       return p.speed_to_market === 'True' ? 'Yes' : p.speed_to_market === 'False' ? 'No' : '';
            case 'gls':         return p.gls_status || '';
            case 'launch':      return p.roster_launch_date || '';
            case 'cim':         return p.cim_step || '';
            case 'cimcatalog':  return p.cim_completion_date || '';
            case 'cimterm':     return _pfEffTermLabel(p);
            case 'svtnote':     return _svtCoordNote(p);
            case 'cimchange':   return (p.cim_step && p.cim_change_type) ? p.cim_change_type : p.cim_program_id ? '' : '';
            case 'inworkflow':  return p.cim_program_id ? 'Yes' : 'No';
            case 'inactadmit':  return p.inactivation_admission || '';
            case 'inacttoday':  return _inactAdmittingToday(p) || '';
            case 'offering':    return portfolioOfferingLabel(p);
            case 'gtmentered':  return p.gtm_entered_date || '';
            case 'gtmtype':     return p.gtm_type || '';
            case 'gtmdate':     return p.gtm_date || '';
            case 'gtmfirst':    return p.gtm_first_term || '';
            case 'gtmlast':     return p.gtm_last_term || '';
            case 'gtmintake':   return p.gtm_intake_terms || '';
            case 'exitmasters': return p.exit_masters || '';
            case 'market2025':      return p.market_2025 || '';
            case 'perf2025':        return p.performance_2025 || '';
            case 'marketscore2025': return p.market_score_2025 != null ? String(p.market_score_2025) : '';
            case 'perfscore2025':   return p.performance_score_2025 != null ? String(p.performance_score_2025) : '';
            case 'notes':       return p.note || '';
            case 'emplreview':  return p.otp_notes || '';
            default:            return '';
        }
    }

    const visCols = PORTFOLIO_COLUMNS.filter(c => portfolioVisibleCols.has(c.key));
    const headers = ['Program', ...visCols.map(c => c.label)];
    const csvRows = rows.map(({prog: p, isConc, parent}) => {
        const name = isConc ? _portfolioShortConcName(p.program_name) : normalizePortfolioName(stripCampusFromName(p.program_name));
        return [name, ...visCols.map(c => colText(p, c.key, isConc, parent))];
    });

    const csv = [headers, ...csvRows].map(row =>
        row.map(cell => {
            const s = String(cell == null ? '' : cell);
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        }).join(',')
    ).join('\n');

    const blob = new Blob(['﻿' + csv], {type: 'text/csv;charset=utf-8'});
    const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
    const fname = `portfolio-${stamp}.csv`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Short-name helper for concentration sub-rows (used in the CSV export).
function _portfolioShortConcName(full) {
    const n = (full || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
    let m;
    m = n.match(/^.+?,\s*concentration\s+in\s+(.+?),\s*[A-Z]{1,7}\s*$/i); if (m) return m[1].trim();
    m = n.match(/^.+?\s+with\s+Concentration\s+in\s+(.+?),\s*[A-Z]{1,7}\s*$/i); if (m) return m[1].trim();
    m = n.match(/^.+?\s*[-—]\s*(.+?)\s+Concentration,?\s+[A-Z]{1,7}\s*$/i); if (m) return m[1].trim();
    m = n.match(/^\S+\s+(.+?)\s+Concentration\b.*?,\s*[A-Z]{1,7}\s*$/i); if (m) return m[1].trim();
    return n;
}

async function editPortfolioNote(el, programId) {
    const current = el.querySelector('.add-note') ? '' : el.innerText.trim();
    const textarea = document.createElement('textarea');
    textarea.className = 'portfolio-note-input';
    textarea.value = current;
    textarea.rows = 2;
    el.replaceWith(textarea);
    textarea.focus();

    async function save() {
        const note = textarea.value.trim();
        try {
            await fetch(`/api/portfolio/note/${encodeURIComponent(programId)}`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({note}),
            });
            // Update in-memory so re-render reflects new note
            const prog = allPortfolioPrograms.find(p => p.id === programId);
            if (prog) prog.note = note;
        } catch(e) { console.error('note save failed', e); }
        renderPortfolioTable();
    }

    textarea.addEventListener('blur', save);
    textarea.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
        if (e.key === 'Escape') { textarea.blur(); }
    });
}

async function refreshPortfolio() {
    const btn = document.getElementById('btn-portfolio-refresh');
    if (btn) { btn.textContent = 'Refreshing…'; btn.disabled = true; }
    try {
        const res = await fetch('/api/portfolio/refresh', {method: 'POST'});
        const data = await res.json();
        if (data.error) {
            alert('Refresh failed: ' + data.error);
        } else {
            await loadPortfolioDashboard();
        }
    } catch(e) {
        alert('Could not reach server: ' + e.message);
    } finally {
        if (btn) { btn.textContent = 'Refresh Data'; btn.disabled = false; }
    }
}
