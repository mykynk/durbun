# Dürbün for testers

This guide is for people who test apps and want to see what the app does while they use it: its log lines,
its crashes and, in builds that allow it, its network requests. You do not need to write code. The steps
follow the order you meet them: first on the Mac, then on the phone, then in Dürbün.

If something does not work, see [Troubleshooting](troubleshooting.md).

## What you need

- A Mac with macOS 13 Ventura or later.
- The phone you test on and a USB cable that carries data (some cables only charge).
- For an Android phone: a small free tool from Google called `adb`. Dürbün tells you how to install it.
- For an iPhone: a log tool called `idevicesyslog`, and Xcode for starting and stopping the app and reading
  its crash reports. Dürbün tells you what is missing.

## 1. Install Dürbün on the Mac

1. Download the DMG from [GitHub Releases](https://github.com/mykynk/durbun/releases/latest):
   `Durbun-<version>-arm64.dmg` for Macs with Apple silicon (M1 and later), `Durbun-<version>-x64.dmg` for
   Intel Macs. If you are not sure: Apple menu → About This Mac shows "Chip: Apple M…" on Apple silicon.
2. Open the DMG and drag Dürbün to Applications.
3. Open Dürbün from Applications. The window says "Starting Dürbün…" for a moment.

With no phone connected, the window shows **Connect a device**: short steps for Android phones, iPhones and
simulators, and whether the tools each one needs were found on this Mac.

Closing the window does not stop Dürbün: it keeps recording in the menu bar. To quit, press ⌘Q.

## 2. Let Dürbün check the Mac

Click **System check** (bottom of the left sidebar, or the Help button **?** in the window's top bar). It lists
the tools Dürbün uses and marks each one **OK**, **Warning** or **Missing**. For a missing tool it shows the
command that installs it, with a **Copy command** button: paste it into the Terminal app and press Return.
Then click **Check again**.

The commands it suggests use Homebrew (`brew`). If your Mac has no Homebrew, or you are not allowed to install
software, ask your team. What each phone needs:

| Phone | Tool | Without it |
|---|---|---|
| Android | Android Debug Bridge (`adb`). Android Studio includes it; Dürbün finds that copy by itself | The phone does not appear |
| iPhone | iOS device logs (`idevicesyslog`) | The iPhone appears, but its log lines do not come in |
| iPhone | Xcode 15 or later (`devicectl`) | No starting, stopping or installing the app and no crash reports from the phone; screenshots and screen recordings may not work |

## 3. Connect an Android phone

Do this once per phone:

1. On the phone, open **Settings → About phone** and tap **Build number** seven times. The phone says that
   you are now a developer. On some phones Build number is one level deeper, for example under
   **Software information**.
2. Open **Settings → System → Developer options** (on some phones Developer options is at the bottom of
   Settings) and turn on **USB debugging**.
3. Plug the phone into the Mac.
4. Unlock the phone. It asks **"Allow USB debugging?"**. Tick **Always allow from this computer** and tap
   **Allow**.

The phone appears in the left sidebar under **Devices**. While the question on the phone is still open, Dürbün
shows the phone as **Waiting for permission** and tells you to accept it.

## 4. Connect an iPhone or iPad

1. Plug the iPhone into the Mac and unlock it.
2. The iPhone asks **"Trust This Computer?"**. Tap **Trust** and enter the iPhone's passcode.
3. On iOS 16 and later, turn on **Developer Mode**: **Settings → Privacy & Security → Developer Mode**, then
   restart the iPhone as it asks. If the switch is not there, the iPhone has to be connected to Xcode once;
   ask your team.

Until you tap Trust, Dürbün shows "Unlock the device and tap Trust on “Trust This Computer?”". With Developer
Mode off, log lines still come in, but screenshots, screen recordings, starting and stopping the app and
crash reports do not; Dürbün says so on the device.

## 5. Simulators and emulators

An iOS simulator or Android emulator that is already running on this Mac appears in the sidebar by itself.
There is nothing to set up.

## 6. Find your app

Under each device the sidebar lists the apps it found. Click your app: every tab (Logs, Network, Mocks,
Performance, Device) now shows only that app. Click **All devices** at the top to see everything again.

The labels on an app tell you what Dürbün can see in this build:

| Label | What it means |
|---|---|
| **SDK** | Dürbün is built into this build of the app: you see its own log lines, its network requests and its performance, and mock rules work |
| **VM Service** | A developer started this app from their computer in debug mode: log lines, network requests and frame times come in |
| **Device log only** | Dürbün is not built into this build, or it is turned off in it. You see what the phone records by itself (log lines and crashes), but no network requests |

A second label tells you how the build was installed, for example **Debug**, **Firebase**, **Play**,
**Store / TestFlight / ad-hoc** (an iPhone does not say which of the three) or **APK** (installed from a file).

The **ⓘ** button on an app's row opens **What can I see?**: for each kind of data (logs, network requests,
performance, crashes, mocks, in-app tools) whether it is available for this build and, if not, why.

Which builds have Dürbün built in is your team's decision. If you need network requests and the app shows
**Device log only**, ask for a build with Dürbün turned on.

## 7. Read the logs

The **Logs** tab shows the lines live, newest at the bottom.

- Type in the search box to filter. Examples: `level:warn` (warnings and errors), `is:crash` (crashes),
  `tag:auth`. The help button next to the search box explains the rest.
- **Minimum level** hides the chatty levels; **Only Error and Fatal** leaves just the errors.
- Errors and warnings have their own colors. Long stack traces and JSON fold; click them to open.
- A crash raises a banner, and **Go to the latest crash** jumps to it. Crashes the phone recorded before Dürbün
  was connected show up too, marked "Crashed before watching".
- **Pause** (or the space bar) freezes the view while lines keep arriving.
- Press **M**, or click the bookmark button, to add a marker line: "the bug happened here". It makes the moment
  easy to find later.

Click a line to see all its details on the right.

## 8. Network requests

The **Network** tab lists the app's requests: address, status, duration and size. Click one to see the
headers, the body that was sent and the answer that came back (JSON opens as a tree). Failed requests and
error answers stand out in the list.

Requests only appear for apps with the **SDK** or **VM Service** label. They cannot be read from outside the
app; this is how phones protect apps, not a setup mistake.

## 9. Report what you found

**A log line or a request.** Right-click it and choose **Share…** (it is also in the detail panel). Dürbün
makes a report your team can read without Dürbün. **Copy** it into Jira or an e-mail, **Save as .md**, or
**Send to Slack** if your team has connected a Slack channel (Settings → Slack). For requests, passwords,
tokens and cookies are masked as `••••` unless you turn **Mask secret values** off.

**Everything at once.** Open the **Import / export** button in the top bar and choose **Export the session…**.
It saves the log lines and requests of the current scope (the app or device you picked in the sidebar) into
one `.durbun.json` file. Secret values are masked unless you choose **Save unmasked**. Anyone with Dürbün can
open the file.

**A screenshot or a screen recording.** In the **Device** tab, use **Screenshot** or **Screen recording**. On
an iPhone this needs Developer Mode.

## 10. Open a file a colleague sent

Drop the file on the Dürbün window, or choose **Import / export → Import a file…**.

- A **session recording** (`.durbun.json`) opens as a separate, read-only device in the sidebar under
  **Imported**. Values shown as `••••` were masked when it was saved.
- A **Dürbün package** (`.durbun`) carries mock rules, flows and settings from a teammate. Dürbün shows what is
  new, what you already have and what differs, and lets you replace, keep both or skip each item. Nothing is
  overwritten before you choose.

## 11. Mock rules

Mock rules make the app receive a different answer than the server would give: an error, an empty list, a
slow response or no connection at all. They work only in apps with the **SDK** label. See
[Mock rules](mocks.md).

## 12. Flutter apps: the panel inside the app

Flutter apps can carry Dürbün's panel inside the app itself, if the developers added it. **Shake the phone**
to open it. It shows the same logs and requests on the phone, without a Mac, and its **Share** button can
copy a report, send it through the phone's share sheet, or post it to Slack when the build was made with a
Slack link. If shaking does nothing, the build does not have the panel, Dürbün is turned off in it, or the
developers chose another way to open it; ask your team.

## When something does not work

[Troubleshooting](troubleshooting.md) is organised by what you see: the phone does not appear, the iPhone
shows no logs, requests are missing, and more.
