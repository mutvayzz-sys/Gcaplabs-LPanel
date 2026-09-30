# Licence panel documentation audit

## Snapshot and scope

Reviewed the LPanel documentation and implementation at commit 9f33fa4 (30 September 2026). The assigned worktree is based on the repository's main branch. CLAUDE.md was read before editing; this checkout has no root AGENTS.md. The source snapshot is frozen for this task.

The audit covered README.md; docs/introduction.mdx, docs/quickstart.mdx and docs/self-hosting.mdx; the three docs/headmaster-*.md pages; docs/README.md; and the Headmaster integration, managed configuration and inference implementation. The wider inherited concepts, guides, API, support, comparison and configuration pages were checked for Headmaster-specific navigation or incoming links. They do not describe Headmaster behavior. The existing docs.json navigation is outside this Markdown-only change, so those inherited routes remain a publication issue.

## Current documentation claims

- The root README and docs metadata still present the inherited upstream name, runtime catalog, installer, third-party links, feature counts, and self-hosted product promises as the Headmaster product.
- The quickstart and self-hosting pages instruct readers to clone and run a different upstream repository, and describe its local demo and deployment choices.
- The three Headmaster pages mix implementation contracts with public guidance. They include internal service routes, deployment state, secret-related configuration names, host details, and dated build evidence.
- The managed-configuration page says a model selected from another provider is lost on the next resync. The compatibility page simultaneously says the Headmaster integration is still in progress and describes later deployment state.
- The original Mintlify navigation did not include any Headmaster page. It exposed the inherited documentation catalog. Removing pages from navigation does not prevent direct access; navigation and legacy-route remediation remain unresolved because docs.json is outside this change's Markdown-only scope.

## Code and history evidence

- The Headmaster launch integration exists in backend-api/headmasterLaunch.ts, backend-api/routes/headmaster.ts, backend-api/routes/auth.ts and the dashboard launch bridge. It uses short-lived, single-use browser-bound launch codes, explicit administrator links, current role checks, periodic liveness revalidation and session revocation. This proves implementation presence, not current live availability.
- Identity adoption and managed runtime configuration are implemented in backend-api/headmasterConfig.ts and backend-api/routes/headmasterRuntimeIdentity.ts. Config writes are identity-bound and revision-fenced; repeated applied writes are no-ops; retries reapply saved state; runtime auth/environment synchronization must complete before a revision is acknowledged.
- The managed Cloud model provider and model-selection retention rules are in agent-runtime/lib/headmasterInference.ts. The code defines Lite, Pro and Max. A selected own-provider entry is kept only while its endpoint and derived credential reference continue to match.
- The relay assignment policy is in services/headmaster-inference/assignments.mjs and services/headmaster-inference/policy.mjs. The September 30 implementation permits only Lite for an account using the fallback assignment; Pro and Max require an enabled account-specific assignment. The fallback applies only when the account has no assignment row; a disabled row and lookup failures deny service.
- Git history records the first repository commit as 208cc24 on 2026-03-19, while the first Headmaster integration merge is 4b49eba / PR #1 on 2026-09-18. The September changes continue through PRs #8-#27, including managed configuration, identity resolution, memory bootstrap, built-in tiers, own-key relay handling, assignment metadata, model retention, and the Lite-only fallback policy.

## Corrections made

- Replaced the root README with a concise Headmaster control-panel repository overview and a link to the ecosystem map.
- Reworked the introduction, quickstart and self-hosting pages to describe Headmaster paths without repeating inherited setup instructions. Customer navigation, deployment, and publication details not established by this source snapshot carry TODO(verify) comments.
- Rewrote the Headmaster integration, managed-configuration and compatibility pages in plain Headmaster language. Kept source-backed behavior and removed stale rollout narratives and internal deployment details.
- Added Cloud model tier guidance to the existing compatibility page, so no new documentation route is introduced.
- Updated Markdown links to point to existing Headmaster pages. The Mintlify navigation and inherited direct URLs still require a separate documentation-configuration change.

## Limits

This is a source and Git-history review only. It does not establish current customer-facing deployment state, publication configuration, legacy route access, or end-to-end acceptance. No tests or live checks are in scope. TODO(verify) comments identify those limits where the revised pages might otherwise imply availability.
