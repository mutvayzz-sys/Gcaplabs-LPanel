# Managed runtime configuration

This contributor reference describes how the control panel applies configuration to Headmaster-managed Cloud runtimes.

## Identity and ownership

A managed runtime has an adopted Headmaster identity. Owner and workspace identifiers must match that identity. The identity cannot be rebound after adoption.

The control panel stores owner, workspace, and memory bootstrap metadata as server-managed fields. Ordinary integration and provider synchronization cannot overwrite those fields. Initial deployment must persist matching identity and bootstrap metadata before the provisioner starts the runtime.

## Revision and retry behavior

Managed updates use a desired revision and an applied revision. A stale revision is rejected. Repeating an identical update after it has applied is a no-op. A retry reapplies the saved desired configuration without increasing its revision.

The applied revision advances only after runtime synchronization reports a complete, non-staged result. A failed application remains unacknowledged and can be retried. A retry does not start a runtime that the user stopped.

## Model configuration

The managed model block registers the Headmaster provider with the Lite, Pro, and Max tier labels. The default label is Lite. Operator-owned provider credentials and endpoint overrides are not copied into the managed model block.

A model chosen through a personal-provider entry survives a later synchronization only while that entry still exists and both its endpoint and runtime credential reference match. Otherwise the model selection returns to the managed default.

The behavior is implemented in backend-api/headmasterConfig.ts and agent-runtime/lib/headmasterInference.ts. The identity-bound routes are registered in backend-api/routes/agents.ts.
