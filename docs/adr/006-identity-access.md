# ADR-006 — P1 Identity & Access decisions

Date: 2026-10-22. Status: accepted. Builds on the research report §3.3/§3.7/§3.8.

1. **PermissionEvaluator is the only source of truth** for capabilities
   (context tree + per-role leaf→root resolution + absolute PROHIBIT +
   multi-role aggregation + site-admin bypass via the `siteadmins` config
   key). CASL is not used server-side. Results are cached in the
   application-mode cache under keys embedding the context-path version
   stamp; any assignment/override change bumps `context.version` for the
   context and all descendants (Moodle's dirty-context mechanism).
   Capabilities are never embedded in the JWT (identity + session id only).

2. **Default roles are virtual assignments**: every authenticated user is
   evaluated with the `user` archetype role and the guest account with the
   `guest` role, anchored at the system context — mirroring accesslib's
   default-role handling. The guest account never receives direct assignments.

3. **Refresh tokens**: opaque, SHA-256-hashed at rest, grouped in families
   (`refresh_token_family`). Every use rotates; presenting the rotated-out
   (previous) token revokes the whole family (reuse detection, report §3.7).

4. **File content hash = SHA-256** (the report §3.8 default of SHA-1 existed
   only for legacy filedir compatibility, which the project explicitly does
   not need). Physical layout keeps Moodle's shape: `<2>/<2>/<hash>`.
   Serving is capability-checked first; the local adapter then issues
   short-lived HMAC signed URLs. The S3 adapter remains a port
   (`ObjectStorage`), to be implemented when a deployment needs it.

5. **Multipart uploads**: capability guards run before Nest interceptors, so
   a multipart body's target context does not exist at guard time. Upload
   endpoints therefore check the capability in the handler (after
   FileInterceptor parsing) via the same evaluator — the rule is unchanged,
   only the enforcement point moves for this transport reason.
