# Headmaster administrator access

When enabled, the administrator integration opens the control panel from the Headmaster administrator experience. It uses a single-use launch code bound to the browser that started the request.

## Who can enter

Access is limited to an explicitly linked, existing panel administrator. The integration does not create administrator accounts or promote a user because they signed in through Headmaster.

## Session checks

The panel rechecks the linked account's status and administrator role. Logout, account switching, suspension, role removal, and removal of the account link revoke access. The integration also closes privileged live connections when a session is revoked.

If a required identity or session check cannot complete, the request fails closed. Ask a Headmaster administrator to review the account link if access is denied.

<!-- TODO(verify): Source code contains the launch and revocation flow, but this review did not verify the current live deployment or end-to-end revocation timing. -->
