# Business traceability — Moodle tests → our tests

Per the project standard (research report §3.11): a feature is done only when
its **business flow** is covered by flow-level tests, and the behavioural
oracle is Moodle's own PHPUnit test suite, translated scenario-by-scenario.
Every phase appends its mapping here: Moodle test file/case → our test file
→ status. Cases that encode PHP implementation details rather than business
behaviour are skipped with a recorded reason.

## Structure (template for P1+)

| # | Behaviour | Moodle oracle (file / case) | Our test | Phase | Status |
|---|-----------|-----------------------------|----------|-------|--------|
|   |           |                             |          |       |        |

## P0 — Infrastructure (no business subsystems yet)

P0 deliberately ships no Moodle business behaviour, so there are no Moodle
oracle mappings yet. The P0 acceptance tests verify the infrastructure
contracts the later business flows rely on:

| Behaviour under test | Our test |
|----------------------|----------|
| Outbox: event published only after commit; rollback ⇒ no event | `apps/api/src/infra/events/outbox.spec.ts` |
| BullMQ adhoc dedup by jobId (Moodle adhoc-task dedup semantics, report §3.5) | `apps/api/src/infra/tasks/tasks.spec.ts` |
| Scheduled job runs once across two instances (Redis lock) | `apps/api/src/infra/tasks/tasks.spec.ts` |
| Cache MUC modes stay namespace-isolated (application / session / request) | `apps/api/src/infra/cache/cache-infra.spec.ts` |
| RFC 7807 Problem Details shape for all API errors | `apps/api/src/common/problem-details.filter.spec.ts`, `apps/api/test/app.e2e-spec.ts` |
| Env validation fails fast at boot | `apps/api/src/config/env.spec.ts` |
| Shared api↔web contracts parse/reject correctly | `packages/contracts/src/contracts.spec.ts` |
| Worker boots; sample processor + outbox relay work | `apps/worker/test/worker.smoke.spec.ts` |
| Web health page renders live API status | `apps/web/src/pages/health.spec.tsx` |

## P1 — Identity & Access

Oracle sources were read from Moodle `MOODLE_503_STABLE` on 2026-10-22
(note: in 5.3 the tree moved under `public/`, e.g. `public/lib/tests/...`).

| # | Behaviour | Moodle oracle (file / case) | Our test | Phase | Status |
|---|-----------|-----------------------------|----------|-------|--------|
| 1 | PROHIBIT at system beats ALLOW at module (same role) | `public/lib/tests/accesslib_test.php` / `test_permission_evaluation`, `test_assign_capability` | `apps/api/test/access-capability.e2e-spec.ts` › "PROHIBIT at system beats ALLOW at module" + `src/modules/access/domain/permission.spec.ts` | P1 | ✅ |
| 2 | Leaf ALLOW cannot remove an ancestor PROHIBIT | accesslib_test / `test_permission_evaluation` | access-capability › "a leaf ALLOW cannot remove an ancestor PROHIBIT" | P1 | ✅ |
| 3 | PREVENT at parent + ALLOW at leaf ⇒ allow for that role (nearest wins) | accesslib_test / `test_permission_evaluation` | access-capability › "PREVENT at parent + ALLOW at leaf" | P1 | ✅ |
| 4 | Multi-role aggregation: ALLOW+PREVENT ⇒ allow; ALLOW+PROHIBIT (any level) ⇒ deny | accesslib_test / `test_permission_evaluation`, `test_get_users_by_capability` cross-check | access-capability › two "two roles" cases + permission.spec aggregation cases | P1 | ✅ |
| 5 | User with no role assignment is denied; assignments apply only inside their subtree | accesslib_test / `test_permission_evaluation`, `test_role_assign` | access-capability › "no role assignment is denied", "assignments only apply within their context subtree" | P1 | ✅ |
| 6 | Site admin (doanything) bypass | accesslib_test / `test_is_siteadmin` | access-capability › "site admin bypasses capability checks" | P1 | ✅ |
| 7 | Guest user evaluates through the guest role only | accesslib_test / `test_get_guest_role`, `test_isguestuser` | access-capability › "guest account evaluates through the guest role only" | P1 | ✅ |
| 8 | Changing an override/assignment changes results (dirty contexts invalidate caches) | accesslib_test / `test_role_definition_caching`, `test_assign_capability` + accesslib_clear_all_caches pattern | access-capability › "changing an override changes the result" | P1 | ✅ |
| 9 | Standard roles exist; non-admins are denied role administration | accesslib_test / `test_get_all_roles`, `test_get_archetype_roles` | access-capability › "standard Moodle roles are seeded and admin endpoints deny non-admins" | P1 | ✅ |
| 10 | Login lockout: threshold in window locks, duration applies, success resets | `public/lib/tests/authlib_test.php` / `test_lockout` | `apps/api/test/auth-flow.e2e-spec.ts` › "locks the account out after the configured number of failed attempts" (threshold/window/duration are config; the window/duration-expiry sub-cases of Moodle's test manipulate stored prefs directly — PHP detail, covered by config semantics instead) | P1 | ✅ (partial mapping, see note) |
| 11 | Credential verification accepts correct and rejects wrong passwords | authlib_test / `test_authenticate_user_login` | auth-flow › "logs in with correct credentials", "rejects a wrong password" | P1 | ✅ |
| 12 | Refresh rotation + reuse revokes the family | — (report §3.7 self-built design; Moodle has no equivalent test) | auth-flow › "rotates refresh tokens and revokes the whole family on reuse" | P1 | ✅ |
| 13 | Suspended user cannot log in; live tokens/sessions die | user_test / `test_require_active_user` + report §2#29 | auth-flow › "refuses login for suspended users…", "web session … suspend invalidates the session" | P1 | ✅ |
| 14 | Force password change on first login | report §2#3 (auth policy) | auth-flow › "enforces the force-password-change flow" | P1 | ✅ |
| 15 | Session id rotates at login (fixation) | report §2#29 | auth-flow › "web session: login rotates the session id" | P1 | ✅ |
| 16 | Login-as requires its capability and never works for plain users | report §2#29 / `moodle/user:loginas` | auth-flow › "login-as…" | P1 | ✅ |
| 16a | MFA TOTP: setup (secret shown once) → confirm activates → password login stops at an MFA challenge (short-lived scoped token, useless for regular APIs) → verify with the current ±1-step code issues the normal token pair; wrong codes are 401 and feed the login lockout; disable with a valid code and an admin reset (`moodle/user:update`) both return the user to direct login | blueprint §2#3 (Auth framework "MFA hook") + Moodle `tool_mfa` factor_totp semantics (TOTP factor must be satisfied before login completes) + authlib_test login family | auth-flow › "MFA TOTP: setup → confirm → login stops at MFA → verify admits; disable returns to direct login", "MFA TOTP: admin reset…" | P1 (addendum) | ✅ |
| 17 | Identity fields hidden without `moodle/site:viewuseridentity` | `public/lib/tests/user_test.php` / `test_search_no_identity_fields` | `apps/api/test/users-flow.e2e-spec.ts` › "hides identity fields (email)…" | P1 | ✅ |
| 18 | Deleted users: soft-delete keeps the row, identity mangled, excluded from normal use | user_test / `test_search_deleted_users` + report §2#2 | users-flow › "soft-deletes…" | P1 | ✅ |
| 19 | Username/email normalized + unique | user_test / `test_validate`, `test_clean_data` | users-flow › "normalizes username/email to lowercase…" | P1 | ✅ |
| 20 | User lifecycle events are emitted (user_created/updated/deleted) | report §3.4 (outbox) | users-flow › "emits user_created/user_deleted through the transactional outbox" | P1 | ✅ |
| 21 | Custom field categories/fields are metadata; deleting a category removes its fields | `public/customfield/tests/api_test.php` / `test_create_category`, `test_delete_category_with_fields` | `apps/api/test/custom-fields-flow.e2e-spec.ts` › "deleting a category removes its fields" + value-validation cases per type (select options, required, date, checkbox) | P1 | ✅ |
| 22 | Same content uploaded twice ⇒ one physical file, two records (dedup by content hash) | `public/lib/filestorage/tests/file_storage_test.php` / `test_create_file_from_string`, `test_get_file_by_hash` + report §3.11(2c) | `apps/api/test/files-flow.e2e-spec.ts` › "uploading identical content twice…" (hash is SHA-256 here — ADR-006) | P1 | ✅ |
| 23 | Deleting records: physical file survives until refcount 0, then cleanup removes it | file_storage_test / `test_cron`, `test_delete_area_files` + report §3.11(2c) | files-flow › "deleting one record keeps the physical file…" + `apps/worker/test/file-cleanup.spec.ts` | P1 | ✅ |
| 24 | Files are served only after a capability check on the file's context; strangers get 403 Problem Details | report §3.8/§3.11(2c) (pluginfile semantics) | files-flow › "serves content … via signed URL", "denies a stranger…" | P1 | ✅ |
| 25 | Web login stores tokens, auto-refreshes once on 401, renders profile incl. custom fields | report §3.7/§3.13 | `apps/web/src/pages/login.spec.tsx` (3 tests) | P1 | ✅ |

Skipped Moodle cases (PHP implementation details, not business behaviour):
accesslib_test's `test_get_enrolled_sql_*` family (SQL generation for enrol —
enrol arrives in P2 and will be mapped there), `test_context_*_caps_returned_*`
(capability listing per context level — presentational), authlib_test's
email-sink assertions in `test_lockout` (notification side-effect; our lockout
emits no email in P1), file_storage_test's image-conversion and
reference/alias cases (file references & image processing are plugin-level
features outside P1 scope).

