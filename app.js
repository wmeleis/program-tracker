/* Program Approval Tracker - Frontend Logic */

let allPrograms = [];
let allCourses = [];
let allCatalogPages = [];
let cachedCatalogPipeline = [];
let currentView = 'programs'; // 'programs', 'courses', 'catalog', or 'portfolio'
let detailTabState = {}; // programId/courseId -> active detail tab key
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
// CIM Programs "New Offering" filter (programs only) — values 'new_concentration'
// / 'new_degree' from programs.new_offering (derived from the proposal XML, unlike
// CIM's status which almost never says "Added"). Multi-select OR.
let cimNewOfferingFilter = new Set();
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

    // Administrative buttons (Authenticate, Console, Mappings, References) stay
    // visible on every view — the top bar is consistent across all tabs.

    // Reset filters when switching views
    pipelineFilter = null;
    typeFilter = new Set();
    proposalFilter = new Set();
    cimNewOfferingFilter = new Set();
    programKindFilter = '';
    document.querySelectorAll('.type-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.proposal-btn').forEach(btn => btn.classList.remove('active-all', 'active-new', 'active-edit', 'active-inact', 'active-complete'));
    document.querySelectorAll('.smart-view-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.kind-btn').forEach(btn => btn.classList.remove('active'));
    cimMultiSel('filter-college').clear(); _updateCimMultiBtn('filter-college');
    cimMultiSel('filter-campus').clear();  _updateCimMultiBtn('filter-campus');
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
    // Administrative header buttons stay visible on every view (consistent top
    // bar). The portfolio-specific Export / Views / Columns live in the table
    // toolbar, alongside — not instead of — the admin buttons.
    const adminHdrBtns = ['auth-btn','console-btn','mappings-btn','discrepancies-btn','refs-btn']
        .map(id => document.getElementById(id)).filter(Boolean);
    adminHdrBtns.forEach(b => b.style.display = '');
    const lastUpdatedEl = document.getElementById('last-updated');
    const scanStatusEl  = document.getElementById('scan-status');
    const progressEl    = document.getElementById('progress-container');
    if (view === 'portfolio') {
        // #last-updated stays visible on Portfolio — it's part of the always-on
        // freshness line under the title, not a CIM-only control.
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
        if (lastUpdatedEl) lastUpdatedEl.style.display = '';
        if (scanStatusEl)  scanStatusEl.style.display  = '';
        if (progressEl)    progressEl.style.display    = 'none';  // stays hidden until scan runs
        if (portfolioFilters)    portfolioFilters.style.display = 'none';
        // The saved-Views tiles bar is Portfolio-only; hide it on CIM/Courses/
        // Catalog (renderPortfolioViewTiles only re-hides on a Portfolio action,
        // so without this it leaks in after Portfolio → CIM).
        const _viewTiles = document.getElementById('portfolio-view-tiles');
        if (_viewTiles)          _viewTiles.style.display = 'none';
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
        else if (view === 'portfolio') searchEl.placeholder = 'Search portfolio by program, code, college, campus (* and ? wildcards)…';
        else                            searchEl.placeholder = 'Search programs by name or banner code (* and ? wildcards)…';
    }

    // Show/hide the OTP/College perspective toggle for the new view.
    syncPerspectiveUI();

    // Collapsible filters: the "▸ Filters" toggle applies to ALL views. It sits
    // above every view's filter content and the collapse CSS hides the right
    // sections per view (program/course controls, catalog dropdowns, portfolio
    // filter bar + view tiles).
    // Portfolio uses the toggle above its filter bar; CIM/courses/catalog use
    // the one below the pipeline.
    const topToggle = document.getElementById('cim-filter-toggle-row-top');
    const cimToggle = document.getElementById('cim-filter-toggle-row-cim');
    if (topToggle) topToggle.style.display = (view === 'portfolio') ? 'block' : 'none';
    if (cimToggle) cimToggle.style.display = (view === 'portfolio') ? 'none' : 'block';
    // Views bar collapse toggle is Portfolio-only.
    const viewsToggle = document.getElementById('portfolio-views-toggle-row');
    if (viewsToggle) viewsToggle.style.display = (view === 'portfolio') ? 'block' : 'none';
    applyCimFiltersState();
    applyViewsBarState();

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
    if (window.trackerShell) window.trackerShell.refresh();   // sync rail nav/panels
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
    const counts = new Map();
    for (const p of allCatalogPages || []) {
        const c = getCatalogCollege(p);
        counts.set(c, (counts.get(c) || 0) + 1);
    }
    const items = Array.from(counts.entries())
        .sort((a, b) => abbreviateCollege(a[0]).localeCompare(abbreviateCollege(b[0])))
        .map(([name, count]) => ({ value: name, label: abbreviateCollege(name), count }));
    renderCimMulti('filter-college', items);
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
    const collegeSel = excludeFilter === 'college' ? new Set() : cimMultiSel('filter-college');
    const approverFilter = excludeFilter === 'approver' ? '' : (document.getElementById('filter-approver')?.value || '');
    const searchRaw = excludeFilter === 'search' ? '' : (document.getElementById('filter-search')?.value || '');
    const matchSearch = buildSearchMatcher(searchRaw);
    let pages = (allCatalogPages || []).slice();
    if (collegeSel.size) pages = pages.filter(p => collegeSel.has(getCatalogCollege(p)));
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
    const collegeSel = cimMultiSel('filter-college');
    const approverFilter = document.getElementById('filter-approver')?.value || '';
    let pages = (allCatalogPages || []).slice();
    if (collegeSel.size) {
        pages = pages.filter(p => collegeSel.has(getCatalogCollege(p)));
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
    if (cimMultiFilters[id]) {
        cimMultiSel(id).clear();
        // Re-render the checkbox list so boxes uncheck; button label resets.
        const dd = document.getElementById('fmd-' + id);
        if (dd) dd.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
        _updateCimMultiBtn(id);
    } else {
        const el = document.getElementById(id);
        if (el) el.value = '';
    }
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

// ── CIM College/Campus multi-select filters ────────────────────────────────
// The College and Campus filters on the CIM tracker (Programs / Courses /
// Catalog) are checkbox multi-selects backed by Sets, mirroring the Portfolio
// filter dropdowns. OR semantics: an item passes if its value is in the set;
// an empty set means "all". The button id is the filter id (e.g. filter-college);
// the checkbox list lives in #fmd-<id>, wrapped by #fmw-<id>.
const cimMultiFilters = {
    'filter-college': new Set(),
    'filter-campus':  new Set(),
};
// Sentinel that matches no real value. A filter set containing only this means
// "None selected → show nothing" (distinct from an empty set, which means
// "All → no restriction"). Because every read is `set.size && !set.has(value)`,
// a set of {sentinel} hides every row with no read-site changes.
const _FILTER_NONE = '__cim_filter_none__';
function cimMultiSel(id) { return cimMultiFilters[id] || new Set(); }

// Apply-on-close: checkbox multi-select dropdowns update their Set + button
// label live but defer the (heavy) table re-render until the dropdown closes.
// A dropdown marks itself dirty on each toggle; closing it commits & applies.
const _multiFilterDirty = new Set();
function _commitMultiFilter(id) {
    if (!_multiFilterDirty.has(id)) return;
    _multiFilterDirty.delete(id);
    if (id === 'filter-college' || id === 'filter-campus') {   // CIM tab
        applyFilters();
        updateClearButtons();
    } else if (id.indexOf('portfolio-filter-') === 0) {        // Portfolio tab
        if (typeof _portfolioViewTouch === 'function') _portfolioViewTouch();
        updateClearButtons();
        renderPortfolioTable();
    }
}
// Remove .open from a multi-select dropdown element and commit its deferred
// selection. Used by every close path (outside-click, button toggle, opening
// another dropdown).
function _closeMultiDropdown(el) {
    if (!el || !el.classList || !el.classList.contains('open')) return;
    el.classList.remove('open');
    const id = (el.id || '').replace(/^fmd-/, '');
    if (id) _commitMultiFilter(id);
}
function _closeAllMultiDropdowns() {
    document.querySelectorAll('.filter-multi-dropdown.open').forEach(_closeMultiDropdown);
}
function _cimMultiAllLabel(id) {
    return id === 'filter-college' ? 'All Colleges'
         : id === 'filter-campus'  ? 'All Campuses' : 'All';
}
function _updateCimMultiBtn(id) {
    const btn = document.getElementById(id);
    if (!btn) return;
    const set = cimMultiSel(id);
    const wrap = document.getElementById('fmw-' + id);
    const labelFor = id === 'filter-college' ? (v => abbreviateCollege(v)) : (v => v);
    if (set.size === 0)          { btn.textContent = _cimMultiAllLabel(id) + ' ▾'; if (wrap) wrap.classList.remove('has-value'); }
    else if (set.has(_FILTER_NONE)) { btn.textContent = 'None ▾';                  if (wrap) wrap.classList.add('has-value'); }
    else if (set.size === 1)     { btn.textContent = labelFor([...set][0]) + ' ▾'; if (wrap) wrap.classList.add('has-value'); }
    else                         { btn.textContent = set.size + ' selected ▾';     if (wrap) wrap.classList.add('has-value'); }
}
// items: [{value, label, count?}] (pre-sorted). Reflects the current Set state.
function renderCimMulti(id, items) {
    const dd = document.getElementById('fmd-' + id);
    if (!dd) { _updateCimMultiBtn(id); return; }
    const set = cimMultiSel(id);
    const _attr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    // "All" is a master checkbox: checked when every entry is selected (which we
    // store as the empty set = "no restriction"). In that state all the value
    // boxes render checked too; the "None" state ({sentinel}) renders them clear.
    const allState = set.size === 0;
    const allRow = `
        <label class="portfolio-col-check filter-all-row">
            <input type="checkbox" ${allState ? 'checked' : ''}
                   onchange="toggleCimMultiAll(${_attr(JSON.stringify(id))})">
            ${escapeHtml(_cimMultiAllLabel(id))}
        </label>`;
    dd.innerHTML = allRow + items.map(it => `
        <label class="portfolio-col-check">
            <input type="checkbox" class="filter-val-box" data-fval="${_attr(it.value)}"
                   ${allState || set.has(it.value) ? 'checked' : ''}
                   onchange="toggleCimMultiValue(${_attr(JSON.stringify(id))})">
            ${escapeHtml(it.label)}${it.count != null ? ` (${it.count})` : ''}
        </label>`).join('');
    _updateCimMultiBtn(id);
}
function toggleCimMultiFilter(id, event) {
    if (event) event.stopPropagation();
    const dd = document.getElementById('fmd-' + id);
    if (!dd) return;
    const wasOpen = dd.classList.contains('open');
    _closeAllMultiDropdowns();       // close + commit any open dropdown (incl. this one)
    if (!wasOpen) dd.classList.add('open');
}
function toggleCimMultiAll(id) {
    // Master toggle: check every entry (All → show everything) ⇄ clear every
    // entry (None → show nothing). "All" is stored as the empty set; "None" as
    // the no-match sentinel, so the read logic needs no change.
    const wasAll = cimMultiSel(id).size === 0;
    cimMultiFilters[id] = wasAll ? new Set([_FILTER_NONE]) : new Set();
    const nowAll = cimMultiSel(id).size === 0;
    const dd = document.getElementById('fmd-' + id);
    if (dd) dd.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = nowAll; });
    _updateCimMultiBtn(id);
    _multiFilterDirty.add(id);       // defer the table apply until the dropdown closes
}
// Rebuild the selection from the entry checkboxes' current state. All checked →
// empty set (All); none checked → {sentinel} (None); otherwise the explicit set.
function toggleCimMultiValue(id) {
    const dd = document.getElementById('fmd-' + id);
    if (!dd) return;
    const boxes = [...dd.querySelectorAll('.filter-val-box')];
    const selected = boxes.filter(cb => cb.checked).map(cb => cb.dataset.fval);
    if (selected.length === boxes.length)      cimMultiFilters[id] = new Set();               // all → All
    else if (selected.length === 0)            cimMultiFilters[id] = new Set([_FILTER_NONE]);  // none → None
    else                                       cimMultiFilters[id] = new Set(selected);
    const allBox = dd.querySelector('.filter-all-row input');
    if (allBox) allBox.checked = cimMultiSel(id).size === 0;
    _updateCimMultiBtn(id);
    _multiFilterDirty.add(id);       // defer the table apply until the dropdown closes
}
if (typeof window !== 'undefined') {
    window.toggleCimMultiFilter = toggleCimMultiFilter;
    window.toggleCimMultiValue = toggleCimMultiValue;
    window.toggleCimMultiAll = toggleCimMultiAll;
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
    // ALWAYS-visible info: app build time in the header (the last-refresh time is
    // already shown alongside it by loadScanStatus in #last-updated).
    const buildEl = document.getElementById('app-build');
    if (buildEl) buildEl.textContent = data.build_time ? ('Build: ' + _fmtDT(data.build_time)) : '';
    // The amber BANNER appears ONLY when a source is stale.
    let bar = document.getElementById('source-health-banner');
    const stale = ((data && data.sources) || []).filter(s => s.stale);
    if (!stale.length) { if (bar) bar.remove(); return; }
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'source-health-banner';
        document.body.insertBefore(bar, document.body.firstChild);
    }
    const items = stale.map(s => `${escapeHtml(s.name)} (${_fmtStaleAge(s.age_hours)})`).join(', ');
    bar.innerHTML = `<span class="shb-icon">⚠</span>`
        + `<span>Source data out of date — no refresh in over ${data.threshold_days} days: `
        + `<strong>${items}</strong></span>`;
}

// ── Collapsible CIM filters (programs/courses) ──────────────────────────────
// Mirrors the student/section tracker's "▸ Filters" toggle. Hides the filter
// controls (proposal/kind/smart-view buttons, dropdown filters); the perspective/
// level scope bar and pipeline stay visible. Remembered per-browser AND per-view:
// every view defaults COLLAPSED, and each view keeps its own open/closed state.
function _filtersOpenFor(view) {
    let v = null;
    try { v = localStorage.getItem('cim-filters-open-' + view); } catch (_) {}
    return v === 'true';   // default collapsed on every view until the user opens it
}
function applyCimFiltersState() {
    const open = _filtersOpenFor(currentView);
    document.body.classList.toggle('cim-filters-collapsed', !open);
    // Two toggle buttons (portfolio one above its bar, CIM one below the
    // pipeline) — keep both labels in sync.
    document.querySelectorAll('.cim-filter-toggle-btn').forEach(btn => {
        btn.textContent = open ? '▾ Filters' : '▸ Filters';
    });
}
function toggleCimFilters() {
    const open = !_filtersOpenFor(currentView);
    try { localStorage.setItem('cim-filters-open-' + currentView, open); } catch (_) {}
    applyCimFiltersState();
}
window.toggleCimFilters = toggleCimFilters;

