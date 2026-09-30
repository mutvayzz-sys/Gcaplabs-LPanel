# Documentation source

This folder contains the Headmaster licence panel's product and contributor pages. Pages use Markdown or MDX. The Mintlify navigation, theme, logo, and legacy-path redirects are defined in [docs.json](docs.json).

## Preview

With the Mintlify CLI installed, run `mint dev` from this folder to preview the documentation locally. Confirm the preview against the project's current Mintlify setup before relying on it for publication.

## Page maintenance

When a code change affects documented behavior, update the relevant page in the same change. Check command names, paths, environment-variable names, ports, and feature behavior against the implementation. Keep the navigation synchronized with the published pages. Legacy page files remain in the repository as source history; the redirects in `docs.json` route their old URL paths to the current Headmaster overview or compatibility pages.

<!-- TODO(verify): Confirm the connected Mintlify project and publication branch before documenting a live deployment workflow. -->
<!-- TODO(verify): Confirm wildcard redirects retire direct access to the legacy page routes before publishing. -->
<!-- TODO(verify): Confirm unreferenced static files under docs/ cannot bypass the page redirects on the published documentation site. -->
