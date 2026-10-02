# Headmaster Cloud control panel

This repository contains the Headmaster licence panel and Cloud control-plane services. It implements administrator access, managed runtime identity and configuration, and account-based model routing.

The Headmaster desktop app and account website live in separate repositories. See the [ecosystem map](https://github.com/mutvayzz-sys/gcaplabs-desktop/blob/beta/ECOSYSTEM.md) for how the services fit together.

## Repository map

- [backend-api](backend-api/): account, administrator, runtime configuration, and API services.
- [frontend-dashboard](frontend-dashboard/): operations workspace.
- [admin-dashboard](admin-dashboard/): platform administration workspace.
- [workers/provisioner](workers/provisioner/): asynchronous runtime deployment and reconciliation.
- [services/headmaster-inference](services/headmaster-inference/): authenticated inference relay and account assignment policy.
- [docs](docs/): product and contributor documentation.

## Documentation

- [Product overview](docs/introduction.mdx)
- [Quickstart](docs/quickstart.mdx)
- [Administrator access](docs/headmaster-integration.md)
- [Cloud model tiers and compatibility](docs/headmaster-compatibility.md#cloud-model-tiers)
- [Managed runtime configuration](docs/headmaster-managed-config.md)
- [Compatibility notes](docs/headmaster-compatibility.md)
- [Self-hosting status](docs/self-hosting.mdx)

The Mintlify navigation is defined in [docs/docs.json](docs/docs.json).
