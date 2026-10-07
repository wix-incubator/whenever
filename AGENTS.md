# Whenever SDK development

Use Node.js 26.3.1 and checked-in Yarn 4.6.0. Install with `yarn install --immutable`; run `yarn check` before submitting a change.

The SDK has no runtime dependencies. The standalone adapter depends on the SDK and undici only. Keep both packages independent of their hosts. Preserve export names, integration contracts, authorization and transport limits. Do not include credentials or customer workflow code.

For behavior changes, start with a failing test at the exported boundary, implement the change, run affected checks and verify the test detects a temporary break. Existing tests cover mechanical moves and behavior-preserving refactors. Prefer observable results over implementation details.

Public CI installs from public npm and does not publish. Source changes use pull requests against main.