## P2 — Course & Enrolment

Oracle sources were read from Moodle `MOODLE_503_STABLE` on 2026-10-22 (tree
under `public/`). Checked paths: `public/course/tests/category_test.php` ✅,
`public/course/tests/courselib_test.php` ✅, `public/group/tests/lib_test.php`
✅, `public/enrol/tests/enrollib_test.php` ✅ (enrol tests live at
`enrol/tests/`, not `lib/tests/enrollib_test.php` — that path 404s in 5.3),
`public/availability/tests/tree_test.php` ✅, `public/availability/tests/info_test.php`
✅, `public/lib/tests/completionlib_test.php` ✅ (there is no
`completion/tests/completion_test.php`; the completion API/criteria tests live
in `public/completion/tests/api_test.php` + `completion_criteria_test.php`).

| # | Behaviour | Moodle oracle (file / case) | Our test | Phase | Status |
|---|-----------|-----------------------------|----------|-------|--------|
| 26 | Category tree: create with path/depth, hierarchy, move rewrites subtree path, cycle refused | `course/tests/category_test.php` / `test_create_coursecat`, `test_hierarchy`, `test_update` | `apps/api/test/courses-flow.e2e-spec.ts` › category tree + move cases | P2 | ✅ |
| 27 | Deleting a category must state what happens to its contents (move up vs delete recursively); non-empty + no choice = error | category_test / `test_delete`, `test_get_courses_during_delete` | courses-flow › "deleting a non-empty category without an explicit mode is refused", "mode=moveup…", "mode=recursive…" | P2 | ✅ |
| 28 | Course create: unique shortname, start/end date sanity, default section 0, course context created | `course/tests/courselib_test.php` / `test_create_course`, `test_create_course_sections`, `test_course_enddate` | courses-flow › tree case, duplicate/dates case | P2 | ✅ |
| 29 | Creating a course requires the capability in the CATEGORY context | courselib_test / `test_create_course` permission paths + report §2#4 | courses-flow › "creating a course requires course:create in the CATEGORY context" | P2 | ✅ |
| 30 | Hidden course: enrolled students cannot see it; staff with viewhiddencourses can | category_test / `test_visibility`, courselib_test / `test_course_change_visibility` | courses-flow › "hidden course is invisible to an enrolled student…" | P2 | ✅ |
| 31 | cm lifecycle: create in a section, move between sections, delete emits event and dependent subsystems clean up (completion records, cm-context files) | courselib_test / `test_create_module`, `test_move_module_in_course`, `test_course_module_deleted_event_exceptions`, `test_delete_course_*` | courses-flow › "sections and cms: create, move cm…, delete cm emits cm_deleted and cleans completion + files" (cleanup via CompletionModule + FilesModule `@OnEvent('cm_deleted')` handlers) | P2 | ✅ |
| 32 | Course custom fields are metadata on the course (no business-table alter); format options stored per course/format | `course/tests/customfield_test.php` + P1 customfield api_test pattern | courses-flow › "supports course custom fields … and format options" | P2 | ✅ |
| 33 | Enrol grants a role at the course context and emits user_enrolled; enrolment and capability are independent checks | `enrol/tests/enrollib_test.php` / `test_user_enrolment_created_event`, `test_enrol_get_my_courses_only_enrolled_courses` | `apps/api/test/enrol-groups-flow.e2e-spec.ts` › "enrolling grants the student role…" (incl. outsider with virtual course:view still denied) | P2 | ✅ |
| 34 | SUSPENDED enrolment blocks course access despite the role; only a real staff course:view path (teacher assignment) is the exception; reactivation restores | report §2#5 invariant + enrollib_test suspended semantics | enrol-groups-flow › "SUSPENDED user is blocked…", "suspended user who ALSO holds a real teacher assignment…" | P2 | ✅ |
| 35 | Unenrol: enrolment + granted role removed, user_unenrolled emitted; with related data (completion) the UE row is soft-withdrawn (status=2) and the data survives | enrollib_test / `test_user_enrolment_deleted_event` + report §2#5 | enrol-groups-flow › "unenrol without related data…" + availability-completion-flow › "unenrol keeps completion data…" | P2 | ✅ |
| 36 | Group/grouping membership; deleting a group removes grouping links and members | `group/tests/lib_test.php` / `test_member_added_event`, `test_groups_delete_groupings_groups`, `test_groups_delete_groups`, `test_groups_remove_member` | enrol-groups-flow › "groups + groupings: membership, grouping links, and deleting a group cleans its links" | P2 | ✅ |
| 37 | Separate groups is a data law enforced at the server: other groups' members are 403 and absent from lists for users without accessallgroups | report §2#6 (groups_get_members_by_role / separate-groups semantics in lib_test) | enrol-groups-flow › "SEPARATE GROUPS is a server-side data law…" | P2 | ✅ |
| 38 | Cohort sync: member added ⇒ enrolled into linked courses (+ configured group), member removed ⇒ suspend (default) or unenrol (configured); instance created later syncs existing members | cohort sync semantics (enrol_cohort) + report §2#6 | enrol-groups-flow › "cohort sync: …" (both modes) + "a cohort enrol instance created AFTER users joined…" | P2 | ✅ |
| 39 | Expired enrolment (timeend past) is not active — access denied immediately; the worker sweep flips it to SUSPENDED idempotently and writes the outbox event | enrollib_test / `test_enrol_get_my_courses_by_time` | enrol-groups-flow › "expired enrolment … is not active" + `apps/worker/test/p2-jobs.spec.ts` › enrol-expiry case | P2 | ✅ |
| 40 | Self enrol instance allows self-enrolment; other methods refuse it; guest/self/guest instances exist at config level in P2 | enrollib_test / `test_enrol_selfenrol_available` | enrol-groups-flow › "self enrol instance: …" | P2 | ✅ |
| 41 | GOLDEN availability: tree semantics — AND/OR, NOT-AND/NOT-OR by De Morgan, nested & inside !| with showc, root show=false hides information, showc=false child hides everything | `availability/tests/tree_test.php` / `test_check_available` (translated scenario-by-scenario, mock conditions → leaf ids) | `apps/api/src/modules/availability/domain/availability-tree.spec.ts` (12 tests) | P2 | ✅ |
| 42 | Availability blocks at the API, not just the UI: date-locked cm 403 with show=true (listed, locked) and with show=false (unlisted, still 403); section trees gate their cms | tree_test + `availability/tests/info_test.php` (info layer enforces restriction) | `apps/api/test/availability-completion-flow.e2e-spec.ts` › date/show cases + section case | P2 | ✅ |
| 43 | Leaf combination over real data: completion leaf opens cm B only after cm A completes; group leaf AND profile leaf inside !| gate by membership; grade leaf declared, unmet without grade data (P3 hook) | tree_test nested cases + `lib/tests/completionlib_test.php` completion conditions | availability-completion-flow › completion-leaf, group-leaf-nested, grade-leaf cases | P2 | ✅ |
| 44 | completionview: viewing a cm records `viewed` and completes an automatic cm | completionlib_test / `test_set_module_viewed`, `test_update_state`, `test_internal_get_state` | availability-completion-flow › "completionview: viewing a cm records viewed and completes it" | P2 | ✅ |
| 45 | Manual completion: self-marking works; marking others needs the markothers capability | completionlib_test / `test_update_state` (overrideby paths) + `completion/tests/capabilities_test.php` | availability-completion-flow › "manual completion by a teacher for another user…" | P2 | ✅ |
| 46 | Course completion aggregates module criteria AND (method=ALL) / OR (method=ANY) and date criteria; timecompleted is stored | completionlib_test / `test_aggregate_completions`, `criteria_test` (`completion/tests/completion_criteria_test.php`), `test_mark_complete` | availability-completion-flow › aggregation + date-criterion cases | P2 | ✅ |
| 47 | Changing criteria after completion data exists triggers CONTROLLED recalculation (job enqueued; recalculation reopens a course that no longer satisfies the new criteria) | completionlib_test / `test_clear_criteria`, `test_aggregate_completions` + report §2#9 | availability-completion-flow › "changing criteria after data exists…" (API twin) + `apps/worker/test/p2-jobs.spec.ts` › completion-recalculate case (AND + tightening reopens, in the worker) | P2 | ✅ |
| 48 | Golden P2 end-to-end: category → course → section/cm → group/cohort → enrol with role → availability blocks → completion recorded | report §4 P2 DoD | availability-completion-flow › "GOLDEN end-to-end: …" | P2 | ✅ |
| 49 | Web: category tree renders with courses nested; a locked (show=true) module renders shown-but-disabled with its restriction text | report §3.13/§4 P2 (web scope) | `apps/web/src/pages/courses.spec.tsx` (2 tests) | P2 | ✅ |
| 50 | Contracts: category tree (recursive), course content with availabilityResult, enrol instance shapes parse | — (contract shape source, §3.13) | `packages/contracts/src/contracts.spec.ts` › "course contracts (P2)" | P2 | ✅ |

