# Headmaster runtime compatibility

This page describes source-level contracts in this repository. It is not a list of currently deployed runtime images.

## Source contract

- Managed configuration is accepted only for a runtime carrying an adopted Headmaster identity.
- The first deployment stores the matching owner, workspace, and memory bootstrap metadata before the provisioner starts the runtime.
- Runtime identity lookups resolve a runtime credential digest to the immutable Headmaster owner identity.
- The managed provider exposes Lite, Pro, and Max labels. The relay resolves those labels against the account's allowed model set.
- A fallback assignment, when configured, permits Lite only. Pro and Max requests require an enabled account-specific assignment.

See backend-api/headmasterConfig.ts, backend-api/routes/headmasterRuntimeIdentity.ts, agent-runtime/lib/headmasterInference.ts, and services/headmaster-inference/policy.mjs for the source contracts.

## Cloud model tiers

Headmaster-managed Cloud runtimes use three tier labels: **Lite**, **Pro**, and **Max**. These labels are not fixed provider model names. The control panel assigns an allowed model set to each account, and the relay resolves tier requests against that set.

An enabled account-specific assignment provides access to the full tier set. The configured fallback applies only when the account has no assignment row; it permits **Lite** only and rejects Pro or Max requests. An explicitly disabled assignment or a failed assignment lookup denies the request.

All three tier labels can resolve to the same underlying model until the account's allowed model policy distinguishes them. The labels alone do not promise a specific model, price, response time, or capability.

<!-- TODO(verify): Confirm the current production assignment policy and customer model-picker behavior before treating these source rules as a live availability statement. -->

<!-- TODO(verify): Confirm the supported runtime image/version matrix and the currently deployed API, provisioner, admission, and relay contracts before publishing deployment compatibility guarantees. -->
