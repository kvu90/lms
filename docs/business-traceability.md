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
