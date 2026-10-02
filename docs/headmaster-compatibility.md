# Headmaster runtime compatibility

This page describes source-level contracts in this repository. It is not a list of currently deployed runtime images.

## Source contract

- Managed configuration is accepted only for a runtime carrying an adopted Headmaster identity.
- The first deployment stores the matching owner, workspace, and memory bootstrap metadata before the provisioner starts the runtime.
- Runtime identity lookups resolve a runtime credential digest to the immutable Headmaster owner identity.
- The managed provider exposes Lite, Pro, and Max labels. The current relay policy maps each label to the first model allowed for the account.
- A fallback assignment, when configured, permits Lite only. Pro and Max requests require an enabled account-specific assignment.

See backend-api/headmasterConfig.ts, backend-api/routes/headmasterRuntimeIdentity.ts, agent-runtime/lib/headmasterInference.ts, and services/headmaster-inference/policy.mjs for the source contracts.

## Cloud model tiers

Headmaster-managed Cloud runtimes use three tier labels: **Lite**, **Pro**, and **Max**. These labels are not fixed provider model names. An account assignment identifies a provider; the relay builds its allowed model set from the provider's configured models and the models covered by the relay.

An enabled account-specific assignment permits all three tier labels. A configured fallback applies only when the account has no assignment row; it permits **Lite** only and rejects Pro or Max requests. An explicitly disabled assignment or a failed assignment lookup denies the request.

When an account has an allowed model, the current relay policy maps each tier label to the first allowed backend model. All three labels therefore select the same model for that account; this snapshot does not implement separate backend-model selection by tier. The labels alone do not promise a specific model, price, response time, or capability.

<!-- TODO(verify): Confirm the current production assignment policy and customer model-picker behavior before treating these source rules as a live availability statement. -->

<!-- TODO(verify): Confirm the supported runtime image/version matrix and the currently deployed API, provisioner, admission, and relay contracts before publishing deployment compatibility guarantees. -->
