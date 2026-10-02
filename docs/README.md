# Documentation source

This folder contains the Headmaster licence panel's product and contributor pages. Pages use Markdown or MDX. The Mintlify navigation, theme, and logo are defined in [docs.json](docs.json).

## Preview

With the Mintlify CLI installed, run `mint dev` from this folder to preview the documentation locally. Confirm the preview against the project's current Mintlify setup before relying on it for publication.

## Page maintenance

When a code change affects documented behavior, update the relevant page in the same change. Check command names, paths, environment-variable names, ports, and feature behavior against the implementation. Keep the navigation synchronized with the published pages.

<!-- TODO(verify): Confirm the connected Mintlify project and publication branch before documenting a live deployment workflow. -->
<!-- TODO(verify): Reconcile docs.json navigation and legacy page access after documentation configuration changes are in scope. -->
