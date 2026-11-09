# Security policy

## Supported versions

Security fixes go into the latest release. While Dürbün is at `0.x`, only the newest minor version is
supported.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through
[GitHub's private vulnerability reporting](https://github.com/mykynk/durbun/security/advisories/new)
(the repository's **Security** tab → **Report a vulnerability**).

Include the affected part (Mac app, server, or which SDK), the version, steps to reproduce and the impact you
expect. You will get a reply in the advisory, and the fix and the advisory are published together.

## Scope

Dürbün is a development tool. Things that are in scope include:

- The server or the Mac app being reachable from another machine without **LAN** turned on, or from a web
  page in the browser (the server binds to `127.0.0.1` and checks request origins).
- Another app on the phone reading or controlling Dürbün through the forwarded ports.
- An SDK that sends data anywhere other than the Dürbün the developer connected it to, or that runs in a
  release build that did not opt in.
- Secrets that the redaction features promise to hide (for example `Authorization` headers in shared
  reports) showing up in clear text.
