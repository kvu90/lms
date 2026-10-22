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