// Portfolio "Views" bar collapse — independent of the Filters toggle. Defaults
// open (Views is the primary navigation); remembered per-browser. Uses a body
// class with !important since renderPortfolioViewTiles sets inline display.
function _viewsBarOpen() {
    let v = null;
    try { v = localStorage.getItem('portfolio-views-open'); } catch (_) {}
    return v !== 'false';
}
function applyViewsBarState() {
    const open = _viewsBarOpen();
    document.body.classList.toggle('portfolio-views-collapsed', !open);
    document.querySelectorAll('.views-toggle-btn').forEach(b => {
        b.textContent = open ? '▾ Views' : '▸ Views';
    });
}
function toggleViewsBar() {
    const open = !_viewsBarOpen();
    try { localStorage.setItem('portfolio-views-open', open); } catch (_) {}
    applyViewsBarState();
}
window.toggleViewsBar = toggleViewsBar;

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
        const colleges = (data.colleges || []).slice()
            .sort((a, b) => abbreviateCollege(a).localeCompare(abbreviateCollege(b)));
        renderCimMulti('filter-college', colleges.map(c => ({ value: c, label: abbreviateCollege(c) })));
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
        const colleges = (data.colleges || []).slice()
            .sort((a, b) => abbreviateCollege(a).localeCompare(abbreviateCollege(b)));
        renderCimMulti('filter-college', colleges.map(c => ({ value: c, label: abbreviateCollege(c) })));
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
        // App build time — set here (runs on every view) so it's reliable even
        // when loadSourceHealth (loadDashboard-only) doesn't run, e.g. Portfolio.
        const buildEl = document.getElementById('app-build');
        if (buildEl && data.build_time) buildEl.textContent = 'Build: ' + _fmtDT(data.build_time);
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
    const counts = {};
    baseFiltered.forEach(item => {
        if (item.college) counts[item.college] = (counts[item.college] || 0) + 1;
    });
    const items = Object.keys(counts)
        .sort((a, b) => abbreviateCollege(a).localeCompare(abbreviateCollege(b)))
        .map(c => ({ value: c, label: abbreviateCollege(c), count: counts[c] }));
    renderCimMulti('filter-college', items);
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
    renderCimMulti('filter-campus', sorted.map(c => ({ value: c, label: c })));
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
    const collegeSel = cimMultiSel('filter-college');
    const stepFilter = document.getElementById('filter-step').value;
    const campusSel = cimMultiSel('filter-campus');
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
        if (collegeScope && item.college !== collegeScope
                && !(item.concentration_colleges || []).includes(collegeScope)) return false;
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
        if (currentView === 'programs' && cimNewOfferingFilter.size
                && !cimNewOfferingFilter.has(item.new_offering)) return false;
        if (!ex.college && collegeSel.size && !collegeSel.has(item.college)
                && !(item.concentration_colleges || []).some(cc => collegeSel.has(cc))) return false;
        if (currentView === 'courses') {
            const subjSel = document.getElementById('filter-subject');
            const subjectFilter = subjSel ? subjSel.value : '';
            if (subjectFilter && courseSubjectCode(item) !== subjectFilter) return false;
        }
        if (stepFilter && item.current_step !== stepFilter) return false;
        if (currentView === 'programs' && campusSel.size && !campusSel.has(extractCampus(item.name))) return false;
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
        // Normalize to string so the id passed via the onclick handler
        // (openCimRecord('${id}') always stringifies) matches lookups.
        const id = String(item.id);
        const itemTitle = isCourseView ? item.code : item.name;
        const itemDisplay = isCourseView ? `${item.code}: ${item.title}` : item.name;
        const collegeDisplay = abbreviateCollege(item.college);
        const isComplete = !!item.completion_date && !item.current_step;
        const progress = isComplete ? 100 :
            (item.total_steps > 0 ? (item.completed_steps / item.total_steps * 100) : 0);
        const progressClass = isComplete ? 'complete' :
            (progress < 33 ? 'early' : progress < 66 ? 'mid' : 'late');
        // A proposal that adds a new concentration/degree reaches CIM as an "Edited"
        // revision (status Edited), so treat an in-workflow new offering as New
        // (green). Programs only; Deactivated still wins (red).
        const _isNewOffering = !isCourseView && !!item.current_step &&
            (item.new_offering === 'new_concentration' || item.new_offering === 'new_degree');
        const rowClass =
            (item.status === 'Deactivated' ? 'row-deactivated' :
             (item.status === 'Added' || _isNewOffering) ? 'row-added' :
             item.status === 'Edited' ? 'row-edited' : 'row-edited') +
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
            <tr class="program-row ${rowClass}"
                onclick="openCimRecord('${id}')">
                <td><strong>${escapeHtml(itemDisplay)}</strong></td>
                <td title="${escapeHtml(item.college || '')}">${escapeHtml(collegeDisplay)}</td>
                <td>${stepCellText}</td>
                <td>${progressCell}</td>
                <td>${daysCell}</td>
            </tr>
        `;
    }

    html += '</tbody></table>';
    container.innerHTML = html;
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
    // multi-modality programs that section also contains the Pathway Options form
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

        // Self-reference: this program IS the governance baseline. Show that
        // (with provenance) rather than "no reference"; the picker still lets
        // the user override it to another program / uploaded file.
        if (data.source === 'self') {
            const g = data.governance || {};
            let prov;
            if (g.completion_date) prov = `Went through governance — approved ${escapeHtml(g.completion_date)}.`;
            else if (g.approved && g.approved_version_date) prov = `Prior approved version on file (${escapeHtml(g.approved_version_date)}).`;
            else if (g.in_workflow) prov = 'Currently in workflow — has not completed governance yet.';
            else prov = 'No prior approved version on file yet.';
            contentEl.innerHTML = banner + picker +
                '<div class="reference-header">This program is the reference — it defines the academic baseline.</div>' +
                `<div class="workflow-meta">${prov} There is no separate program to align against; a deployment would compare against this record. Use the picker above to point at a different reference instead.</div>`;
            return;
        }

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
    if (tab === 'workflow') loadWorkflowDetail(programId, currentView === 'courses');
    else if (tab === 'campuses') loadCampusesDetail(programId);
    else if (tab === 'reference') loadReferenceDetail(programId);
    else if (tab === 'academic' || tab === 'compare') loadCompareDetail(programId);
    else if (tab === 'misaligned') loadMisalignedDetail(programId);
    else if (tab === 'changes') loadChangesDetail(programId);
    else if (tab === 'regulatory') loadRegulatoryDetail(programId);
    else if (tab === 'precheck') loadPrecheckDetail(programId);
    else if (tab === 'otp_disp') loadOtpDetail(programId, 'disposition');
    else if (tab === 'otp_notes') loadOtpDetail(programId, 'notes');
    else if (tab === 'review') loadOtpDetail(programId, 'review');
    else loadCurriculumDetail(programId);
}

async function loadPrecheckDetail(programId) {
    const el = document.getElementById(`detail-content-${programId}`);
    if (!el) return;
    el.innerHTML = '<div class="workflow-loading">Running Registrar check…</div>';
    let d;
    try {
        const resp = await fetch(`/api/program/${programId}/precheck`);
        d = await resp.json();
        if (d.error) throw new Error(d.error);
    } catch (e) {
        el.innerHTML = `<p style="color:#b91c1c;padding:8px">Could not run pre-check: ${e.message}</p>`;
        return;
    }
    const SEV = {block: ['#fee2e2', '#991b1b'], fix: ['#fef3c7', '#92400e'], advisory: ['#e0e7ff', '#3730a3']};
    let html = '<div style="padding:6px 4px;font-size:13px">';
    html += `<p style="color:#64748b;font-size:12px;margin:0 0 8px">Automated checks against the Registrar rules `
          + `(deterministic + CIM-data only; judgment rules are listed below for manual review). Source: ${d.source}.</p>`;
    if (!d.findings.length) {
        html += '<p style="color:#166534;background:#dcfce7;padding:6px 10px;border-radius:6px;display:inline-block">No automated flags.</p>';
    } else {
        html += `<h4 style="margin:4px 0 6px">Flags (${d.findings.length})</h4>`;
        for (const f of d.findings) {
            const s = SEV[f.severity] || ['#f1f5f9', '#475569'];
            html += `<div style="border-left:3px solid ${s[1]};background:${s[0]}22;padding:6px 10px;margin:0 0 6px;border-radius:0 6px 6px 0">
                <span style="background:${s[0]};color:${s[1]};font-size:10px;padding:1px 6px;border-radius:8px;font-weight:600">${f.severity.toUpperCase()}</span>
                <span style="color:#94a3b8;font-size:11px;margin-left:6px">${f.id} · ${escapeHtml(f.theme)}</span>
                <div style="margin-top:3px">${escapeHtml(f.message)}</div>
                ${f.evidence ? `<div style="color:#64748b;font-size:11px;font-family:monospace;margin-top:2px">${escapeHtml(f.evidence)}</div>` : ''}
            </div>`;
        }
    }
    // AI review section (llm judgment rules) — evaluated on demand via Claude.
    html += `<div id="precheck-llm-${programId}" style="margin-top:12px;border-top:1px solid #eef2f7;padding-top:10px">
        <div style="display:flex;align-items:center;gap:8px">
          <h4 style="margin:0">AI review of judgment rules</h4>
          <button onclick="event.stopPropagation(); loadPrecheckLLM(${programId}, false)"
            style="font-size:11px;padding:3px 10px;border:1px solid var(--accent);background:#eff6ff;color:var(--accent);border-radius:6px;cursor:pointer">Run AI review</button>
        </div>
        <p style="color:#64748b;font-size:11px;margin:4px 0 0">Uses Claude to evaluate the judgment rules against this program's curriculum &amp; internal CIM fields. Cached per proposal version.</p>
      </div>`;
    html += '</div>';
    el.innerHTML = html;
}

// AI pass over the judgment (llm) Registrar rules. Renders into the section
// created by loadPrecheckDetail. Needs the Flask backend + an Anthropic key.
async function loadPrecheckLLM(programId, force) {
    const box = document.getElementById(`precheck-llm-${programId}`);
    if (!box) return;
    const btn = box.querySelector('button');
    if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
    let d;
    try {
        const resp = await fetch(`/api/program/${programId}/precheck_llm${force ? '?force=1' : ''}`);
        d = await resp.json();
    } catch (e) {
        d = {available: false, reason: e.message};
    }
    let h = `<div style="display:flex;align-items:center;gap:8px">
          <h4 style="margin:0">AI review of judgment rules</h4>`;
    if (d.available) {
        h += `<button onclick="event.stopPropagation(); loadPrecheckLLM(${programId}, true)"
              style="font-size:11px;padding:3px 10px;border:1px solid #cbd5e1;background:#f8fafc;color:#475569;border-radius:6px;cursor:pointer">Re-run</button>
          <span style="color:#94a3b8;font-size:11px">${d.model}${d.cached ? ' · cached' : ''}</span></div>`;
        const VER = {
            flag: ['#fee2e2', '#991b1b', 'FLAG'],
        };
        // Only show FLAG — hide OK / N/A / UNCLEAR (nothing the reviewer must act on).
        const shown = d.findings.filter(f => f.verdict === 'flag');
        const nflag = d.n_flag || 0;
        h += `<p style="font-size:12px;margin:6px 0;color:${nflag ? '#991b1b' : '#166534'}">`
           + `${nflag ? nflag + ' rule(s) flagged' : 'No judgment rules flagged'} `
           + `<span style="color:#94a3b8">(${d.findings.length} evaluated)</span></p>`;
        for (const f of shown) {
            const v = VER[f.verdict] || VER.unclear;
            h += `<div style="border-left:3px solid ${v[1]};background:${v[0]}55;padding:5px 10px;margin:0 0 5px;border-radius:0 6px 6px 0">
                <span style="background:${v[0]};color:${v[1]};font-size:10px;padding:1px 6px;border-radius:8px;font-weight:600">${v[2]}</span>
                <span style="color:#94a3b8;font-size:11px;margin-left:6px">${f.id} · ${escapeHtml(f.theme)}</span>
                <div style="font-size:12px;color:#334155;margin-top:2px">${escapeHtml(f.rule)}</div>
                ${f.reason ? `<div style="font-size:12px;color:${v[1]};margin-top:2px">${escapeHtml(f.reason)}</div>` : ''}
            </div>`;
        }
    } else {
        h += `</div><p style="color:#b45309;background:#fffbeb;font-size:12px;padding:6px 10px;border-radius:6px;margin:6px 0">
              ${escapeHtml(d.reason || 'AI review unavailable.')}</p>
              <button onclick="event.stopPropagation(); loadPrecheckLLM(${programId}, false)"
                style="font-size:11px;padding:3px 10px;border:1px solid var(--accent);background:#eff6ff;color:var(--accent);border-radius:6px;cursor:pointer">Retry</button>`;
    }
    box.innerHTML = h;
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
    // twice in MBA Online but once in the MBA reference → the
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

// One-line summary of a course-level diff, shown atop the Academic Alignment
// side-by-side (this merges the former "Alignment Summary" into the view).
// `diff` is oriented compareCurricula(thisProgram, reference): 'removed' =
// only in this program, 'added' = only in the reference.
function _alignmentSummaryLine(diff) {
    const here = _redCoursesFromDiff(diff).length;
    const there = _greenCoursesFromDiff(diff).length;
    if (!here && !there)
        return '<div class="align-summary align-ok">No course-level differences from the reference.</div>';
    const parts = [];
    if (here)  parts.push(`<b>${here}</b> course${here === 1 ? '' : 's'} only in this program`);
    if (there) parts.push(`<b>${there}</b> only in the reference`);
    return `<div class="align-summary align-diff">${parts.join(' &#183; ')}</div>`;
}

// Academic Alignment: current curriculum vs. the program's governance-approved
// reference (override → Boston → self). When the program IS its own reference
// (source 'self'), this is identity — the program defines the baseline — so we
// show that, not a diff (the temporal self-diff lives in the Changes tab).
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

        // Self-reference: this program IS the governance baseline. With no
        // deployments there is nothing to align against (identity). With
        // deployments, fall through to the deployment-comparison branch below,
        // which shows how each deployment aligns TO this reference.
        if (refData0.source === 'self' && !(deploymentIds && deploymentIds.length > 0)) {
            const g = refData0.governance || {};
            let prov;
            if (g.completion_date)  prov = `Went through governance — approved ${escapeHtml(g.completion_date)}.`;
            else if (g.in_workflow) prov = 'Currently in workflow — not yet approved.';
            else                    prov = 'No prior approved version on file yet.';
            updateCompareButton(programId, true);
            contentEl.innerHTML =
                '<div class="reference-header">This program is the reference — it defines the academic baseline.</div>'
                + `<div class="workflow-meta">${prov} There is nothing to align against here; a deployment would compare against this record. To see how this proposal differs from its own prior approved version, use the <b>Program Changes</b> tab.</div>`;
            return;
        }

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
                contentEl.innerHTML = `${header}${_alignmentSummaryLine(diff)}
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
                contentEl.innerHTML = `${header}${_alignmentSummaryLine(diff)}
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

            let html = `<div class="reference-header">This program is the reference — showing how its ${deploymentIds.length} campus deployment${deploymentIds.length > 1 ? 's' : ''} compare to it.</div>`;

            if (allIdentical) {
                html += '<div class="compare-identical">All campus deployments are identical to this reference.</div>';
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
        if (tab.dataset.tab === 'academic') {  // the "Academic Alignment" tab
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

// Legacy alias — CIM rows now open the shared record drawer instead of an
// inline expansion. Kept in case anything else calls toggleRow(id).
function toggleRow(programId) {
    openCimRecord(programId);
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

// ---- Ideas modal (add/edit/remove portfolio ideas & new projects; local-only) ----
// Ideas are the manual, seed-backed portfolio additions with no CIM/SVT record.
// The Credential shown in the table is derived from the program NAME (like every
// other portfolio row), so the name should carry it (e.g. "Quality Assurance, MS").
let _ideasCache = [];
// Common graduate credentials for the Credential datalist (free-text still allowed).
const _IDEA_CREDENTIALS = ['MS', 'MA', 'MPS', 'MBA', 'MEd', 'MFA', 'MPP', 'MPH', 'MSN',
    'MArch', 'MDes', 'Graduate Certificate', 'CAGS', 'PhD', 'EdD', 'DNP', 'DPT', 'OTD',
    'PharmD', 'DrPH', 'JD', 'LLM', 'DPS'];
function _ensureIdeasModal() {
    let m = document.getElementById('ideas-modal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'ideas-modal';
    m.className = 'modal-overlay';
    m.style.display = 'none';
    m.addEventListener('click', e => { if (e.target.id === 'ideas-modal') closeIdeasModal(); });
    const fld = (lbl, inner) => `<label style="display:block;margin:0 0 8px"><span style="display:block;font-size:11px;color:#64748b;margin:0 0 2px">${lbl}</span>${inner}</label>`;
    const inp = 'width:100%;padding:6px 8px;font-size:13px;border:1px solid var(--border,#cbd5e1);border-radius:6px;box-sizing:border-box';
    m.innerHTML = `
      <div class="modal-panel" style="max-width:720px" onclick="event.stopPropagation()">
        <div class="modal-header">
          <h2>Portfolio ideas &amp; new projects</h2>
          <button class="modal-close" onclick="closeIdeasModal()">&times;</button>
        </div>
        <div class="modal-body" style="font-size:13px">
          <p style="color:#64748b;margin:0 0 10px">Ideas and new projects that have no CIM or SVT record yet. They appear in the Portfolio marked as ideas; reconcile them to CIM/SVT once they enter those systems.</p>
          <input type="hidden" id="idea-f-id">
          <div style="display:flex;gap:10px">
            <div style="flex:2">${fld('Program name <span style="color:#b91c1c">*</span>', `<input id="idea-f-name" style="${inp}" placeholder="Quality Assurance">`)}</div>
            <div style="flex:1">${fld('Credential', `<input id="idea-f-cred" list="idea-cred-list" style="${inp}" placeholder="MS"><datalist id="idea-cred-list">${_IDEA_CREDENTIALS.map(c => `<option value="${escapeHtml(c)}"></option>`).join('')}</datalist>`)}</div>
          </div>
          <div style="display:flex;gap:10px">
            <div style="flex:1">${fld('Level', `<select id="idea-f-level" style="${inp}"><option value="Graduate">Graduate</option><option value="Undergraduate">Undergraduate</option></select>`)}</div>
            <div style="flex:1">${fld('Kind', `<select id="idea-f-kind" style="${inp}"><option value="idea">Idea</option><option value="new project">New project</option></select>`)}</div>
          </div>
          <div style="display:flex;gap:10px">
            <div style="flex:1">${fld('College', `<select id="idea-f-college" style="${inp}"></select>`)}</div>
            <div style="flex:1">${fld('Campus', `<select id="idea-f-campus" style="${inp}"></select>`)}</div>
          </div>
          ${fld('Note — the “why” (rationale, source of the idea)', `<textarea id="idea-f-note" rows="3" style="${inp};resize:vertical"></textarea>`)}
          <div style="display:flex;gap:8px;align-items:center;margin:4px 0 0">
            <button id="idea-save" style="padding:6px 14px;font-size:13px;border:1px solid #2563eb;background:#eff6ff;color:#1e40af;border-radius:6px;cursor:pointer">Add idea</button>
            <button id="idea-cancel-edit" style="display:none;padding:6px 12px;font-size:13px;border:1px solid var(--border,#cbd5e1);background:#fff;border-radius:6px;cursor:pointer">Cancel edit</button>
            <span id="idea-save-msg" style="color:#16a34a;font-size:12px"></span>
          </div>
          <hr style="margin:16px 0;border:none;border-top:1px solid var(--border,#e2e8f0)">
          <div style="font-weight:600;margin:0 0 8px">Current ideas <span id="idea-count" style="color:#94a3b8;font-weight:400"></span></div>
          <div id="ideas-list">Loading…</div>
        </div>
      </div>`;
    document.body.appendChild(m);
    m.querySelector('#idea-save').onclick = _ideaSave;
    m.querySelector('#idea-cancel-edit').onclick = _ideaResetForm;
    return m;
}
function openIdeasModal() {
    if (window._staticMode) { alert('Ideas can only be added on the local admin app.'); return; }
    _ensureIdeasModal().style.display = 'flex';
    _ideaPopulateSelects();
    _ideaResetForm();
    _renderIdeasList();
}
function closeIdeasModal() {
    const m = document.getElementById('ideas-modal');
    if (m) m.style.display = 'none';
}
function _ideaPopulateSelects() {
    const colSel = document.getElementById('idea-f-college');
    const campSel = document.getElementById('idea-f-campus');
    // Colleges: the app's canonical, fixed set (COLLEGE_ABBREVS keys) — NOT the
    // dynamic in-use list — so all colleges are always offered, sorted by abbrev.
    const colleges = (typeof COLLEGE_ABBREVS === 'object')
        ? Object.keys(COLLEGE_ABBREVS).sort((a, b) => abbreviateCollege(a).localeCompare(abbreviateCollege(b)))
        : ((typeof getPortfolioFieldValues === 'function') ? getPortfolioFieldValues('college') : []);
    const campuses = (typeof getPortfolioFieldValues === 'function') ? getPortfolioFieldValues('campus') : [];
    if (colSel) colSel.innerHTML = '<option value="">— select —</option>' +
        colleges.filter(Boolean).map(c => `<option value="${escapeHtml(c)}">${escapeHtml(abbreviateCollege(c))} — ${escapeHtml(c)}</option>`).join('');
    if (campSel) campSel.innerHTML = '<option value="">— none / Boston —</option>' +
        campuses.filter(Boolean).map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
}
function _ideaResetForm() {
    const g = id => document.getElementById(id);
    if (!g('idea-f-name')) return;
    g('idea-f-id').value = '';
    g('idea-f-name').value = '';
    g('idea-f-cred').value = '';
    g('idea-f-level').value = 'Graduate';
    g('idea-f-kind').value = 'idea';
    g('idea-f-college').value = '';
    g('idea-f-campus').value = '';
    g('idea-f-note').value = '';
    g('idea-save').textContent = 'Add idea';
    g('idea-cancel-edit').style.display = 'none';
    g('idea-save-msg').textContent = '';
}
async function _renderIdeasList() {
    const box = document.getElementById('ideas-list');
    if (!box) return;
    box.innerHTML = 'Loading…';
    try {
        const data = await (await fetch('/api/portfolio/ideas')).json();
        _ideasCache = data.ideas || [];
    } catch (e) {
        box.innerHTML = `<p style="color:#b91c1c">Could not load ideas: ${e.message}</p>`;
        return;
    }
    const cnt = document.getElementById('idea-count');
    if (cnt) cnt.textContent = `(${_ideasCache.length})`;
    if (!_ideasCache.length) { box.innerHTML = '<p style="color:#94a3b8">No ideas yet.</p>'; return; }
    box.innerHTML = _ideasCache.map(r => {
        const meta = [r.college, r.campus, r.level].filter(Boolean).join(' · ');
        const kind = (r.idea_kind === 'new project') ? 'New project' : 'Idea';
        const note = (r.note || '').trim();
        return `<div style="display:flex;gap:8px;align-items:flex-start;padding:8px 0;border-top:1px solid var(--border,#f1f5f9)">
            <div style="flex:1;min-width:0">
              <div style="font-weight:600">${escapeHtml(r.program_name)} <span style="font-weight:400;font-size:11px;color:#2563eb;border:1px solid #bfdbfe;border-radius:4px;padding:0 5px">${kind}</span></div>
              <div style="color:#64748b;font-size:12px">${escapeHtml(meta || '—')}</div>
              ${note ? `<div style="color:#475569;font-size:12px;margin:2px 0 0">${escapeHtml(note)}</div>` : ''}
            </div>
            <button onclick="_ideaEditFromList('${escapeHtml(r.id)}')" style="padding:3px 10px;font-size:12px;border:1px solid var(--border,#cbd5e1);background:#fff;border-radius:6px;cursor:pointer">Edit</button>
            <button onclick="_ideaRemove('${escapeHtml(r.id)}')" style="padding:3px 10px;font-size:12px;border:1px solid #fecaca;background:#fef2f2;color:#b91c1c;border-radius:6px;cursor:pointer">Remove</button>
          </div>`;
    }).join('');
}
function _ideaEditFromList(id) {
    const r = _ideasCache.find(x => x.id === id);
    if (!r) return;
    const g = i => document.getElementById(i);
    g('idea-f-id').value = r.id;
    // Decompose the stored "Subject, Credential" name back into the two fields.
    const cred = r.idea_credential || '';
    let subj = r.program_name || '';
    if (cred && subj.endsWith(', ' + cred)) subj = subj.slice(0, -(cred.length + 2));
    g('idea-f-name').value = subj;
    g('idea-f-cred').value = cred;
    g('idea-f-level').value = r.level || 'Graduate';
    g('idea-f-kind').value = (r.idea_kind === 'new project') ? 'new project' : 'idea';
    g('idea-f-college').value = r.college || '';
    g('idea-f-campus').value = r.campus || '';
    g('idea-f-note').value = r.note || '';
    g('idea-save').textContent = 'Save changes';
    g('idea-cancel-edit').style.display = '';
    g('idea-save-msg').textContent = '';
    document.getElementById('ideas-modal').querySelector('.modal-body').scrollTop = 0;
}
async function _ideaSave() {
    const g = id => document.getElementById(id);
    const subject = g('idea-f-name').value.trim();
    if (!subject) { g('idea-save-msg').style.color = '#b91c1c'; g('idea-save-msg').textContent = 'Program name is required.'; return; }
    const payload = {
        id: g('idea-f-id').value || undefined,
        subject,
        credential: g('idea-f-cred').value.trim(),
        level: g('idea-f-level').value,
        kind: g('idea-f-kind').value,
        college: g('idea-f-college').value,
        campus: g('idea-f-campus').value,
        note: g('idea-f-note').value.trim(),
    };
    const btn = g('idea-save'); btn.disabled = true;
    try {
        const res = await fetch('/api/portfolio/ideas', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const j = await res.json();
        if (!res.ok || !j.ok) throw new Error(j.error || 'save failed');
        const wasEdit = !!payload.id;
        _ideaResetForm();
        g('idea-save-msg').style.color = '#16a34a';
        g('idea-save-msg').textContent = wasEdit ? 'Saved.' : 'Added.';
        await _renderIdeasList();
        if (typeof loadPortfolioDashboard === 'function') loadPortfolioDashboard();
    } catch (e) {
        g('idea-save-msg').style.color = '#b91c1c';
        g('idea-save-msg').textContent = 'Error: ' + e.message;
    } finally { btn.disabled = false; }
}
async function _ideaRemove(id) {
    const r = _ideasCache.find(x => x.id === id);
    if (!confirm(`Remove idea “${r ? r.program_name : id}” from the portfolio?`)) return;
    try {
        const res = await fetch(`/api/portfolio/ideas/${encodeURIComponent(id)}/remove`, { method: 'POST' });
        if (!res.ok) throw new Error('remove failed');
        await _renderIdeasList();
        if (typeof loadPortfolioDashboard === 'function') loadPortfolioDashboard();
    } catch (e) { alert('Could not remove: ' + e.message); }
}

// ---- Mappings modal (persistent SVT→CIM dispositions; local-only) ----
function openMappingsModal() {
    const m = document.getElementById('mappings-modal');
    if (m) m.style.display = 'flex';
    loadSvtDispositions();
}
function closeMappingsModal() {
    const m = document.getElementById('mappings-modal');
    if (m) m.style.display = 'none';
}
function closeMappingsModalIfBackdrop(event) {
    if (event.target.id === 'mappings-modal') closeMappingsModal();
}

// ---- Discrepancies modal (consolidated report; local-only) ----
function openDiscrepanciesModal() {
    const m = document.getElementById('discrepancies-modal');
    if (m) m.style.display = 'flex';
    loadDiscrepancies();
    const dl = document.getElementById('disc-download');
    if (dl) dl.onclick = () => { window.location = '/api/discrepancies/download'; };
    const gen = document.getElementById('disc-generate');
    if (gen) gen.onclick = discGenerate;
}
function closeDiscrepanciesModal() {
    const m = document.getElementById('discrepancies-modal');
    if (m) m.style.display = 'none';
}
function closeDiscrepanciesModalIfBackdrop(event) {
    if (event.target.id === 'discrepancies-modal') closeDiscrepanciesModal();
}

async function loadDiscrepancies() {
    const body = document.getElementById('discrepancies-body');
    if (!body) return;
    body.innerHTML = 'Loading…';
    try {
        const data = await (await fetch('/api/discrepancies')).json();
        renderDiscrepancies(data);
    } catch (e) {
        body.innerHTML = `<p style="color:#b91c1c">Could not load discrepancies: ${e.message}</p>`;
    }
}

function renderDiscrepancies(data) {
    const body = document.getElementById('discrepancies-body');
    const asof = document.getElementById('disc-asof');
    if (asof) asof.textContent = data.state_generated_at
        ? `New-since baseline: last report ${new Date(data.state_generated_at).toLocaleString()}`
        : 'No prior report yet — nothing marked new on this first view.';
    const summary = data.summary || [];
    const total = summary.reduce((a, s) => a + s.count, 0);
    const totalNew = summary.reduce((a, s) => a + s.new, 0);
    // Summary table
    let html = '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px">';
    // map each section key → its source-pair group (for grouped headers below)
    const _groupByKey = {};
    (data.sections || []).forEach(s => { _groupByKey[s.key] = s.group || ''; });
    html += '<thead><tr style="background:#eff6ff;text-align:left"><th style="padding:4px 8px">Discrepancy type</th><th style="padding:4px 8px">Count</th><th style="padding:4px 8px">New</th></tr></thead><tbody>';
    let _sumGroup = null;
    for (const s of summary) {
        const g = _groupByKey[s.key] || '';
        if (g && g !== _sumGroup) {
            _sumGroup = g;
            html += `<tr style="background:#f1f5f9"><td colspan="3" style="padding:5px 8px;font-weight:600;color:#334155">${escapeHtml(g)}</td></tr>`;
        }
        html += `<tr style="border-top:1px solid #e2e8f0;cursor:pointer" onclick="document.getElementById('disc-sec-${s.key}')?.scrollIntoView({behavior:'smooth'})">
            <td style="padding:4px 8px 4px 20px">${escapeHtml(s.title)}</td>
            <td style="padding:4px 8px">${s.count}</td>
            <td style="padding:4px 8px">${s.new ? `<span style="background:#fef3c7;color:#92400e;padding:1px 7px;border-radius:8px">${s.new} new</span>` : ''}</td>
        </tr>`;
    }
    html += `<tr style="border-top:2px solid #cbd5e1;font-weight:500"><td style="padding:4px 8px">TOTAL</td><td style="padding:4px 8px">${total}</td><td style="padding:4px 8px">${totalNew || ''}</td></tr>`;
    html += '</tbody></table>';
    // One collapsible section per type, grouped by source pair
    let _detGroup = null;
    for (const sec of (data.sections || [])) {
        if (sec.group && sec.group !== _detGroup) {
            _detGroup = sec.group;
            html += `<div style="margin:16px 0 6px;font-weight:600;color:#1e293b;font-size:13px;border-bottom:1px solid #cbd5e1;padding-bottom:3px">${escapeHtml(sec.group)}</div>`;
        }
        const openAttr = sec.rows.some(r => r._new) ? ' open' : '';
        html += `<details id="disc-sec-${sec.key}"${openAttr} style="margin:0 0 8px;border:1px solid #e2e8f0;border-radius:6px">
            <summary style="cursor:pointer;padding:6px 10px;font-weight:500">${escapeHtml(sec.title)} <span style="color:#64748b;font-weight:400">(${sec.rows.length})</span></summary>`;
        if (sec.rows.length) {
            html += '<table style="width:100%;border-collapse:collapse;font-size:11px"><thead><tr style="background:#f8fafc;text-align:left">';
            html += '<th style="padding:3px 8px"></th>' + sec.columns.map(c => `<th style="padding:3px 8px">${escapeHtml(c)}</th>`).join('');
            html += '</tr></thead><tbody>';
            for (const r of sec.rows) {
                const bg = r._new ? 'background:#fffdf5' : '';
                html += `<tr style="border-top:1px solid #eef2f7;${bg}">`;
                html += `<td style="padding:3px 8px">${r._new ? '<span style="background:#fef3c7;color:#92400e;font-size:10px;padding:0 5px;border-radius:6px">NEW</span>' : ''}</td>`;
                html += sec.fields.map(f => `<td style="padding:3px 8px">${escapeHtml(r[f] || '')}</td>`).join('');
                html += '</tr>';
            }
            html += '</tbody></table>';
        } else {
            html += '<p style="padding:6px 10px;color:#64748b;margin:0">None.</p>';
        }
        html += '</details>';
    }
    body.innerHTML = html;
}

async function discGenerate() {
    const btn = document.getElementById('disc-generate');
    if (btn) { btn.textContent = 'Generating… (~1 min, incl. UIP)'; btn.disabled = true; }
    try {
        const data = await (await fetch('/api/discrepancies/generate', {method: 'POST'})).json();
        if (!data.ok) throw new Error(data.error || 'failed');
        await loadDiscrepancies();
    } catch (e) {
        alert('Generate failed: ' + e.message);
    } finally {
        if (btn) { btn.textContent = 'Generate new report'; btn.disabled = false; }
    }
}

// ---- SVT dispositions editor (Flask-local tool) ----
let _svtDispRows = [];
let _svtCimPrograms = [];
let _svtCimNameById = {};   // id → program name (for initializing the picker)
let _svtCimIdByName = {};   // program name → id (to resolve a picked name)

function _buildSvtCimMaps() {
    _svtCimNameById = {}; _svtCimIdByName = {};
    for (const p of _svtCimPrograms) {
        _svtCimNameById[String(p.id)] = p.name;
        _svtCimIdByName[p.name] = String(p.id);
    }
}

// Selected-program chips for the (multi-select) CIM program picker. Reads the
// comma-separated ids from the row's hidden .svt-parent and renders one removable
// chip per program, each showing the full name (with a leading campus badge) so
// the campus is always visible.
function _svtChipIds(k) {
    const hidden = document.querySelector(`.svt-parent[data-k="${CSS.escape(k)}"]`);
    return String(hidden && hidden.value || '').split(',').map(s => s.trim()).filter(Boolean);
}
function _svtRenderChips(k) {
    const box = document.querySelector(`.svt-cim-picked[data-k="${CSS.escape(k)}"]`);
    if (!box) return;
    const ids = _svtChipIds(k);
    if (!ids.length) {
        box.innerHTML = '<span style="color:#94a3b8">— no CIM program selected yet (pick one or more from the list)</span>';
        return;
    }
    box.innerHTML = ids.map(id => {
        const name = _svtCimNameById[id] || ('id ' + id);
        const m = name.match(/\(([^)]+)\)\s*$/);
        const badge = m ? `<span style="display:inline-block;background:#eef2ff;color:#3730a3;border-radius:4px;padding:0 5px;margin-right:5px;font-size:10px;font-weight:600;white-space:nowrap">${escapeHtml(m[1])}</span>` : '';
        return `<span class="svt-chip" style="display:inline-flex;align-items:flex-start;gap:5px;max-width:100%;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;padding:2px 7px;margin:2px 5px 2px 0;white-space:normal;word-break:break-word">${badge}<span>${escapeHtml(name)}</span><span class="svt-chip-x" data-id="${escapeHtml(id)}" title="remove" style="cursor:pointer;color:#64748b;font-weight:700;padding-left:2px">×</span></span>`;
    }).join('');
}

async function loadSvtDispositions() {
    const bodyEl = document.getElementById('svt-disp-body');
    if (!bodyEl) return;
    try {
        const resp = await fetch('/api/svt_overrides');
        const data = await resp.json();
        _svtDispRows = data.rows || [];
        _svtCimPrograms = data.cim_programs || [];
        _buildSvtCimMaps();
        renderSvtDispositions();
        const s = document.getElementById('svt-disp-search');
        const f = document.getElementById('svt-disp-filter');
        if (s) s.oninput = renderSvtDispositions;
        if (f) f.onchange = renderSvtDispositions;
        const rb = document.getElementById('svt-disp-reingest');
        if (rb) rb.onclick = svtReingest;
        const mb = document.getElementById('svt-disp-reviewed');
        if (mb) mb.onclick = svtMarkAllShownReviewed;
    } catch (e) {
        bodyEl.innerHTML = `<p style="color:#b91c1c">Could not load SVT dispositions: ${e.message}</p>`;
    }
}

async function svtMarkReviewed(keys) {
    if (!keys.length) return;
    await fetch('/api/svt_overrides/reviewed', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({svt_keys: keys})});
    // Clear the flag locally and re-render so reviewed rows drop their highlight.
    for (const r of _svtDispRows) if (keys.includes(r.svt_key)) { r.flagged = false; r.is_new = false; }
    renderSvtDispositions();
}

function svtMarkAllShownReviewed() {
    // Only the currently-rendered (filtered) flagged rows.
    const keys = [...document.querySelectorAll('#mappings-modal tbody tr[data-k]')]
        .map(tr => tr.getAttribute('data-k'))
        .filter(k => (_svtDispRows.find(r => r.svt_key === k) || {}).flagged);
    if (!keys.length) { alert('No new/changed rows in the current view.'); return; }
    svtMarkReviewed(keys);
}

// Mapping status = the auto-classifier's result, collapsed to three confidence
// buckets (capitalized). matched/concentration/non_program are all confident
// classifications the user just confirms; added is a best guess; pending/mismatch
// couldn't be classified. Stored outcome values are unchanged — display only.
// The detail line under the badge disambiguates (e.g. "under <parent>").
const _SVT_OUTCOME_BADGE = {
    matched:       ['#dcfce7', '#166534', 'High-Confidence Auto Match to CIM'],
    concentration: ['#dcfce7', '#166534', 'High-Confidence Auto Match to CIM'],
    non_program:   ['#dcfce7', '#166534', 'High-Confidence Auto Match to CIM'],
    added:         ['#fef3c7', '#92400e', 'New — Not in CIM'],
    pending:       ['#fee2e2', '#991b1b', 'Unknown'],
    mismatch:      ['#fee2e2', '#991b1b', 'Unknown'],
};

// Append " (Campus)" to a label unless the campus name already appears in it —
// used for both the SVT entry and the mapping-status guess so campus is explicit.
function _campusParen(text, campus) {
    text = text || '';
    if (!campus || text.toLowerCase().includes(campus.toLowerCase())) return text;
    return `${text} (${campus})`;
}

function _svtBadge(outcome) {
    const b = _SVT_OUTCOME_BADGE[outcome] || ['#f1f5f9', '#475569', outcome || '—'];
    return `<span style="background:${b[0]};color:${b[1]};font-size:11px;padding:2px 7px;border-radius:10px;white-space:nowrap">${b[2]}</span>`;
}

function renderSvtDispositions() {
    const bodyEl = document.getElementById('svt-disp-body');
    if (!bodyEl) return;
    const q = (document.getElementById('svt-disp-search')?.value || '').trim().toLowerCase();
    const filter = document.getElementById('svt-disp-filter')?.value || 'attention';
    let rows = _svtDispRows.filter(r => {
        if (q && !(`${r.name} ${r.svt_key}`.toLowerCase().includes(q))) return false;
        if (filter === 'all') return true;
        // "Needs attention" = an unresolved outcome (added / pending / mismatch)
        // that hasn't been confirmed yet. `flagged` is true when the row is new
        // or changed since it was last reviewed, so confirming a row drops it out
        // of this queue until it next changes (then it re-appears). Matched /
        // concentration / non-program are resolved, so they never show here.
        if (filter === 'attention') return ['added','pending','mismatch'].includes(r.outcome) && r.flagged;
        if (filter === 'highconf') return ['matched','concentration','non_program'].includes(r.outcome);
        if (filter === 'lowconf') return r.outcome === 'added';
        if (filter === 'unknown') return ['pending','mismatch'].includes(r.outcome);
        if (filter === 'flagged') return r.flagged;
        if (filter === 'overridden') return r.disposition !== 'auto';
        return r.outcome === filter;
    });
    // Sort most-in-need-of-attention first: mismatch → pending → added, then the
    // resolved outcomes (concentration/non-program/matched). Within a rank, sort
    // by name. A manual override that ISN'T pending counts as handled, so it
    // drops below the auto rows still flagged for attention.
    const rank = o => ({mismatch: 0, pending: 1, added: 2, concentration: 3, non_program: 4, matched: 5}[o] ?? 6);
    rows.sort((a, b) => {
        // New/changed-since-reviewed float above everything else.
        if (!!a.flagged !== !!b.flagged) return a.flagged ? -1 : 1;
        const ra = rank(a.outcome), rb = rank(b.outcome);
        if (ra !== rb) return ra - rb;
        return (a.name || '').localeCompare(b.name || '');
    });
    const flaggedCount = rows.filter(r => r.flagged).length;
    let html = `<p style="color:#64748b;font-size:11px;margin:0 0 6px">${rows.length} of ${_svtDispRows.length} rows`
        + (flaggedCount ? ` · <span style="color:#92400e">${flaggedCount} new/changed</span>` : '')
        + ` — new/changed first, then most in need of attention</p>`;
    html += '<table style="width:100%;border-collapse:collapse;font-size:12px">';
    html += `<thead><tr style="background:#f8fafc;text-align:left">
        <th style="padding:4px 8px">SVT entry</th>
        <th style="padding:4px 8px">Mapping status</th>
        <th style="padding:4px 8px">Disposition</th>
        <th style="padding:4px 8px">Details</th>
        <th style="padding:4px 8px"></th></tr></thead><tbody>`;
    for (const r of rows) {
        html += _renderSvtDispRow(r);
    }
    html += '</tbody></table>';
    // The program picker (Existing program / Concentration parent) uses a custom
    // token-search dropdown wired in _svtWireRow — NOT a native <datalist> (which
    // clips long option text, hiding the campus at the tail, and can't do
    // multi-word matching like "electrical oakland").
    bodyEl.innerHTML = html;
    for (const r of rows) _svtWireRow(r.svt_key);
}

function _renderSvtDispRow(r) {
    const k = r.svt_key;
    const disp = r.disposition || 'auto';
    // Disposition is a two-step control: mode (Auto | Edit) and, when Edit, a type.
    // Stored value maps back: auto/pending → Auto; match/concentration/program/
    // non_program → Edit + that type. Default type when switching to Edit = match
    // (Existing program).
    const EDIT_TYPES = ['match', 'concentration', 'program', 'non_program'];
    const mode = EDIT_TYPES.includes(disp) ? 'edit' : 'auto';
    const type = EDIT_TYPES.includes(disp) ? disp : 'match';
    const detail = r.outcome_detail ? `<div style="color:#94a3b8;font-size:10px">${escapeHtml(_campusParen(r.outcome_detail, r.campus))}</div>` : '';
    // Program picker — a searchable name list shared by "Existing program" (match)
    // and "Concentration" (parent). The visible input shows/searches the program
    // NAME; a hidden .svt-parent holds the CIM id that save reads.
    const parentVal = r.parent_cim_id != null ? String(r.parent_cim_id) : '';
    const showPicker = mode === 'edit' && (type === 'match' || type === 'concentration');
    const showProg   = mode === 'edit' && type === 'program';
    // Multi-select: the hidden .svt-parent holds a comma-separated list of CIM ids;
    // .svt-cim-picked renders one removable chip per selected program (filled by
    // _svtRenderChips in the row wiring). Supports the multi-target case where one SVT
    // intake maps to several CIM concentration records.
    const parentPick = `<span class="svt-pick-wrap" data-k="${k}" style="position:relative;display:${showPicker?'block':'none'}">
        <input autocomplete="off" class="svt-cim-name" data-k="${k}" value="" placeholder="type words in any order — e.g. electrical oakland — pick one or more" style="width:100%;min-width:520px;box-sizing:border-box;padding:3px 5px;font-size:11px;border:1px solid #cbd5e1;border-radius:5px">
        <input type="hidden" class="svt-parent" data-k="${k}" value="${escapeHtml(parentVal)}">
        <div class="svt-cim-results" data-k="${k}" style="display:none;position:absolute;left:0;right:0;top:100%;z-index:60;max-height:240px;overflow-y:auto;border:1px solid #cbd5e1;border-radius:6px;background:#fff;box-shadow:0 6px 16px rgba(0,0,0,.14)"></div>
        </span>
        <div class="svt-cim-picked" data-k="${k}" style="display:${showPicker?'block':'none'};margin-top:3px;font-size:11px;line-height:1.35;color:#334155"></div>`;
    const progFields = `<span class="svt-progfields" data-k="${k}" style="display:${showProg?'inline-flex':'none'};gap:4px">
        <input class="svt-oname" data-k="${k}" value="${escapeHtml(r.override_name||'')}" placeholder="name" style="width:120px;padding:3px 5px;font-size:11px;border:1px solid #cbd5e1;border-radius:5px">
        <input class="svt-odeg" data-k="${k}" value="${escapeHtml(r.override_degree||'')}" placeholder="degree" style="width:60px;padding:3px 5px;font-size:11px;border:1px solid #cbd5e1;border-radius:5px">
        <input class="svt-ocampus" data-k="${k}" value="${escapeHtml(r.override_campus||'')}" placeholder="campus" style="width:80px;padding:3px 5px;font-size:11px;border:1px solid #cbd5e1;border-radius:5px">
    </span>`;
    // New/changed highlight: amber left border + a NEW or CHANGED chip. The
    // chip's tooltip lists the field-level diff (old → new) for changed rows.
    let chip = '';
    if (r.flagged) {
        if (r.is_new) {
            chip = `<span style="background:#fef3c7;color:#92400e;font-size:10px;padding:1px 6px;border-radius:8px;margin-left:6px">NEW</span>`;
        } else {
            const diffTitle = (r.change_detail || [])
                .map(d => `${d.field}: "${d.old}" → "${d.new}"`).join('\n');
            chip = `<span title="${escapeHtml(diffTitle)}" style="background:#fef3c7;color:#92400e;font-size:10px;padding:1px 6px;border-radius:8px;margin-left:6px;cursor:help">CHANGED</span>`;
        }
    }
    const rowStyle = r.flagged
        ? 'border-top:1px solid #e2e8f0;border-left:3px solid #f59e0b;background:#fffdf5'
        : 'border-top:1px solid #e2e8f0';
    return `<tr style="${rowStyle}" data-k="${k}">
        <td style="padding:5px 8px"><div>${escapeHtml(_campusParen(r.name, r.campus))}${chip}</div><div style="color:#94a3b8;font-size:10px">${escapeHtml(r.svt_key)}</div></td>
        <td style="padding:5px 8px">${_svtBadge(r.outcome)}${detail}</td>
        <td style="padding:5px 8px">
            <select class="svt-disp-mode" data-k="${k}" style="width:140px;padding:3px 6px;font-size:12px;border:1px solid #cbd5e1;border-radius:5px">
                <option value="auto"${mode==='auto'?' selected':''}>Auto</option>
                <option value="edit"${mode==='edit'?' selected':''}>Edit</option>
            </select>
            <select class="svt-disp-type" data-k="${k}" style="width:140px;margin-top:4px;padding:3px 6px;font-size:12px;border:1px solid #cbd5e1;border-radius:5px;display:${mode==='edit'?'block':'none'}">
                <option value="match"${type==='match'?' selected':''}>Existing program</option>
                <option value="concentration"${type==='concentration'?' selected':''}>Concentration</option>
                <option value="program"${type==='program'?' selected':''}>New program</option>
                <option value="non_program"${type==='non_program'?' selected':''}>Non-Program</option>
            </select>
        </td>
        <td style="padding:5px 8px">${parentPick}${progFields}
            <input class="svt-note" data-k="${k}" value="${escapeHtml(r.note||'')}" placeholder="note" style="width:100%;margin-top:4px;padding:3px 5px;font-size:11px;border:1px solid #e2e8f0;border-radius:5px">
        </td>
        <td style="padding:5px 8px"><button class="svt-save" data-k="${k}" title="Save this mapping decision and mark the entry reviewed" style="padding:3px 12px;font-size:12px;border:1px solid #2563eb;background:#eff6ff;color:#1e40af;border-radius:5px;cursor:pointer">Confirm</button></td>
    </tr>`;
}

function _svtWireRow(k) {
    const modeSel = document.querySelector(`.svt-disp-mode[data-k="${CSS.escape(k)}"]`);
    const typeSel = document.querySelector(`.svt-disp-type[data-k="${CSS.escape(k)}"]`);
    const nameInput = document.querySelector(`.svt-cim-name[data-k="${CSS.escape(k)}"]`);
    const sync = () => {
        const edit = modeSel && modeSel.value === 'edit';
        const type = typeSel ? typeSel.value : 'match';
        if (typeSel) typeSel.style.display = edit ? 'block' : 'none';
        const pf = document.querySelector(`.svt-progfields[data-k="${CSS.escape(k)}"]`);
        const picked = document.querySelector(`.svt-cim-picked[data-k="${CSS.escape(k)}"]`);
        const wrap = document.querySelector(`.svt-pick-wrap[data-k="${CSS.escape(k)}"]`);
        // The program name picker serves both "Existing program" and "Concentration".
        const showPick = edit && (type === 'match' || type === 'concentration');
        if (wrap) wrap.style.display = showPick ? 'block' : 'none';
        if (picked) picked.style.display = showPick ? 'block' : 'none';
        if (pf) pf.style.display = (edit && type === 'program') ? 'inline-flex' : 'none';
    };
    if (modeSel) modeSel.onchange = sync;
    if (typeSel) typeSel.onchange = sync;
    // Custom token-search dropdown for the CIM program picker. Typing words in any
    // order (e.g. "electrical oakland") narrows to programs whose name contains
    // EVERY word; each result wraps and leads with a campus badge, so the campus
    // (which sits at the tail of the name) is always visible.
    const hidden  = document.querySelector(`.svt-parent[data-k="${CSS.escape(k)}"]`);
    const results = document.querySelector(`.svt-cim-results[data-k="${CSS.escape(k)}"]`);
    _svtRenderChips(k);  // initial chips from the stored id list
    const addPick = (id) => {
        if (!hidden) return;
        const ids = _svtChipIds(k);
        if (!ids.includes(String(id))) ids.push(String(id));
        hidden.value = ids.join(',');
        _svtRenderChips(k);
    };
    const renderResults = () => {
        if (!results || !nameInput) return;
        const tokens = nameInput.value.toLowerCase().split(/\s+/).filter(Boolean);
        if (!tokens.length) { results.style.display = 'none'; results.innerHTML = ''; return; }
        const matches = _svtCimPrograms.filter(p => {
            const n = (p.name || '').toLowerCase();
            return tokens.every(t => n.includes(t));
        });
        const shown = matches.slice(0, 50);
        if (!shown.length) {
            results.innerHTML = '<div style="padding:6px 9px;color:#94a3b8;font-size:11px">no CIM program matches those words</div>';
        } else {
            results.innerHTML = shown.map(p => {
                const m = (p.name || '').match(/\(([^)]+)\)\s*$/);
                const badge = m ? `<span style="display:inline-block;background:#eef2ff;color:#3730a3;border-radius:4px;padding:0 5px;margin-right:6px;font-size:10px;font-weight:600;white-space:nowrap">${escapeHtml(m[1])}</span>` : '';
                return `<div class="svt-cim-opt" data-id="${p.id}" style="padding:5px 9px;font-size:11px;line-height:1.3;cursor:pointer;border-bottom:1px solid #f1f5f9;white-space:normal;word-break:break-word">${badge}${escapeHtml(p.name)}</div>`;
            }).join('') + (matches.length > shown.length
                ? `<div style="padding:5px 9px;color:#94a3b8;font-size:10px">…${matches.length - shown.length} more — add another word to narrow</div>`
                : '');
        }
        results.style.display = 'block';
    };
    let _searchTimer = null;
    if (nameInput) {
        // Typing only drives the search dropdown now — selection is by clicking a
        // result (multi-select). Debounced so a fast typist doesn't rebuild the
        // dropdown on every keystroke.
        nameInput.oninput = () => {
            clearTimeout(_searchTimer);
            _searchTimer = setTimeout(renderResults, 150);
        };
        nameInput.onfocus = renderResults;
        nameInput.onblur = () => setTimeout(() => { if (results) results.style.display = 'none'; }, 200);
    }
    if (results) {
        results.onmouseover = (e) => { const o = e.target.closest('.svt-cim-opt'); if (o) o.style.background = '#f1f5f9'; };
        results.onmouseout  = (e) => { const o = e.target.closest('.svt-cim-opt'); if (o) o.style.background = ''; };
        // mousedown (not click) + preventDefault so the input's blur-hide doesn't
        // fire before the selection registers. Selecting APPENDS to the picked set
        // and clears the search box so you can add another; the dropdown hides.
        results.onmousedown = (e) => {
            const o = e.target.closest('.svt-cim-opt'); if (!o) return;
            e.preventDefault();
            addPick(o.getAttribute('data-id'));
            if (nameInput) { nameInput.value = ''; nameInput.focus(); }
            results.style.display = 'none';
        };
    }
    // Remove a selected program by clicking its chip ×.
    const pickedBox = document.querySelector(`.svt-cim-picked[data-k="${CSS.escape(k)}"]`);
    if (pickedBox) {
        pickedBox.onclick = (e) => {
            const x = e.target.closest('.svt-chip-x'); if (!x || !hidden) return;
            const rm = x.getAttribute('data-id');
            hidden.value = _svtChipIds(k).filter(id => id !== rm).join(',');
            _svtRenderChips(k);
        };
    }
    const btn = document.querySelector(`.svt-save[data-k="${CSS.escape(k)}"]`);
    if (btn) btn.onclick = () => svtSaveRow(k, btn);
}

async function svtSaveRow(k, btn) {
    const val = sel => document.querySelector(`${sel}[data-k="${CSS.escape(k)}"]`)?.value || '';
    // Auto → 'auto'; Edit → the chosen type (program|concentration|non_program).
    const disposition = val('.svt-disp-mode') === 'edit' ? val('.svt-disp-type') : 'auto';
    const payload = {
        svt_key: k,
        disposition,
        parent_cim_id: val('.svt-parent'),
        override_name: val('.svt-oname'),
        override_degree: val('.svt-odeg'),
        override_campus: val('.svt-ocampus'),
        note: val('.svt-note'),
    };
    if (btn) { btn.textContent = 'Confirming…'; btn.disabled = true; }
    try {
        const resp = await fetch('/api/svt_overrides', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)});
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        // Confirming a mapping now also RE-INGESTS automatically (Waleed 2026-07-23),
        // so the change flows into the portfolio views without a separate button.
        // This rebuilds portfolio_programs, re-exports, and publishes to gh-pages
        // (~30–90s), so the per-row Confirm blocks for that duration.
        if (btn) btn.textContent = 'Reingesting… (~1 min)';
        const ri = await fetch('/api/svt_overrides/reingest', {method: 'POST'});
        const rj = await ri.json().catch(() => ({}));
        if (!ri.ok || rj.ok === false) throw new Error('reingest: ' + (rj.error || ('HTTP ' + ri.status)));
        loadSvtDispositions();  // reload the Mappings table from fresh, re-ingested state
    } catch (e) {
        if (btn) { btn.textContent = 'Error'; btn.disabled = false; }
        alert('Confirm failed: ' + e.message);
    }
}

async function svtReingest() {
    const btn = document.getElementById('svt-disp-reingest');
    if (btn) { btn.textContent = 'Re-ingesting… (~1 min)'; btn.disabled = true; }
    try {
        const resp = await fetch('/api/svt_overrides/reingest', {method: 'POST'});
        const data = await resp.json();
        if (!data.ok) throw new Error(data.error || 'failed');
        if (btn) btn.textContent = 'Done — reloading…';
        loadSvtDispositions();
        if (btn) setTimeout(() => { btn.textContent = 'Re-run ingest now'; btn.disabled = false; }, 1500);
    } catch (e) {
        if (btn) { btn.textContent = 'Re-run ingest now'; btn.disabled = false; }
        alert('Re-ingest failed: ' + e.message);
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

    const svtPending = mm.svt_pending_analysis || [];
    html += `<h4 style="margin:0 0 4px;font-size:13px;color:#92400e">SVT concentrations needing edits (${svtPending.length})</h4>`;
    html += '<p style="color:#64748b;font-size:11px;margin:0 0 6px">Concentration proposals whose parent program is unclear or that bundle multiple concentrations — held out of the portfolio until a parent is assigned.</p>';
    if (!svtPending.length) {
        html += '<p style="color:#64748b;font-size:12px;margin:0 0 12px">None.</p>';
    } else {
        html += '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px">';
        html += '<thead><tr style="background:#fffbeb;text-align:left">'
             + '<th style="padding:4px 8px">SVT Name</th>'
             + '<th style="padding:4px 8px">SVT Campus</th>'
             + '<th style="padding:4px 8px">Reason</th>'
             + '</tr></thead><tbody>';
        for (const p of svtPending) {
            html += `<tr style="border-top:1px solid #e2e8f0">
                <td style="padding:4px 8px">${escapeHtml(p.source_name || '')}</td>
                <td style="padding:4px 8px;color:#64748b">${escapeHtml(p.campus || '')}</td>
                <td style="padding:4px 8px;color:#64748b;font-size:11px">${escapeHtml(p.reason || '')}</td>
            </tr>`;
        }
        html += '</tbody></table>';
    }

    // IPD sections removed — overlay disabled, source no longer consulted.

    html += `<h4 style="margin:0 0 4px;font-size:13px;color:#991b1b">SVT entries with no CIM match (${svtMismatches.length})</h4>`;
    html += _mismatchTable(svtMismatches, '#fff1f2');

    // OTP mismatches removed — OTP retired 2026-08-13.

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

    // ---- Banner ↔ Portfolio reconciliation (programs / codes / campuses) ----
    const rec = mm.banner_reconciliation || {};
    const recTotal = (rec.missing_in_portfolio || []).length + (rec.missing_in_banner || []).length
                   + (rec.code_mismatch || []).length + (rec.campus_diff || []).length;
    if (recTotal) {
        html += `<h3 style="margin:22px 0 6px">Banner ↔ Portfolio reconciliation (${recTotal})</h3>`;
        html += '<p style="color:#64748b;font-size:11px;margin:0 0 10px">Banner (Registrar system of record) and the portfolio are meant to be in sync. Graduate programs only; compares programs that have completed the CIM workflow against Banner active codes. Excludes undergraduate programs, combined/dual majors, minors, non-degree/pathway records, in-workflow proposals, inactivations, and programs inactive in Banner.</p>';
        const _simpleTable = (rows, cols, bg) => {
            let t = `<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px"><thead><tr style="background:${bg};text-align:left">`;
            t += cols.map(c => `<th style="padding:4px 8px">${escapeHtml(c[0])}</th>`).join('') + '</tr></thead><tbody>';
            for (const r of rows) {
                t += '<tr style="border-top:1px solid #e2e8f0">' + cols.map(c => {
                    let v = r[c[1]];
                    if (Array.isArray(v)) v = v.join(', ');
                    return `<td style="padding:4px 8px">${escapeHtml(v || '—')}</td>`;
                }).join('') + '</tr>';
            }
            return t + '</tbody></table>';
        };
        const mip = rec.missing_in_portfolio || [];
        html += `<h4 style="margin:0 0 4px;font-size:13px;color:#991b1b">Active in Banner, not in portfolio (${mip.length})</h4>`;
        html += mip.length ? _simpleTable(mip, [['Banner code','banner_code'],['Program','name']], '#fff1f2')
                           : '<p style="color:#64748b;font-size:12px;margin:0 0 12px">None.</p>';
        const mib = rec.missing_in_banner || [];
        if (mib.length) {
            html += `<h4 style="margin:0 0 4px;font-size:13px;color:#991b1b">Tracked, not active in Banner (${mib.length})</h4>`;
            html += _simpleTable(mib, [['Program','program'],['CIM code','banner_code']], '#fff1f2');
        }
        const cmm = rec.code_mismatch || [];
        if (cmm.length) {
            html += `<h4 style="margin:0 0 4px;font-size:13px;color:#92400e">Banner code ≠ CIM code (${cmm.length})</h4>`;
            html += _simpleTable(cmm, [['Program','program'],['CIM code','cim_code'],['Banner code','banner_code']], '#fffbeb');
        }
        const cdf = rec.campus_diff || [];
        if (cdf.length) {
            html += `<h4 style="margin:0 0 4px;font-size:13px;color:#92400e">Campus footprint differs (${cdf.length})</h4>`;
            html += _simpleTable(cdf, [['Program','program'],['Banner code','banner_code'],['Only in portfolio','only_portfolio'],['Only in Banner','only_banner']], '#fffbeb');
        }
    }

    // ---- Banner ↔ CIM concentration discrepancies ----
    const concDisc = mm.concentration_college_discrepancies || [];
    if (concDisc.length) {
        html += `<details style="margin-top:16px"><summary style="cursor:pointer;font-size:13px;font-weight:600;color:#991b1b">Concentrations: Banner ↔ CIM differences (${concDisc.length})</summary>`;
        html += '<p style="color:#64748b;font-size:11px;margin:6px 0 8px">Per program, concentrations found in the CIM curriculum but not Banner (Program/Major/Concentration), and vice-versa. Names are matched fuzzily (Banner truncates), so some rows are naming variants rather than true gaps. Banner is authoritative for the managing college.</p>';
        html += '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px">';
        html += '<thead><tr style="background:#fff1f2;text-align:left">'
             + '<th style="padding:4px 8px">Program</th>'
             + '<th style="padding:4px 8px">Banner code</th>'
             + '<th style="padding:4px 8px">In CIM, not Banner</th>'
             + '<th style="padding:4px 8px">In Banner, not CIM</th>'
             + '</tr></thead><tbody>';
        for (const d of concDisc) {
            html += `<tr style="border-top:1px solid #e2e8f0">
                <td style="padding:4px 8px">${escapeHtml(d.program || '')}</td>
                <td style="padding:4px 8px;color:#64748b">${escapeHtml(d.banner_code || '—')}</td>
                <td style="padding:4px 8px;color:#92400e">${(d.cim_only || []).map(escapeHtml).join('<br>') || '<span style="color:#94a3b8">—</span>'}</td>
                <td style="padding:4px 8px;color:#1e40af">${(d.banner_only || []).map(escapeHtml).join('<br>') || '<span style="color:#94a3b8">—</span>'}</td>
            </tr>`;
        }
        html += '</tbody></table></details>';
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

// Deep-link focus: after the view's data loads, apply a CIM Step filter or a
// saved Portfolio view. Retries (~200ms × 40) because switchView loads async.
function _applyDeepFocus(step, pview, tries) {
    if (tries > 40) return;
    try {
        if (step) {
            const el = document.getElementById('filter-step');
            if (el && [...el.options].some(o => o.value === step)) {
                el.value = step; applyFilters(); return;
            }
        }
        if (pview) {
            // Admin views are behind a toggle; enable so an Admin·… view resolves.
            try { if (typeof _pvAdminViewsOn === 'function' && !_pvAdminViewsOn())
                    localStorage.setItem('cim-portfolio-admin-views', '1'); } catch(e) {}
            const v = getAllPortfolioViews().find(x => x.name === pview);
            if (v) { applyPortfolioView(v.id); return; }
        }
    } catch(e) {}
    setTimeout(() => _applyDeepFocus(step, pview, tries + 1), 200);
}

function _initDashboard() {
    // Restore last active view (so navigating away and back keeps your context).
    let savedView = 'programs';
    try { savedView = localStorage.getItem('cim-active-view') || 'programs'; } catch(e) {}
    // Deep-link (used by the shared console's "Needs You" pane):
    //   ?view=<programs|courses|catalog|portfolio> overrides the restored view,
    //   ?step=<exact current_step>  focuses the CIM Step filter (e.g. Grad Provost Review),
    //   ?pview=<portfolio view name> applies a saved Portfolio view (e.g. Launch-timing).
    let _dqStep = null, _dqPView = null;
    try {
        const _q = new URLSearchParams(location.search);
        const qv = _q.get('view'); if (qv) savedView = qv;
        _dqStep = _q.get('step'); _dqPView = _q.get('pview');
    } catch(e) {}
    const validViews = ['programs', 'courses', 'catalog', 'portfolio'];
    if (!validViews.includes(savedView)) savedView = 'programs';
    if (savedView === 'programs') {
        loadDashboard();
    } else {
        switchView(savedView);
    }
    if (_dqStep || _dqPView) _applyDeepFocus(_dqStep, _dqPView, 0);
    // Deep-link ?discrepancies=1 → open the consolidated Discrepancies modal (used by
    // the shared console's Needs-Attention route-out for the Catalog-curriculum flag).
    try {
        if (new URLSearchParams(location.search).has('discrepancies'))
            setTimeout(() => { try { openDiscrepanciesModal(); } catch (e) {} }, 400);
    } catch (e) {}
    // Fast CourseLeaf session health probe so user sees "please log in" quickly,
    // not after a 10-minute scan that silently does nothing.
    // Only do this when the server is the Flask local server (not the static site).
    if (typeof window._staticMode === 'undefined') {
        checkSessionHealth();
    }
}

// DOMContentLoaded handled by static __staticInit -> _initDashboard()

// Auto-refresh every 2 minutes — refreshes whichever view is active
setInterval(() => {
    if (currentView === 'programs') loadDashboard();
    else if (currentView === 'courses') loadCoursesDashboard();
    else if (currentView === 'catalog') loadCatalogDashboard();
    else if (currentView === 'portfolio') loadPortfolioDashboard();
}, 120000);

// Keep the CourseLeaf-session error banner self-correcting on the local
// dashboard. (Login now lives in the shared console; the header auth/SharePoint
// buttons, their status pollers, and the handler functions were removed.)
if (typeof window._staticMode === 'undefined') {
    setInterval(() => { checkSessionHealth(); }, 60000);
}

// ==================== Portfolio view ====================

const PORTFOLIO_COLUMNS = [
    {key: 'degree',       label: 'Credential',
        help: 'Academic credential the program leads to (BS / MS / PhD / Prof Doctorate / CAGS / Certificate / Minor / Dual Degree / Concentration). Detected from the program name in CIM "Subject, Degree" format; SVT/IPD-added rows are normalized to that format at ingest so this column is filled for every program.'},
    {key: 'college',      label: 'College', defaultHidden: true,
        help: 'Owning college. From CIM XML for tracked programs; SVT/IPD-supplied values are normalized to the canonical CIM name so duplicates and abbreviations are merged.'},
    {key: 'campus',       label: 'Campus',
        help: 'Deployment campus. All online variants (Online, Primarily Online, "Online - Vancouver Requirements", etc.) are merged into a single "Online" campus.'},
    {key: 'catalogyears', label: 'Catalog Years',
        help: 'Catalog years the program is part of (current year plus two forward), derived from CIM: a proposal’s effective catalog and type set when a program enters and leaves. A pending inactivation still in workflow keeps the program in the current year and removes it from its effective year onward.'},
    {key: 'market2025',      label: '2025 Market Category', defaultHidden: true,
        help: 'Market category from the 2025 portfolio scoring workbook (Boston programs only).'},
    {key: 'perf2025',        label: '2025 Performance Category', defaultHidden: true,
        help: 'Performance category from the 2025 portfolio scoring workbook (Boston programs only).'},
    {key: 'marketscore2025', label: '2025 Market Score', defaultHidden: true,
        help: 'Numeric market score from the 2025 portfolio scoring workbook (Boston programs only).'},
    {key: 'perfscore2025',   label: '2025 Performance Score', defaultHidden: true,
        help: 'Numeric performance score from the 2025 portfolio scoring workbook (Boston programs only).'},
    {key: 'svt',          label: 'SVT Status',
        help: 'Status from the SVT Source Data table (Intake, Discovery, Approved for Development by College, Launch in Progress, Complete, Inactivation In Progress, etc.).'},
    {key: 'svttype',      label: 'SVT Proposal Type', defaultHidden: true,
        help: 'Proposal/request type from the SVT Source Data table (New, Change, Network Deployment, Inactivation) — most recent intake wins. This is what the SVT request is FOR; the SVT Status column only shows its lifecycle stage, so e.g. "Complete" alone does not reveal whether the request was an inactivation.'},
    {key: 'substatus',    label: 'SVT Sub-status',
        help: 'Launch sub-status from the SVT Source Data table (e.g. "Regulatory Submission in Progress", "Post-Launch & Monitor - IPD").'},
    {key: 'speed',        label: 'Speed to Market',
        help: 'Speed to Market flag from the SVT Source Data table (checkbox).'},
    {key: 'gls',          label: 'GLS Status',
        help: 'Per-campus status from the GLS Tableau dashboard (campus deployment health).'},
    {key: 'launch',       label: 'GTM Launch', defaultHidden: true,
        help: 'Go-To-Market launch DATE (SVT GTM_Launch) — the day the program goes live in the market (website live, applications open). This is a date, NOT a launch term; ideally it falls ~1 year before the launch term to allow time to recruit.'},
    {key: 'proposedterm', label: 'Proposed Launch Term', defaultHidden: true,
        help: 'Launch term the SUBMITTER requested (SVT Proposed_Launch_Time). For a new program/redeployment it is the first term with students; for a redesign, the first term the new version runs; for an inactivation, the target term to be inactivated by.'},
    {key: 'expectedterm', label: 'Expected Launch Term', defaultHidden: true,
        help: 'Launch term the EMPL project manager EXPECTS (SVT Expected_Launch). Often blank — only network-deployment programs get an EMPL PM; when blank, the Proposed Launch Term is used instead.'},
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
    {key: 'ciminact',     label: 'Inactivation in Progress',
        help: 'Inactivation in progress: the program has a CIM inactivation and isn’t fully wound down — still moving through the CIM workflow (including teach-out) or still admitting students.'},
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
    {key: 'otp_prog_disp',  label: 'OTP program disposition',
        help: 'Leadership/college disposition set at the PROGRAM level (Banner code); shared across all campuses. Edit in the program record.'},
    {key: 'otp_prog_notes', label: 'OTP program notes',
        help: 'Program-level OTP note (the 2025-26 program review), shared across all campuses. Edit in the program record.'},
    {key: 'otp_dep_disp',   label: 'OTP deployment disposition',
        help: 'Disposition set on THIS campus deployment, overriding the program-level value.'},
    {key: 'otp_dep_notes',  label: 'OTP deployment notes',
        help: 'OTP note on THIS campus deployment, overriding the program-level note.'},
];

// Master's enrollment columns are generated dynamically from whatever years
// the enrollment feed provides (the academic-year window rolls forward), so
// they aren't hardcoded above. They're appended to PORTFOLIO_COLUMNS the first
// time portfolio data loads. Keys: enr_total_YYYY / enr_new_YYYY. Hidden by
// default (toggle via the Columns menu). Source: Master's Program Enrollment
// Summary (Tableau, ProfessionalAdvancementNetwork), joined by CIM banner code.
function _enrollmentYears() {
    const ys = new Set();
    (allPortfolioPrograms || []).forEach(p => {
        if (p.enrollment) Object.keys(p.enrollment).forEach(y => ys.add(y));
    });
    return [...ys].sort();
}
function _ensureEnrollmentColumns() {
    const have = new Set(PORTFOLIO_COLUMNS.map(c => c.key));
    // Only the two most recent enrollment years (currently New/Total 2025 & 2026).
    // Older years are intentionally omitted so the table isn't cluttered with a
    // long tail of historical enrollment columns.
    const years = _enrollmentYears().slice(-2);
    // Build "New {y}" columns first, then all "Total {y}" columns, so the natural
    // order is New 2025, New 2026, Total 2025, Total 2026.
    const fresh = [];
    [['new', 'New'], ['total', 'Total']].forEach(([m, label]) => {
        years.forEach(y => {
            const key = `enr_${m}_${y}`;
            if (!have.has(key)) {
                const startY = +y - 1;   // label year = year the academic year ENDS
                const which = m === 'new'
                    ? `New master's students entering Fall ${startY}`
                    : `Total master's enrollment, ${startY}–${y}`;
                fresh.push({
                    key, label: `${label} ${y}`, defaultHidden: true, enroll: {m, y},
                    help: `${which}, from the Master's Program Enrollment Summary `
                        + `(Tableau), joined by CIM banner code.`,
                });
            }
        });
    });
    // Insert at the FRONT so enrollment reads immediately after the Program name
    // column (rather than at the far right of the table) in views that show them.
    if (fresh.length) PORTFOLIO_COLUMNS.unshift(...fresh);
}
// Numeric enrollment value for a program + enr_ column key, or '' if absent.
function _enrValue(p, key) {
    const m = /^enr_(total|new)_(\d{4})$/.exec(key);
    if (!m || !p.enrollment) return '';
    const rec = p.enrollment[m[2]];
    if (!rec) return '';
    const v = rec[m[1] === 'total' ? 't' : 'n'];
    return (v === 0 || v) ? v : '';
}

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
    portfolioLayout = (mode === 'matrix' || mode === 'program') ? mode : 'table';
    try { localStorage.setItem('cim-portfolio-layout', portfolioLayout); } catch (_) {}
    document.querySelectorAll('.portfolio-layout-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.layout === portfolioLayout);
    });
    if (window.trackerShell) window.trackerShell.refresh();
    renderPortfolioTable();
}

