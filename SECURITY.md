# Security policy

## Supported versions

Security fixes go into the latest release. While Dürbün is at `0.x`, only the newest minor version is
supported.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through
[GitHub's private vulnerability reporting](https://github.com/mykynk/durbun/security/advisories/new)
(the repository's **Security** tab → **Report a vulnerability**).

Include the affected part (Mac app, server, or which SDK), the version, steps to reproduce and the impact you
expect.

## What happens next

- You get a first answer in the advisory within 7 days.
- A confirmed problem is fixed in a new release. The fix is announced with a GitHub security advisory for the
  repository, published together with that release, and listed in [CHANGELOG.md](CHANGELOG.md).

## Scope

Dürbün is a development tool. Things that are in scope include:

- The server or the Mac app being reachable from another machine without **LAN** turned on, or from a web
  page in the browser (the server binds to `127.0.0.1` and checks request origins).
- Another app on the phone reading or controlling Dürbün's interface or API through the forwarded ports
  (they serve the SDK connection only).
- An SDK that sends data anywhere other than the Dürbün the developer connected it to, or that runs in a
  release build that did not opt in.
- Secrets that the redaction features promise to hide (for example `Authorization` headers in shared
  reports, exports and HAR files) showing up in clear text.
- **Files from someone else.** Opening a `.durbun` package or backup, a session recording (`.durbun.json`), a
  HAR file or a flow file made by someone else: anything that runs code, writes outside Dürbün's data folder,
  changes existing data before you choose in the import dialog, or turns on a shared flow's automation (shared
  flows come in with automation off).
- **Encrypted backups.** Reading the secret values or the Slack webhook in a backup without its passphrase
  (they are encrypted with AES-256-GCM, key from scrypt), or a backup or share package that carries them in
  clear text.
- **Flows.** A flow, including a shared one, that does more than the requests and device actions written in
  it: reaching Dürbün's own ports, running a shell command, or reading or sending files on the Mac (an install
  step only hands the build it names to the device). A run that changes the device for good (clear data,
  uninstall) without asking first.
- **Flow environments.** Secret environment values that leave the Mac in a share package or the AI pack, or
  that show in run records and reports unmasked.
- **Slack.** The stored webhook (`slack.json` in the data folder) readable by other users of the Mac or
  returned to the interface after it is saved, and the [Add to Slack](https://appnify.dev/durbun/slack/) page
  leaking the webhook or the authorization code to anyone but your own browser.
- **Updates.** The Mac app's update check or download installing anything other than a signed Dürbün release,
  or sending an identifier with the request.

## Out of scope

- What a device on your network can reach after you turn on **LAN** (or pass `--lan`): the SDK port, as
  described in the [README](README.md#security). The SDK connection is not paired or encrypted yet.
- Another app on the same phone taking the Mac's place on the SDK's local port and receiving the app's logs and
  traffic or sending it mock rules. The SDK READMEs describe this.
- Requests and device actions that a flow you chose to run performs, and what an automatic flow you turned on
  does when its event happens.
- A rooted or jailbroken phone, or a Mac where an attacker already runs code as your user.
- Data you chose to put in a report, a session export (including an unmasked one) or a Slack message.
- A webhook compiled into a Flutter build with `--dart-define=DURBUN_SLACK_WEBHOOK`: anyone who has the build can
  read it, as the README says.
- Denial of service by a device or an app you plugged in or connected yourself, for example one that floods
  logs.
