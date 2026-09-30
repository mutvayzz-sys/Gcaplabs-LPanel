# Headmaster runtime compatibility

This page describes source-level contracts in this repository. It is not a list of currently deployed runtime images.

## Source contract

- Managed configuration is accepted only for a runtime carrying an adopted Headmaster identity.
- The first deployment stores the matching owner, workspace, and memory bootstrap metadata before the provisioner starts the runtime.
- Runtime identity lookups resolve a runtime credential digest to the immutable Headmaster owner identity.
- The managed provider exposes Lite, Pro, and Max labels. The relay resolves those labels against the account's allowed model set.
- A fallback assignment, when configured, permits Lite only. Pro and Max requests require an enabled account-specific assignment.

See backend-api/headmasterConfig.ts, backend-api/routes/headmasterRuntimeIdentity.ts, agent-runtime/lib/headmasterInference.ts, and services/headmaster-inference/policy.mjs for the source contracts.

<!-- TODO(verify): Confirm the supported runtime image/version matrix and the currently deployed API, provisioner, admission, and relay contracts before publishing deployment compatibility guarantees. -->