// ── Left-rail shell (opt-in) ────────────────────────────────────────────────
// The shell is now the shared, config-driven module in shared/web/rail.js
// (inlined into the page; initTrackerShell({…}) is called at the END of this
// file). This helper is the only program-specific glue the config's Portfolio
// nav items need. Default OFF; classic header is the fallback.
function _railLayout(layout) {
    if (typeof currentView !== 'undefined' && currentView !== 'portfolio') switchView('portfolio');
    setPortfolioLayout(layout);
}

// Program (grouped) view — how the program GROUPS are ordered. Deployments
// within a group always stay in campus order (rarely worth re-sorting).
let programGroupSortKey = (() => {
    try { return localStorage.getItem('cim-progsort-key') || 'name'; } catch (_) { return 'name'; }
})();
let programGroupSortDir = (() => {
    try { return localStorage.getItem('cim-progsort-dir') === '-1' ? -1 : 1; } catch (_) { return 1; }
})();

function setProgramGroupSort(key) {
    programGroupSortKey = key;
    try { localStorage.setItem('cim-progsort-key', key); } catch (_) {}
    renderPortfolioTable();
}
function toggleProgramGroupSortDir() {
    programGroupSortDir = -programGroupSortDir;
    try { localStorage.setItem('cim-progsort-dir', String(programGroupSortDir)); } catch (_) {}
    renderPortfolioTable();
}
// Row's latest-year total enrollment (or -1 if unknown), used to rank groups.
function _rowLatestEnroll(p) {
    if (!p || !p.enrollment) return -1;
    const years = Object.keys(p.enrollment).sort();
    if (!years.length) return -1;
    const rec = p.enrollment[years[years.length - 1]];
    const v = rec && rec.t;
    return (typeof v === 'number') ? v : -1;
}