## P3 — Assessment (Grades / Questions / Completion-by-grade)

Oracle sources checked against Moodle `MOODLE_503_STABLE` on 2026-10-22 (tree
under `public/`):
- `public/question/engine/tests/questionusagebyactivity_test.php` ✅ VERIFIED
  live (usage groups attempts, deferredfeedback, steps, pinned questions).
- `public/lib/tests/completionlib_test.php` ✅ VERIFIED live — grade cases
  `test_internal_get_state_with_grade_criteria`, `test_inform_grade_changed`
  (deferred from P2, now implemented).
- Grade tests: the probed paths `public/grade/tests/grade_category_test.php`
  and `public/grade/tests/category_test.php` return **404** in the 5.3 tree —
  recorded honestly; the arithmetic oracle used instead is the **MoodleDocs
  "Grade aggregation" page** (the source report §2.1 itself cites), whose
  worked examples were read via the indexed MoodleDocs mirror on 2026-10-22
  and are quoted verbatim in the GradeCalculator spec.

| # | Behaviour | Moodle oracle (file / case) | Our test | Phase | Status |
|---|-----------|-----------------------------|----------|-------|--------|
| 51 | GOLDEN Natural, no weight forcing: (70+20+10)/(100+80+10) = 100/190; category max = sum of item maxes | MoodleDocs Grade_aggregation, Natural worked example (verbatim) | `apps/api/src/modules/grades/domain/grade-calculator.spec.ts` › Natural case + `test/grades-questions-flow.e2e-spec.ts` › GOLDEN via API | P3 | ✅ |
| 52 | GOLDEN extra credit: item max excluded from denominator, grade counts, total capped at category max (20 extra + 70/75 ⇒ 75/75) | MoodleDocs Grade_aggregation, Natural extra-credit example (verbatim) | grade-calculator.spec › extra credit + e2e GOLDEN extra credit | P3 | ✅ |
| 53 | GOLDEN Natural weight override: overridden weight kept, remainder redistributed to exactly 100% by relative max (25% kept; 37.5/37.5 split; total 172.5/300) | MoodleDocs Grade_aggregation Natural weighting rule + report §2.1 | grade-calculator.spec › redistribution case | P3 | ✅ |
| 54 | GOLDEN drop-the-lowest / keep-the-highest over normalised grades | report §2.1 (Moodle aggregate droplow/keephigh semantics) | grade-calculator.spec › drop/keep cases | P3 | ✅ |
| 55 | GOLDEN exclude empty grades: empty ≠ 0 — excluding empties changes the denominator (50/100 graded-only ⇒ 100/200 structural; counted as zero ⇒ 50/200) | report §2.1 + §3.11(2b) | grade-calculator.spec › exclude-empty case | P3 | ✅ |
| 56 | GOLDEN freeze with multiplicator: grade produced by a penalty multiplicator is frozen data; later formula changes do not rewrite it; unfrozen + re-entry recomputes | report §2.1/§2#7 (MDL-89497 freeze invariant) | grade-calculator.spec › freeze case + e2e › freeze flow | P3 | ✅ |
| 57 | Other strategies over the verbatim MoodleDocs set: mean 65, lowest 25, highest 100, median 70, mode 70 (mode(0.7,0.7,0.25,1.0,0.7)); weighted mean 493/6=82.167; simple weighted mean; sum legacy | MoodleDocs Grade_aggregation worked examples (verbatim) | grade-calculator.spec › strategy cases (8 tests) | P3 | ✅ |
| 58 | Recursive aggregation: subcategory totals feed the parent category and the course total; natural syncs the total item's grademax | grade_category tree semantics (report §2#7) | e2e › nested categories (mean subcat 90; course natural 150/200) | P3 | ✅ |
| 59 | Overridden grades are never recomputed by regrade; locked item/grade refuses entry; every change lands in grade_grades_history | grade_grades overridden/locked semantics (report §2#7) | e2e › override/lock/history flow | P3 | ✅ |
| 60 | Grade entry requires moodle/grade:edit at the course context; a student sees only their own book; hidden items/grades are filtered server-side for non-viewall viewers; letters apply at display time | report §2#7 + capability model (P1) | e2e › permissions/privacy + letters flows | P3 | ✅ |
| 61 | Aggregation change ⇒ bulk regrade: API enqueues the worker job, writes grade_category_aggregation_changed + grade_updated outbox records, and stored totals follow the new strategy | report §3.4/§3.5 (outbox + BullMQ) | e2e › aggregation-change chain + `apps/worker/test/p3-jobs.spec.ts` › grade-regrade (100/190 recomputed, history written, idempotent) | P3 | ✅ |
| 62 | Question bank versioning: editing creates a NEW version and bumps the entry's latest pointer; previous versions are immutable | question bank versioning (report §2#8) | e2e › bank versioning flow (v1 intact after edit to v2) | P3 | ✅ |
| 63 | INVARIANT: an attempt started on version X is graded by X after the question is edited to version Y; a new usage pins Y and grades differently; every transition is a step with step_data | `question/engine/tests/questionusagebyactivity_test.php` / usage+attempt lifecycle, deferredfeedback | e2e › INVARIANT flow (steps todo→complete→gradedright; new usage gradedwrong) + `src/modules/questions/domain/question-engine.spec.ts` | P3 | ✅ |
| 64 | completionusegrade runs for real: grade ≥ gradepass ⇒ COMPLETE_PASS (2), below ⇒ COMPLETE_FAIL (3), no grade ⇒ incomplete; grade changes update it both ways | completionlib_test grade cases (deferred from P2 case 43) | e2e › CHAIN flow (0 → 3 → 2) | P3 | ✅ |
| 65 | Availability `grade` leaf evaluates against real grade percentages; regrade keeps completion/availability consistent: chain grade → completion → gated cm opens | completionlib_test + availability grade condition (report §2#9/#10) | e2e › CHAIN flow (403 → 403 → 200) | P3 | ✅ |
| 66 | Course completion 'grade' criterion: course completes only when the course total reaches the course item's gradepass (API + worker recalculation agree) | completionlib_test / `test_get_grade_completion*` family (deferred from P2) | e2e › course grade criterion + p3-jobs › completion grade criterion | P3 | ✅ |
| 67 | Web: gradebook renders the category/item tree with grades + letters + teacher report + grade entry; question bank shows the version badge (edit bumps v1→v2); usage view shows attempt states/steps/pinned version | report §4 P3 web scope | `apps/web/src/pages/grades.spec.tsx` (3 tests) | P3 | ✅ |
| 68 | Contracts: gradebook tree (recursive) with letters, question usage with pinned version + steps parse and reject bad shapes | — (contract shape source, §3.13) | `packages/contracts/src/contracts.spec.ts` › "assessment contracts (P3)" (2 tests) | P3 | ✅ |
| 68a | Grade outcomes (addendum, was deferred below): outcomes are qualitative scales at site (courseid=null) or course scope, CRUD under `moodle/grade:manage`; an item linked to an outcome stores its grade as the 1-based scale index, is refused out-of-scale grades (400 `grades.outcome_grade_out_of_scale`), does NOT enter numeric category aggregation (same rule as scale items), and appears in gradebook + teacher report with its scale label (`scaleValue`) | Moodle grade outcomes + `grade/tests/behat/grade_scales.feature` scale semantics | grades-questions-flow › "grade outcomes: …" + `apps/worker/test/grade-jobs.spec.ts` › outcome/scale exclusion in regrade | P3 | ✅ |
| 68b | Calculated grade items (addendum, was deferred below): itemtype `calculated` with a Moodle formula (`=sum/average/min/max([[idnumber]],…)`, `+ - * /`, parentheses, safe recursive-descent parser — no eval); unknown idnumber ⇒ 400 at save time, circular references ⇒ 400 at save time, unsupported functions ⇒ 400; division by zero ⇒ null; the calculated result (clamped to the item's grademin/grademax) feeds category/course aggregation like a regular grade in BOTH the API regrade and the worker regrade twin | MoodleDocs "Grade calculations" (docs.moodle.org, read online 2026-10-23; worked examples `=average([[1]],[[2]],[[3]])`, `=sum([[1]]*0.3,[[2]]*0.6,[[3]]*0.1)`, `=max([[A]],[[B]],100)` quoted in the spec) | `apps/api/src/modules/grades/domain/grade-formula.spec.ts` (11 golden tests) + grades-questions-flow › calculated flows (course total 210/300, category total 280/400) + grade-jobs › worker calculated regrade | P3 | ✅ |

Skipped / deferred Moodle cases for P3 (with reasons):
- qtype plugins (multichoice, essay, …) and behaviours other than
  deferredfeedback (interactive, adaptive, CBM) — plugins/extension points
  by design (report §2#8); the engine ships the behaviour INTERFACE plus the
  one core behaviour, and data-level truefalse/shortanswer so the engine
  runs end-to-end.
- Grade outcomes and calculated grade items (formulas) were deferred in
  the original §4 P3 scope and are NOW IMPLEMENTED as the addendum in rows
  68a/68b above. Remaining formula gaps, recorded honestly: Moodle's extra
  functions `power`, `round`, `mod`, `pi` and conditional `if` are NOT
  supported — using one is refused at save time with 400
  `grades.calculation_unknown_function` rather than silently miscomputed;
  only `sum`/`average`/`min`/`max`, `+ - * /`, parentheses and unary minus
  are supported. A formula referencing a category/course TOTAL item reads
  that total's currently stored value (totals are recomputed after
  calculated items in the same pass). Scale-based aggregation remains out
  of scope: scales back an item's gradetype and scale/outcome items do not
  enter numeric aggregation.
- grade/tests PHPUnit files could not be located at the probed 5.3 paths
  (404s recorded above); aggregation arithmetic is oracle-checked against
  MoodleDocs' own worked examples instead, quoted verbatim in the spec.

## P4 — Communication & Engagement (Messaging / Calendar / Badges / Competencies / Social)

Oracle sources checked against Moodle `MOODLE_503_STABLE` on 2026-10-22 (tree
under `public/`), read live from raw.githubusercontent.com:
- `public/message/tests/api_test.php` ✅ VERIFIED (blocked users, mark-all-read,
  individual/group conversation types).
- `public/calendar/tests/lib_test.php` ✅ VERIFIED (`test_add_subscription`,
  `test_get_legacy_events_with_overrides`, `test_update_subscription`);
  `public/calendar/tests/event_test.php` ✅ (getters only);
  `public/calendar/tests/api_test.php` **404** in the 5.3 tree — recorded.
- `public/badges/tests/badgeslib_test.php` ✅ VERIFIED (`test_create_badge_criteria`,
  `test_badge_awards`, `test_clone_badge`, `test_delete_badge` = archive).
- `public/competency/tests/api_test.php` ✅ VERIFIED (plan review family,
  evidence family, `test_create_plan_from_template`, `test_create_template_cohort`,
  `test_set_ruleoutcome_course_competency`, `test_observe_course_completed`,
  `test_validate_grade_in_user_competency`, `test_list_frameworks`).
- `public/tag/tests/taglib_test.php` ✅ VERIFIED (`test_add_remove_item_tag`,
  `test_add_tag_ordering_calculation`).
- `public/comment/tests/externallib_test.php` ✅ VERIFIED (`test_get_comments`,
  `test_add_comments_single`); `comment/tests/comment_test.php` and
  `lib/tests/comment_test.php` **404** — recorded.
- `public/rating/tests/rating_test.php` ✅ VERIFIED (`test_get_ratings_sql` —
  aggregation numbers (1,3)→2, (1,4)→2.5, (3,5)→4).
- `public/blog/tests/lib_test.php` ✅ VERIFIED (`test_overrides` listing
  filters); `blog/tests/bloglib_test.php`, `blog_test.php`, `external_test.php`
  **404** — recorded.
- `public/notes/tests/lib_test.php` ✅ VERIFIED but navigation-only;
  `notes/tests/notes_test.php` **404** — note visibility law follows report
  §2#16 + the P4 spec instead (recorded, not invented).

| # | Behaviour | Moodle oracle (file / case) | Our test | Phase | Status |
|---|-----------|-----------------------------|----------|-------|--------|
| 69 | Messaging: individual conversation exchange, unread counts per member, mark-read clears only the reader's count | `message/tests/api_test.php` (conversation + mark-all-read family) | `apps/api/test/messaging-calendar-flow.e2e-spec.ts` › conversation exchange | P4 | ✅ |
| 70 | INVARIANT: after sending, the sender cannot edit or delete a message — API refuses (403 `messaging.message_immutable`) | report §2#12 | messaging-calendar-flow › message immutability | P4 | ✅ |
| 71 | A blocked contact cannot send you messages (403 `messaging.contact_blocked`) | `message/tests/api_test.php` / blocked-users family | messaging-calendar-flow › blocked contact | P4 | ✅ |
| 72 | Suspended users receive nothing: direct message refused, system notification stores nothing | report §2#12 | messaging-calendar-flow › suspended recipient | P4 | ✅ |
| 73 | Notification preferences gate dispatch per (provider × channel × loggedin/loggedoff): popup off ⇒ nothing stored; dispatch log records `skipped-preference`; email stays a queued port | `message/tests/api_test.php` (preferences) + report §2#12 | messaging-calendar-flow › preference gating (P4 DoD) | P4 | ✅ |
| 74 | Worker dispatch re-checks suspension + preferences at dispatch time and is idempotent by dedupekey (`duplicate` on replay) | report §2#12/§3.5 | `apps/worker/test/p4-jobs.spec.ts` › dispatch tests | P4 | ✅ |
| 75 | Calendar visibility matrix: site = everyone, user = owner only, course = actively enrolled, category = learners of its courses | `calendar/tests/lib_test.php` + report §2#13 | messaging-calendar-flow › visibility matrix | P4 | ✅ |
| 76 | DoD: group events are visible only to group members (and course staff) | `calendar/tests/lib_test.php` / `test_get_legacy_events_with_overrides` | messaging-calendar-flow › group event DoD | P4 | ✅ |
| 77 | Series: FREQ=WEEKLY + COUNT materialises occurrences sharing `repeatid`; an exception row replaces its occurrence in listings; deleting the root deletes the series | `calendar/tests/lib_test.php` (repeat semantics) + report §2#13 | messaging-calendar-flow › series + exception | P4 | ✅ |
| 78 | Subscriptions import ICS in the worker with Moodle-shaped counts `{eventsimported, eventsskipped, eventsupdated, eventsdeleted}` and dedupe on (subscription, UID); reminders become notifications exactly once | `calendar/tests/lib_test.php` / `test_add_subscription` | messaging-calendar-flow › subscription + reminder scheduling; p4-jobs › import + reminder tests | P4 | ✅ |
| 79 | Badges: criteria tree (overall ALL/ANY + leaves); activation without criteria refused; criteria of an ACTIVE badge are frozen (403 `badges.criteria_frozen`) | `badges/tests/badgeslib_test.php` / `test_create_badge_criteria` | `apps/api/test/badges-competency-flow.e2e-spec.ts` › criteria ALL + freeze | P4 | ✅ |
| 80 | Auto-award: completing the criteria (course + activity completion via completion hooks; competency proficiency via review event) issues an immutable assertion once + `badge_awarded` notification; criteria freeze after issuance; duplicate is the sanctioned edit path; revoke keeps the assertion row | `badgeslib_test.php` / `test_badge_awards`, `test_clone_badge`, `test_delete_badge` (delete = archive) | badges-competency-flow › auto-award + competency-leaf + revoke tests | P4 | ✅ |
| 81 | Manual award requires `moodle/badges:awardbadge` at the badge context AND a manual criterion leaf; denial and success both asserted | `badgeslib_test.php` (manual award rules) | badges-competency-flow › manual award | P4 | ✅ |
| 82 | Worker badge evaluation is the idempotent twin of the API evaluator: course-completion badge issued exactly once, ALL with an unmet leaf issues nothing | `badgeslib_test.php` / awards | p4-jobs › badge auto-award | P4 | ✅ |
| 83 | Competency course links carry an explicit ruleoutcome: `complete` sets scale proficiency on course completion; `attach-evidence` writes evidence ONLY (proficiency stays null — grades/evidence never imply proficiency) | `competency/tests/api_test.php` / `test_set_ruleoutcome_course_competency`, `test_observe_course_completed` | badges-competency-flow › ruleoutcomes | P4 | ✅ |
| 84 | Templates + template cohorts generate one active plan per cohort member, idempotently, with plan competencies materialised | `competency/tests/api_test.php` / `test_create_plan_from_template`, `test_create_template_cohort` | badges-competency-flow › template+cohort | P4 | ✅ |
| 85 | DoD: plan review lifecycle draft → active → waitingforreview → inreview → (approve ⇒ active) → complete, every transition in the review history; request from draft refused | `competency/tests/api_test.php` / plan review family (`test_plan_request_review`, `test_plan_start_review`, `test_approve_plan`, `test_complete_plan`, …) | badges-competency-flow › plan lifecycle | P4 | ✅ |
| 86 | User-competency review: evidence + send-for-review → start → reject keeps proficiency unset; re-request → approve with a scale grade sets proficiency; grade outside the framework scale refused (400) | `competency/tests/api_test.php` / evidence family + `test_validate_grade_in_user_competency` | badges-competency-flow › usercomp review | P4 | ✅ |
| 87 | Tags are polymorphic: the same API tags a course and a blog post; ordering is per item and restarts at 1; correlations link co-occurring tags across items; unregistered areas refused | `tag/tests/taglib_test.php` / `test_add_remove_item_tag`, `test_add_tag_ordering_calculation` | `apps/api/test/social-flow.e2e-spec.ts` › tags | P4 | ✅ |
| 88 | Comments are polymorphic with per-context capabilities: same API on a course item and a blog post; non-members cannot post at a course context; only author/manager deletes | `comment/tests/externallib_test.php` / `test_get_comments`, `test_add_comments_single` | social-flow › comments | P4 | ✅ |
| 89 | Ratings aggregate over the item ONLY with the oracle's exact numbers (1,3)→2, (1,4)→2.5, (3,5)→4, count 2; re-rating replaces; out-of-scale refused; individual list needs the separate `viewall` capability | `rating/tests/rating_test.php` / `test_get_ratings_sql` | social-flow › ratings | P4 | ✅ |
| 90 | Blog: drafts are author-only; public posts are site-visible; a course association narrows the audience to actively enrolled members | `blog/tests/lib_test.php` / `test_overrides` (listing filters) | social-flow › blog | P4 | ✅ |
| 91 | Notes: draft = creator only; course (`public`) notes are visible to the course's teachers — NOT to fellow students and NOT to the subject; enforced on list and direct fetch | report §2#16 + P4 spec (notes PHPUnit oracle is navigation-only in 5.3, recorded above) | social-flow › notes | P4 | ✅ |
| 92 | Web: messages inbox, notification centre + preference toggles (toggle ⇒ PUT with flipped value), calendar month + type filter, my badges render incl. revoked assertions, learning plan + review requests, blog with integrated tag/comment/rating | report §4 P4 web scope | `apps/web/src/pages/engagement.spec.tsx` (2 tests) + pages messages/notifications/calendar/badges/learning-plan/blog | P4 | ✅ |
| 93 | Contracts: engagement schemas (conversation, notification, preference, calendar event, badge, issued badge, plan, user competency, rating aggregate, note) parse and reject impossible shapes | — (contract shape source, §3.13) | `packages/contracts/src/contracts.spec.ts` › "engagement contracts (P4)" (3 tests) | P4 | ✅ |

Skipped / deferred Moodle cases for P4 (with reasons):
- `badge_backpack` (Open Badges backpack connect / external assertion
  hosting) — an external service integration; the report §4 table lists it
  as a port, out of P4 scope. Assertions are stored locally with a stable
  sha256 `uniquehash` so a backpack port can be added without data change.
- Real email/push delivery — by spec (§2#12) these channels are PORTS in
  P4: the worker writes the dispatch log (`logged` / `skipped-*`) and no
  mail leaves the system. Popup (in-app) is the only real channel.
- Full RRULE grammar (BYDAY/BYSETPOS/BYMONTHDAY sets, timezones) — only
  FREQ=DAILY|WEEKLY|MONTHLY + COUNT/UNTIL are ported, matching Moodle's own
  simple repeat model (repeatid + exception events); arbitrary RFC 5545
  rules in subscriptions are imported as their concrete VEVENTs instead.
- Competency points-based rules (`competency_rule_*`) and framework
  duplication/import-export — outside the §4 P4 scope; plan completion here
  is the explicit lifecycle + review flow that the DoD names.
- Tag administration extras (flagging, official-tag management UI, tag
  cloud blocks) — the data law (areas, instances, ordering, correlations)
  is ported; admin curation screens are presentation-layer extras.
- Message search, conversation starring/muting, group-conversation creation
  from course groups — conversation types (individual/group) and the
  blocked/suspended laws are ported; these are UX extras over the same
  tables.
- The 404 oracle files listed above (`calendar/tests/api_test.php`,
  `comment/tests/comment_test.php`, `blog/tests/{bloglib,blog,external}_test.php`,
  `notes/tests/notes_test.php`) — behaviour for those areas was taken from
  the verified sibling files + report §2 rows, and that substitution is
  recorded per row above rather than silently assumed.

## P2 skipped / deferred (recorded at P2 time)

Skipped / deferred Moodle cases for P2 (with reasons):
- courselib_test's backup/restore-coupled deletion cases
  (`test_course_not_deleted_if_backup_process_pending`, async deletion
  dispatch) — Backup is P5; P2 course delete is synchronous.
- Groups conversation/messaging cases in lib_test
  (`test_groups_create_group_with_conversation`, `*_conversation_*`) —
  Messaging is P4; groups carry no conversation in P2.
- `test_groups_create_autogroups` — auto-group creation is a bulk admin
  utility, not part of the P2 group data law; not ported.
- enrollib_test's plugin-data validation cases
  (`test_validate_enrol_plugin_data`, `test_update_enrol_plugin_data`) —
  PHP plugin-field plumbing; our instance config is a typed DTO validated by
  class-validator instead.
- completionlib_test's grade-state cases
  (`test_internal_get_state_with_grade_criteria`, `test_inform_grade_changed`,
  `test_get_grade_completion*`) — gradebook is P3; P2 declares
  completionusegrade and the grade availability leaf, both evaluating as
  unmet without grade data (covered by case 43's grade-leaf test).
- tree_test's SQL-generation cases (`test_get_user_list_sql`,
  `test_unique_sql_parameter_behaviour`) — PHP/SQL implementation details;
  our evaluator is a registered-leaf async evaluator, tested by truth table.
- info_test's display-string cases — presentation; our API returns
  structured `failedDescriptions`, asserted in cases 42/49 instead.

## P5 — Platform Services (Search / Web Services / Backup / Analytics / Report Builder / Content Bank / Payment / Privacy)

Oracle sources checked against Moodle `MOODLE_503_STABLE` on 2026-10-22 (tree
under `public/`), verified live via raw.githubusercontent.com / GitHub API:
- `public/search/tests/manager_test.php` ✅, `public/search/tests/base_test.php` ✅
  (area registry + document/access semantics).
- `public/webservice/tests/externallib_test.php` ✅ (service/token model);
  `public/lib/tests/externallib_test.php` ✅.
- Backup: `public/backup/tests/backup_test.php` and `restore_test.php` return
  **404** in the 5.3 tree — recorded honestly; the backup oracle used instead is
  `public/backup/tests/backup_restore_permission_test.php` ✅,
  `backup_restore_base_testcase.php` ✅, `async_backup_test.php` /
  `async_restore_test.php` ✅ (plan steps + restore id mapping family).
- `public/analytics/tests/model_test.php` ✅, `prediction_test.php` ✅,
  `indicator_test.php` ✅ (`insights_test.php` **404** — recorded).
- `public/reportbuilder/tests/manager_test.php` ✅, `permission_test.php` ✅,
  `datasource_test.php` ✅.
- `public/contentbank/tests/contentbank_test.php` ✅, `content_test.php` ✅.
- Payment: `public/payment/tests/helper_test.php` ✅, `generator_test.php` ✅
  (the probed `payment/tests/privacy/provider_test.php` is **404** — recorded).
- Privacy: `public/privacy/tests/manager_test.php` ✅ (request lifecycle +
  approval), `collection_test.php` ✅, `contextlist_test.php` ✅
  (`privacy/tests/provider_test.php` **404** at that exact path — recorded;
  provider behaviour follows report §2#28 + the manager/collection files).

| # | Behaviour | Moodle oracle (file / case) | Our test | Phase | Status |
|---|-----------|-----------------------------|----------|-------|--------|
| 94 | Search: areas register into a registry (courses, users, contentbank, blog); results are filtered by the searcher's capability AT QUERY TIME via PermissionEvaluator, with a re-check against the live record — a user with PROHIBIT at the document context finds nothing even when a stale index entry points at that context | `search/tests/manager_test.php` + `base_test.php` (area/access family) + report §2#17 | `apps/api/test/platform-search-webservice-flow.e2e-spec.ts` › search DoD (PROHIBIT + stale index + enrolled-found) | P5 | ✅ |
| 95 | Search: documents of a suspended/deleted user leave the index (area fetch returns null after suspension; purge by owner) | report §2#17 (deleted/suspended documents exit the index via events) | platform-search-webservice-flow › suspended user document leaves the index; `apps/worker/test/p5-jobs.spec.ts` › search reindex (idempotent, no duplicates) | P5 | ✅ |
| 96 | Web Services: a service is a set of registered functions, each declaring a required capability + context resolver; a token is bound to user+service, stored only as a hash, with expiry/IP restriction/revocation — and a token NEVER bypasses its owner's capability (student token calling a teacher-capability function ⇒ 403) | `webservice/tests/externallib_test.php` + report §2#21 | platform-search-webservice-flow › webservice DoD (view ok, grade:edit 403, revoked 401, raw token never listed, manage capability gates admin API) | P5 | ✅ |
| 97 | Backup→Restore DoD: backup plan runs contributor steps (courses, enrol, groups, grades, completion, files) into a versioned own-format archive (`lms-backup` v1, ADR-007, NOT .mbz); restore as a new course matches the equivalence checklist (sections/cms/enrol instances/enrolments/grades/cm completion), every id is remapped through backup_id_mappings (newid ≠ oldid), and a restored file downloads via a signed URL in the new course; merge mode also works | `backup/tests/backup_restore_permission_test.php` + `backup_restore_base_testcase.php` (plan + id mapping family) + report §2#22/§5 | platform-backup-payments-privacy-flow › backup DoD (checklist + mappings + signed download + merge) | P5 | ✅ |
| 98 | Backup anonymize option scrubs user identities from exported enrol/grades/completion data (userid → 0 in the archive; restore skips anonymized rows) | report §2#22 (anonymize setting) | platform-backup-payments-privacy-flow › backup anonymize | P5 | ✅ |
| 99 | Worker backup builds the same versioned archive with contributor steps idempotently, and the worker restore copies sections to a target course writing id mappings | report §3.5/§4 P5 (multi-step BullMQ jobs) | p5-jobs › backup processor + restore processor | P5 | ✅ |
| 100 | Analytics: models/indicators are code-registered providers; the minimal real "students at risk" model (no recent access + low grade from grades/event read models) creates predictions and insights ONLY for recipients with `moodle/analytics:viewinsights` at the course context; a run changes neither grades nor enrolments | `analytics/tests/model_test.php` + `prediction_test.php` + report §2#23 | platform-search-webservice-flow › analytics (teacher insight, student sees none, no side-effects); p5-jobs › analytics run (prediction + insight, grade untouched) | P5 | ✅ |
| 101 | Report Builder DoD: permission to view = audience ∩ per-row context rights — a report whose audience includes user A never leaks rows of a course A has no rights in, even with an empty filter (A sees only their own rows); non-audience users get 403 | `reportbuilder/tests/permission_test.php` + `manager_test.php` + report §2#24 | platform-search-webservice-flow › reports DoD | P5 | ✅ |
| 102 | Report schedules run in the worker/API twin under the CREATOR's identity with rights at run time, store the result on the schedule, and notify the creator through MessagingModule | report §2#24 (scheduled reports run as their creator) | platform-search-webservice-flow › schedule part; p5-jobs › report schedule processor (ranAs = creator, notification stored) | P5 | ✅ |
| 103 | Content Bank: content belongs to a context with an author and draft/public state, its file goes through FilesModule, and view/edit use the DEDICATED contentbank capabilities — a draft is author-only, a public item needs `moodle/contentbank:viewcontent`, and publishing syncs the search index | `contentbank/tests/contentbank_test.php` + `content_test.php` + report §2#25 | platform-search-webservice-flow › content bank (draft hidden, upload, public + signed URL, search finds it) | P5 | ✅ |
| 104 | Payments DoD: amounts are integers in the smallest currency unit + currency code; a succeeded payment is immutable and a refund is a separate compensating row; the gateway webhook is idempotent by external transaction id — a replay is flagged duplicate, emits no second PaymentSucceeded and does NOT activate a fee enrolment twice (exactly one enrolment) | `payment/tests/helper_test.php` + report §2#27 | platform-backup-payments-privacy-flow › payments DoD (fee enrol blocked before payment, active after, replay duplicate, refund row, amount unchanged); p5-jobs › payment webhook twin (one outbox event on replay) | P5 | ✅ |
| 105 | Fee enrol: an enrol instance with cost + currency + payment account only activates after a verified PaymentSucceeded; direct self-enrol into a fee instance is refused (400 `enrol.payment_required`) | report §2#27 (benefiting business activates only via verified payment event) | platform-backup-payments-privacy-flow › payments DoD (early self-enrol 400, enrolments/me inactive → active) | P5 | ✅ |
| 106 | Privacy completeness GATE: every existing business subsystem has a registered PrivacyProvider (metadata + export + delete) in the inverted registry; the completeness check lists any missing subsystem and fails the flow | `privacy/tests/manager_test.php` + `collection_test.php` + report §2#28/§3.12 | platform-backup-payments-privacy-flow › privacy completeness (EXPECTED_PRIVACY_SUBSYSTEMS ⊆ registry, `/privacy/completeness` complete=true) | P5 | ✅ |
| 107 | Privacy DoD: an approved export bundles data per subsystem with a manifest stored through FilesModule; an approved delete propagates to EVERY registered subsystem (enrolments, grades and completion of the user are gone, the user is anonymized/soft-deleted); only an admin with the privacy manage capability may approve — the requester cannot approve their own request (403) | `privacy/tests/manager_test.php` (request lifecycle + approval) + report §2#28 | platform-backup-payments-privacy-flow › privacy DoD (export subsystems + file, self-approve 403, delete propagation); p5-jobs › privacy processor (export manifest + delete anonymizes) | P5 | ✅ |
| 108 | Web: global search (permission-filtered results), integration token admin, backup/restore (create job, steps, restore), teacher insights, report builder (datasource/column, run, schedule), content bank (list by context, upload), privacy requests (self-service export/delete + admin approval) | report §4 P5 web scope | `apps/web/src/pages/platform.spec.tsx` (2 tests: search renders only returned results; privacy export request posts and shows pending) + pages in `apps/web/src/pages/platform.tsx` | P5 | ✅ |
| 109 | Contracts: platform schemas (search document, external token creation, backup job + id mapping that rejects keeping the original id, insight, report, content bank, integer-amount payment, privacy request) parse and reject impossible shapes | — (contract shape source, §3.13) | `packages/contracts/src/contracts.spec.ts` › "platform contracts (P5)" (3 tests) | P5 | ✅ |

Skipped / deferred Moodle cases for P5 (with reasons):
- Real payment gateways (Stripe/PayPal/etc.) — gateway-specific plugins by
  design (report §2#27); the framework ships the gateway PORT plus the
  manual/fake adapter used by tests, exactly the frame Moodle itself ships.
- A separate search engine (Solr/Elasticsearch) — engine-specific backends
  are replaceable by design (§2#17); the shipped adapter is Postgres
  tsvector over `search_documents`, behind the `SEARCH_ENGINE` port.
- Restore of question bank / badges / calendar content and site-level
  (non-course) backup — the contributor registry is the extension point;
  P5 contributors cover the DoD checklist subsystems (courses/sections/cm,
  enrol, groups, grades, completion, files). Restore into an existing
  course supports the three explicit modes (new/merge/replace); replace
  clears the target's sections/enrol/grades/completion/groups first.
- Analytics model training/evaluation lifecycle (train/evaluate/deploy) —
  §2#23 lifecycle beyond the minimal real model: P5 ships the registered
  model + indicators + prediction/insight generation; no prediction ever
  mutates grades or enrolments (asserted in cases 100).
- Privacy export file is a single JSON bundle per request (manifest +
  per-subsystem data) stored via FilesModule; per-subsystem separate files
  in a zip archive are a packaging extra over the same provider data.
- The 404 oracle files recorded above (`backup/tests/{backup,restore}_test.php`,
  `analytics/tests/insights_test.php`, `payment/tests/privacy/provider_test.php`,
  `privacy/tests/provider_test.php`) — behaviour was taken from the verified
  sibling files + report §2 rows, and that substitution is recorded here
  rather than silently assumed.

## Addendum — platform standards sync (i18n + Zod-only validation)

The cross-cutting standards from the decision log (report §3.10) were applied
to the platform services scope in the same delivery:

- **i18n foundation** — official `@nestjs/i18n` pinned exact 0.0.1
  (ADR-008): catalogs `apps/api/src/i18n/{vi,en}/{errors,validation,platform}.json`
  (53 error codes of the platform scope), resolvers Query → Header('x-lang') →
  Accept-Language → Cookie, `missingKey` throw/fallback; worker catalog copy +
  explicit-locale translation for the scheduled-report notification;
  frontend i18next resources in `apps/web/src/i18n.ts` (vi default).
  Tests: `apps/api/test/platform-i18n-flow.e2e-spec.ts` (token capability 403
  detail in vi by default / en with `Accept-Language: en`; payments Zod
  validation messages localized both ways), worker catalog parity test in
  `apps/worker/test/platform-jobs.spec.ts`.
- **Zod-only validation** (ADR-009): all request DTOs of search, web
  services, backup, analytics, reports, content bank, payments and privacy
  are Zod schemas from `packages/contracts` bound via the `schema` parameter
  option and the global `I18nStandardSchemaValidationPipe`; server-side
  extensions: privacy `userid` (admin-only), search raw indexing fields.
  Issue-code → catalog-key mapping lives in the api `validation.json`
  catalogs. Tests: schema cases in `packages/contracts/src/contracts.spec.ts`
  (strict objects reject unknown fields; integer smallest-unit amounts;
  restore modes; report datasources).
- **Conventions recorded**: ADR-008 (i18n), ADR-009 (Zod-only), ADR-010
  (business naming + repo hygiene, with `scripts/check-repo-hygiene.mjs`),
  ADR-011 (business-flow-test acceptance), ADR-012 (latest-first versions);
  README conventions section updated to match.

## Oracle types for the platform flow tests (PHPUnit vs Behat)

Per the testing documentation of Moodle (moodledev.io Testing), PHPUnit is
the oracle for business rules, while Behat `.feature` files hold the
user-journey acceptance scenarios. Every platform flow test below names its
oracle type explicitly. Behat steps tied to the PHP UI (header search box,
breadcrumbs, fieldsets, autocomplete pickers, action menus, dialogues, bulk
checkboxes) are UI implementation details and were skipped, exactly like
PHP-implementation-bound PHPUnit cases; only business steps and expected
outcomes were translated into HTTP (Supertest) tests.

| Flow test | Oracle type | Oracle source (verified live 22/10/2026 on MOODLE_503_STABLE) |
|---|---|---|
| `platform-search-webservice-flow.e2e-spec.ts` — search PROHIBIT + stale-index re-check | PHPUnit | `search/tests/manager_test.php`, `search/tests/base_test.php` |
| same file — webservice token cannot bypass owner capability | PHPUnit | `webservice/tests/externallib_test.php` |
| same file — content bank draft/public by dedicated capability | PHPUnit | `contentbank/tests/contentbank_test.php` |
| same file — students-at-risk insights, no grade/enrol side-effect | PHPUnit | `analytics/tests/model_test.php`, `analytics/tests/prediction_test.php` |
| same file — report audience ∩ per-row context rights; schedule runs as creator | PHPUnit | `reportbuilder/tests/manager_test.php`, `reportbuilder/tests/permission_test.php` |
| `platform-backup-payments-privacy-flow.e2e-spec.ts` — backup→restore checklist + id mapping | PHPUnit | `backup/tests/backup_restore_permission_test.php`, `backup/tests/backup_restore_base_testcase.php` (the initially guessed `backup/tests/backup_test.php` and `backup/tests/restore_test.php` return 404) |
| same file — payments integer amounts, webhook replay idempotency, refunds | PHPUnit | `payment/tests/helper_test.php`, `payment/tests/generator_test.php` |
| same file — privacy registry completeness, export/delete propagation | PHPUnit | `privacy/tests/manager_test.php`, `privacy/tests/collection_test.php` |
| `platform-i18n-flow.e2e-spec.ts` — localized error detail + validation messages | Decision-log standard (§3.10), no Moodle oracle | Project convention (ADR-008/ADR-009); behaviour asserted in vi (default) and en |
| `platform-user-journeys-flow.e2e-spec.ts` — search journey: matching query returns visible matches, non-matching query returns none | Behat | `search/tests/behat/search_query.feature` — scenario "Search from search page with two results" |
| same file — user-picker scoping by course | Behat (SKIPPED as UI detail) | `search/tests/behat/search_by_user.feature` — scenario "As student, cannot see users on other courses": the expectation binds to the PHP search form's course-scoped autocomplete; the API-level business rule (user documents filtered by `moodle/user:viewdetails` at the user context) is covered by the PHPUnit-derived search flow test above |
| same file — restore into an existing course keeps the target identity and gains the source content; restore as new copies exactly the source structure | Behat | `backup/util/ui/tests/behat/restore_moodle2_courses.feature` — scenarios "Restore a course in another existing course" and "Restore a course in a new course" (the `.mbz` filename, blocks and format settings in the scenarios are Moodle-format/UI details and were skipped; content and section-count expectations were kept) |
| same file — two users submit export requests; officer sees both awaiting approval; approving completes them, denying rejects | Behat | `admin/tool/dataprivacy/tests/behat/manage_data_requests.feature` — scenarios "Bulk accepting requests" and "Bulk denying requests" (bulk selection on the UI translated into per-request decisions through the API; the "general enquiry" message requests of the first scenario are a separate request type not implemented here and were skipped) |

## Behat retro-audit of the older modules (cleanup round, 2026-10-22)

Oracle types, stated once for the older sections above: every row in the
P1–P4 sections cites a Moodle **PHPUnit** file/case (oracle type: PHPUnit)
unless the row itself says otherwise; the platform section further down
already types its rows individually. This round re-audited the older modules
against the **Behat** features of `MOODLE_503_STABLE` (tree under `public/`,
same note as the P1 section) to catch end-to-end journeys the PHPUnit-derived
tests had not covered. Behat steps bound to the PHP UI (clicks, forms, page
text) were skipped per the standing convention; only business steps and
expected outcomes were translated into Supertest e2e.

Feature files examined per module: course (59), grade (46), badges (17),
message (16), admin/tool/lp learning plans (12), calendar (9), completion
(15), enrol/self (4), enrol/manual (3), enrol/cohort (2), group (6),
user (~40, sampled), question bank (sampled).

### Coverage by flow file after this audit

| Our flow test | Oracle type of pre-existing rows | Behat retro status |
|---|---|---|
| `access-capability.e2e-spec.ts`, `auth-flow.e2e-spec.ts`, `users-flow.e2e-spec.ts`, `custom-fields-flow.e2e-spec.ts` | PHPUnit (accesslib/authlib/user tests) | Audited against user/auth Behat features (addnewuser, delete_users, custom_profile_fields, edituserpassword): journeys already covered; remaining scenarios are profile-page UI |
| `courses-flow.e2e-spec.ts`, `enrol-groups-flow.e2e-spec.ts` | PHPUnit (course/category/group/enrol tests) | Audited; one journey added below (cohort → group); gaps recorded below |
| `availability-completion-flow.e2e-spec.ts` | PHPUnit (completionlib, availability tests) | Audited against completion features (activity_completion_criteria, enable_completion_on_view_and_grade, teacher_manual_completion): covered |
| `grades-questions-flow.e2e-spec.ts` | PHPUnit (gradebook, question engine tests) | Audited; one journey added below (grade scales) |
| `messaging-calendar-flow.e2e-spec.ts` | PHPUnit (message api_test, calendar tests) | Audited; one journey added below (event deletion); divergences recorded below |
| `badges-competency-flow.e2e-spec.ts` | PHPUnit (badgeslib, competency api_test) | Audited; one journey added below (badge-requires-badge); gaps recorded below |
| `social-flow.e2e-spec.ts`, `files-flow.e2e-spec.ts` | PHPUnit (taglib, comment, rating, blog, file tests) | Not Behat-audited this round — no dedicated core Behat suites drive these APIs beyond UI pages; marked explicitly as unaudited rather than implied covered |

### Journeys added from Behat scenarios (`apps/api/test/behat-retro-flow.e2e-spec.ts`)

| Behat oracle (feature / scenario) | Our added test |
|---|---|
| `enrol/cohort/tests/behat/enrolcohorts.feature` / "Course cohort enrolment creates a new group" — adapted: this system references an existing group on the instance (`groupId`) instead of creating one during sync | "cohort enrolment places synced members into the instance group" |
| `badges/tests/behat/criteria_*.feature` family (criteria tree semantics) — the `badge` leaf of our criteria evaluator had no e2e | "badge criteria can require another badge: badge B is issued only after badge A" |
| `calendar/tests/behat/calendar.feature` / "Delete an event" | "deleting a calendar event removes it from the owner listing" |
| `grade/tests/behat/grade_scales.feature` (grade with custom scales) | "grade scales: a scale item takes index grades and reports them in the gradebook" |

### Gaps found by the audit — recorded, NOT silently skipped

These Behat journeys have business meaning but the behaviour is **not
implemented** in this system, so no e2e was added (adding the behaviour is
feature work, outside this cleanup round):

| Behat oracle | Gap |
|---|---|
| `enrol/self/tests/behat/self_enrolment.feature` / "Self-enrolment enabled requiring an enrolment key" and "...requiring a group enrolment key" | Self-enrol instances have no enrolment-key field at all (schema has no key column); any user may self-enrol into an enabled self instance |
| `enrol/self` + `enrol/manual` welcome-message scenarios | No welcome message is sent on enrolment |
| `enrol/self/tests/behat/self_enrolment.feature` / "Self unenrol as a self-enrolled student" | Unenrol requires the manage capability; a student cannot unenrol themselves |
| `enrol/cohort/tests/behat/enrolcohorts.feature` / "Editing a cohort enrolment method's role should change participants' role" | Updating an instance does not re-assign the role of already-enrolled members |
| ~~`badges/tests/behat/criteria_cohort.feature`, `criteria_profile.feature`~~ — **CLOSED in the backend-business-gaps round**: the `cohort` leaf (`{cohortId}` or `{cohortIds}` = membership in ALL listed cohorts) and the `profile` leaf (`{field, value?}` — a standard profile field or a `core_user`/`user` custom field by shortname; with `value` it must equal it, without it must be filled) are now supported by the API evaluator and its worker twin | `apps/api/test/badges-competency-flow.e2e-spec.ts` › "cohort leaf…", "profile leaf…" + `apps/worker/test/engagement-jobs.spec.ts` › "badge auto-award honours the cohort + profile leaves…" |
| ~~`badges/tests/behat/award_badge.feature` / "Badge awarded depending on the course completion by-date"~~ — **CLOSED in the backend-business-gaps round**: the `coursecompletion` leaf now honours its optional `byDate` parameter (completion counts only when `timecompleted ≤ byDate`) in both the API evaluator and the worker twin | `apps/api/test/badges-competency-flow.e2e-spec.ts` › "coursecompletion by-date…" + `apps/worker/test/engagement-jobs.spec.ts` › same twin test |
| `message/tests/behat` / "Disallow sending a message if you are neither a contact nor do you share a course with the user" | Messaging enforces blocks and suspension only; there is no contact/shared-course gate (Moodle ties this to the `messagingallusers` setting, which has no equivalent here) |
| `message/tests/behat` / group conversation member sync scenarios | Conversations have explicit member lists; course-group conversations that auto-sync members do not exist |
| `calendar/tests/behat/export.feature` (ICS export + export URLs) | Calendar export (ICS download / tokenised export URL) is not implemented; only subscription import is |
| `group/tests/behat/private_groups.feature` | Groups have no visibility mode; only the course groupmode (separate groups) law is enforced |

### Frontend contract check — badges page endpoints (backend-business-gaps round)

Conclusion (option b — equivalent routes already exist; NO duplicate
endpoints were added): the web badges page (`apps/web/src/pages/badges.tsx`)
calls two routes that do not exist in `BadgesController`. Both behaviours
are already served by canonical routes, so the WEB side must change:

| Web call (does not exist) | Canonical route to use instead | Semantics |
|---|---|---|
| `POST /badges/:id/activate` | `POST /api/v1/badges/:id/status` with body `{ "status": 1 }` | Same activation path (`BadgesService.setStatus`): requires `moodle/badges:configurecriteria` at the badge context and refuses activation without criteria (`400 badges.no_criteria`) |
| `GET /badges/users/:userId/issued` | `GET /api/v1/badges/mine` | The page only ever asks for the signed-in user's own assertions; `mine` returns exactly those (issued rows + badge). Per-badge recipient lists already exist at `GET /api/v1/badges/:id/issued` for staff with `moodle/badges:awardbadge` |

Also spotted in the same page while checking: its set-criteria call sends
`{ method, leaves: [...] }` but the contract
(`setBadgeCriteriaSchema`) expects `{ method, criteria: [...] }` — the web
side should rename `leaves` → `criteria`.

### Recorded divergence (implemented differently on purpose)

| Behat oracle | Divergence |
|---|---|
| `message/tests/behat` / "Delete a message sent by the user..." scenarios | Moodle lets a sender delete their own message within a time limit; this system deliberately makes sent messages immutable (project decision recorded in the messaging flow test) and the e2e asserts immutability instead |

## Addendum — UUIDv7 primary keys on PostgreSQL 18 (platform verification, 2026-10-22)

This round changes no business behaviour: every entity primary key moved
from integer identity to UUIDv7 (PostgreSQL 18 native `uuidv7()`), per
ADR-013. The new tests are **platform verification tests**, not
translations of a Moodle oracle — their source is the internal research
report `research_notes/postgresql-18-uuidv7-primary-keys-20261022-1134/
report.md` §4.6:

| # | Verification | Source | Our test |
|---|--------------|--------|----------|
| 1 | Raw SQL inserts without an id get `uuid_extract_version(id) = 7`; the baseline migration carries `DEFAULT uuidv7()`; the live catalog defaults every entity id to `uuidv7()` and pure join tables carry composite (or single-FK) PKs with no surrogate id | report §4.6 (1) | `test/uuidv7-primary-keys-flow.e2e-spec.ts` |
| 2 | Monotonicity within one session: 2,000 sequential inserts on one connection, `ORDER BY id` matches insertion order | report §4.6 (2) | same file |
| 3 | No collisions when DB defaults and the app-side `$defaultFn` are mixed (outbox/event); bulk check: 100k ids mixed across DB defaults, app-side values and parallel connections stay unique | report §4.6 (3) | same file |
| 4 | `uuid_extract_timestamp(id)` agrees with `created_at` within ±2s | report §4.6 (4) | same file |
| 5 | Keyset pagination on `(created_at, id)`: rows inserted mid-paging cause no duplicates and no loss of rows present from the start | report §4.6 (5) | same file |
| 6 | FK joins/filters use the explicit FK indexes; index presence asserted in `pg_indexes`; every single-column FK in the catalog is covered by a leading index column | report §4.6 (6) | same file |
| 7 | IDOR re-asserted after the key change: a valid UUID of another course's resource still yields 404/403 | report §4.6 (7) | same file |
| 8 | API contract: ids serialize as UUID strings; malformed id → 400; well-formed unknown id → 404 — including the user route, where the capability guard resolves context from the raw `:id` before validation (regression: malformed id must not surface as a 500) | report §4.6 (8) | same file |

All pre-existing flow tests were updated from numeric to string ids as
part of the same round; their Moodle-oracle mappings above are unchanged
(the key change does not alter any business scenario).

## Addendum — HTTP edge hardening (platform verification, 2026-10-22)

Also platform verification, not a Moodle oracle translation; the design
record is ADR-014 and operations live in `docs/operations-runbook.md`:

| Verification | Our test |
|---|---|
| Every response carries the standard security headers; versioned API routes also carry the strict CSP | `test/platform-hardening.e2e-spec.ts` |
| Credential routes are throttled per IP: with the auth limit lowered to 3/minute, the 4th login attempt from one IP is a 429 Problem Details while other routes stay 200 | same file |