// Program (grouped) view: which program groups are expanded to show their
// campus deployments. Keyed by group key (Banner code, or '~'+id for a
// blank-Banner singleton). Collapsed by default — a program is an abstract row
// you open to reveal its campuses, the way concentrations open under a program.
let portfolioProgramExpanded = new Set();
function togglePortfolioProgram(gkey) {
    if (portfolioProgramExpanded.has(gkey)) portfolioProgramExpanded.delete(gkey);
    else portfolioProgramExpanded.add(gkey);
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
// Per-column widths for the fixed-layout portfolio table. Effective width =
// the user's saved drag width, else a per-column default, else a fallback.
// (table-layout:fixed makes these authoritative — otherwise content forces the
// width and a drag to narrow the column doesn't stick.)
const _PF_DEFAULT_W = {
    name: 260, degree: 110, college: 110, campus: 90, catalogyears: 160,
    svt: 130, svttype: 130, substatus: 160, speed: 110, gls: 120, cim: 150,
    cimchange: 110, cimterm: 110, cimcatalog: 120, launch: 110, proposedterm: 120,
    expectedterm: 120, ciminact: 110, inworkflow: 90, offering: 120, gtmentered: 120,
};
const _PF_FALLBACK_W = 110;
function _pfColW(key) {
    const w = portfolioColWidths[key];
    return (typeof w === 'number' && w > 0) ? w : (_PF_DEFAULT_W[key] || _PF_FALLBACK_W);
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
    // On a fixed-layout table, also grow/shrink the TABLE by the same delta so the
    // dragged column resizes on its own instead of squeezing its neighbours.
    const table = th.closest('table');
    const startTableW = table ? table.getBoundingClientRect().width : 0;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev) => {
        const newW = Math.max(40, Math.round(startW + (ev.clientX - startX)));
        th.style.width = newW + 'px';
        if (table) table.style.width = (startTableW + (newW - startW)) + 'px';
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

// ---- column ORDER (drag-to-reorder in the ⊞ Columns picker; persisted per
// active portfolio view, like the student tracker). Applied in the header, cell,
// and CSV-export column lists via orderedPortfolioCols(). ----
const _PF_COL_ORDER_LS = 'cim-portfolio-col-order-v1';
function _pfColOrderMap() { try { return JSON.parse(localStorage.getItem(_PF_COL_ORDER_LS) || '{}') || {}; } catch (_) { return {}; } }
function _pfColOrderScope() { return portfolioActiveViewId || '__default__'; }   // resolved at call time
function _getPfColOrder() { const a = _pfColOrderMap()[_pfColOrderScope()]; return Array.isArray(a) ? a : null; }
function _setPfColOrder(arr) { const m = _pfColOrderMap(); m[_pfColOrderScope()] = arr; try { localStorage.setItem(_PF_COL_ORDER_LS, JSON.stringify(m)); } catch (_) {} }
function _clearPfColOrder() { const m = _pfColOrderMap(), k = _pfColOrderScope(); if (k in m) { delete m[k]; try { localStorage.setItem(_PF_COL_ORDER_LS, JSON.stringify(m)); } catch (_) {} } }
// PORTFOLIO_COLUMNS reordered by the saved order for the active scope. A column
// NOT in the saved order (e.g. one just toggled on, or added in a new build) is
// slotted in right before its nearest following saved column in definition order
// — i.e. next to its siblings — instead of dumped at the far right. So turning on
// "Total 2025" in a view whose saved order already has "Total 2026" places it
// immediately to the left of "Total 2026". Truly-trailing unknowns (nothing known
// follows them) still land at the end, so nothing ever vanishes.
function orderedPortfolioCols() {
    const order = _getPfColOrder();
    if (!order) return PORTFOLIO_COLUMNS.slice();
    const pos = new Map(order.map((k, i) => [k, i]));
    const n = PORTFOLIO_COLUMNS.length;
    // Rank of the nearest FOLLOWING known column, scanning definition order from
    // the right; columns after the last known one sort to the end.
    const nextKnownRank = new Array(n);
    let nk = order.length;
    for (let i = n - 1; i >= 0; i--) {
        const k = PORTFOLIO_COLUMNS[i].key;
        if (pos.has(k)) nk = pos.get(k);
        nextKnownRank[i] = nk;
    }
    return PORTFOLIO_COLUMNS
        .map((c, i) => ({ c, i, known: pos.has(c.key),
                          rank: pos.has(c.key) ? pos.get(c.key) : nextKnownRank[i] }))
        // At equal rank the known column IS the successor, so unknowns (which share
        // its rank) come BEFORE it; multiple unknowns keep definition order.
        .sort((a, b) => a.rank - b.rank || (a.known ? 1 : 0) - (b.known ? 1 : 0) || a.i - b.i)
        .map(r => r.c);
}

function _rebuildColDropdownItems(dd) {
    const rows = orderedPortfolioCols().map(c => `
        <label class="portfolio-col-check col-drag-row" draggable="true" data-key="${c.key}"
               data-label="${escapeHtml((c.label || '').toLowerCase())}"
               ondragstart="_pfColDragStart(event)" ondragover="_pfColDragOver(event)"
               ondrop="_pfColDrop(event)" ondragend="_pfColDragEnd(event)">
            <input type="checkbox" ${portfolioVisibleCols.has(c.key) ? 'checked' : ''}
                   onchange="togglePortfolioCol('${c.key}',this.checked)" onclick="event.stopPropagation()">
            <span class="col-item-lbl">${c.label}</span>
            <span class="col-drag-handle" title="Drag to reorder" aria-hidden="true">⠿</span>
        </label>`).join('');
    dd.innerHTML =
        `<div class="portfolio-col-search">
            <input type="text" id="portfolio-col-search-input" placeholder="Search columns…"
                   autocomplete="off" oninput="_filterColDropdown(this.value)"
                   onclick="event.stopPropagation()">
        </div>
        <div class="col-pick-hint">Drag <span aria-hidden="true">⠿</span> to reorder</div>
        <div class="portfolio-col-selectall">
            <button onclick="toggleAllPortfolioCols(true)">Select All</button>
            <button onclick="toggleAllPortfolioCols(false)">Unselect All</button>
            <button onclick="resetPortfolioColOrder()">Reset order</button>
        </div>` + rows;
}

// ---- drag-to-reorder handlers (ported from the student tracker): hide the
// dragged row, slide a dashed placeholder to the landing slot (FLIP-animated),
// persist the new order on drop. ----
let _pfColDragEl = null, _pfColPh = null;
function _pfColDragStart(ev) {
    _pfColDragEl = ev.currentTarget;
    ev.dataTransfer.effectAllowed = 'move';
    try { ev.dataTransfer.setData('text/plain', _pfColDragEl.dataset.key || ''); } catch (_) {}
    const ph = document.createElement('div');
    ph.className = 'portfolio-col-check col-placeholder';
    ph.style.height = _pfColDragEl.offsetHeight + 'px';
    _pfColPh = ph;
    setTimeout(() => { if (!_pfColDragEl) return; _pfColDragEl.parentNode.insertBefore(ph, _pfColDragEl.nextSibling); _pfColDragEl.style.display = 'none'; }, 0);
}
function _pfColFlip(container, ref, node) {
    const items = [...container.querySelectorAll('.portfolio-col-check')].filter(el => el !== _pfColDragEl && el !== node);
    const firstTop = new Map(); items.forEach(el => firstTop.set(el, el.getBoundingClientRect().top));
    container.insertBefore(node, ref);
    items.forEach(el => { const prev = firstTop.get(el); if (prev == null) return; const dy = prev - el.getBoundingClientRect().top; if (!dy) return;
        el.style.transition = 'none'; el.style.transform = 'translateY(' + dy + 'px)'; el.getBoundingClientRect();
        el.style.transition = 'transform 140ms ease'; el.style.transform = ''; });
}
function _pfColDragOver(ev) {
    ev.preventDefault(); ev.dataTransfer.dropEffect = 'move';
    const over = ev.currentTarget, ph = _pfColPh;
    if (!ph || over === ph) return;
    const r = over.getBoundingClientRect(); const after = (ev.clientY - r.top) > r.height / 2;
    const ref = after ? over.nextSibling : over;
    if (ref === ph || ph.nextSibling === ref) return;
    _pfColFlip(over.parentNode, ref, ph);
}
function _pfColDrop(ev) { ev.preventDefault(); }
function _pfColDragEnd() {
    const drag = _pfColDragEl, ph = _pfColPh; _pfColDragEl = null; _pfColPh = null;
    if (drag && ph && ph.parentNode) ph.parentNode.insertBefore(drag, ph);
    if (ph) ph.remove(); if (drag) drag.style.display = '';
    const dd = document.getElementById('portfolio-col-dropdown'); if (!dd) return;
    const keys = [...dd.querySelectorAll('.portfolio-col-check')]
        .filter(d => !d.classList.contains('col-placeholder')).map(d => d.dataset.key).filter(Boolean);
    _setPfColOrder(keys);
    renderPortfolioTable();
}
function resetPortfolioColOrder() {
    _clearPfColOrder();
    const dd = document.getElementById('portfolio-col-dropdown'); if (dd) _rebuildColDropdownItems(dd);
    renderPortfolioTable();
}

// Filter the column-picker list by label as the user types.
function _filterColDropdown(q) {
    q = (q || '').trim().toLowerCase();
    const dd = document.getElementById('portfolio-col-dropdown');
    if (!dd) return;
    dd.querySelectorAll('.portfolio-col-check').forEach(lab => {
        const hay = lab.getAttribute('data-label') || lab.textContent.toLowerCase();
        lab.style.display = (!q || hay.includes(q)) ? '' : 'none';
    });
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
    const s = document.getElementById('portfolio-col-search-input');
    if (s) setTimeout(() => s.focus(), 0);
}

function togglePortfolioCol(key, visible) {
    if (visible) portfolioVisibleCols.add(key);
    else portfolioVisibleCols.delete(key);
    _savePortfolioCols();
    renderPortfolioTable();
}

document.addEventListener('click', e => {
    // Close multi-select filter dropdowns on outside click (commits deferred
    // selection via _closeMultiDropdown → apply-on-close).
    document.querySelectorAll('.filter-multi-dropdown.open').forEach(el => {
        const wrap = el.closest('.filter-multi-wrap');
        if (wrap && !wrap.contains(e.target)) _closeMultiDropdown(el);
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

// "Recently inactivated" — master's programs whose CIM inactivation was approved
// (completed) in the current or prior catalog year (~last two years).
const RECENTLY_INACTIVATED_VIEW = {
    id: 'recently_inactivated', name: 'Recently inactivated', team: true, system: true,
    tip: "Master's programs being inactivated in CIM: either still in workflow (in-progress inactivation) OR approved (completed) within the current + two prior catalog years (~last three). Approved-recency is by completion catalog edition (no real approval date is stored).",
    state: { visibleCols: ['degree', 'college', 'campus', 'cimchange', 'cimcatalog', 'cim', 'svt'], filters: {}, tree: { type: 'group', conj: 'all', children: [
        { type: 'rule', field: 'credential',   op: 'in', value: ["Master's"] },
        { type: 'rule', field: 'recent_inact', op: 'in', value: ['Y'] },
    ] } },
};

// "Portfolio Review" — the graduate portfolio review surface: New/Total master's
// enrollment (2025 & 2026) right after the program name, CIM status, and the
// editable OTP Disposition + OTP Notes. No college filter by default (review
// across colleges; pick a college to focus).
const _PORTFOLIO_REVIEW_COLS = [
    'enr_total_2025', 'enr_total_2026',
    'degree', 'college', 'campus', 'cim', 'cimchange', 'svt',
    // all OTP fields — program-grain + deployment-grain disposition & notes
    // (these four ARE the OTP columns; effective disposition/notes are filter
    //  fields only, not columns)
    'otp_prog_disp', 'otp_dep_disp', 'otp_prog_notes', 'otp_dep_notes'];
const PORTFOLIO_REVIEW_VIEW = {
    id: 'portfolio_review', name: 'Portfolio Review', team: true, system: true,
    tip: 'Portfolio review: the current and upcoming catalog portfolio plus programs being sunset. Total master\'s enrollment (2025 & 2026), sorted by Total 2026 descending, CIM status, and all OTP fields (effective + program- and deployment-grain Disposition & Notes). Scoped to programs in the current or upcoming catalog editions OR with a CIM inactivation in progress (so teach-outs stay visible even though they\'re no longer in the catalog).',
    state: {
        visibleCols: _PORTFOLIO_REVIEW_COLS,
        sortKey: 'enr_total_2026', sortDir: -1,   // Total 2026 enrollment, descending
        filters: {},
        // Current/upcoming catalog + sunsetting programs. in_catalog = the row
        // has any catalog-window year (current + two forward), so it needs no
        // annual edit; cim_inact keeps teach-outs (past-effective inactivations,
        // blank catalog_years) in view.
        tree: { type: 'group', conj: 'any', children: [
            { type: 'rule', field: 'in_catalog', op: 'in', value: ['Y'] },
            { type: 'rule', field: 'cim_inact', op: 'in', value: ['Y'] },
        ] },
    },
};

// ── Administrative data-quality views ───────────────────────────────────────
// Hidden behind the "⚙ Admin views" toggle in the Views modal (per-browser,
// localStorage). Graduate data-validation queues; CIM is authoritative.
const _ADMIN_LAUNCH_COLS = ['degree', 'college', 'campus', 'svt', 'substatus', 'proposedterm', 'expectedterm', 'launch', 'cimterm', 'cim'];
// One consolidated launch-timing / launch-readiness view (2026-08-11): surfaces a
// graduate program if ANY link in the pipeline Proposed → Expected → CIM → GTM is
// inconsistent, OR the program is launching with no CIM proposal at all ("planning
// ahead of CIM", merged in from its own view). Built entirely from surfaced filter
// fields so it's transparent/editable in the Views builder.
const ADMIN_LAUNCH_TIMING_VIEW = {
    id: 'admin_launch_timing', name: 'Admin · Launch-timing discrepancy', team: true, system: true, admin: true,
    tip: 'Graduate programs with a launch-timing or launch-readiness issue: launch term (Expected, else Proposed) before the CIM effective term; GTM date < 6 months before the launch term; CIM still pre-approval with a current/next-term launch; or no CIM record at all while SVT is Launch in Progress / Regulatory Validation In Progress (launching ahead of CIM — may be a CIM match failure). Past-governance and already-launched (Active in Banner, or GTM date past) programs are excluded from the timing checks — the SVT launch term is aspirational, so an already-running program CIM has reopened for a later change is not flagged.',
    state: { visibleCols: _ADMIN_LAUNCH_COLS, filters: {}, tree: { type: 'group', conj: 'all', children: [
        { type: 'rule', field: 'level', op: 'in', value: ['Graduate'] },
        { type: 'group', conj: 'any', children: [
            // timing discrepancies (only for launches not past governance and not already live)
            { type: 'group', conj: 'all', children: [
                { type: 'rule', field: 'past_gov', op: 'in', value: ['N'] },   // exclude settled/past-governance launches
                { type: 'rule', field: 'already_live', op: 'in', value: ['N'] }, // exclude already-launched (Active in Banner / GTM past)
                { type: 'group', conj: 'any', children: [
                    { type: 'rule', field: 'launchterm',   op: 'before_field', value: 'cimterm' },      // launch term BEFORE CIM eff term (launching before effective)
                    { type: 'rule', field: 'gtm_lead_short', op: 'in', value: ['Y'] },                  // GTM runway < 6 mo
                    { type: 'rule', field: 'cim_behind_launch', op: 'in', value: ['Y'] },               // CIM behind the launch
                ] },
            ] },
            // planning ahead of CIM: launching with no CIM proposal linked
            { type: 'group', conj: 'all', children: [
                { type: 'rule', field: 'in_cim', op: 'in', value: ['N'] },
                { type: 'rule', field: 'svt', op: 'in', value: ['Launch in Progress', 'Regulatory Validation In Progress'] },
            ] },
        ] },
    ] } },
};
const _ADMIN_SVT_COLS = ['degree', 'college', 'campus', 'svt', 'svttype', 'substatus', 'launch', 'svtnote'];
const ADMIN_SVT_COORD_VIEW = {
    id: 'admin_svt_coord', name: 'Admin · Needs SVT coordination', team: true, system: true, admin: true,
    tip: 'SVT entries that do not cleanly map to one CIM program and need reconciliation with the SVT team — there is an SVT status but no CIM record. The SVT Coordination Note classifies each (heuristic): no CIM match, a possible match to an existing CIM program (likely a match failure / duplicate, e.g. "Applied Sustainability - new concentration, MS"), or a bundled name that may need splitting.',
    state: { visibleCols: _ADMIN_SVT_COLS, filters: {}, tree: { type: 'group', conj: 'all', children: [
        { type: 'rule', field: 'level', op: 'not_in', value: ['Undergraduate'] },
        { type: 'rule', field: 'svt_coord', op: 'in', value: ['Y'] },
    ] } },
};
const ADMIN_VIEWS = [ADMIN_LAUNCH_TIMING_VIEW, ADMIN_SVT_COORD_VIEW];

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
    const base = [ALL_PROGRAMS_VIEW, GTM_VIEW, GTM_NEEDS_ACTION_VIEW, GTM_RECENT_VIEW, RECENTLY_INACTIVATED_VIEW,
            PORTFOLIO_REVIEW_VIEW,
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
        disposition: [...portfolioDispositionFilter],
        ipd:        [...portfolioIpdFilter],
        roster:     [...portfolioRosterFilter],
        substatus:  [...portfolioSubStatusFilter],
        speed:      [...portfolioSpeedFilter],
        gls:        [...portfolioGlsFilter],
        cim:        [...portfolioCimFilter],
        cimchange:  [...portfolioCimChangeFilter],
        inworkflow: [...portfolioInWorkflowFilter],
        inactadmit: [...portfolioInactAdmitFilter],
        catalogyear:[...portfolioCatalogYearFilter],
        inacttoday: portfolioInactTodayFilter,
        inactprogress: portfolioInactProgressFilter,
        exitmasters: portfolioExitMastersFilter,
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
    portfolioDispositionFilter      = new Set(f.disposition || []);
    portfolioIpdFilter      = new Set(f.ipd       || []);
    portfolioRosterFilter   = new Set(f.roster    || []);
    portfolioSubStatusFilter = new Set(f.substatus || []);
    portfolioSpeedFilter    = new Set(f.speed     || []);
    portfolioGlsFilter      = new Set(f.gls       || []);
    portfolioCimFilter      = new Set(f.cim       || []);
    portfolioCimChangeFilter = new Set(f.cimchange || []);
    portfolioInWorkflowFilter = new Set(f.inworkflow || []);
    portfolioInactAdmitFilter = new Set(f.inactadmit || []);
    portfolioCatalogYearFilter = new Set(f.catalogyear || []);
    portfolioInactTodayFilter = f.inacttoday || '';
    portfolioInactProgressFilter = f.inactprogress || '';
    portfolioExitMastersFilter = f.exitmasters || '';
    // Search is a sticky, independent text filter — applying a view or filter must
    // NOT clear what the user has typed (Waleed 2026-07-23). So we deliberately do
    // NOT restore the view's saved search; portfolioSearch keeps its current value.
    // Sync all UI controls to the restored state
    _syncPortfolioFilterUi();
}

// Sync all filter UI widgets to the current filter state variables.
// Called after programmatically restoring filter state.
function _syncPortfolioFilterUi() {
    const multiIds = {
        'portfolio-filter-college':   portfolioCollegeFilter,
        'portfolio-filter-campus':    portfolioCampusFilter,
        'portfolio-filter-disposition':       portfolioDispositionFilter,
        'portfolio-filter-ipd':       portfolioIpdFilter,
        'portfolio-filter-roster':    portfolioRosterFilter,
        'portfolio-filter-substatus': portfolioSubStatusFilter,
        'portfolio-filter-speed':     portfolioSpeedFilter,
        'portfolio-filter-gls':       portfolioGlsFilter,
        'portfolio-filter-cim':       portfolioCimFilter,
        'portfolio-filter-cimchange': portfolioCimChangeFilter,
        'portfolio-filter-inworkflow':portfolioInWorkflowFilter,
        'portfolio-filter-inactadmit':portfolioInactAdmitFilter,
        'portfolio-filter-catalogyear':portfolioCatalogYearFilter,
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
    const ipSel = document.getElementById('portfolio-filter-inactprogress');
    if (ipSel) ipSel.value = portfolioInactProgressFilter;
    const emSel = document.getElementById('portfolio-filter-exitmasters');
    if (emSel) emSel.value = portfolioExitMastersFilter;
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
    s = String(s);
    // (a) academic-term label: "Fall 2026", "FA26", "Spring '27" …
    const m = s.match(/(Fall|Spring|Summer|Winter|FA|SP|SU|WI)\s*'?\s*((?:20)?\d{2})\b/i);
    if (m) {
        let yr = parseInt(m[2], 10); if (yr < 100) yr += 2000;
        const rank = {winter:0, wi:0, spring:1, sp:1, summer:2, su:2, fall:3, fa:3}[m[1].toLowerCase()];
        return rank == null ? null : yr * 10 + rank;
    }
    // (b) ISO calendar date "YYYY-MM-DD" → the academic term it falls in. SVT's
    // launch date (roster_launch_date) is an actual date post-Airtable, so we map
    // it to a term so it's comparable to term fields. Month→season matches
    // _pfCurrentTermRank: Jan–Apr Spring, May–Aug Summer, Sep–Dec Fall.
    const d = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (d) {
        const yr = parseInt(d[1], 10), mo = parseInt(d[2], 10);   // mo 1–12
        const season = mo <= 4 ? 1 : mo <= 8 ? 2 : 3;
        return yr * 10 + season;
    }
    return null;
}
// Format a term rank back to a label ("Fall 2026") for the builder's term picker.
function _pfTermLabel(rank) {
    if (rank == null) return '';
    const yr = Math.floor(rank / 10), s = rank % 10;
    return (({0:'Winter', 1:'Spring', 2:'Summer', 3:'Fall'})[s] || '') + ' ' + yr;
}
// Canonical term string for display, from any term/date source. Standardizes the
// three term fields (SVT launch = ISO date, GTM first = "Fall 27", CIM eff term)
// to one "Fall 2026" format. Falls back to the raw value when unparseable (e.g.
// "TBD"), and '' when empty.
function _pfTermDisplay(raw) {
    const r = _pfTermRank(raw);
    return r != null ? _pfTermLabel(r) : (raw ? String(raw) : '');
}
// "Recently inactivated" = a CIM inactivation that is EITHER still in workflow
// (being inactivated now — cim_step set) OR already approved (completed) within
// the current + two prior catalog years (~last three). There is no real
// inactivation-approval DATE — CIM completion is a catalog-year surrogate
// ("Catalog 2025-2026") — so approved-recency is measured by catalog edition.
function _pfCatalogStartYear(s) { const m = /(\d{4})\s*-\s*\d{4}/.exec(s || ''); return m ? parseInt(m[1], 10) : null; }
function _pfCurrentCatalogStartYear() { const d = new Date(); return d.getMonth() >= 4 ? d.getFullYear() : d.getFullYear() - 1; }
function _pfRecentlyInactivated(p) {
    if ((p.cim_change_type || '') !== 'Inactivation') return false;
    if (p.cim_step) return true;                        // in-workflow inactivation (being inactivated now)
    const y = _pfCatalogStartYear(p.cim_completion_date);
    if (y == null) return false;
    return y >= _pfCurrentCatalogStartYear() - 2;       // approved within the last 3 catalog editions
}
function _pfCurrentTermRank() {
    const d = new Date(), mo = d.getMonth();          // 0=Jan
    const rank = mo <= 3 ? 1 : mo <= 7 ? 2 : 3;        // Jan–Apr Spring, May–Aug Summer, Sep–Dec Fall
    return d.getFullYear() * 10 + rank;
}
// Distinct academic terms present across all `term`-typed fields, ordered
// chronologically — powers the term picker in the Views builder.
function _pfAllTermValues() {
    const ranks = new Set();
    (allPortfolioPrograms || []).forEach(p => {
        PORTFOLIO_FILTER_FIELDS.forEach(f => {
            if (f.type === 'term') { const r = _pfTermRank(f.value(p)); if (r != null) ranks.add(r); }
        });
    });
    // Return canonical term LABELS ("Fall 2026") ordered chronologically — the
    // literal-term operators compare via _pfTermRank, which parses these labels.
    return [...ranks].sort((a, b) => a - b).map(_pfTermLabel);
}
// Launch overdue / launch-vs-GTM / launch-before-CIM-term are now expressed as
// `term`-type filter rules in the admin views (before_now / diff_field /
// before_field), so their bespoke boolean accessors were removed 2026-07-23.
// SVT launch term falls outside CIM's approved effective catalog year (kept —
// CIM catalog is a catalog year, not a term, so the term type doesn't cover it).
// Fall Y -> catalog Y/(Y+1) (start Y); Spring/Summer/Winter Y -> catalog (Y-1)/Y (start Y-1).
function _pfLaunchVsCimCatalog(p) {
    // Uses the SVT launch TERM (Expected, else Proposed) — NOT roster_launch_date,
    // which is the go-to-market DATE.
    const r = _pfTermRank(p.roster_expected_launch_term || p.roster_proposed_launch_term);
    if (r == null) return false;
    const m = /Catalog\s+(\d{4})-\d{4}/.exec(p.cim_completion_date || '');
    if (!m) return false;
    const yr = Math.floor(r / 10), implied = (r % 10) >= 3 ? yr : yr - 1;
    return implied !== parseInt(m[1], 10);
}

// Launch-timing flags (_pfGtmLeadShort / _pfCimBehindLaunch / _pfPastGovernance),
// the effective-launch-term rank, the Banner term-code decoder, and the level
// classifier were MOVED to portfolio_fields.py — computed once in
// portfolio_ingest.py and read from stored columns (p.gtm_lead_short,
// p.cim_behind_launch, p.past_gov, p.launch_term, p.cim_term, p.level). Single
// source of truth, shared with the build's action_counts emitter.

const PORTFOLIO_FILTER_FIELDS = [
    {key: 'program',     label: 'Program',          type: 'text',   value: p => p.program_name || ''},
    {key: 'level',       label: 'Level',            type: 'select', value: p => p.level || ''},
    {key: 'credential',  label: 'Credential',       type: 'select', value: p => extractPortfolioDegree(p.program_name) || ''},
    {key: 'college',     label: 'College',          type: 'select', value: p => p.college || ''},
    {key: 'campus',      label: 'Campus',           type: 'select', value: p => p.campus || ''},
    {key: 'catalog_year',label: 'Catalog Year',     type: 'select',
        multi: p => { const ys = (p.catalog_years || '').split(/,\s*/).filter(Boolean); return ys.length ? ys : ['(none)']; },
        help: 'Catalog years the program is part of (current year + two forward), derived from CIM. Multi-valued: pick one or more years with "is one of"; "(none)" matches programs not in any of these catalog years.'},
    {key: 'in_catalog', label: 'In catalog (current or upcoming)', type: 'boolean',
        value: p => (p.catalog_years || '').split(/,\s*/).filter(Boolean).length ? 'Y' : 'N',
        help: 'Yes = the program is part of the current catalog year or one of the next two upcoming editions (the CIM catalog window). No = not in any current/upcoming catalog — e.g. a teach-out effective in a past year, still being wound down.'},
    {key: 'in_cim',      label: 'In CIM',           type: 'boolean', value: p => p.cim_program_id ? 'Y' : 'N'},
    {key: 'cim_step',    label: 'CIM Step',         type: 'select', value: p => p.cim_step || ''},
    {key: 'cim_change',  label: 'CIM Change',       type: 'select', value: p => p.cim_change_type || ''},
    {key: 'recent_inact', label: 'Recently inactivated (in workflow or last 3 catalog yrs)', type: 'boolean', value: p => _pfRecentlyInactivated(p) ? 'Y' : 'N',
        help: "Yes = a CIM inactivation that is either still in workflow (being inactivated now) or was approved (completed) within the current + two prior catalog years. No real approval date is stored, so approved-recency is by catalog edition."},
    {key: 'cimcompleted', label: 'CIM Completed',   type: 'select', value: p => p.cim_completion_date || '',
        help: 'CIM completion record (the effective catalog/term the proposal was approved for). "is set" = CIM finished approving this proposal (done); "is empty" = still in workflow or no CIM record. Use this rather than "CIM Step is empty" to mean CIM-done, since an unsubmitted/limbo record can also lack a step.'},
    {key: 'svt',         label: 'SVT Status',       type: 'select', value: p => p.svt_status || ''},
    {key: 'svt_type',    label: 'SVT Proposal Type', type: 'select', value: p => p.roster_proposal_type || ''},
    {key: 'launch',      label: 'GTM Launch',       type: 'date',   value: p => p.roster_launch_date || '',
        help: 'Go-To-Market launch DATE (SVT GTM_Launch) — market-live day. A date, not a term; ideally ~1 year before the launch term.'},
    {key: 'proposedterm', label: 'Proposed Launch Term', type: 'term', value: p => p.roster_proposed_launch_term || '',
        help: 'Launch TERM the submitter requested (SVT Proposed_Launch_Time). Compare by academic-term order to a chosen term, the current term, or another term field.'},
    {key: 'expectedterm', label: 'Expected Launch Term', type: 'term', value: p => p.roster_expected_launch_term || '',
        help: 'Launch TERM the EMPL PM expects (SVT Expected_Launch). Often blank — only network deployments get a PM.'},
    {key: 'launchterm',  label: 'Launch Term (Expected, else Proposed)', type: 'term', value: p => p.launch_term || '',
        help: 'The effective SVT launch term used for CIM/GTM comparisons: Expected Launch Term when set, otherwise Proposed Launch Term.'},
    {key: 'cimterm',     label: 'CIM Effective Term', type: 'term',  value: p => p.cim_term || ''},
    {key: 'gtm_lead_short', label: 'GTM lead < 6 months', type: 'boolean', value: p => p.gtm_lead_short || 'N',
        help: 'Yes = the Go-To-Market date leads the launch term (Expected/Proposed) by LESS than 6 months, or is after it — not enough recruiting runway (ideal is ~1 year). Only evaluated when both a GTM date and a parseable launch term are present.'},
    {key: 'cim_behind_launch', label: 'CIM behind launch timeline', type: 'boolean', value: p => p.cim_behind_launch || 'N',
        help: 'Yes = the launch term (Expected/Proposed) is the current or next term, but the CIM proposal is still pre-approval (College discussion or Governance — not yet past Senate into teach-out/setup/completed). Flags programs unlikely to be approved in time to launch.'},
    {key: 'already_live', label: 'Already launched (Banner Active / GTM past)', type: 'boolean', value: p => p.already_live || 'N'},
    {key: 'launching',   label: 'Launching (governance done, first window)', type: 'boolean', value: p => p.launching || 'N'},
    {key: 'past_gov',    label: 'Governance past', type: 'boolean', value: p => p.past_gov || 'N',
        help: 'Yes = the CIM proposal has completed the approval workflow, or is at a post-approval build step (teach-out/Setup/Banner/Editor/Catalog/Degree Audit). Used to EXCLUDE settled programs from the launch-timing view — launch execution is not tracked here.'},
    {key: 'launch_vs_cim',  label: 'SVT launch ≠ CIM catalog', type: 'boolean', value: p => _pfLaunchVsCimCatalog(p) ? 'Y' : 'N'},
    {key: 'svt_coord',   label: 'Needs SVT coordination', type: 'boolean', value: p => _svtNeedsCoord(p) ? 'Y' : 'N'},
    {key: 'svtnote',     label: 'SVT coordination note', type: 'text',    value: p => _svtCoordNote(p)},
    {key: 'substatus',   label: 'SVT Sub-status',   type: 'select', value: p => p.roster_sub_status || ''},
    {key: 'speed',       label: 'Speed to Market',  type: 'boolean', value: p => p.speed_to_market === 'True' ? 'Y' : p.speed_to_market === 'False' ? 'N' : ''},
    {key: 'gls',         label: 'GLS Status',       type: 'select', value: p => p.gls_status || ''},
    {key: 'cim_inact',   label: 'Inactivation in Progress', type: 'boolean', value: p => _cimInactivating(p) ? 'Y' : 'N',
        help: 'Yes when the program has a CIM inactivation and isn’t fully wound down — still moving through the CIM workflow (including teach-out) or still admitting students.'},
    {key: 'inact_admit', label: 'Inactivation of Admission', type: 'select', value: p => p.inactivation_admission || ''},
    {key: 'admit_today', label: 'Admitting Today',  type: 'boolean', value: p => { const v = _inactAdmittingToday(p); return v === 'Yes' ? 'Y' : v === 'No' ? 'N' : ''; }},
    {key: 'offering',    label: 'New Offering',     type: 'select', value: p => portfolioOfferingLabel(p)},
    {key: 'ready_gtm',   label: 'Ready for GTM',    type: 'boolean', value: p => p.ready_for_gtm === 'Yes' ? 'Y' : 'N'},
    {key: 'gtm_inact',   label: 'GTM Inactivation', type: 'boolean', value: p => p.gtm_inactivation === 'Yes' ? 'Y' : 'N'},
    {key: 'gtm_entered', label: 'GTM Entered Date', type: 'date',   value: p => p.gtm_entered_date || ''},
    {key: 'gtm_type',    label: 'GTM Type',         type: 'select', value: p => p.gtm_type || ''},
    {key: 'gtm_date',    label: 'GTM Date',         type: 'text',   value: p => p.gtm_date || ''},
    {key: 'gtm_first',   label: 'GTM First Intake', type: 'term',   value: p => p.gtm_first_term || ''},
    {key: 'gtm_last',    label: 'GTM Last Term',    type: 'select', value: p => p.gtm_last_term || ''},
    {key: 'gtm_intake',  label: 'GTM Intake Terms', type: 'text',   value: p => p.gtm_intake_terms || ''},
    {key: 'exit_masters',label: "Exit master's only", type: 'select', value: p => p.exit_masters || ''},
    {key: 'note',        label: 'OTP Notes',        type: 'text',   value: p => p.note || ''},
    {key: 'disposition', label: 'OTP Disposition',  type: 'select',
        multi: p => (p.dispositions || []),                 // multi-valued — a program can carry several
        options: () => portfolioDispositionValues,          // fixed 6 leadership/college dispositions, not row-derived
        help: 'Editable leadership/college disposition on a program’s future (multi-select, timestamped). Multi-valued: pick one or more with "is one of"; a program with none set matches "is not set".'},
];
function _pvField(key) { return PORTFOLIO_FILTER_FIELDS.find(f => f.key === key); }

// Distinct values for a select field (across all portfolio rows), sorted.
function getPortfolioFieldValues(key) {
    const f = _pvField(key);
    if (!f) return [];
    // Fixed option list (e.g. dispositions) — offer all allowed values, not just
    // the ones currently in use on some row.
    if (f.options) return (f.options() || []).slice();
    const set = new Set();
    (allPortfolioPrograms || []).forEach(p => {
        // Multi-valued fields (e.g. Catalog Year, where a row belongs to several
        // years) expose each value individually so the picker offers them all.
        if (f.multi) (f.multi(p) || []).forEach(v => { if (v) set.add(v); });
        else set.add(f.value(p));
    });
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
    const op = rule.op || '';
    // Multi-valued field (e.g. Catalog Year): the row has a set of values; a
    // rule matches if any selected value is in that set ("is one of" OR).
    if (f.multi) {
        const vals = (f.multi(p) || []).map(String).filter(Boolean);
        if (op === 'is_set')   return vals.length > 0;
        if (op === 'is_empty') return vals.length === 0;
        const arr = Array.isArray(rule.value) ? rule.value : (rule.value ? [rule.value] : []);
        if (!arr.length) return true;
        const sel = new Set(arr);
        const hit = vals.some(x => sel.has(x));
        return op === 'not_in' ? !hit : hit;
    }
    let v = String(f.value(p) == null ? '' : f.value(p));
    if (op === 'is_set')   return v !== '';
    if (op === 'is_empty') return v === '';
    if (f.type === 'term') {
        // Academic-term comparison by rank (Winter<Spring<Summer<Fall). Ops:
        // literal (is/before/on_after vs a chosen term), current-term
        // (before_now/on_after_now), and field-vs-field (…_field, value = another
        // term field's key). Comparisons require BOTH sides to parse to a term;
        // an unparseable/blank term never matches a comparison (it's not a
        // meaningful disagreement) — matching the old boolean accessors.
        const rank = _pfTermRank(v);
        if (op === 'before_now')   return rank != null && rank <  _pfCurrentTermRank();
        if (op === 'on_after_now') return rank != null && rank >= _pfCurrentTermRank();
        if (op === 'is' || op === 'before' || op === 'on_after') {
            const rr = _pfTermRank(rule.value);
            if (rank == null || rr == null) return false;
            if (op === 'is')     return rank === rr;
            if (op === 'before') return rank <  rr;
            return rank >= rr;                        // on_after
        }
        if (op === 'before_field' || op === 'on_after_field' || op === 'same_field' || op === 'diff_field') {
            const of = _pvField(rule.value);
            if (!of) return true;                     // no field chosen yet → don't restrict
            const orank = _pfTermRank(String(of.value(p) == null ? '' : of.value(p)));
            if (rank == null || orank == null) return false;
            if (op === 'before_field')   return rank <  orank;
            if (op === 'on_after_field') return rank >= orank;
            if (op === 'same_field')     return rank === orank;
            return rank !== orank;                    // diff_field
        }
        return true;
    }
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
    if (t === 'term')    return [
        ['is','is'],['before','is before'],['on_after','is on or after'],
        ['before_now','is before the current term'],['on_after_now','is the current term or later'],
        ['before_field','is before (another field)'],['on_after_field','is on or after (another field)'],
        ['same_field','is the same term as (another field)'],['diff_field','is a different term from (another field)'],
        ['is_set','is set'],['is_empty','is not set']];
    return [['in','is one of'],['not_in','is not one of'],['is_set','is set'],['is_empty','is not set']];
}
function _defaultPvRule(key) {
    const f = _pvField(key) || PORTFOLIO_FILTER_FIELDS[0];
    if (f.type === 'text')    return {type:'rule', field:f.key, op:'contains', value:''};
    if (f.type === 'boolean') return {type:'rule', field:f.key, op:'in', value:['Y']};
    if (f.type === 'date')    return {type:'rule', field:f.key, op:'within_days', value:'30'};
    if (f.type === 'term')    return {type:'rule', field:f.key, op:'before_now', value:null};
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
    // Optional default sort carried by the view (else leave the current sort).
    if (view.state.sortKey !== undefined) {
        portfolioSortKey = view.state.sortKey || '';
        portfolioSortDir = view.state.sortDir || 1;
    }
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
    html += item(RECENTLY_INACTIVATED_VIEW);
    html += item(PORTFOLIO_REVIEW_VIEW);
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
    const help = f.help
        ? `<span class="info-tip" onclick="event.stopPropagation()"><i class="tip-icon">i</i><span class="tip-bubble">${escapeHtml(f.help)}</span></span>`
        : '';
    return `<div class="pvb-rule">${fieldSel}${help}${opSel}${_renderPvRuleValue(rule, f, path)}
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
    if (f.type === 'term') {
        if (rule.op === 'before_now' || rule.op === 'on_after_now') return '';   // relative to today — no value
        if (rule.op && rule.op.endsWith('_field')) {
            const others = PORTFOLIO_FILTER_FIELDS.filter(x => x.type === 'term' && x.key !== f.key);
            return `<select class="pvb-text" onchange="pvbSetValue('${path}', this.value)">
                <option value="">choose field…</option>
                ${others.map(x => `<option value="${x.key}"${rule.value === x.key ? ' selected' : ''}>${escapeHtml(x.label)}</option>`).join('')}
            </select>`;
        }
        const terms = _pfAllTermValues();
        return `<select class="pvb-text" onchange="pvbSetValue('${path}', this.value)">
            <option value="">choose term…</option>
            ${terms.map(t => `<option value="${escapeHtml(t)}"${rule.value === t ? ' selected' : ''}>${escapeHtml(t)}</option>`).join('')}
        </select>`;
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
function pvbSetOp(path, op)      { const w = _pvWalk(path); if (w && w.node.type === 'rule') { w.node.op = op; const t = (_pvField(w.node.field) || {}).type; if (op === 'is_set' || op === 'is_empty') w.node.value = null; else if (t === 'term') w.node.value = (op === 'before_now' || op === 'on_after_now') ? null : ''; else if (t === 'date') w.node.value = (op === 'within_days') ? '30' : ''; else if (!w.node.value || (Array.isArray(w.node.value) && !w.node.value.length)) w.node.value = (t === 'text') ? '' : []; renderPvModal(); } }
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
// ── Rail filter option-builders ─────────────────────────────────────────────
// The active-filter / Add-filter UI now lives in the shared shell
// (shared/web/rail.js). These two helpers stay here because they build option
// lists from program data; the config below wires them into the shell's field
// registry. See shared/web/left-rail-redesign.md.
function _railDistinct(get, withNone) {
    const s = new Set(); let blank = false;
    (allPortfolioPrograms || []).forEach(p => { const v = get(p); if (v) s.add(v); else blank = true; });
    const arr = [...s].sort((a, b) => String(a).localeCompare(String(b)));
    return (withNone && blank) ? [...arr, '(none)'] : arr;
}
function _railCatalogYears() {
    const s = new Set(); let blank = false;
    (allPortfolioPrograms || []).forEach(p => {
        const ys = (p.catalog_years || '').split(/,\s*/).filter(Boolean);
        if (ys.length) ys.forEach(y => s.add(y)); else blank = true;
    });
    const arr = [...s].sort();
    return blank ? [...arr, '(none)'] : arr;
}
// The program tracker's field registry for the shared shell — same globals /
// option sets getPortfolioFiltered reads, mapped to the shell's FieldDef
// contract (multi: options/has/toggle; bool: get/set). Rail rows drive the
// simple AND quick-filters; saved Views keep the full filterTree builder.
function _pgMulti(id, label, category, setFn, optionsFn, opts) {
    opts = opts || {};
    return {
        id: id, label: label, category: category, kind: 'multi', search: !!opts.search, labelFor: opts.labelFor,
        options: optionsFn,
        has: v => setFn().has(v),
        toggle: v => { const s = setFn(); if (s.has(v)) s.delete(v); else s.add(v); },
        active: () => setFn().size > 0,
        clear: () => setFn().clear(),
        summary: () => { const a = [...setFn()]; return a.length === 1 ? (opts.labelFor ? opts.labelFor(a[0]) : a[0]) : (a.length ? a.length + ' selected' : ''); },
    };
}
function _pgBool(id, label, category, getFn, setFn) {
    return {
        id: id, label: label, category: category, kind: 'bool',
        get: getFn, set: setFn, active: () => getFn() !== '', clear: () => setFn(''), summary: () => getFn(),
    };
}
function _portfolioRailFields() {
    return [
        // Level / College / Campus / Credential are permanent top-level `scopes`
        // now (Level = Focus buttons, see _programScopes), so they're no longer in
        // the collapsible Filters list.
        _pgMulti('disposition','OTP disposition','SVT / OTP', () => portfolioDispositionFilter, () => [...portfolioDispositionValues, '(none)']),
        _pgMulti('svt',        'SVT status',   'SVT / OTP', () => portfolioRosterFilter, () => _railDistinct(p => p.svt_status, true)),
        _pgMulti('substatus',  'SVT sub-status','SVT / OTP', () => portfolioSubStatusFilter, () => _railDistinct(p => p.roster_sub_status, true)),
        _pgMulti('speed',      'Speed to market','SVT / OTP', () => portfolioSpeedFilter, () => ['True','False'], {labelFor: v => v === 'True' ? 'Yes' : (v === 'False' ? 'No' : v)}),
        _pgMulti('gls',        'GLS status',   'GLS',     () => portfolioGlsFilter,     () => _railDistinct(p => p.gls_status, true)),
        _pgMulti('cim',        'CIM step',     'CIM',     () => portfolioCimFilter,     () => _railDistinct(p => p.cim_step, true), {search: true}),
        _pgMulti('cimchange',  'CIM change',   'CIM',     () => portfolioCimChangeFilter,() => _railDistinct(p => p.cim_change_type, true)),
        _pgMulti('inworkflow', 'In CIM',       'CIM',     () => portfolioInWorkflowFilter,() => ['Yes','No']),
        _pgMulti('inactadmit', 'Inactivation of admission','CIM', () => portfolioInactAdmitFilter, () => _railDistinct(p => p.inactivation_admission, true), {search: true}),
        _pgMulti('catalogyear','Catalog year', 'CIM',     () => portfolioCatalogYearFilter, () => _railCatalogYears()),
        _pgMulti('ipd',        'IPD status',   'IPD',     () => (typeof portfolioIpdFilter !== 'undefined' ? portfolioIpdFilter : new Set()), () => _railDistinct(p => p.ipd_status, true)),
        _pgBool('inacttoday',    'Admitting today',          'CIM', () => portfolioInactTodayFilter,    v => { portfolioInactTodayFilter = v; }),
        _pgBool('inactprogress', 'Inactivation in progress', 'CIM', () => portfolioInactProgressFilter, v => { portfolioInactProgressFilter = v; }),
        _pgBool('exitmasters',   "Exit master's only",       'Program', () => portfolioExitMastersFilter, v => { portfolioExitMastersFilter = v; }),
        // Everything else: one generic rail filter per remaining select/boolean
        // Views-builder field, so every such column is reachable from ＋ Add filter.
        ..._portfolioGenericRailFields(),
    ];
}

// Build a rail quick-filter for each PORTFOLIO_FILTER_FIELDS select/boolean field
// that isn't already a curated rail filter or a top-level scope. Backed by
// portfolioGenFilters[key]; matched in getPortfolioFiltered via evalPortfolioRule.
// Date/term/text fields stay Views-builder-only (they need range operators).
function _portfolioGenericRailFields() {
    // Concepts already covered by the curated rail filters + scopes above.
    const covered = new Set([
        'level', 'college', 'campus', 'credential', 'program',
        'svt', 'substatus', 'speed', 'gls', 'cim_step', 'cim_change',
        'in_cim', 'catalog_year', 'disposition', 'cim_inact', 'exit_masters',
        'inact_admit', 'admit_today',   // duplicate the curated inactadmit / inacttoday
    ]);
    return (PORTFOLIO_FILTER_FIELDS || [])
        .filter(f => !covered.has(f.key) && (f.type === 'select' || f.type === 'boolean'))
        .map(f => {
            const key = f.key;
            const getSet = () => (portfolioGenFilters[key] || (portfolioGenFilters[key] = new Set()));
            if (f.type === 'boolean') {
                return _pgMulti(key, f.label, 'More', getSet, () => ['Y', 'N'],
                    { labelFor: v => v === 'Y' ? 'Yes' : v === 'N' ? 'No' : v });
            }
            return _pgMulti(key, f.label, 'More', getSet,
                () => (getPortfolioFieldValues(key) || []).filter(v => v !== ''), { search: true });
        });
}

// CIM Programs/Courses/Catalog filter registry for the shared rail — drives the
// same Set globals getFiltered reads (typeFilter = Level, proposalFilter =
// proposal scope, programKindFilter = credential). onChange calls applyFilters().
// Permanent top-level rail pickers: College / Campus / Credential, single-select
// + "All", per-function. On CIM they drive the cimMultiFilters Sets / programKind;
// on Portfolio they drive the portfolio filter Sets. A single value is written as
// a 0/1-element Set so all existing (multi) read-paths keep working unchanged.
function _programScopes() {
    const _one = set => { const a = [...(set || [])].filter(Boolean); return a.length === 1 ? a[0] : ''; };
    const _isCim = () => currentView === 'programs' || currentView === 'courses';
    const _KIND_LABEL = { bachelors: "Bachelor's", masters: "Master's", phd: 'PhD', profdoc: 'Prof. Doctorate',
        certificate: 'Certificate', cags: 'CAGS', minor: 'Minor', plusone: 'PlusOne', concentration: 'Concentration', dual: 'Dual Degree' };
    const _PF_CREDENTIALS = ["Bachelor's", "Master's", "PhD", "Prof. Doctorate", "CAGS", "Certificate", "Minor", "Dual Degree", "PlusOne", "Concentration"];
    return [
        {   // Level (Undergraduate / Graduate) — Focus buttons on CIM programs +
            // courses AND the Portfolio view. Both back a multi-select Set
            // (typeFilter for CIM, portfolioLevelFilter for Portfolio), so each
            // button toggles independently.
            kind: 'buttons', label: 'Level',
            enabled: () => currentView === 'portfolio' || currentView === 'programs' || currentView === 'courses',
            options: () => [{ value: 'Undergraduate', label: 'Undergrad' }, { value: 'Graduate', label: 'Graduate' }],
            has: v => currentView === 'portfolio' ? portfolioLevelFilter.has(v) : typeFilter.has(v),
            onSelect: v => {
                if (currentView === 'portfolio') {
                    if (portfolioLevelFilter.has(v)) portfolioLevelFilter.delete(v); else portfolioLevelFilter.add(v);
                    renderPortfolioTable();
                    if (typeof updateClearButtons === 'function') updateClearButtons();
                } else setTypeFilter(v);
            },
        },
        {   // College — CIM (University perspective only) + Portfolio.
            label: 'College', placeholder: 'All colleges',
            enabled: () => currentView === 'portfolio' || (_isCim() && cimPerspective !== 'college'),
            options: () => {
                let vals;
                if (currentView === 'portfolio') vals = getPortfolioFieldValues('college') || [];
                else { const s = new Set(); ((currentView === 'courses' ? allCourses : allPrograms) || []).forEach(p => { if (p.college) s.add(p.college); }); vals = [...s]; }
                return vals.filter(Boolean).sort((a, b) => abbreviateCollege(a).localeCompare(abbreviateCollege(b))).map(c => ({ value: c, label: abbreviateCollege(c) }));
            },
            active: () => currentView === 'portfolio' ? _one(portfolioCollegeFilter) : _one(cimMultiSel('filter-college')),
            onSelect: v => {
                if (currentView === 'portfolio') { portfolioCollegeFilter = v ? new Set([v]) : new Set(); renderPortfolioTable(); }
                else { cimMultiFilters['filter-college'] = v ? new Set([v]) : new Set(); applyFilters(); }
                if (typeof updateClearButtons === 'function') updateClearButtons();
            },
        },
        {   // Campus — CIM Programs + Portfolio.
            label: 'Campus', placeholder: 'All campuses',
            enabled: () => currentView === 'portfolio' || currentView === 'programs',
            options: () => {
                let vals;
                if (currentView === 'portfolio') vals = getPortfolioFieldValues('campus') || [];
                else { const s = new Set(); (allPrograms || []).forEach(p => { const c = extractCampus(p.name); if (c) s.add(c); }); vals = [...s]; }
                const opts = vals.filter(Boolean).sort().map(c => ({ value: c, label: c }));
                // Portfolio: offer a synthetic "Network" campus (all except Boston/Online).
                if (currentView === 'portfolio') opts.unshift({ value: _NETWORK_CAMPUS, label: _NETWORK_CAMPUS });
                return opts;
            },
            active: () => currentView === 'portfolio' ? _one(portfolioCampusFilter) : _one(cimMultiSel('filter-campus')),
            onSelect: v => {
                if (currentView === 'portfolio') { portfolioCampusFilter = v ? new Set([v]) : new Set(); renderPortfolioTable(); }
                else { cimMultiFilters['filter-campus'] = v ? new Set([v]) : new Set(); applyFilters(); }
                if (typeof updateClearButtons === 'function') updateClearButtons();
            },
        },
        {   // Credential — CIM Programs (programKind) + Portfolio (degree).
            label: 'Credential', placeholder: 'All credentials',
            enabled: () => currentView === 'portfolio' || currentView === 'programs',
            options: () => {
                if (currentView === 'portfolio') return _PF_CREDENTIALS.map(v => ({ value: v, label: v }));
                const s = new Set(); (allPrograms || []).forEach(p => { const k = classifyProgramKind(p); if (k) s.add(k); });
                return [...s].sort().map(k => ({ value: k, label: _KIND_LABEL[k] || k }));
            },
            active: () => currentView === 'portfolio' ? _one(portfolioDegreeFilter) : (programKindFilter || ''),
            onSelect: v => {
                if (currentView === 'portfolio') { portfolioDegreeFilter = v ? new Set([v]) : new Set(); renderPortfolioTable(); }
                else { programKindFilter = v || ''; applyFilters(); }
                if (typeof updateClearButtons === 'function') updateClearButtons();
            },
        },
    ];
}

function _cimRailFields() {
    const _PROPOSAL_LABEL = { Added: 'New', Edited: 'Change', Deactivated: 'Inactivation', '__complete__': 'Complete' };
    const fields = [
        _pgMulti('cim_proposal', 'Proposal', 'CIM', () => proposalFilter, () => ['Added', 'Edited', 'Deactivated', '__complete__'],
            { labelFor: v => _PROPOSAL_LABEL[v] || v }),
    ];
    // (Perspective is a rail MODE, and College / Campus / Credential are permanent
    //  top-level `scopes` — see initProgramShell — so none of them are in this
    //  filter list anymore. What's left are the multi-value filters.)
    // Approver (the classic #filter-approver <select>, populated dynamically) —
    // a radio-style "multi" driving the select's value + applyFilters.
    const _apSel = () => document.getElementById('filter-approver');
    fields.push({
        id: 'cim_approver', label: 'Approver', category: 'CIM', kind: 'multi',
        options: () => { const s = _apSel(); return s ? [...s.options].map(o => o.value).filter(Boolean) : []; },
        labelFor: v => { const s = _apSel(); if (!s) return v; const o = [...s.options].find(o => o.value === v); return o ? o.text : v; },
        has: v => (_apSel()?.value || '') === v,
        toggle: v => { const s = _apSel(); if (!s) return; s.value = (s.value === v) ? '' : v;
            if (typeof applyFilters === 'function') applyFilters();
            if (typeof updateClearButtons === 'function') updateClearButtons(); },
        active: () => !!(_apSel()?.value),
        clear: () => { const s = _apSel(); if (!s) return; s.value = '';
            if (typeof applyFilters === 'function') applyFilters();
            if (typeof updateClearButtons === 'function') updateClearButtons(); },
        summary: () => { const s = _apSel(); return (s && s.value) ? (s.options[s.selectedIndex]?.text || '') : ''; },
    });
    // Step (the classic #filter-step <select>) — radio-style multi, programs only.
    if (currentView === 'programs') {
        const _stSel = () => document.getElementById('filter-step');
        fields.push({
            id: 'cim_step', label: 'Step', category: 'CIM', kind: 'multi',
            options: () => { const s = _stSel(); return s ? [...s.options].map(o => o.value).filter(Boolean) : []; },
            has: v => (_stSel()?.value || '') === v,
            toggle: v => { const s = _stSel(); if (!s) return; s.value = (s.value === v) ? '' : v;
                if (typeof applyFilters === 'function') applyFilters();
                if (typeof updateClearButtons === 'function') updateClearButtons(); },
            active: () => !!(_stSel()?.value),
            clear: () => { const s = _stSel(); if (!s) return; s.value = '';
                if (typeof applyFilters === 'function') applyFilters();
                if (typeof updateClearButtons === 'function') updateClearButtons(); },
            summary: () => { const s = _stSel(); return (s && s.value) ? (s.options[s.selectedIndex]?.text || '') : ''; },
        });
        // New Offering (from programs.new_offering — the proposal-XML signal, since
        // CIM's status almost never says "New"). Multi-select; drives getBaseFiltered.
        fields.push(_pgMulti('cim_offering', 'New Offering', 'CIM',
            () => cimNewOfferingFilter, () => ['new_concentration', 'new_degree'],
            { labelFor: v => v === 'new_concentration' ? 'New concentration'
                           : v === 'new_degree' ? 'New degree' : v }));
    }
    return fields;
}

function renderPortfolioViewTiles() {
    const bar = document.getElementById('portfolio-view-tiles');
    if (!bar) return;
    if (currentView !== 'portfolio') { bar.style.display = 'none'; window._portfolioTileViews = []; if (window.trackerShell) window.trackerShell.refresh(); return; }

    const stars   = getPortfolioStarredIds();
    // The permanent "All Programs" view is always first; then starred team/
    // personal views. The bar is therefore always visible.
    const starredViews = [...getPortfolioTeamViews(), ...getPortfolioPersonalViews()]
                            .filter(v => stars.has(v.id));
    const tileViews = [ALL_PROGRAMS_VIEW, GTM_VIEW, GTM_NEEDS_ACTION_VIEW, GTM_RECENT_VIEW, RECENTLY_INACTIVATED_VIEW,
        PORTFOLIO_REVIEW_VIEW,
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

    // Clickable "VIEWS" label opens the Views modal (replaces the header button).
    const _viewsLabel = `<button class="view-tiles-label" onclick="openPortfolioViewsModal()" title="Open saved views — switch, star, or build a filter">VIEWS${_pvIsAdmin() ? ' <span class="pv-admin-pill">ADMIN</span>' : ''}</button>`;
    bar.innerHTML = _viewsLabel + tileViews.map(v => {
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

    window._portfolioTileViews = tileViews;   // hand the rail its Views list
    if (window.trackerShell) window.trackerShell.refresh();
}

// Back-compat aliases
function saveCurrentAsPortfolioView() { openPortfolioViewsModal(); }
function deletePortfolioView(id)      { pvDeleteView(id); }

let allPortfolioPrograms   = [];
// Canonical program key — folds online modality variants (-O / -PO, + aliased
// irregulars) into the base program so they group as deployments and share
// program-grain OTP. Mirrors database.canonical_banner. Bridge/Align stay separate.
// Group the New York "International Business, BS" (BS-INBU-NX) deployment with
// the Boston BSIB group (BSIB-INBU-NX) — same program, coded BS at NY / BSIB at
// Boston (a Banner coding inconsistency); the Exchange variant (-X) stays its
// own program.
const _BANNER_ALIAS = {'MSIS-IS-B-O': 'MSIS-INSY-B', 'BS-INBU-NX': 'BSIB-INBU-NX'};
let _validBannerSet = new Set();
function _rebuildValidBanners() {
    _validBannerSet = new Set((allPortfolioPrograms || [])
        .map(p => (p.banner_code || '').trim()).filter(Boolean));
}
function canonicalBanner(code) {
    code = (code || '').trim();
    if (!code) return code;
    if (_BANNER_ALIAS[code]) return _BANNER_ALIAS[code];
    for (const suf of ['-PO', '-O']) {
        if (code.endsWith(suf)) {
            const base = code.slice(0, -suf.length);
            if (_validBannerSet.has(base)) return base;
        }
    }
    return code;
}
let portfolioDispositionValues = [];   // the 6 allowed leadership/college dispositions
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

// Shortcut: set the Campus multi-select to every network campus — all except
// Boston AND Online (Online isn't a physical location). Toggles off if already
// exactly that set.
function setPortfolioCampusNetwork() {
    const s = portfolioCampusFilter;
    const network = getPortfolioFieldValues('campus').filter(v => v && v !== 'Boston' && v !== 'Online');
    const isNetwork = !s.has('Boston') && !s.has('Online') && s.size === network.length
        && network.every(v => s.has(v));
    s.clear();
    if (!isNetwork) network.forEach(v => s.add(v));
    _updateMultiFilterBtn('portfolio-filter-campus', s);
    updateClearButtons();
    renderPortfolioTable();
}
if (typeof window !== 'undefined') window.setPortfolioCampusNetwork = setPortfolioCampusNetwork;
let portfolioDispositionFilter       = new Set();
let portfolioIpdFilter       = new Set();
let portfolioRosterFilter    = new Set();  // SVT Status filter (legacy id)
let portfolioSubStatusFilter = new Set();  // SVT Sub-status (Launch Sub-Status)
let portfolioSpeedFilter     = new Set();  // Speed to Market
let portfolioGlsFilter       = new Set();
let portfolioCimFilter       = new Set();
let portfolioCimChangeFilter  = new Set();
let portfolioInWorkflowFilter = new Set();
let portfolioCatalogYearFilter = new Set();   // Catalog Years (CIM-derived membership)

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
let portfolioInactProgressFilter = '';   // '' | 'Yes' | 'No' — CIM inactivation in progress
let portfolioExitMastersFilter = '';     // '' | 'Yes' | 'No' — exit-master's-only

// "Fall 2026" → Date object for Sep 1 of that year (approximate start of Fall semester).
function _semesterToDate(s) {
    if (!s) return null;
    const m = s.match(/^(Fall|Spring|Summer)\s+(\d{4})$/i);
    if (!m) return null;
    const year = parseInt(m[2], 10);
    const month = /fall/i.test(m[1]) ? 8 : /spring/i.test(m[1]) ? 0 : 5; // Sep=8, Jan=0, Jun=5
    return new Date(year, month, 1);
}

// A program's inactivation is *in progress* when its current CIM proposal is an
// Inactivation and the program is not fully wound down yet — still moving
// through the CIM workflow (including Program Teach-Out) OR still admitting
// students (inactivation approved but admissions not yet ended). All-levels.
function _cimInactivating(p) {
    if (p.cim_change_type !== 'Inactivation') return false;
    // In progress = the program has a CIM inactivation and is not fully wound
    // down: still moving through the workflow (including Program Teach-Out) OR
    // the inactivation is approved but the program is still admitting students.
    return !!p.cim_step || _inactAdmittingToday(p) === 'Yes';
}

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
let _pfSearchRenderTimer = null;
function setPortfolioSearch(v) {
    portfolioSearch = v || '';
    const hdr = document.getElementById('filter-search');
    if (hdr && hdr.value !== portfolioSearch) hdr.value = portfolioSearch;
    if (typeof updateClearButtons === 'function') updateClearButtons();
    _portfolioViewTouch();
    // Debounce the expensive full-table re-render so typing stays responsive on
    // the large portfolio (the cheap bits above still run per keystroke).
    clearTimeout(_pfSearchRenderTimer);
    _pfSearchRenderTimer = setTimeout(() => {
        if (typeof renderPortfolioTable === 'function') renderPortfolioTable();
    }, 180);
}
// Belt-and-suspenders: explicit window-level export so inline handlers
// always resolve setPortfolioSearch regardless of script-scope nuances.
if (typeof window !== 'undefined') window.setPortfolioSearch = setPortfolioSearch;

// classifyPortfolioLevel moved to portfolio_fields.py (stored as p.level).

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
    "Prof Doctorate":new Set(['DNP','DPT','DPS','DLP','EDD','DMSC','PHARMD','JD','JSSD']),  // LLM (Master of Laws) is a master's, not a doctorate
    "CAGS":          new Set(['CAGS']),
    "Certificate":   new Set(['CERTG','CERTU','CERTP','CERT']),
    "Minor":         new Set(['MINOR']),
};

function _credentialFromCode(rawIn) {
    const raw = (rawIn || '').toUpperCase().replace(/\./g, '');
    if (_CRED_SETS["CAGS"].has(raw))           return 'CAGS';
    if (_CRED_SETS["PhD"].has(raw))            return 'PhD';
    if (_CRED_SETS["Prof Doctorate"].has(raw)) return 'Prof. Doctorate';
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
    if (/\bDoctor\s+of\b/i.test(n))              return 'Prof. Doctorate';
    if (/\bDoctorate\b/i.test(n))                return 'Prof. Doctorate';
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
        const [res, dres] = await Promise.all([
            fetch('/api/portfolio'),
            fetch('/api/portfolio/dispositions'),
            loadScanStatus(),
        ]);
        const pj = await res.json();
        try { const dj = await dres.json(); portfolioDispositionValues = dj.values || []; }
        catch (e) { console.error('dispositions load failed', e); }
        allPortfolioPrograms = pj.programs || [];
        _rebuildValidBanners();
        allPortfolioPrograms.forEach(p => {
            p.concentrations = p.concentrations_json ? JSON.parse(p.concentrations_json) : [];
            try { p.enrollment = p.enrollment_json ? JSON.parse(p.enrollment_json) : null; }
            catch (e) { p.enrollment = null; }
            // Two-grain OTP arrives pre-resolved from /api/portfolio (most-specific-wins):
            //   p.dispositions / p.note              = effective value the UI shows
            //   p.program_dispositions / p.program_note      = program grain (Banner code)
            //   p.deployment_dispositions / p.deployment_note = deployment grain (this row)
            //   p.otp_disposition_source / p.otp_note_source  = 'program' | 'deployment' | ''
            p.dispositions            = p.dispositions            || [];
            p.program_dispositions    = p.program_dispositions    || [];
            p.deployment_dispositions = p.deployment_dispositions || [];
        });
        await _hydratePortfolioTeamViews(pj);
        populatePortfolioFilters();
        if (isRefresh) {
            // Restore exactly what was on screen before the refresh — INCLUDING the
            // expanded programs/campuses/concentrations. Previously portfolioExpandedIds
            // /CollapsedIds were reset here on every 2-min auto-refresh, which collapsed
            // the user's open concentration rows and made the campus chevron look like
            // it "did nothing" (expand, then the refresh silently re-collapsed them).
            // portfolioProgramExpanded / portfolioExpandedIds / portfolioCollapsedIds
            // are all kept as-is (they key on stable ids, which survive the rebuild).
            portfolioActiveViewId = _prevActive;
            portfolioFilterTree   = _prevTree;
            _applyPortfolioFilters(_prevFilters);
            renderPortfolioViewTiles();
            renderPortfolioTable();
        } else {
            portfolioExpandedIds = new Set();
            portfolioCollapsedIds = new Set();
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

// Distinct non-empty values for a portfolio field, plus a '(none)' sentinel
// when any row has a blank value — so blank-valued rows can be isolated or
// excluded from every value filter (matches the catalog-year pattern).
function _optsNone(programs, get, cmp) {
    const v = [...new Set(programs.map(get).filter(Boolean))].sort(cmp);
    if (programs.some(p => !get(p))) v.push('(none)');
    return v;
}
// Match a possibly-blank field value against a filter set; a blank value
// matches only when '(none)' is selected.
function _matchNone(set, val) { const v = val || ''; return v ? set.has(v) : set.has('(none)'); }
// Synthetic campus filter option: selecting it matches every NETWORK campus —
// all except Boston AND Online (Online isn't a physical location).
const _NETWORK_CAMPUS = 'Network (all except Boston/Online)';
function _matchCampus(set, val) {
    const v = val || '';
    if (set.has(_NETWORK_CAMPUS) && v && v !== 'Boston' && v !== 'Online') return true;
    return _matchNone(set, v);
}
// Multi-valued variant for array fields (e.g. dispositions): a program matches
// when it carries ANY selected value (OR-over-array); a program with no values
// matches only when '(none)' is selected. Master "None" ({_FILTER_NONE}) matches
// nothing. Used by the Disposition filter, whose field (p.dispositions) is an array.
function _matchDispositions(set, arr) {
    const vals = arr || [];
    if (!vals.length) return set.has('(none)');
    return vals.some(v => set.has(v));
}

function _getPortfolioFilterValues() {
    const programs = allPortfolioPrograms;
    return {
        'portfolio-filter-college':    _optsNone(programs, p => p.college),
        'portfolio-filter-campus':     [_NETWORK_CAMPUS, ..._optsNone(programs, p => p.campus)],
        // Options are the fixed leadership/college dispositions (+ (none) for
        // programs with none set) — NOT derived from row values, since only a
        // couple of the six are in use at any time.
        'portfolio-filter-disposition':        [...portfolioDispositionValues, '(none)'],
        'portfolio-filter-ipd':        _optsNone(programs, p => p.ipd_status),
        'portfolio-filter-roster':     _optsNone(programs, p => p.svt_status),
        'portfolio-filter-substatus':  _optsNone(programs, p => p.roster_sub_status),
        'portfolio-filter-speed':      ['True', 'False'],
        'portfolio-filter-gls':        _optsNone(programs, p => p.gls_status),
        'portfolio-filter-cim':        _optsNone(programs, p => p.cim_step),
        'portfolio-filter-cimchange':  _optsNone(programs, p => p.cim_change_type),
        'portfolio-filter-inworkflow': ['Yes', 'No'],
        'portfolio-filter-inactadmit': _optsNone(programs, p => p.inactivation_admission,
            (a, b) => (_semesterToDate(a)||0) - (_semesterToDate(b)||0)),
        'portfolio-filter-catalogyear': (() => {
            const ys = new Set();
            let anyBlank = false;
            programs.forEach(p => {
                const v = (p.catalog_years || '').split(/,\s*/).filter(Boolean);
                if (v.length) v.forEach(y => ys.add(y));
                else anyBlank = true;
            });
            const out = [...ys].sort();
            if (anyBlank) out.push('(none)');   // isolate blank (inactivated / out-of-window)
            return out;
        })(),
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
        'portfolio-filter-disposition':        'All Dispositions',
        'portfolio-filter-ipd':        'All IPD',
        'portfolio-filter-roster':     'All Statuses',
        'portfolio-filter-substatus':  'All Sub-statuses',
        'portfolio-filter-speed':      'All',
        'portfolio-filter-gls':        'All GLS',
        'portfolio-filter-cim':        'All Steps',
        'portfolio-filter-cimchange':  'All Changes',
        'portfolio-filter-inworkflow': 'All',
        'portfolio-filter-inactadmit': 'All Semesters',
        'portfolio-filter-catalogyear': 'All Catalog Years',
    };
    if (filterSet.size === 0) {
        btn.textContent = (ALL_LABEL[id] || 'All') + ' ▾';
        if (wrap) wrap.classList.remove('has-value');
    } else if (filterSet.has(_FILTER_NONE)) {
        btn.textContent = 'None ▾';
        if (wrap) wrap.classList.add('has-value');
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
        'portfolio-filter-disposition', 'portfolio-filter-ipd', 'portfolio-filter-roster',
        'portfolio-filter-substatus', 'portfolio-filter-speed',
        'portfolio-filter-gls',
        'portfolio-filter-cim', 'portfolio-filter-cimchange',
        'portfolio-filter-inworkflow', 'portfolio-filter-inactadmit',
        'portfolio-filter-catalogyear',
    ];
    const filterSetMap = {
        'portfolio-filter-college':    portfolioCollegeFilter,
        'portfolio-filter-campus':     portfolioCampusFilter,
        'portfolio-filter-disposition':        portfolioDispositionFilter,
        'portfolio-filter-ipd':        portfolioIpdFilter,
        'portfolio-filter-roster':     portfolioRosterFilter,
        'portfolio-filter-substatus':  portfolioSubStatusFilter,
        'portfolio-filter-speed':      portfolioSpeedFilter,
        'portfolio-filter-gls':        portfolioGlsFilter,
        'portfolio-filter-cim':        portfolioCimFilter,
        'portfolio-filter-cimchange':  portfolioCimChangeFilter,
        'portfolio-filter-inworkflow': portfolioInWorkflowFilter,
        'portfolio-filter-inactadmit': portfolioInactAdmitFilter,
        'portfolio-filter-catalogyear': portfolioCatalogYearFilter,
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
    'portfolio-filter-disposition':        () => { portfolioDispositionFilter.clear();        _updateMultiFilterBtn('portfolio-filter-disposition',        portfolioDispositionFilter); },
    'portfolio-filter-ipd':        () => { portfolioIpdFilter.clear();        _updateMultiFilterBtn('portfolio-filter-ipd',        portfolioIpdFilter); },
    'portfolio-filter-roster':     () => { portfolioRosterFilter.clear();     _updateMultiFilterBtn('portfolio-filter-roster',     portfolioRosterFilter); },
    'portfolio-filter-substatus':  () => { portfolioSubStatusFilter.clear();  _updateMultiFilterBtn('portfolio-filter-substatus',  portfolioSubStatusFilter); },
    'portfolio-filter-speed':      () => { portfolioSpeedFilter.clear();      _updateMultiFilterBtn('portfolio-filter-speed',      portfolioSpeedFilter); },
    'portfolio-filter-gls':        () => { portfolioGlsFilter.clear();        _updateMultiFilterBtn('portfolio-filter-gls',        portfolioGlsFilter); },
    'portfolio-filter-cim':        () => { portfolioCimFilter.clear();        _updateMultiFilterBtn('portfolio-filter-cim',        portfolioCimFilter); },
    'portfolio-filter-cimchange':  () => { portfolioCimChangeFilter.clear();  _updateMultiFilterBtn('portfolio-filter-cimchange',  portfolioCimChangeFilter); },
    'portfolio-filter-inworkflow': () => { portfolioInWorkflowFilter.clear(); _updateMultiFilterBtn('portfolio-filter-inworkflow', portfolioInWorkflowFilter); },
    'portfolio-filter-inactadmit': () => { portfolioInactAdmitFilter.clear(); _updateMultiFilterBtn('portfolio-filter-inactadmit', portfolioInactAdmitFilter); },
    'portfolio-filter-catalogyear': () => { portfolioCatalogYearFilter.clear(); _updateMultiFilterBtn('portfolio-filter-catalogyear', portfolioCatalogYearFilter); },
    'portfolio-filter-inacttoday': () => { portfolioInactTodayFilter = ''; },
    'portfolio-filter-inactprogress': () => { portfolioInactProgressFilter = ''; },
    'portfolio-filter-exitmasters': () => { portfolioExitMastersFilter = ''; },
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
    if (dd.classList.contains('open')) { _closeMultiDropdown(dd); return; }  // close + commit
    // Close (and commit) other open dropdowns
    _closeAllMultiDropdowns();
    const filterSetMap = {
        'portfolio-filter-college':    portfolioCollegeFilter,
        'portfolio-filter-campus':     portfolioCampusFilter,
        'portfolio-filter-disposition':        portfolioDispositionFilter,
        'portfolio-filter-ipd':        portfolioIpdFilter,
        'portfolio-filter-roster':     portfolioRosterFilter,
        'portfolio-filter-substatus':  portfolioSubStatusFilter,
        'portfolio-filter-speed':      portfolioSpeedFilter,
        'portfolio-filter-gls':        portfolioGlsFilter,
        'portfolio-filter-cim':        portfolioCimFilter,
        'portfolio-filter-cimchange':  portfolioCimChangeFilter,
        'portfolio-filter-inworkflow': portfolioInWorkflowFilter,
        'portfolio-filter-inactadmit': portfolioInactAdmitFilter,
        'portfolio-filter-catalogyear': portfolioCatalogYearFilter,
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
    const _attr = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    // "All" is a master checkbox: checked when every entry is selected (stored as
    // the empty set = "no restriction"). In that state the value boxes render
    // checked too; the "None" state ({sentinel}) renders them clear.
    const allState = !filterSet || filterSet.size === 0;
    const allRow = `
        <label class="portfolio-col-check filter-all-row">
            <input type="checkbox" ${allState ? 'checked' : ''}
                   onchange="togglePortfolioMultiAll(${_attr(JSON.stringify(id))})">
            All
        </label>`;
    dd.innerHTML = allRow + display.map(v => `
        <label class="portfolio-col-check">
            <input type="checkbox" class="filter-val-box" data-fval="${_attr(String(v))}"
                   ${allState || (filterSet && filterSet.has(v)) ? 'checked' : ''}
                   onchange="togglePortfolioMultiValue(${_attr(JSON.stringify(id))})">
            ${escapeHtml(labelFor(v))}
        </label>`).join('');
    dd.classList.add('open');
}

function _portfolioFilterSetMap() {
    return {
        'portfolio-filter-college':     portfolioCollegeFilter,
        'portfolio-filter-campus':      portfolioCampusFilter,
        'portfolio-filter-disposition':         portfolioDispositionFilter,
        'portfolio-filter-ipd':         portfolioIpdFilter,
        'portfolio-filter-roster':      portfolioRosterFilter,
        'portfolio-filter-substatus':   portfolioSubStatusFilter,
        'portfolio-filter-speed':       portfolioSpeedFilter,
        'portfolio-filter-gls':         portfolioGlsFilter,
        'portfolio-filter-cim':         portfolioCimFilter,
        'portfolio-filter-cimchange':   portfolioCimChangeFilter,
        'portfolio-filter-inworkflow':  portfolioInWorkflowFilter,
        'portfolio-filter-inactadmit':  portfolioInactAdmitFilter,
        'portfolio-filter-catalogyear': portfolioCatalogYearFilter,
    };
}
function togglePortfolioMultiAll(id) {
    const filterSetMap = _portfolioFilterSetMap();
    const set = filterSetMap[id];
    if (!set) return;
    // Master toggle: check every entry (All → everything) ⇄ clear every entry
    // (None → nothing). "All" is the empty set; "None" the no-match sentinel.
    const wasAll = set.size === 0;
    if (wasAll) { set.add(_FILTER_NONE); } else { set.clear(); }
    const nowAll = set.size === 0;
    const dd = document.getElementById('fmd-' + id);
    if (dd) dd.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = nowAll; });
    _updateMultiFilterBtn(id, set);
    if (typeof _syncPortfolioButtonRows === 'function') _syncPortfolioButtonRows();
    _multiFilterDirty.add(id);   // defer the table apply until the dropdown closes
}

// Rebuild the selection from the entry checkboxes. All checked → empty set
// (All); none checked → {sentinel} (None); otherwise the explicit set.
function togglePortfolioMultiValue(id) {
    const filterSet = _portfolioFilterSetMap()[id];
    if (!filterSet) return;
    const dd = document.getElementById('fmd-' + id);
    if (!dd) return;
    const boxes = [...dd.querySelectorAll('.filter-val-box')];
    const selected = boxes.filter(cb => cb.checked).map(cb => cb.dataset.fval);
    filterSet.clear();
    if (selected.length === 0)                 filterSet.add(_FILTER_NONE);   // none → None
    else if (selected.length < boxes.length)   selected.forEach(v => filterSet.add(v));
    // (all checked → leave empty = All)
    const allBox = dd.querySelector('.filter-all-row input');
    if (allBox) allBox.checked = filterSet.size === 0;
    _updateMultiFilterBtn(id, filterSet);
    if (typeof _syncPortfolioButtonRows === 'function') _syncPortfolioButtonRows();
    _multiFilterDirty.add(id);   // defer the table apply until the dropdown closes
}

// Generic rail quick-filters — one Set per PORTFOLIO_FILTER_FIELDS key that isn't
// already a curated rail filter (so EVERY select/boolean field/column is
// filterable from the rail's ＋ Add filter). Applied below via evalPortfolioRule's
// 'in' operator, so each uses the same accessor/semantics as the Views builder.
let portfolioGenFilters = {};

// Row-colour filter — set by clicking a legend entry. The key matches
// _pfRowColorKey below (same logic as the row tint), so clicking "New (in
// workflow)" keeps only green rows, etc.
let portfolioColorFilter = '';
// True when a row hosts a concentration still classified 'new' (launching).
function _hasNewConc(p) {
    try { return (JSON.parse(p.concentrations_json || '[]') || []).some(x => x && x.status === 'new'); }
    catch (e) { return false; }
}
// Brand-new WHOLE program (dark green): a new degree / New proposal in workflow,
// AND the program is NOT already established elsewhere — a new deployment of an
// existing program (a new-location launch) isn't a new program (Waleed 2026-08-31).
function _depProgramNew(d) {
    return !!d.cim_step && d.program_established !== 'Y'
        && (d.cim_change_type === 'New' || d.new_offering === 'new_degree');
}
// Program that CONTAINS something launching (light green): a new concentration
// in workflow, or any concentration still classified 'new'. Deliberately NOT a
// completed program whose new_offering flag lingers (e.g. Applied Sustainability,
// out of workflow with all-'existing' concentrations) — that stays white.
function _depContainsNew(d) {
    return (!!d.cim_step && d.new_offering === 'new_concentration') || _hasNewConc(d);
}
function _pfRowColorKey(p) {
    if (!p.cim_program_id) return 'notincim';
    if (_depProgramNew(p)) return 'new';
    if (_depContainsNew(p)) return 'new_partial';
    if (p.launching === 'Y') return 'launching';
    if (!p.cim_step) return 'completed';
    if (p.cim_change_type === 'Inactivation') return 'inact';
    if (p.cim_change_type === 'Change') return 'change';
    return 'neutral';
}
function togglePortfolioColorFilter(key) {
    portfolioColorFilter = (portfolioColorFilter === key) ? '' : key;
    renderPortfolioTable();
}

function getPortfolioFiltered() {
    let rows = allPortfolioPrograms.slice();
    if (portfolioLevelFilter.size)
        rows = rows.filter(p => portfolioLevelFilter.has(p.level));
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
    if (portfolioCollegeFilter.size)    rows = rows.filter(p =>
        _matchNone(portfolioCollegeFilter, p.college)
        // Also keep a program whose OWN college doesn't match but which has an
        // interdisciplinary concentration managed by the selected college
        // (e.g. Khoury-managed Robotics/Machine Learning concentrations under a
        // Provost-owned AI/Data Science MS). The matching concentrations are
        // surfaced (and the parent auto-expanded) at render time.
        || (p.concentrations || []).some(c => c && typeof c === 'object'
                && c.college && portfolioCollegeFilter.has(c.college)));
    if (portfolioCampusFilter.size)     rows = rows.filter(p => _matchCampus(portfolioCampusFilter, p.campus));
    if (portfolioDispositionFilter.size)        rows = rows.filter(p => _matchDispositions(portfolioDispositionFilter, p.dispositions));
    if (portfolioIpdFilter.size)        rows = rows.filter(p => _matchNone(portfolioIpdFilter, p.ipd_status));
    if (portfolioRosterFilter.size)     rows = rows.filter(p => _matchNone(portfolioRosterFilter, p.svt_status));
    if (portfolioSubStatusFilter.size)  rows = rows.filter(p => _matchNone(portfolioSubStatusFilter, p.roster_sub_status));
    if (portfolioSpeedFilter.size)      rows = rows.filter(p => portfolioSpeedFilter.has(p.speed_to_market || ''));
    if (portfolioGlsFilter.size)        rows = rows.filter(p => _matchNone(portfolioGlsFilter, p.gls_status));
    if (portfolioCimFilter.size)        rows = rows.filter(p => _matchNone(portfolioCimFilter, p.cim_step));
    if (portfolioCimChangeFilter.size)  rows = rows.filter(p => _matchNone(portfolioCimChangeFilter, p.cim_change_type));
    if (portfolioInWorkflowFilter.size) rows = rows.filter(p => portfolioInWorkflowFilter.has(p.cim_program_id ? 'Yes' : 'No'));
    if (portfolioInactAdmitFilter.size) rows = rows.filter(p => _matchNone(portfolioInactAdmitFilter, p.inactivation_admission));
    if (portfolioCatalogYearFilter.size) rows = rows.filter(p => {
        const ys = (p.catalog_years || '').split(/,\s*/).filter(Boolean);
        return [...portfolioCatalogYearFilter].some(
            y => y === '(none)' ? ys.length === 0 : ys.includes(y));
    });
    if (portfolioInactTodayFilter)      rows = rows.filter(p => _inactAdmittingToday(p) === portfolioInactTodayFilter);
    if (portfolioInactProgressFilter)   rows = rows.filter(p => (_cimInactivating(p) ? 'Yes' : 'No') === portfolioInactProgressFilter);
    if (portfolioExitMastersFilter)     rows = rows.filter(p => (p.exit_masters === 'Yes' ? 'Yes' : 'No') === portfolioExitMastersFilter);
    // Row-colour legend filter (click a legend entry).
    if (portfolioColorFilter) rows = rows.filter(p => _pfRowColorKey(p) === portfolioColorFilter);
    // Generic rail quick-filters (any select/boolean field) — ANDed; each behaves
    // like a Views-builder "field is one of […]" rule.
    Object.keys(portfolioGenFilters).forEach(key => {
        const set = portfolioGenFilters[key];
        if (set && set.size) rows = rows.filter(p => evalPortfolioRule(p, { field: key, op: 'in', value: [...set] }));
    });
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
            match(p.banner_code || '') ||
            match(p.degree_code || '') ||
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

// Ordinal rank of a CIM workflow step (College first → Trustees/Setup/Teach-Out
// last), so the Program-view row can show a span (earliest → latest) when a
// program's campuses sit at different stages. Blank step → null (not in workflow).
const _CIM_STAGE_RANK_ORDER = [
    "Program PR Graduate Dean's Office", 'Provost Initial Review', 'Program Review 2',
    'Program Graduate Provost Review', 'Program GRA Regulatory',
    'Program Graduate Curriculum Committee',
    'Program Undergraduate Curriculum Committee - Tabled Proposals',
    'Program Provost Administrative and Budgetary Review', 'Program Provost Approval',
    'Program Faculty Senate', 'Program University Board of Trustees',
    'Program Setup', 'Program Teach-Out',
];
function _cimStageRank(step) {
    if (!step) return null;
    if (typeof isCollegeStep === 'function' && isCollegeStep(step)) return 0;
    const c = (typeof canonicalStep === 'function') ? canonicalStep(step) : step;
    const i = _CIM_STAGE_RANK_ORDER.indexOf(c);
    return (i >= 0) ? i + 1 : _CIM_STAGE_RANK_ORDER.length + 1;   // +1 so College(0) stays first
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
    const badge = '';   // no "In workflow" label — rely on row colors
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

    // Program-group sort control shows only in Program view; keep its widgets in
    // sync with the persisted key/direction.
    // Program groups are now sorted by clicking column headers (like a normal
    // table), so the standalone "Sort programs" control is retired.
    const progSort = document.getElementById('portfolio-progsort');
    if (progSort) progSort.style.display = 'none';

    // In matrix mode, hide the per-deployment status filters — they're
    // redundant with what the cells already show and they fragment the grid
    // (a status that varies by campus blanks out cells rather than pruning
    // rows cleanly). Keep the CIM scope buttons and Admitting Today, which
    // narrow the program set without that problem. Left structural filters
    // (Level / Degree / College / Campus) always stay.
    const matrix = portfolioLayout === 'matrix';
    const hideIds = ['portfolio-filter-inactadmit', 'portfolio-filter-roster',
        'portfolio-filter-substatus', 'portfolio-filter-speed',
        'portfolio-filter-gls', 'portfolio-filter-disposition'];
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
    _ensureEnrollmentColumns();   // register dynamic per-year enrollment columns
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

    // Program (grouped) view: deployments of the same Banner code are collected
    // into a group and rendered under one program-header row. Sort so that a
    // program's deployments are contiguous (by campus-stripped name, then Banner
    // code, then campus); blank-Banner rows (no program grain yet) fall in by name.
    const isProgramView = portfolioLayout === 'program';
    const bannerGroups = {};
    if (isProgramView) {
        topLevel.forEach(p => {
            const k = canonicalBanner(p.banner_code);
            if (k) (bannerGroups[k] = bannerGroups[k] || []).push(p);
        });
        // Group identity: canonical Banner, or a per-row key for blank-Banner singletons.
        const gkey = p => canonicalBanner(p.banner_code) || ('~' + p.id);
        const _enrCache = {};
        const groupMaxEnroll = p => {
            const gk = gkey(p);
            if (gk in _enrCache) return _enrCache[gk];
            const rows = canonicalBanner(p.banner_code) ? (bannerGroups[gk] || [p]) : [p];
            let mx = -1;
            rows.forEach(r => { const v = _rowLatestEnroll(r); if (v > mx) mx = v; });
            return (_enrCache[gk] = mx);
        };
        // Program groups are ordered by clicking a COLUMN HEADER (like a normal
        // table). Map the clicked column to a program-level sort key; columns
        // that are blank on the program header (deployment-only) fall back to
        // name, except enrollment which ranks groups by their max latest-year
        // enrollment.
        const gsk = (() => {
            const k = portfolioSortKey;
            if (!k || k === 'name') return 'name';
            if (k === 'degree')      return 'credential';
            if (k === 'college')     return 'college';
            if (k === 'gls')         return 'gls';
            if (k === 'disposition' || k === 'otp_prog_disp') return 'disposition';
            if (k === 'otp_prog_notes') return 'prognotes';
            if (k.indexOf('enr_') === 0) return 'enrollment';
            return 'name';
        })();
        const gtext = p => {
            switch (gsk) {
                case 'college':     return (p.college || '').toLowerCase();
                case 'credential':  return extractPortfolioDegree(p.program_name || '').toLowerCase();
                case 'gls':         return (p.gls_status || '').toLowerCase();
                case 'disposition': return (p.program_dispositions || []).join('; ').toLowerCase();
                case 'prognotes':   return (p.program_note || '').toLowerCase();
                default:            return stripCampusFromName(p.program_name || '').toLowerCase();
            }
        };
        const dir = portfolioSortDir || 1;
        topLevel.sort((a, b) => {
            let c = (gsk === 'enrollment')
                ? (groupMaxEnroll(a) - groupMaxEnroll(b)) * dir
                : gtext(a).localeCompare(gtext(b)) * dir;
            if (c) return c;
            // Ties: keep a group's deployments contiguous (by Banner), then order
            // deployments within the group by campus (always ascending).
            const ka = gkey(a), kb = gkey(b);
            if (ka !== kb) return ka.localeCompare(kb);
            return (a.campus || '').localeCompare(b.campus || '');
        });
    } else
    topLevel.sort((a, b) => {
        let av = '', bv = '';
        if (!portfolioSortKey) {
            // Default (no column chosen): group by college, then name.
            return ((a.college || '').localeCompare(b.college || '') ||
                    (a.program_name || '').localeCompare(b.program_name || '')) * portfolioSortDir;
        }
        if (portfolioSortKey === 'name') {
            // Explicit Program-name sort: purely alphabetical by program name.
            return (a.program_name || '').localeCompare(b.program_name || '') * portfolioSortDir;
        }
        if (portfolioSortKey.startsWith('enr_')) {
            const na = parseFloat(_enrValue(a, portfolioSortKey));
            const nb = parseFloat(_enrValue(b, portfolioSortKey));
            return ((isNaN(na) ? -Infinity : na) - (isNaN(nb) ? -Infinity : nb)) * portfolioSortDir;
        }
        switch (portfolioSortKey) {
            case 'degree':    av = extractPortfolioDegree(a.program_name); bv = extractPortfolioDegree(b.program_name); break;
            case 'college':   av = a.college || '';  bv = b.college || '';  break;
            case 'campus':    av = a.campus  || '';  bv = b.campus  || '';  break;
            case 'catalogyears': av = a.catalog_years || ''; bv = b.catalog_years || ''; break;
            case 'ipd':       av = a.ipd_status || ''; bv = b.ipd_status || ''; break;
            case 'svt':       av = a.svt_status || ''; bv = b.svt_status || ''; break;
            case 'svttype':   av = a.roster_proposal_type || ''; bv = b.roster_proposal_type || ''; break;
            case 'substatus': av = a.roster_sub_status || ''; bv = b.roster_sub_status || ''; break;
            case 'speed':     av = a.speed_to_market || ''; bv = b.speed_to_market || ''; break;
            case 'gls':       av = a.gls_status || ''; bv = b.gls_status || ''; break;
            case 'launch':    return ((_pfTermRank(a.roster_launch_date) || -1) - (_pfTermRank(b.roster_launch_date) || -1)) * portfolioSortDir;
            case 'cim':       av = a.cim_step || ''; bv = b.cim_step || ''; break;
            case 'cimcatalog': av = a.cim_completion_date || ''; bv = b.cim_completion_date || ''; break;
            case 'cimterm':   return ((_pfTermRank(a.cim_term) || -1) - (_pfTermRank(b.cim_term) || -1)) * portfolioSortDir;
            case 'svtnote':   av = _svtCoordNote(a); bv = _svtCoordNote(b); break;
            case 'cimchange':   av = a.cim_change_type || ''; bv = b.cim_change_type || ''; break;
            case 'ciminact':    av = _cimInactivating(a) ? '1' : '0'; bv = _cimInactivating(b) ? '1' : '0'; break;
            case 'inworkflow':  av = a.cim_program_id ? 'Yes' : 'No'; bv = b.cim_program_id ? 'Yes' : 'No'; break;
            case 'inactadmit':  av = a.inactivation_admission || ''; bv = b.inactivation_admission || ''; break;
            case 'inacttoday':  av = _inactAdmittingToday(a); bv = _inactAdmittingToday(b); break;
            case 'offering':    av = portfolioOfferingLabel(a); bv = portfolioOfferingLabel(b); break;
            case 'gtmentered':  av = a.gtm_entered_date || '';  bv = b.gtm_entered_date || '';  break;
            case 'gtmtype':     av = a.gtm_type || '';        bv = b.gtm_type || '';        break;
            case 'gtmdate':     av = a.gtm_date || '';        bv = b.gtm_date || '';        break;
            case 'gtmfirst':    return ((_pfTermRank(a.gtm_first_term) || -1) - (_pfTermRank(b.gtm_first_term) || -1)) * portfolioSortDir;
            case 'gtmlast':     av = a.gtm_last_term || '';   bv = b.gtm_last_term || '';   break;
            case 'gtmintake':   av = a.gtm_intake_terms || ''; bv = b.gtm_intake_terms || ''; break;
            case 'exitmasters': av = a.exit_masters || '';     bv = b.exit_masters || '';     break;
            case 'disposition': av = (a.dispositions || []).join('; '); bv = (b.dispositions || []).join('; '); break;
            case 'otp_prog_disp':  av = (a.program_dispositions || []).join('; ');    bv = (b.program_dispositions || []).join('; ');    break;
            case 'otp_dep_disp':   av = (a.deployment_dispositions || []).join('; '); bv = (b.deployment_dispositions || []).join('; '); break;
            case 'otp_prog_notes': av = a.program_note || '';    bv = b.program_note || '';    break;
            case 'otp_dep_notes':  av = a.deployment_note || ''; bv = b.deployment_note || ''; break;
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
        portfolioDispositionFilter.size || portfolioIpdFilter.size ||
        portfolioRosterFilter.size || portfolioSubStatusFilter.size || portfolioSpeedFilter.size ||
        portfolioGlsFilter.size || portfolioCimFilter.size ||
        portfolioCimChangeFilter.size || portfolioInWorkflowFilter.size ||
        portfolioInactAdmitFilter.size || portfolioCatalogYearFilter.size ||
        portfolioInactTodayFilter || portfolioInactProgressFilter || portfolioExitMastersFilter || portfolioSearch;

    // Determine which programs should be auto-expanded. Two triggers:
    //  • search — reveal a curriculum/linked concentration that matches the query;
    //  • college filter — surface an interdisciplinary concentration managed by
    //    the selected college on a program whose OWN college doesn't match.
    const searchAutoExpand = new Set();
    if (portfolioSearch && portfolioSearch.trim()) {
        const match = buildSearchMatcher(portfolioSearch);
        allPortfolioPrograms.forEach(p => {
            if (p.concentrations && p.concentrations.some(c => {
                const n = (typeof c === 'string') ? c : (c && c.name) || '';
                return match(n);
            })) {
                searchAutoExpand.add(p.id);
            }
            if (p.concentration_of && match(p.program_name)) {
                searchAutoExpand.add(p.concentration_of);
            }
        });
    }
    const collegeAutoExpand = new Set();
    if (portfolioCollegeFilter.size) {
        allPortfolioPrograms.forEach(p => {
            if (portfolioCollegeFilter.has(p.college || '')) return;
            if ((p.concentrations || []).some(c => c && typeof c === 'object'
                    && c.college && portfolioCollegeFilter.has(c.college))) {
                collegeAutoExpand.add(p.id);
            }
        });
    }
    // In the Program (grouped) view, keep concentrations HIDDEN by default when a
    // program is opened to list its campuses — only a search reveals a match. The
    // flat Deployments view still auto-expands the college-surfaced concentration.
    const autoExpand = (portfolioLayout === 'program')
        ? searchAutoExpand
        : new Set([...searchAutoExpand, ...collegeAutoExpand]);
    // Mirror to module scope so togglePortfolioConcentrations() can read it.
    _portfolioAutoExpand = autoExpand;

    const countEl = document.getElementById('portfolio-result-count');
    if (countEl) countEl.textContent = `${topLevel.length} programs`;

    if (topLevel.length === 0 && Object.keys(matchingConcsByParent).length === 0) {
        container.innerHTML = '<p class="empty-state">No programs match your filters.</p>';
        return;
    }

    const rowHtml = [];

    // Emit one deployment row + its concentration children (the flat-view unit;
    // in Program view this runs for each campus under an expanded program).
    // A curriculum concentration is visible under the active College focus if its
    // own college matches (or, when it declares none, the parent program's college
    // matches). No College filter → everything passes.
    const _concPassesCollege = (p, college) =>
        !portfolioCollegeFilter.size || portfolioCollegeFilter.has(college || (p.college || ''));

    const emitDeploymentRows = (p, extra) => {
        const portfolioConcs = anyFilterActive
            ? (matchingConcsByParent[p.id] || [])
            : (allConcsByParent[p.id] || []);
        const curriculumConcs = p.concentrations || [];
        const isExpanded = !portfolioCollapsedIds.has(p.id)
            && (portfolioExpandedIds.has(p.id) || autoExpand.has(p.id));
        // Show the arrow only if expanding would actually reveal something UNDER
        // THE ACTIVE FILTERS — curriculum concentrations that pass the College
        // focus, OR linked sub-rows. Counting the *unfiltered* concentrations here
        // gave a chevron that the College filter then hid every child of, so the
        // row expanded to nothing (e.g. a Provost-owned program shown under a
        // college focus whose concentrations all belong to other colleges).
        const visibleCurricConcCount = curriculumConcs.reduce((n, c) => {
            const college = (typeof c === 'string') ? '' : (c && c.college) || '';
            return n + (_concPassesCollege(p, college) ? 1 : 0);
        }, 0);
        const hasAnyChildren = visibleCurricConcCount > 0 || portfolioConcs.length > 0;

        rowHtml.push(renderPortfolioRow(p, Object.assign(
            {hasConcentrations: hasAnyChildren, isExpanded}, extra || {})));

        if (isExpanded) {
            // Curriculum concentrations (entries may be strings (legacy) or
            // {name, college} objects). Inherit the parent's college (unless the
            // concentration declares its own) and the parent's campus.
            const curriculumConcKeys = new Set();
            curriculumConcs.forEach(c => {
                const name    = (typeof c === 'string') ? c : (c && c.name)    || '';
                const college = (typeof c === 'string') ? ''  : (c && c.college) || '';
                const status  = (typeof c === 'string') ? ''  : (c && c.status) || '';
                const svtStatus = (typeof c === 'string') ? '' : (c && c.svt_status) || '';
                curriculumConcKeys.add(_concNorm(name));
                if (!_concPassesCollege(p, college)) return;
                rowHtml.push(renderPortfolioConcRow(
                    name, portfolioSearch, college,
                    p.college || '', p.campus || '', status, svtStatus));
            });
            portfolioConcs
                .filter(c => !curriculumConcKeys.has(_concNorm(_shortConcName(c.program_name || ''))))
                .forEach(c => rowHtml.push(renderPortfolioRow(
                    c, {isPortfolioConc: true, parent: p})));
        }
    };

    if (isProgramView) {
        // Group deployments into abstract programs (Banner code; blank-Banner
        // rows are their own program). topLevel is already group-sorted, so
        // first-appearance order is the desired program order; deployments are
        // ordered by campus within each program. Each program is one collapsible
        // row — open it to reveal its campuses (and their concentrations).
        // Canonical banner so online variants (-O/-PO, aliased) fold into the base.
        // Blank-Banner deployments (in-workflow campus rollouts with no Banner code
        // yet) would each split into a singleton program; instead fold them into
        // the program whose CODED deployments share their base name. Dash-normalized
        // so "MS—Align"/"MS-Align" match; "—Align" (MS-ARIN-AL) stays separate from
        // the base (MS-ARIN) because its base name still contains "-align".
        const _baseKey = p => (normalizePortfolioName(stripCampusFromName(p.program_name || ''))
            .replace(/[—–]/g, '-').toLowerCase().trim());
        const _nameToBanner = {};
        topLevel.forEach(p => {
            const cb = canonicalBanner(p.banner_code);
            if (cb) { const bn = _baseKey(p); if (bn && !_nameToBanner[bn]) _nameToBanner[bn] = cb; }
        });
        const gkeyOf = p => {
            const cb = canonicalBanner(p.banner_code);
            if (cb) return cb;
            const bn = _baseKey(p);
            return (bn && _nameToBanner[bn]) || (bn ? ('~name:' + bn) : ('~' + p.id));
        };
        const order = [];
        const byG = {};
        topLevel.forEach(p => {
            const gk = gkeyOf(p);
            if (!byG[gk]) { byG[gk] = []; order.push(gk); }
            byG[gk].push(p);
        });
        if (countEl) countEl.textContent = `${order.length} programs`;
        order.forEach(gk => {
            const deployments = byG[gk].slice()
                .sort((a, b) => (a.campus || '').localeCompare(b.campus || ''));
            const expanded = portfolioProgramExpanded.has(gk);
            rowHtml.push(renderPortfolioProgramRow(gk, deployments, expanded));
            if (expanded) deployments.forEach(dep => emitDeploymentRows(dep, {groupedDeployment: true}));
        });
    } else {
        topLevel.forEach(p => emitDeploymentRows(p, {}));
    }

    // Use the page's existing info-tip overlay system (JS-driven, no native
    // title= delay). The IIFE near the top of the file watches for mouseover
    // on .tip-icon elements and renders the .tip-bubble text in #tip-overlay.
    const _help = (text) => text
        ? `<span class="info-tip" onclick="event.stopPropagation()"><i class="tip-icon">i</i><span class="tip-bubble">${escapeHtml(text)}</span></span>`
        : '';
    const _savedWidth = (key) => ` style="width:${_pfColW(key)}px"`;
    const _resizeHandle = '<span class="col-resize" onmousedown="startPortfolioColResize(event)" onclick="event.stopPropagation()"></span>';
    const visibleHeaders = orderedPortfolioCols()
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
    // Clickable legend = quick colour filter (concentration is a row type, not a
    // per-row colour key, so it stays a plain label).
    const _legItems = [
        { key: 'new',         cls: 'new',          label: 'New program' },
        { key: 'new_partial', cls: 'new-partial',  label: 'Contains new' },
        { key: 'launching',   cls: 'launching',    label: 'Launching' },
        { key: 'change',      cls: 'change',        label: 'Change' },
        { key: 'inact',     cls: 'inactivation',  label: 'Inactivation' },
        { key: 'notincim',  cls: 'not-in-cim',    label: 'Not in CIM' },
        { key: 'completed', cls: 'completed',     label: 'Completed / not in workflow' },
        { key: null,        cls: 'concentration', label: 'Concentration' },
    ];
    const portfolioLegend = `<div class="table-legend">` + _legItems.map(it => {
        const active = it.key && portfolioColorFilter === it.key;
        const attrs = it.key
            ? ` legend-clickable${active ? ' legend-active' : ''}" role="button" tabindex="0" title="Filter to ${escapeHtml(it.label)} rows${active ? ' (click to clear)' : ''}" onclick="togglePortfolioColorFilter('${it.key}')"`
            : '"';
        return `<span class="legend-item${attrs}><span class="legend-swatch ${it.cls}"></span> ${escapeHtml(it.label)}</span>`;
    }).join('') + `</div>`;
    // Fixed layout so per-column widths are authoritative (drag-to-resize sticks).
    // Table width = sum of the visible columns' effective widths.
    const _totalW = _pfColW('name') + orderedPortfolioCols()
        .filter(c => portfolioVisibleCols.has(c.key))
        .reduce((s, c) => s + _pfColW(c.key), 0);
    container.innerHTML = portfolioLegend + `
        <table class="program-table pf-fixed${portfolioLayout === 'program' ? ' pf-grouped' : ''}" style="width:${_totalW}px">
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

// Extract the concentration topic from a linked sub-row's full program name
// ("Robotics with Concentration in Computer Science, MS" → "Computer Science").
// Module-level so both the row display and the curriculum-vs-linked de-dup use
// the same extraction. Falls back to the full name when no pattern matches.
function _shortConcName(full) {
    const n = (full || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
    let m;
    // ORDER MATTERS — specific patterns before the generic one.
    m = n.match(/^.+?,\s*concentration\s+in\s+(.+?),\s*[A-Z]{1,7}\s*$/i);
    if (m) return m[1].trim();
    m = n.match(/^.+?\s+with\s+Concentration\s+in\s+(.+?),\s*[A-Z]{1,7}\s*$/i);
    if (m) return m[1].trim();
    m = n.match(/^.+?\s*[-—]\s*(.+?)\s+Concentration,?\s+[A-Z]{1,7}\s*$/i);
    if (m) return m[1].trim();
    m = n.match(/^\S+\s+(.+?)\s+Concentration\b.*?,\s*[A-Z]{1,7}\s*$/i);
    if (m) return m[1].trim();
    return n;
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
    const cellHtml = orderedPortfolioCols()
        .filter(c => portfolioVisibleCols.has(c.key))
        .map(c => {
            if (c.key === 'college') return `<td${collegeTitle}>${collegeAbbrev}</td>`;
            if (c.key === 'campus')  return `<td${campusTitle}>${campusAbbrev}</td>`;
            // Credential cell is fixed to "Concentration" for concentration sub-rows.
            if (c.key === 'degree')  return '<td>Concentration</td>';
            return '<td>—</td>';
        })
        .join('');
    // No "In workflow" status badge — the row colors convey proposal status.
    // Keep only the SVT development status when we have one for this concentration.
    let badge = svtStatus
        ? ` <span class="conc-status conc-workflow">SVT: ${escapeHtml(svtStatus)}</span>`
        : '';
    return `<tr class="portfolio-row portfolio-curriculum-conc-row">
        <td class="program-name-cell"><span class="pf-caret-spacer"></span>${hl}${badge}</td>
        ${cellHtml}
    </tr>`;
}

// Grouped Program view row interaction (2026-08-27): a LEADING caret column
// (its own generous click target) toggles the row's children; the NAME opens the
// record drawer with an on-hover cue (underline + a small panel icon). No trailing
// "Open" button. Concentrations stay leaves. This applies to the grouped Program
// view only (program rows here + grouped campus rows via renderPortfolioRow's
// groupedDeployment branch); the flat Deployments view keeps its trailing chevron.
// Stroked chevron caret (points right; the .pf-caret container rotates it 90° to
// point down when expanded) — a proper disclosure caret, not a solid triangle.
const PF_CARET_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"></polyline></svg>';

// Program (grouped) view: one collapsible row per abstract program. Uses the
// normal table columns — NOT a full-width band — so every program (1 campus or
// many) looks identical. The program is abstract: campus + deployment-only
// columns (CIM step, catalog, SVT, enrollment, launch…) are blank; only
// program-level fields (credential, college, level, GLS) and the PROGRAM-grain
// OTP disposition/note are filled. A leading caret toggles the campus rows open;
// the name opens the program record (program-grain OTP); the disposition/note
// cells open the drawer's OTP tab (program section edits all campuses). Blank-Banner
// programs (no program grain yet) fall back to their single deployment's own
// effective disposition/note.
function renderPortfolioProgramRow(gkey, deployments, expanded) {
    const r0 = deployments[0] || {};
    // gkey is the canonical banner (or '~id' for blank-Banner singletons).
    const banner = (gkey.indexOf('~') === 0) ? '' : gkey;
    const name = normalizePortfolioName(stripCampusFromName(r0.program_name || ''));
    const count = deployments.length;
    const isStatic = typeof window._staticMode !== 'undefined';

    // Leading caret (expand) + name-opens-drawer (underline on hover).
    const caret = `<span class="pf-caret${expanded ? ' expanded' : ''}" role="button" tabindex="0" title="Show/hide campuses" aria-label="Show or hide campuses" onclick="event.stopPropagation(); togglePortfolioProgram('${escapeHtml(gkey)}')">${PF_CARET_SVG}</span>`;
    const nameInner = banner
        ? `<span class="portfolio-record-open pf-open" title="Open program record" onclick="event.stopPropagation(); openProgramRecord('${escapeHtml(banner)}')">${escapeHtml(name)}</span>`
        : escapeHtml(name);
    const nameCell = `<td class="program-name-cell portfolio-parent-name" title="${escapeHtml(banner || 'no Banner code')}">`
        + `${caret}${nameInner}</td>`;

    // Program-grain OTP if set; otherwise roll up the distinct dispositions
    // across the program's campuses (so a Boston-only program's disposition,
    // or a set of differing campus dispositions, still shows on the row).
    let dispVals;
    if (banner && (r0.program_dispositions || []).length) {
        dispVals = r0.program_dispositions;
    } else {
        const _ds = new Set();
        deployments.forEach(d => (d.dispositions || []).forEach(v => _ds.add(v)));
        dispVals = [..._ds];
    }
    const dispChips = dispVals.length
        ? dispVals.map(v => `<span class="portfolio-badge disp-badge" title="${escapeHtml(v)}">${escapeHtml(_dispShort(v))}</span>`).join(' ')
        : '';
    // Program row cells open the PROGRAM record (by banner) to the matching tab;
    // blank-Banner programs fall back to their lone deployment record.
    const _pOpen = tab => banner
        ? `event.stopPropagation(); openProgramRecord('${escapeHtml(banner)}','${tab}')`
        : `event.stopPropagation(); openPortfolioRecord('${escapeHtml(r0.id)}','${escapeHtml(String(r0.cim_program_id))}',${r0.has_regulatory === true},'${tab}')`;
    const otpOpenDisp = _pOpen('otp_disp'), otpOpenNote = _pOpen('otp_notes'), otpOpenReview = _pOpen('review');
    const dispCell = isStatic
        ? (dispChips || '<span class="muted">—</span>')
        : `<span class="portfolio-disp-text" onclick="${otpOpenDisp}">${dispChips || '<span class="muted add-note">+ set</span>'}</span>`;
    const pnote = banner ? (r0.program_note || '').trim() : (r0.note || '').trim();
    const noteCell = isStatic
        ? (pnote ? `<span class="portfolio-note-marker" title="${escapeHtml(pnote)}">✎ note</span>` : '<span class="muted">—</span>')
        : (pnote
            ? `<span class="portfolio-note-text" onclick="${otpOpenNote}"><span class="portfolio-note-marker" title="${escapeHtml(pnote)}">✎ note</span></span>`
            : `<span class="portfolio-note-text" onclick="${otpOpenNote}"><span class="muted add-note">+ note</span></span>`);

    // Only program-level columns carry a value on the abstract program row.
    // Enrollment (enr_new_YYYY / enr_total_YYYY) is inherited as the SUM across
    // all the program's campuses (deployments) and any linked concentration rows.
    const _depIds = new Set(deployments.map(d => d.id));
    const _enrRows = deployments.concat(
        (allPortfolioPrograms || []).filter(c => c.concentration_of && _depIds.has(c.concentration_of)));
    const _sumEnr = key => {
        let any = false, sum = 0;
        _enrRows.forEach(r => { const v = _enrValue(r, key); if (typeof v === 'number') { sum += v; any = true; } });
        return any ? sum : '';
    };
    // Other deployment-level columns are inherited up with the rule: show the
    // value when all campuses AGREE; when they DIFFER show a range (ordered
    // fields: CIM step, launch term) or a distinct-value list (unordered).
    const _distinctVals = get => {
        const s = new Set();
        deployments.forEach(d => { const v = get(d); if (v != null && String(v).trim() !== '') s.add(String(v)); });
        return [...s];
    };
    const _rollup = (get, opts = {}) => {
        const distinct = _distinctVals(get);
        if (!distinct.length) return '';
        const disp = v => escapeHtml(opts.displayFn ? opts.displayFn(v) : v);
        if (distinct.length === 1) return disp(distinct[0]);
        if (opts.rankFn) {
            const ranked = distinct.map(v => ({ v, r: opts.rankFn(v) }))
                .filter(x => x.r != null).sort((a, b) => a.r - b.r);
            if (ranked.length) {
                const lo = ranked[0].v, hi = ranked[ranked.length - 1].v;
                return lo === hi ? disp(lo) : disp(lo) + ' → ' + disp(hi);
            }
        }
        return distinct.map(disp).join(' · ');
    };
    const _glsRoll = _rollup(d => d.gls_status);
    const _cimInact = deployments.some(d => _cimInactivating(d));
    const _cimSteps = _rollup(d => d.cim_step, { rankFn: _cimStageRank, displayFn: _matrixStageLabel });
    const _cimCell = _cimInact
        ? ('<span style="color:#a3312f">Inactivating</span>' + (_cimSteps ? ' · ' + _cimSteps : ''))
        : _cimSteps;
    const _TERM_FIELD = {
        proposedterm: d => d.roster_proposed_launch_term,
        expectedterm: d => d.roster_expected_launch_term,
        cimterm:      d => d.cim_term,
        gtmfirst:     d => d.gtm_first_term,
    };
    const vals = {
        degree:      escapeHtml(extractPortfolioDegree(r0.program_name || '')),
        college:     `<span title="${escapeHtml(r0.college || '')}">${escapeHtml(abbreviateCollege(r0.college || ''))}</span>`,
        campus:      _rollup(d => d.campus),
        level:       escapeHtml(r0.level || ''),
        gls:         _glsRoll ? `<span class="portfolio-badge gls-badge">${_glsRoll}</span>` : '',
        cim:         _cimCell,
        // Program row carries the PROGRAM grain; deployment columns are blank
        // (the campuses below carry those).
        otp_prog_disp:  dispCell,
        otp_prog_notes: noteCell,
        otp_dep_disp:   '',
        otp_dep_notes:  '',
    };
    const cells = orderedPortfolioCols()
        .filter(c => portfolioVisibleCols.has(c.key))
        .map(c => {
            let v = vals[c.key];
            let cls = '';
            if (v == null && c.key.indexOf('enr_') === 0) {
                const s = _sumEnr(c.key);
                v = (s === '') ? '' : Number(s).toLocaleString();
                cls = ' class="enr-cell"';   // right-align + tabular nums, same as the deployment rows
            } else if (v == null && _TERM_FIELD[c.key]) {
                v = _rollup(_TERM_FIELD[c.key], { rankFn: _pfTermRank, displayFn: _pfTermDisplay });
            }
            return `<td${cls}>${v != null ? v : ''}</td>`;
        })
        .join('');
    // Colour the program header to MATCH its campus rows: give each campus the
    // same colour key a deployment row would use, and tint the program only when
    // every campus agrees (a mixed group stays neutral rather than picking one
    // campus's colour and looking like a status the whole program doesn't have).
    // Green is filter-independent + two-tiered: DARK (row-added) when the whole
    // program is brand-new (every campus a new offering), LIGHT (row-added-partial)
    // when it merely CONTAINS something launching (a new concentration, or a new
    // campus on an otherwise-existing program). Green wins over a mixed rollup so a
    // program hosting a launching concentration shows up; non-green falls back to
    // the uniform-else-neutral rollup (all-inact→red, all-change→blue, etc.).
    const _depColor = d => !d.cim_program_id ? 'notincim'
        : d.cim_step ? (d.cim_change_type === 'Inactivation' ? 'inact'
                      : d.cim_change_type === 'Change'       ? 'change' : 'neutral')
        : 'neutral';
    const _allProgNew = deployments.length > 0 && deployments.every(_depProgramNew);
    const _anyNew = deployments.some(d => _depProgramNew(d) || _depContainsNew(d));
    const _allLaunch = deployments.length > 0 && deployments.every(d => d.launching === 'Y');
    const _anyLaunch = deployments.some(d => d.launching === 'Y');
    let _tint;
    if (_allProgNew) _tint = ' row-added';                      // whole program new (dark green)
    else if (_anyNew) _tint = ' row-added-partial';            // contains something new (light green)
    else if (_allLaunch) _tint = ' row-launching';            // whole program launching (dark teal)
    else if (_anyLaunch) _tint = ' row-launching-partial';    // some campuses launching (light teal)
    else {
        const _colors = new Set(deployments.map(_depColor));
        _tint = (_colors.size === 1)
            ? ({ notincim: ' portfolio-not-in-cim', change: ' row-edited',
                 inact: ' row-deactivated', neutral: '' }[[..._colors][0]] || '')
            : '';
    }
    return `<tr class="portfolio-row portfolio-program-row${_tint}">${nameCell}${cells}</tr>`;
}

function renderPortfolioRow(p, opts = {}) {
    const {hasConcentrations = false, isExpanded = false, isPortfolioConc = false, parent = null,
           groupedDeployment = false} = opts;
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
    const isStatic = typeof window._staticMode !== 'undefined';
    // Four grain-specific OTP cells: program disposition / program notes /
    // deployment disposition / deployment notes. Program-grain cells open the
    // PROGRAM record; deployment-grain cells open THIS deployment. In the grouped
    // Program view the program grain lives on the program header row, so it's
    // left blank on the deployment rows below.
    const _bc = canonicalBanner(p.banner_code);
    const _progOpen = tab => _bc
        ? `event.stopPropagation(); openProgramRecord('${escapeHtml(_bc)}','${tab}')`
        : `event.stopPropagation(); openPortfolioRecord('${escapeHtml(p.id)}','${escapeHtml(String(p.cim_program_id))}',${p.has_regulatory === true},'${tab}')`;
    const _depOpen = tab => `event.stopPropagation(); openPortfolioRecord('${escapeHtml(p.id)}','${escapeHtml(String(p.cim_program_id))}',${p.has_regulatory === true},'${tab}')`;
    const _chips = arr => (arr || []).map(v => `<span class="portfolio-badge disp-badge" title="${escapeHtml(v)}">${escapeHtml(_dispShort(v))}</span>`).join(' ');
    const _dispCellFor = (arr, open) => isStatic
        ? (_chips(arr) || '<span class="muted">—</span>')
        : `<span class="portfolio-disp-text" onclick="${open}">${_chips(arr) || '<span class="muted add-note">+ set</span>'}</span>`;
    const _noteCellFor = (txt, open) => {
        const t = (txt || '').trim();
        const marker = t ? `<span class="portfolio-note-marker" title="${escapeHtml(txt)}">✎ note</span>` : '';
        return isStatic
            ? (t ? marker : '<span class="muted">—</span>')
            : `<span class="portfolio-note-text" onclick="${open}">${marker || '<span class="muted add-note">—</span>'}</span>`;
    };
    const _otpBlank = isPortfolioConc;   // concentrations carry no OTP
    const progDispCell = (_otpBlank || groupedDeployment) ? '' : _dispCellFor(p.program_dispositions, _progOpen('otp_disp'));
    const progNoteCell = (_otpBlank || groupedDeployment) ? '' : _noteCellFor(p.program_note, _progOpen('otp_notes'));
    const depDispCell  = _otpBlank ? '' : _dispCellFor(p.deployment_dispositions, _depOpen('otp_disp'));
    const depNoteCell  = _otpBlank ? '' : _noteCellFor(p.deployment_note, _depOpen('otp_notes'));

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
    // A proposal that adds a new concentration/degree comes to CIM as an "Edited"
    // revision, so cim_change_type is "Change" — but treat it as New (green) while
    // in workflow, since the New Offering signal is the meaningful one. Inactivation
    // still wins (red).
    // Two-tier green (filter-independent): DARK when this deployment is itself a
    // brand-new offering, LIGHT when it contains a launching concentration.
    const changeClass =
        _depProgramNew(p)  ? ' row-added' :
        _depContainsNew(p) ? ' row-added-partial' :
        p.launching === 'Y' ? ' row-launching' :
        activeInWorkflow ? (
            p.cim_change_type === 'Inactivation' ? ' row-deactivated' :
            p.cim_change_type === 'Change'       ? ' row-edited' : ''
        ) : '';
    const notInCim = !p.cim_program_id ? ' portfolio-not-in-cim' : '';
    const rowClass = (isPortfolioConc
        ? 'portfolio-row portfolio-concentration-row'
        : isSynthetic ? 'portfolio-row portfolio-synthetic-row' : 'portfolio-row')
        + changeClass + notInCim
        + (groupedDeployment ? ' portfolio-grouped-deployment' : '');

    // Expansion affordance: no dedicated arrow column. The program name
    // itself is clickable when the row has concentrations, with a tiny
    // chevron appended after the name (rotates on expand) plus cursor
    // pointer + hover tint via CSS. Zero extra column width.
    // Leading caret (expand) + name-opens-drawer, in BOTH the grouped Program view
    // and the flat Deployments view. The caret is the only expand target (the row
    // background no longer toggles); rows with nothing to expand get a caret-width
    // spacer so names stay aligned.
    const leadCaret = hasConcentrations
        ? `<span class="pf-caret${isExpanded ? ' expanded' : ''}" role="button" tabindex="0" title="Show/hide concentrations" aria-label="Show or hide concentrations" onclick="event.stopPropagation(); togglePortfolioConcentrations('${escapeHtml(p.id)}')">${PF_CARET_SVG}</span>`
        : '<span class="pf-caret-spacer"></span>';
    const trailChevron = '';
    const nameCellAttrs = ' class="program-name-cell"';


    // For nested concentration sub-rows, prefer a short display name that
    // shows just the concentration topic (via the module-level _shortConcName).
    // Under a program-group header the program name is already shown on the
    // header, so a grouped deployment row labels itself by its campus.
    const displayName = isPortfolioConc
        ? _shortConcName(p.program_name)
        : groupedDeployment
            ? (effectiveCampus || normalizePortfolioName(stripCampusFromName(p.program_name)))
            : normalizePortfolioName(stripCampusFromName(p.program_name));
    // Program name opens the record drawer (CIM-linked, non-concentration rows).
    // stopPropagation so it doesn't also toggle the concentration expansion.
    const _canOpenRec = !isPortfolioConc && p.cim_program_id;
    const nameHtml = _canOpenRec
        ? `<span class="portfolio-record-open pf-open" title="Open program record"
             onclick="event.stopPropagation(); openPortfolioRecord('${escapeHtml(p.id)}','${escapeHtml(String(p.cim_program_id))}',${p.has_regulatory === true})">${escapeHtml(displayName)}</span>`
        : escapeHtml(displayName);
    // Cell content keyed by column key. Rendered in orderedPortfolioCols() order
    // (same as the header, concentration sub-rows, and CSV) so the body always
    // follows the per-view saved column order and stays aligned with the header.
    // Each value is [content, cls?, titleAttr?] spread into _pc(key, ...).
    const _cells = {
        degree:        [isPortfolioConc ? 'Concentration' : extractPortfolioDegree(p.program_name)],
        college:       [abbreviateCollege(effectiveCollege), null, effectiveCollege || ''],
        campus:        [abbreviateCampus(effectiveCampus)],
        catalogyears:  [escapeHtml(p.catalog_years || '')],
        market2025:      [market2025Badge],
        perf2025:        [perf2025Badge],
        marketscore2025: [escapeHtml(p.market_score_2025 || '')],
        perfscore2025:   [escapeHtml(p.performance_score_2025 || '')],
        svt:      [svtBadge],
        svttype:  [escapeHtml(p.roster_proposal_type || '')],
        substatus:[subStatusBadge],
        speed:    [speedBadge],
        gls:      [glsBadge],
        launch:   [escapeHtml(p.roster_launch_date || '')],
        proposedterm: [escapeHtml(_pfTermDisplay(p.roster_proposed_launch_term))],
        expectedterm: [escapeHtml(_pfTermDisplay(p.roster_expected_launch_term))],
        cim:        [cimStep, 'step-cell'],
        cimcatalog: [escapeHtml(p.cim_completion_date || '')],
        cimterm:    [escapeHtml(p.cim_term || '')],
        svtnote:    [escapeHtml(_svtCoordNote(p))],
        cimchange:  [(activeInWorkflow && p.cim_change_type) ? escapeHtml(p.cim_change_type) : (p.cim_program_id ? '—' : '')],
        ciminact:   [_cimInactivating(p) ? '<span class="portfolio-badge badge-bad">In progress</span>' : ''],
        inworkflow: [p.cim_program_id ? 'Yes' : 'No'],
        inactadmit: [escapeHtml(p.inactivation_admission || '')],
        inacttoday: [(() => {
            const v = _inactAdmittingToday(p);
            if (!v) return '';
            return `<span class="portfolio-badge ${v === 'Yes' ? 'badge-good' : 'badge-bad'}">${v}</span>`;
        })()],
        offering:   [escapeHtml(portfolioOfferingLabel(p))],
        gtmentered: [escapeHtml(p.gtm_entered_date || '')],
        gtmtype:    [escapeHtml(p.gtm_type || '')],
        gtmdate:    [escapeHtml(p.gtm_date || '')],
        gtmfirst:   [escapeHtml(_pfTermDisplay(p.gtm_first_term))],
        gtmlast:    [escapeHtml(p.gtm_last_term || '')],
        gtmintake:  [escapeHtml(p.gtm_intake_terms || '')],
        exitmasters:[escapeHtml(p.exit_masters || '')],
        otp_prog_disp:  [progDispCell, 'portfolio-disp-cell'],
        otp_prog_notes: [progNoteCell, 'portfolio-note-cell'],
        otp_dep_disp:   [depDispCell, 'portfolio-disp-cell'],
        otp_dep_notes:  [depNoteCell, 'portfolio-note-cell'],
        emplreview: [escapeHtml(p.otp_notes || '')],
    };
    // Per-year enrollment columns (dynamic keys) — blank on concentration sub-rows.
    PORTFOLIO_COLUMNS.filter(c => c.enroll).forEach(c => {
        _cells[c.key] = [escapeHtml(String(isPortfolioConc ? '' : _enrValue(p, c.key))), 'enr-cell'];
    });
    const bodyCells = orderedPortfolioCols()
        .map(c => _pc(c.key, ...(_cells[c.key] || ['—'])))
        .join('');
    return `<tr class="${rowClass}" id="pfrow-${escapeHtml(p.id)}" title="${escapeHtml(p.program_name)}">
        <td${nameCellAttrs}>${leadCaret}${concBadge}${nameHtml}${trailChevron}${subStatus}</td>
        ${bodyCells}
    </tr>`;
}

// ---- Shared record drawer (CIM + Portfolio) ----------------------------
// A right-side drawer that hosts the tabbed program detail (Workflow,
// Campuses, Curriculum, Program Changes, Registrar Check, the three
// Alignment tabs, Regulatory). Both the CIM table and the Portfolio table
// open records here, reusing switchDetailTab + the per-tab loaders — all
// keyed on the CIM program id — so no backend work is needed. Which tabs
// appear is decided per surface by the caller (openCimRecord /
// openPortfolioRecord).
// Tab keys → labels. The record standardizes on three alignment lenses, each
// comparing the program against a different source of truth:
//   Academic Alignment  — curriculum vs. its governance-approved reference
//   Regulatory Alignment — courses vs. the GRA approved-courses list
//   Catalog Alignment    — CIM/catalog record vs. the Registrar's catalog rules
// "Reference" (Academic's baseline) is kept as its own tab. The former
// Alignment Summary + Alignment Details are merged into one Academic Alignment
// view (summary line + side-by-side).
const DETAIL_TAB_DEFS = {
    workflow:   'Workflow',
    campuses:   'Campuses',
    curriculum: 'Curriculum',
    changes:    'Program Changes',
    reference:  'Reference',
    academic:   'Academic Alignment',
    regulatory: 'Regulatory Alignment',
    precheck:   'Catalog Alignment',
    otp_disp:   'OTP disposition',
    otp_notes:  'OTP notes',
    review:     'Review note',
};

function _recordTabButtons(id, tabKeys) {
    // OTP/Review tab labels carry the grain (program vs deployment) of the record.
    const grain = _recordDrawerProgramMode ? 'program' : 'deployment';
    const label = key => (key === 'otp_disp') ? `OTP ${grain} disposition`
        : (key === 'otp_notes') ? `OTP ${grain} notes`
        : (key === 'review') ? (grain === 'program' ? 'Program review note' : 'Deployment review note')
        : (DETAIL_TAB_DEFS[key] || key);
    return tabKeys.map(key =>
        `<button class="detail-tab" data-tab="${key}"
            onclick="event.stopPropagation(); switchDetailTab('${id}', '${key}')">${label(key)}</button>`
    ).join('');
}

function _ensureRecordDrawer() {
    let d = document.getElementById('record-drawer');
    if (d) return d;
    d = document.createElement('div');
    d.id = 'record-drawer';
    d.innerHTML =
        `<div class="rec-drawer-backdrop" onclick="closeRecordDrawer()"></div>
         <div class="rec-drawer-panel" role="dialog" aria-label="Program record">
            <div class="rec-drawer-head">
                <span id="rec-drawer-title" class="rec-drawer-title"></span>
                <button class="rec-drawer-close" title="Close" onclick="closeRecordDrawer()">×</button>
            </div>
            <div id="rec-drawer-body"></div>
         </div>`;   // styling lives in style.css (#record-drawer …)
    document.body.appendChild(d);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeRecordDrawer(); });
    return d;
}

// Open the drawer for a program keyed on `id` (the CIM program/course id).
// The tab container is #detail-<id> and the content #detail-content-<id>,
// matching what switchDetailTab and every loader expect.
function openRecordDrawer(id, title, tabKeys, defaultTab) {
    id = String(id);
    const d = _ensureRecordDrawer();
    document.getElementById('rec-drawer-title').textContent = title || ('Program ' + id);
    const searchHtml =
        `<input type="text" class="detail-search" id="detail-search-${id}"
            placeholder="Search within this page (Enter = next)…"
            oninput="filterDetailContent('${id}')"
            onkeydown="cycleDetailMatch('${id}', event)"
            onclick="event.stopPropagation()">`;
    document.getElementById('rec-drawer-body').innerHTML =
        `<div class="detail-tabs" id="detail-${id}">${_recordTabButtons(id, tabKeys)}${searchHtml}</div>
         <div class="detail-content" id="detail-content-${id}"><div class="workflow-loading">Loading…</div></div>`;
    switchDetailTab(id, defaultTab || tabKeys[0]);   // sets the active button + loads the content
    d.classList.add('open');
}

function closeRecordDrawer() {
    const d = document.getElementById('record-drawer');
    if (d) d.classList.remove('open');
}

// ---- CIM: open a program (or course) record in the drawer --------------
function openCimRecord(id) {
    id = String(id);
    const isCourseView = currentView === 'courses';
    const src = isCourseView ? (allCourses || []) : (allPrograms || []);
    const item = src.find(p => String(p.id) === id);
    let tabKeys;
    if (isCourseView) {
        tabKeys = ['workflow'];
    } else {
        // Order: core record → the three alignment lenses (Reference is
        // Academic's baseline, then Academic / Regulatory / Catalog).
        tabKeys = ['workflow', 'campuses', 'curriculum', 'changes', 'reference', 'academic'];
        if (item && item.has_regulatory === true) tabKeys.push('regulatory');
        if (!window._staticMode) tabKeys.push('precheck');   // Catalog Alignment (needs live CIM)
    }
    const title = item
        ? (isCourseView ? `${item.code}: ${item.title}` : item.name)
        : ('Program ' + id);
    openRecordDrawer(id, title, tabKeys, 'workflow');
}

// ---- Portfolio: open a program record in the drawer --------------------
// The OTP tab (two-grain disposition/note editor) is keyed on the portfolio row,
// not the CIM id — stash the portfolio id so loadOtpDetail can find the row even
// for deployments with no CIM record.
let _recordDrawerPid = null;
let _recordDrawerProgramMode = false;   // true when the drawer was opened on a whole program (banner grain)
let _recordDrawerBanner = '';
// Open a PROGRAM record (banner grain) — an OTP-only drawer for setting the
// program-level disposition/note directly on the program, without going through
// a deployment. Used by the Program view's program rows.
function openProgramRecord(banner, defaultTab) {
    banner = (banner || '').trim();
    _recordDrawerProgramMode = true;
    _recordDrawerBanner = banner;
    _recordDrawerPid = null;
    const prog = allPortfolioPrograms.find(p => canonicalBanner(p.banner_code) === banner);
    const title = prog ? normalizePortfolioName(stripCampusFromName(prog.program_name)) : ('Program ' + banner);
    openRecordDrawer('prog_' + banner, title, ['otp_disp', 'otp_notes'], defaultTab || 'otp_disp');
}
function openPortfolioRecord(pid, cimId, hasReg, defaultTab) {
    _recordDrawerProgramMode = false;
    _recordDrawerBanner = '';
    _recordDrawerPid = pid;
    const prog = allPortfolioPrograms.find(p => String(p.id) === String(pid))
              || allPortfolioPrograms.find(p => String(p.cim_program_id) === String(cimId));
    // No 'campuses' tab here — the Program (grouped) view shows a program's
    // campuses directly, and the CIM-list-based Campuses loader is unreliable
    // from the Portfolio (it 404s when the row isn't in allPrograms).
    const tabKeys = ['curriculum', 'reference', 'academic'];
    if (hasReg) tabKeys.push('regulatory');
    tabKeys.push('otp_disp', 'otp_notes');
    openRecordDrawer(cimId, prog ? prog.program_name : ('Program ' + cimId),
                     tabKeys, defaultTab || 'curriculum');
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
            case 'catalogyears': return p.catalog_years || '';
            case 'svt':         return p.svt_status || '';
            case 'svttype':     return p.roster_proposal_type || '';
            case 'substatus':   return p.roster_sub_status || '';
            case 'speed':       return p.speed_to_market === 'True' ? 'Yes' : p.speed_to_market === 'False' ? 'No' : '';
            case 'gls':         return p.gls_status || '';
            case 'launch':      return p.roster_launch_date || '';   // GTM go-to-market date
            case 'proposedterm': return _pfTermDisplay(p.roster_proposed_launch_term);
            case 'expectedterm': return _pfTermDisplay(p.roster_expected_launch_term);
            case 'cim':         return p.cim_step || '';
            case 'cimcatalog':  return p.cim_completion_date || '';
            case 'cimterm':     return p.cim_term || '';
            case 'svtnote':     return _svtCoordNote(p);
            case 'cimchange':   return (p.cim_step && p.cim_change_type) ? p.cim_change_type : p.cim_program_id ? '' : '';
            case 'ciminact':    return _cimInactivating(p) ? 'In progress' : '';
            case 'inworkflow':  return p.cim_program_id ? 'Yes' : 'No';
            case 'inactadmit':  return p.inactivation_admission || '';
            case 'inacttoday':  return _inactAdmittingToday(p) || '';
            case 'offering':    return portfolioOfferingLabel(p);
            case 'gtmentered':  return p.gtm_entered_date || '';
            case 'gtmtype':     return p.gtm_type || '';
            case 'gtmdate':     return p.gtm_date || '';
            case 'gtmfirst':    return _pfTermDisplay(p.gtm_first_term);
            case 'gtmlast':     return p.gtm_last_term || '';
            case 'gtmintake':   return p.gtm_intake_terms || '';
            case 'exitmasters': return p.exit_masters || '';
            case 'market2025':      return p.market_2025 || '';
            case 'perf2025':        return p.performance_2025 || '';
            case 'marketscore2025': return p.market_score_2025 != null ? String(p.market_score_2025) : '';
            case 'perfscore2025':   return p.performance_score_2025 != null ? String(p.performance_score_2025) : '';
            case 'otp_prog_notes': return p.program_note || '';
            case 'otp_dep_notes':  return p.deployment_note || '';
            case 'otp_prog_disp':  return (p.program_dispositions || []).join('; ');
            case 'otp_dep_disp':   return (p.deployment_dispositions || []).join('; ');
            case 'emplreview':  return p.otp_notes || '';
            default:
                if (key.startsWith('enr_')) return isConc ? '' : String(_enrValue(p, key));
                return '';
        }
    }

    const visCols = orderedPortfolioCols().filter(c => portfolioVisibleCols.has(c.key));
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

const _DISP_SHORT = {
    'Leadership recommends inactivation': 'Ldr: inactivate',
    'Leadership recommends optimization': 'Ldr: optimize',
    'College considering inactivation': 'Coll: considering inact.',
    'College agrees to inactivate': 'Coll: agreed to inact.',
    'College optimizing': 'Coll: optimizing',
    'Optimization complete': 'Opt: complete',
    'College investigating performance': 'Coll: investigating',
    'College not inactivating': 'Coll: not inactivating',
    'Merging/consolidating into another program': 'Merging/consolidating',
    'Consolidation target': 'Consolidation target',
};
function _dispShort(v) { return _DISP_SHORT[v] || v; }

async function editPortfolioDisposition(el, programId) {
    const prog = allPortfolioPrograms.find(p => p.id === programId);
    const current = new Set(prog ? (prog.dispositions || []) : []);
    const box = document.createElement('div');
    box.className = 'portfolio-disp-editor';
    box.innerHTML = portfolioDispositionValues.map(v =>
        `<label style="display:block;white-space:nowrap;font-size:12px;cursor:pointer;">` +
        `<input type="checkbox" value="${escapeHtml(v)}" ${current.has(v) ? 'checked' : ''}> ${escapeHtml(v)}</label>`
    ).join('') + `<button type="button" class="disp-done-btn btn-secondary" style="margin-top:4px;font-size:11px;">Done</button>`;
    el.replaceWith(box);

    async function save() {
        const values = [...box.querySelectorAll('input[type=checkbox]:checked')].map(cb => cb.value);
        try {
            const res = await fetch(`/api/portfolio/disposition/${encodeURIComponent(programId)}`, {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({values}),
            });
            const data = await res.json();
            if (prog) {
                prog.dispositionsMeta = data.dispositions || [];
                prog.dispositions = prog.dispositionsMeta.map(d => d.value);
            }
        } catch (e) { console.error('disposition save failed', e); }
        renderPortfolioTable();
    }
    box.querySelector('.disp-done-btn').addEventListener('click', save);
}

// Recompute a row's effective disposition/note (most-specific-wins) from its
// per-grain arrays. Mirrors database.resolve_otp so the in-memory model stays
// consistent after an edit without a full reload.
function _recomputeEffectiveOtp(p) {
    const pd = p.deployment_dispositions || [];
    const gd = p.program_dispositions || [];
    if (pd.length)      { p.dispositions = pd; p.otp_disposition_source = 'deployment'; }
    else if (gd.length) { p.dispositions = gd; p.otp_disposition_source = 'program'; }
    else                { p.dispositions = []; p.otp_disposition_source = ''; }
    const dn = (p.deployment_note || '').trim();
    const gn = (p.program_note || '').trim();
    if (dn)      { p.note = dn; p.otp_note_source = 'deployment'; }
    else if (gn) { p.note = gn; p.otp_note_source = 'program'; }
    else         { p.note = ''; p.otp_note_source = ''; }
    const drn = (p.deployment_review_note || '').trim();
    const grn = (p.program_review_note || '').trim();
    if (drn)      { p.review_note = drn; p.review_note_source = 'deployment'; }
    else if (grn) { p.review_note = grn; p.review_note_source = 'program'; }
    else          { p.review_note = ''; p.review_note_source = ''; }
}

// OTP drawer tab: two stacked scopes — Program (all campuses, keyed on Banner
// code) and This deployment (this portfolio row). Editing the program scope
// changes every deployment of the Banner code at once; the deployment scope
// overrides it (most-specific-wins). Keyed on the portfolio row (_recordDrawerPid),
// so it works even for deployments with no CIM record.
// OTP drawer content — ONE grain (program vs deployment, from what was opened)
// and ONE field (`field` = 'disposition' | 'notes', chosen by the top-level tab).
// A deployment shows a muted "inherits program" hint when it hasn't overridden.
function loadOtpDetail(drawerId, field) {
    const el = document.getElementById(`detail-content-${drawerId}`);
    if (!el) return;
    field = (field === 'notes' || field === 'review') ? field : 'disposition';
    const programMode = !!_recordDrawerProgramMode;
    let prog, bc;
    if (programMode) {
        bc = (_recordDrawerBanner || '').trim();
        prog = allPortfolioPrograms.find(p => canonicalBanner(p.banner_code) === bc) || {};
    } else {
        prog = allPortfolioPrograms.find(p => String(p.id) === String(_recordDrawerPid))
            || allPortfolioPrograms.find(p => String(p.cim_program_id) === String(drawerId));
        if (!prog) { el.innerHTML = '<p class="muted" style="padding:8px">No portfolio record.</p>'; return; }
        bc = canonicalBanner(prog.banner_code);
    }
    const isStatic = typeof window._staticMode !== 'undefined';
    const grain = programMode ? 'program' : 'deployment';

    if (grain === 'program' && !bc) {
        el.innerHTML = `<div class="otp-detail"><p class="muted" style="font-size:12px;">No Banner code — program-level OTP is unavailable; set it on a deployment.</p></div>`;
        return;
    }

    const checksHtml = (selected) => portfolioDispositionValues.map(v =>
        `<label class="otp-opt"><input type="checkbox" value="${escapeHtml(v)}" ` +
        `${(selected || []).includes(v) ? 'checked' : ''} ${isStatic ? 'disabled' : ''}> ${escapeHtml(v)}</label>`).join('');

    let content, hint = '';
    if (field === 'disposition') {
        const sel = grain === 'program' ? (prog.program_dispositions || []) : (prog.deployment_dispositions || []);
        content = `<div class="otp-checks">${checksHtml(sel)}</div>`;
        if (grain === 'deployment' && !sel.length && (prog.program_dispositions || []).length)
            hint = `<div class="otp-inherit-hint">Inherits program: ${escapeHtml((prog.program_dispositions || []).map(_dispShort).join(', '))}</div>`;
    } else if (field === 'review') {
        const val = grain === 'program' ? (prog.program_review_note || '') : (prog.deployment_review_note || '');
        content = `<textarea class="portfolio-note-input otp-note" rows="7" ${isStatic ? 'readonly' : ''}>${escapeHtml(val)}</textarea>`;
        if (grain === 'deployment' && !(prog.deployment_review_note || '').trim() && (prog.program_review_note || '').trim())
            hint = `<div class="otp-inherit-hint">Inherits the program review note.</div>`;
    } else {
        const val = grain === 'program' ? (prog.program_note || '') : (prog.deployment_note || '');
        content = `<textarea class="portfolio-note-input otp-note" rows="6" ${isStatic ? 'readonly' : ''}>${escapeHtml(val)}</textarea>`;
        if (grain === 'deployment' && !(prog.deployment_note || '').trim() && (prog.program_note || '').trim())
            hint = `<div class="otp-inherit-hint">Inherits the program note.</div>`;
    }
    const keyid = grain === 'program' ? (bc + ' · all campuses') : (prog.campus || prog.id);

    el.innerHTML =
        `<div class="otp-detail">
           <section class="otp-scope otp-scope-${grain}">
             <div class="otp-scope-head"><span class="otp-scope-key">${escapeHtml(keyid)}</span></div>
             ${content}${hint}
             ${isStatic ? '' : `<div class="otp-save-status" aria-live="polite"></div>`}
           </section>
         </div>`;

    if (isStatic) return;
    const sub = field;   // 'disposition' | 'notes' | 'review'
    const statusEl = el.querySelector('.otp-save-status');
    let _seq = 0;
    const setStatus = t => { if (statusEl) statusEl.textContent = t; };

    // Auto-save: no Save button. Dispositions save on toggle; notes save on blur
    // and ~0.9s after you stop typing. We update the in-memory model + the table
    // but deliberately do NOT re-render this drawer (that would drop textarea
    // focus mid-edit); the inherit hint refreshes next time the tab is opened.
    async function doSave() {
        const seq = ++_seq;
        setStatus('Saving…');
        try {
            if (sub === 'disposition') {
                const values = [...el.querySelectorAll('.otp-checks input[type=checkbox]:checked')].map(cb => cb.value);
                const url = grain === 'program'
                    ? `/api/portfolio/program-disposition/${encodeURIComponent(bc)}`
                    : `/api/portfolio/disposition/${encodeURIComponent(prog.id)}`;
                await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({values})});
                if (grain === 'program') allPortfolioPrograms.forEach(p => {
                    if (canonicalBanner(p.banner_code) === bc) { p.program_dispositions = values.slice(); _recomputeEffectiveOtp(p); }
                });
                else { prog.deployment_dispositions = values.slice(); _recomputeEffectiveOtp(prog); }
            } else if (sub === 'review') {
                const note = (el.querySelector('.otp-note').value || '').trim();
                const url = grain === 'program'
                    ? `/api/portfolio/program-review-note/${encodeURIComponent(bc)}`
                    : `/api/portfolio/review-note/${encodeURIComponent(prog.id)}`;
                await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({note})});
                if (grain === 'program') allPortfolioPrograms.forEach(p => {
                    if (canonicalBanner(p.banner_code) === bc) { p.program_review_note = note; _recomputeEffectiveOtp(p); }
                });
                else { prog.deployment_review_note = note; _recomputeEffectiveOtp(prog); }
            } else {
                const note = (el.querySelector('.otp-note').value || '').trim();
                const url = grain === 'program'
                    ? `/api/portfolio/program-note/${encodeURIComponent(bc)}`
                    : `/api/portfolio/note/${encodeURIComponent(prog.id)}`;
                await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({note})});
                if (grain === 'program') allPortfolioPrograms.forEach(p => {
                    if (canonicalBanner(p.banner_code) === bc) { p.program_note = note; _recomputeEffectiveOtp(p); }
                });
                else { prog.deployment_note = note; _recomputeEffectiveOtp(prog); }
            }
            renderPortfolioTable();
            if (seq === _seq) setStatus('Saved ✓');
        } catch (e) { console.error('OTP save failed', e); setStatus('Save failed — check connection'); }
    }

    if (sub === 'disposition') {
        el.querySelectorAll('.otp-checks input[type=checkbox]').forEach(cb => cb.addEventListener('change', doSave));
    } else {
        const ta = el.querySelector('.otp-note');
        if (ta) {
            let _t, _last = ta.value;
            ta.addEventListener('input', () => { setStatus('Editing…'); clearTimeout(_t); _t = setTimeout(() => { _last = ta.value; doSave(); }, 900); });
            ta.addEventListener('blur', () => { clearTimeout(_t); if (ta.value !== _last || statusEl.textContent === 'Editing…') { _last = ta.value; doSave(); } });
        }
    }
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

// ── Left-rail shell config (mounts shared/web/rail.js) ──────────────────────
// Runs at the END of app.js so every referenced global/function exists — in
// both the Flask app and the encrypted-static gate (which injects app.js after
// unlock). initTrackerShell reads the flag (?shell=rail / localStorage) itself;
// default OFF, classic header is the fallback.
(function initProgramShell() {
    if (typeof initTrackerShell !== 'function') return;
    initTrackerShell({
        brand: { label: 'Program Tracker', logo: 'N' },
        persistPrefix: 'tracker',
        defaultShell: 'rail',   // the rail is the default layout for everyone
        classicToggle: false,   // no "↩ Classic layout" button — the rail is the layout
        nav: [
            { label: 'Portfolio', items: [
                { label: 'Program',     onSelect: () => _railLayout('program'), isActive: () => currentView === 'portfolio' && portfolioLayout === 'program' },
                { label: 'Deployments', onSelect: () => _railLayout('table'),   isActive: () => currentView === 'portfolio' && portfolioLayout === 'table' },
                { label: 'Matrix',      onSelect: () => _railLayout('matrix'),  isActive: () => currentView === 'portfolio' && portfolioLayout === 'matrix' },
            ]},
            { label: 'CIM', items: [
                { label: 'Programs', onSelect: () => switchView('programs'), isActive: () => currentView === 'programs' },
                { label: 'Courses',  onSelect: () => switchView('courses'),  isActive: () => currentView === 'courses' },
                { label: 'Catalog',  onSelect: () => switchView('catalog'),  isActive: () => currentView === 'catalog' },
            ]},
        ],
        // Perspective is a MODE (University vs College lens), not a filter — it
        // gets its own segmented toggle under the nav, only on CIM Programs/Courses.
        modes: [{
            id: 'cim_perspective', label: 'Perspective',
            enabled: () => currentView === 'programs' || currentView === 'courses',
            options: () => [{ value: 'otp', label: 'University' }, { value: 'college', label: 'College' }],
            active: () => cimPerspective,
            onSelect: v => setCimPerspective(v === 'college' ? 'college' : 'otp'),
            // College picker — shown in the rail under the toggle, only in College
            // perspective (replaces the old lone dropdown floating above the pipeline).
            sub: {
                enabled: () => cimPerspective === 'college' && (currentView === 'programs' || currentView === 'courses'),
                placeholder: 'Select a college…',
                options: () => {
                    const src = (currentView === 'courses' ? allCourses : allPrograms) || [];
                    const s = new Set(); src.forEach(p => { if (p.college) s.add(p.college); });
                    if (cimCollegeSelected && !s.has(cimCollegeSelected)) s.add(cimCollegeSelected);
                    return [...s].sort((a, b) => abbreviateCollege(a).localeCompare(abbreviateCollege(b)))
                        .map(c => ({ value: c, label: abbreviateCollege(c) }));
                },
                active: () => cimCollegeSelected,
                onSelect: v => setCimCollege(v),
            },
        }],
        // The coarse "narrow it down" controls live under one "Focus" heading:
        // Level (buttons) + College / Campus / Credential (dropdowns).
        scopesLabel: 'Focus',
        // Permanent top-level single-select pickers (College / Campus / Credential)
        // — the common "narrow to one X" lenses, per-function (they drive the CIM
        // filters on CIM views and the Portfolio filters on Portfolio). Single value
        // written as a 0/1-element Set so the existing multi read-paths are unchanged.
        scopes: _programScopes(),
        // ('＋ Add idea' lives in the Portfolio table toolbar next to Export.)
        tools: [
            { label: 'Console',       onClick: () => openConsoleModal() },
            { label: 'Mappings',      onClick: () => openMappingsModal() },
            { label: 'Discrepancies', onClick: () => openDiscrepanciesModal() },
            { label: 'References',    onClick: () => openReferencesModal() },
        ],
        views: {
            enabled: () => currentView === 'portfolio',
            list: () => (window._portfolioTileViews || []).map(v => ({
                id: v.id, name: v.name,
                active: (v.id === 'all') ? (!portfolioActiveViewId || portfolioActiveViewId === 'all') : (v.id === portfolioActiveViewId),
            })),
            apply: id => { applyPortfolioView(id); renderPortfolioTable(); },
            onManage: () => openPortfolioViewsModal(),
        },
        filters: {
            enabled: () => ['portfolio', 'programs', 'courses', 'catalog'].includes(currentView),
            fields: () => (currentView === 'portfolio') ? _portfolioRailFields() : _cimRailFields(),
            onChange: () => {
                if (currentView === 'portfolio') {
                    if (typeof _portfolioViewTouch === 'function') _portfolioViewTouch();
                    renderPortfolioTable();
                } else if (typeof applyFilters === 'function') {
                    applyFilters();   // CIM re-render
                }
            },
        },
        freshness: () => ({
            updated: (document.getElementById('last-updated') || {}).textContent || '',
            build: (document.getElementById('app-build') || {}).textContent || '',
        }),
        onExitRail: () => {
            if (typeof populatePortfolioFilters === 'function') { try { populatePortfolioFilters(); } catch (_) {} }
            if (currentView === 'portfolio') renderPortfolioTable();
        },
    });
})();


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
        if (D.workflow_roles) cimRolePairs = D.workflow_roles;

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
        const buildEl = document.getElementById('app-build');
        if (buildEl && D.build_time) buildEl.textContent = 'Build: ' + _fmtDT(D.build_time);

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
    function _setLastUpdated(D) {
        const updatedEl = document.getElementById('last-updated');
        if (updatedEl && D.last_scan) {
            const d = new Date(D.last_scan.scan_time);
            updatedEl.textContent = `Updated: ${d.toLocaleDateString('en-US', {month: 'short', day: 'numeric', timeZone: 'America/New_York'})} at ${d.toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'})} ET`;
        }
        const buildEl = document.getElementById('app-build');
        if (buildEl && D.build_time) buildEl.textContent = 'Build: ' + _fmtDT(D.build_time);
    }

    window.loadCatalogDashboard = async function() {
        const D = await _getData();
        _setLastUpdated(D);
        cachedCatalogPipeline = D.catalog_pipeline || [];
        allCatalogPages = D.catalog_pages || [];
        if (typeof populateCatalogCollegeFilter === 'function') populateCatalogCollegeFilter();
        if (typeof populateCatalogApproverFilter === 'function') populateCatalogApproverFilter();
        renderCatalogPipeline();
        renderCatalogTable();
    };

    // Portfolio dashboard: read from embedded data; disable refresh + notes.
    window.loadPortfolioDashboard = async function() {
        const _isRefresh   = (allPortfolioPrograms && allPortfolioPrograms.length > 0);
        const _prevActive  = (typeof portfolioActiveViewId !== 'undefined') ? portfolioActiveViewId : null;
        const _prevTree    = (typeof portfolioFilterTree !== 'undefined' && portfolioFilterTree) ? JSON.parse(JSON.stringify(portfolioFilterTree)) : null;
        const _prevFilters = (typeof _snapshotPortfolioFilters === 'function') ? _snapshotPortfolioFilters() : null;
        const D = await _getData();
        _setLastUpdated(D);
        allPortfolioPrograms = D.portfolio_programs || [];
        allPortfolioPrograms.forEach(p => {
            try {
                p.concentrations = p.concentrations_json
                    ? JSON.parse(p.concentrations_json) : [];
            } catch (e) { p.concentrations = []; }
            try {
                p.enrollment = p.enrollment_json ? JSON.parse(p.enrollment_json) : null;
            } catch (e) { p.enrollment = null; }
        });
        if (typeof portfolioTeamViews !== 'undefined') {
            portfolioTeamViews = D.team_views || [];
        }
        if (typeof populatePortfolioFilters === 'function') populatePortfolioFilters();
        if (_isRefresh) {
            // Preserve the on-screen view/filter across a refresh (don't reset it).
            portfolioActiveViewId = _prevActive;
            portfolioFilterTree   = _prevTree;
            if (_prevFilters && typeof _applyPortfolioFilters === 'function') _applyPortfolioFilters(_prevFilters);
            if (typeof renderPortfolioViewTiles === 'function') renderPortfolioViewTiles();
            renderPortfolioTable();
        } else {
            let _sv = null;
            try { _sv = localStorage.getItem('cim-portfolio-active-view'); } catch (e) {}
            if (_sv && typeof getPortfolioViewById === 'function' && getPortfolioViewById(_sv)) {
                applyPortfolioView(_sv);
            } else {
                if (typeof renderPortfolioViewTiles === 'function') renderPortfolioViewTiles();
                renderPortfolioTable();
            }
        }
    };
    window.refreshPortfolio = function() {
        alert('Refresh is only available on the local server.');
    };
    window.editPortfolioNote = function() { /* read-only on static site */ };

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

        const actionPanel = isCourseView ? '' : buildProgramActionPanel(programId, steps);
        contentEl.innerHTML = `
            <div class="workflow-steps">${stepsHtml}</div>
            ${metaHtml}
            ${courseMetaHtml}
            ${actionPanel}
        `;
        if (actionPanel) revealActionPanelIfLocal(programId);
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
    function _staticBuildReferencedByBanner(programId, D) {
        const list = (D.referenced_by || {})[String(programId)] || [];
        if (!list.length) return '';
        const items = list.map(r => `<li>${escapeHtml(r.name)}</li>`).join('');
        return `<div class="referenced-by-banner">
            <strong>This program is the reference for ${list.length} other program${list.length === 1 ? '' : 's'}:</strong>
            <ul>${items}</ul>
        </div>`;
    }
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
        const D = await _getData();
        const banner = _staticBuildReferencedByBanner(programId, D);
        const ref = _referenceCache[String(programId)];
        if (ref && ref.html) {
            const cleaned = cleanCurriculumHtml(ref.html);
            const displayDate = typeof formatReferenceVersionLabel === 'function'
                ? formatReferenceVersionLabel(ref.version_date)
                : ref.version_date;
            let label = 'Reference version';
            if (ref.source === 'custom')       label = 'Custom reference';
            else if (ref.source === 'program') label = 'Reference program';
            let ugccBadge = '';
            if (ref.source === 'custom') {
                ugccBadge = (ref.ugcc_approved === 'Yes')
                    ? ` <span class="ugcc-badge ugcc-yes">UGCC approved${ref.ugcc_date ? ' · ' + ref.ugcc_date : ''}</span>`
                    : ` <span class="ugcc-badge ugcc-no">UGCC: not approved</span>`;
            }
            const header = (displayDate || ugccBadge)
                ? `<div class="reference-header">${label}${displayDate ? ': ' + displayDate : ''}${ugccBadge}</div>`
                : '';
            contentEl.innerHTML = `${banner}${header}<div class="curriculum-content">${cleaned}</div>`;
        } else {
            contentEl.innerHTML = banner + '<div class="workflow-meta">No reference curriculum available.</div>';
        }
    };

    // Changes tab — diff this program's current curriculum against its
    // OWN last-approved version. Data comes from history.json (separate
    // from reference.json, which is purely cross-program). For non-Boston
    // deployments without own-history data, show a notice.
    let _historyCache = null;
    window.loadChangesDetail = async function(programId) {
        const contentEl = document.getElementById(`detail-content-${programId}`);
        if (!contentEl) return;
        contentEl.innerHTML = '<div class="workflow-loading">Loading change history...</div>';
        if (!_curriculumCache) {
            try { _curriculumCache = window.__EMBEDDED_CURRICULUM__ || (await (await fetch('curriculum.json')).json()); } catch(e) {}
        }
        if (!_historyCache) {
            try { _historyCache = await (await fetch('history.json')).json(); } catch(e) { _historyCache = {}; }
        }
        const currHtml = (_curriculumCache || {})[String(programId)] || '';
        const hist = (_historyCache || {})[String(programId)];
        if (!hist || !hist.html) {
            contentEl.innerHTML = '<div class="workflow-meta">No prior approved version on file for this program. The Changes tab compares against the program&#39;s own previous approved version; non-Boston deployments and brand-new programs commonly have no own-history record.</div>';
            return;
        }
        if (!currHtml) {
            contentEl.innerHTML = '<div class="workflow-meta">Curriculum data not available for change comparison.</div>';
            return;
        }
        // Old version LEFT, current proposal RIGHT → standard diff colors:
        // red = removed from proposal, green = added in this proposal.
        const {identical, diff} = compareCurricula(hist.html, currHtml);
        const vd = hist.version_date || '';
        const dateLabel = typeof formatReferenceVersionLabel === 'function'
            ? formatReferenceVersionLabel(vd) : vd;
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
    };

    // Patch regulatory loading to read from regulatory.json (lazy) instead of API
    let _regulatoryCache = null;
    window.loadRegulatoryDetail = async function(programId) {
      const contentEl = document.getElementById(`detail-content-${programId}`);
      if (!contentEl) return;
      contentEl.innerHTML = '<div class="workflow-loading">Loading regulatory data...</div>';
      try {
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
      } catch (e) {
        contentEl.innerHTML = '<div class="workflow-meta" style="color:#b91c1c">Could not load regulatory alignment: ' +
            escapeHtml(e && e.message ? e.message : String(e)) + '</div>';
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

        // Explicit reference override (uploaded file OR another program chosen
        // via the picker) takes precedence over campus-based comparison logic.
        const _ref = (_referenceCache || {})[String(programId)];
        const isOverrideRef = _ref && (_ref.source === 'custom' || _ref.source === 'program');
        if (isOverrideRef) {
            const refHtml = _ref.html || '';
            if (!currHtml || !refHtml) {
                contentEl.innerHTML = '<div class="workflow-meta">Curriculum or reference data not available for comparison.</div>';
                updateCompareButton(programId, null);
                return;
            }
            const {identical, diff} = compareCurricula(currHtml, refHtml);
            updateCompareButton(programId, identical);
            const header = '<div class="reference-header">Comparing against ' + escapeHtml(_ref.version_date || 'selected reference') + '</div>';
            if (identical) {
                contentEl.innerHTML = header + '<div class="compare-identical">Proposed curriculum is identical to the reference.</div>';
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
            // Self-reference fallback: no Boston counterpart, no prior
            // approved version in CIM history → fetch_reference_curricula
            // stored a sentinel ref where the "reference" is actually the
            // program's own current curriculum. A diff would trivially be
            // identical and labelling it "Boston reference" is wrong.
            const isSelfRef = ref.version_date &&
                ref.version_date.toLowerCase().includes('no prior approved');
            if (isSelfRef) {
                updateCompareButton(programId, null);
                contentEl.innerHTML = '<div class="workflow-meta">No prior approved version on file for this program and no Boston counterpart found — nothing to compare against.</div>';
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
                // Boston on the left (Proposed), deployment on the right (Reference).
                const {identical, diff} = compareCurricula(currHtml, depHtml);
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

    // Misaligned tab (static) — lists red-flagged courses (in this program,
    // not in its reference). Mirrors the static loadCompareDetail data access
    // but emits a plain list via the shared _redCoursesFromDiff /
    // _renderMisalignedList helpers (defined in the base app.js).
    window.loadMisalignedDetail = async function(programId) {
        const contentEl = document.getElementById(`detail-content-${programId}`);
        if (!contentEl) return;
        contentEl.innerHTML = '<div class="workflow-loading">Loading misaligned courses...</div>';
        const note = c => '<div class="workflow-meta">' + c + '</div>';
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
        const progName = getProgramName(programId) || 'this program';
        const campusMatch = progName.match(/\(([^)]+)\)\s*$/);
        const campus = campusMatch ? campusMatch[1] : null;
        const isNonBoston = campus && campus.toLowerCase() !== 'boston';
        const ref = (_referenceCache || {})[String(programId)];

        // Single-reference branches
        if ((ref) || bostonId || isNonBoston || !(deploymentIds && deploymentIds.length)) {
            const refHtml = ref ? ref.html : '';
            const isSelfRef = ref && ref.version_date &&
                ref.version_date.toLowerCase().includes('no prior approved');
            if (!currHtml || !refHtml || isSelfRef) {
                contentEl.innerHTML = note('No reference curriculum available to compare against.');
                return;
            }
            const isCustom = ref.version_date && ref.version_date.indexOf('Custom reference') === 0;
            let refName;
            if (isCustom)         refName = ref.version_date.replace('Custom reference: ', '');
            else if (bostonId)    refName = getProgramName(bostonId) || 'the Boston reference';
            else if (isNonBoston) refName = 'the Boston reference';
            else                  refName = 'the last approved version';
            const {diff} = compareCurricula(currHtml, refHtml);
            contentEl.innerHTML = _renderMisalignPair(progName, refName, diff);
            return;
        }

        // Boston program with deployments — one labeled pair per deployment.
        let html = note('Comparing ' + escapeHtml(progName) + ' against ' + deploymentIds.length + ' deployment' + (deploymentIds.length > 1 ? 's' : '') + ':');
        for (const depId of deploymentIds) {
            const depHtml = (_curriculumCache || {})[String(depId)] || '';
            const depName = getProgramName(depId);
            if (!currHtml || !depHtml) {
                html += '<h4 class="mis-heading">' + escapeHtml(depName) + '</h4>' + note('Curriculum data not available.');
                continue;
            }
            const {diff} = compareCurricula(depHtml, currHtml);
            html += '<div class="compare-deployment-section">' + _renderMisalignPair(depName, progName, diff) + '</div>';
        }
        contentEl.innerHTML = html;
    };

    // Update button: reach local Flask to trigger the fast scan
    // (Options C+F: hybrid discovery, incremental fetch — ~22 min).
    // The deep heal path is reserved for the weekly Sunday-morning
    // launchd-scheduled run (or `curl /api/heal` if needed manually).
    window.triggerScan = async function() {
        const btn = document.getElementById('scan-btn');
        const statusEl = document.getElementById('scan-status');
        btn.disabled = true;
        // No "Updating..." text — scans run continuously in the
        // background; the last-updated timestamp tells the user when
        // they last received fresh data.
        statusEl.textContent = '';
        statusEl.className = 'scan-status';
        try {
            const res = await fetch('http://localhost:5001/api/scan/trigger', {
                method: 'POST',
                mode: 'cors',
                headers: {'Content-Type': 'application/json'},
            });
            if (res.ok) {
                // Poll silently; only re-enable the button when idle.
                const poll = setInterval(async () => {
                    try {
                        const s = await fetch('http://localhost:5001/api/scan/status');
                        const d = await s.json();
                        if (!d.running) {
                            clearInterval(poll);
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

    // Initial load: restore saved view (Portfolio, Courses, etc.) just like Flask mode.
    // _initDashboard() is defined in app.js and handles localStorage view restoration.
    _initDashboard();
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', __staticInit);
} else {
    __staticInit();
}
