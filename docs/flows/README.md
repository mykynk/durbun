# Flow files

A Dürbün flow is one JSON document. The Mac app keeps each flow in `~/.durbun/flows/<id>.json`; the same document
is what **Export as a file** saves, what a `.durbun` package carries and what your AI assistant writes. You can keep
flows in a repository and import them (**Import a file…**, or drop them on the window).

[`durbun-flow.schema.json`](durbun-flow.schema.json) describes every field and node type (JSON Schema 2020-12;
editors such as VS Code complete and check a flow against it). It is generated from the app's node catalog, so it
always matches the version in this repository.

## Editor support

The Mac app's **Export as a file** saves a flow as `<id>.durbun-flow.json`. To get completion and checks for those
files in VS Code, map them to the schema in your user or workspace `settings.json`:

```json
{
  "json.schemas": [
    {
      "fileMatch": ["*.durbun-flow.json"],
      "url": "https://raw.githubusercontent.com/mykynk/durbun/main/docs/flows/durbun-flow.schema.json"
    }
  ]
}
```

Flows kept as `~/.durbun/flows/<id>.json` or in your own repository under another name need their own
`fileMatch` pattern, for example `"flows/*.json"`.

Exported files already name the schema in their first line,
`"$schema": "https://raw.githubusercontent.com/mykynk/durbun/main/docs/flows/durbun-flow.schema.json",`, so most
editors check them without any setting; you can add the same line to any flow file. The schema allows it, and
Dürbün ignores it when it imports a flow (files without it import as before).

## Example

```json
{
  "format": "durbun-flow",
  "version": 1,
  "id": "add-to-cart",
  "name": "Add to cart",
  "description": "Signs in, adds one product and checks the cart total.",
  "tags": ["smoke", "checkout"],
  "inputs": [{ "name": "email", "default": "qa@example.com", "required": true }],
  "nodes": [
    { "id": "start", "type": "trigger.manual" },
    {
      "id": "login",
      "type": "http.request",
      "label": "Sign in",
      "params": {
        "method": "POST",
        "url": "{{env.baseUrl}}/v1/login",
        "bodyType": "json",
        "body": { "email": "{{input.email}}", "password": "{{env.password}}" }
      }
    },
    {
      "id": "addItem",
      "type": "http.request",
      "label": "Add a product",
      "params": {
        "method": "POST",
        "url": "{{env.baseUrl}}/v1/cart/items",
        "headers": [["Authorization", "Bearer {{login.body.token}}"]],
        "bodyType": "json",
        "body": { "productId": "p-100", "quantity": 1 }
      }
    },
    {
      "id": "check",
      "type": "check.assert",
      "params": {
        "assertions": [
          { "left": "{{addItem.status}}", "op": "equals", "right": "201" },
          { "left": "{{addItem.body.total}}", "op": "gt", "right": "0", "message": "The cart total should not be zero" }
        ]
      }
    },
    { "id": "shot", "type": "device.screenshot" }
  ],
  "edges": [
    { "from": "start", "to": "login" },
    { "from": "login", "to": "addItem" },
    { "from": "addItem", "to": "check" },
    { "from": "check", "to": "shot" }
  ]
}
```

Set `baseUrl` and a secret `password` in an environment (Flows → Environments) and run it against your app.

## Structure

- `id`: the file name and the name other flows call it by: lowercase letters, digits, `-` and `_`.
- `inputs`: values asked when the flow starts, or passed by a calling flow. `outputs`: values a calling flow reads.
- `nodes`: the steps. Each has an `id` (letters, digits and `_`; templates use it), a `type` from the catalog and
  `params`. Optional: `label`, `disabled`, `continueOnError`, `retry`, `timeoutMs`, `note`, `position` (nodes
  without one are laid out automatically). `wait.*` and `http.request` use the step's `timeoutMs` when their own
  `timeoutMs` parameter is not set. A disabled or skipped step reads as empty in later templates.
- `edges`: `{ "from", "port", "to" }`. Ports: `out` (default), `true` / `false` (condition), `loop` / `done`
  (repeat) and `error`, which every step that takes input has except `flow.end`: draw it to handle a failure
  instead of ending the run. `continueOnError` lets a failed step go on the way a passed one would (`out`, `true`
  after a condition, `done` after a repeat); an `error` edge wins over it.
- `target`: the platform and app id the flow is written for. `automation`: start by itself on a
  `trigger.event` node while Dürbün is open (see Automation below).
- `flow.end` ends the run. Inside a sub-flow it ends that sub-flow: `failed` makes the calling `flow.call` step
  fail (its `error` edge can handle it), `passed` returns to the caller. A flow cannot call itself, directly or
  through other flows.

## Steps

The schema lists every parameter; this is what each step type is for. "Android" means a phone or an emulator,
"iOS sim." the iOS simulator, "iPhone" a connected device.

| Group | Type | What it does | Runs on |
| --- | --- | --- | --- |
| Start | `trigger.manual` | starts the run when someone presses Run | all |
| | `trigger.event` | starts the run by itself on a crash, a log line, a failed or matching request, an app or device connecting (see Automation) | all |
| HTTP | `http.request` | sends a request from the Mac and saves the response | all |
| Logic | `logic.condition`, `logic.repeat`, `logic.setVariables`, `logic.delay` | branch, repeat (also over a list), set variables, wait a fixed time | all |
| | `check.assert`, `check.noErrors` | fail the run when a check does not hold, or when the app crashed, failed requests or logged errors | all |
| | `flow.call`, `flow.end` | run another flow with inputs, end the run (or the sub-flow) | all |
| Device | `device.openUrl`, `device.launchApp`, `device.stopApp`, `device.restartApp`, `device.uninstallApp`, `device.installApp`, `device.screenshot`, `device.startRecording`, `device.stopRecording` | links, the app's life cycle, builds, evidence | Android, iOS sim., iPhone |
| | `device.clearData` | delete the app's data | Android, iOS sim. |
| | `device.appearance`, `device.fontScale` | dark / light, text size | Android, iOS sim. |
| | `device.location` | simulated location | Android emulator, iOS sim. |
| | `device.pushNotification`, `device.statusBar` | a push payload, a clean status bar for screenshots | iOS sim. |
| | `device.inputText`, `device.keyEvent`, `device.animations` | type text, press a key, system animations | Android |
| | `device.permission` | grant or revoke one of the app's permissions | Android, iOS sim. |
| | `device.appLanguage` | the app's own language, without changing the phone's (Android 13+) | Android |
| | `device.airplaneMode` (Android 11+), `device.wifi`, `device.mobileData` | connectivity | Android |
| | `device.rotation` | turn the screen, or bring back auto-rotate | Android |
| | `device.dontKeepActivities` | the developer option that ends every screen as soon as it is left | Android |
| Wait | `wait.network`, `wait.log`, `wait.event` | wait for the app's request, a log line, or an event the app sends with the SDK | all (`wait.network` and `wait.event` need the SDK) |
| Mocks | `mock.add`, `mock.toggle`, `mock.remove` | change what the app's SDK answers for matching requests | apps with the SDK |
| Output | `output.marker`, `output.slack`, `output.note` | a marker in the logs, a Slack message, a line in the run report | all |

The device setting steps (`device.permission`, `device.appLanguage`, `device.airplaneMode`, `device.wifi`,
`device.mobileData`, `device.rotation`, `device.dontKeepActivities`) put the setting back as it was when the run
ends, unless `restoreAfter` is `false`. On the iOS simulator, putting a permission back means the app asks again.
Turning Wi-Fi off or airplane mode on is refused while the phone is connected to the Mac over Wi-Fi
(`action.wouldDisconnect`): it would cut the connection. Connect it with USB first.

## Templates

String values may contain `{{…}}`:

| Template | Reads |
| --- | --- |
| `{{login.body.token}}`, `{{login.status}}`, `{{login.headers['x-request-id']}}` | an earlier step's output |
| `{{env.baseUrl}}` | the chosen environment |
| `{{input.email}}`, `{{vars.orderId}}` | run inputs, variables set by `logic.setVariables` |
| `{{item}}` | the current element inside a repeat over a list |
| `{{target.appId}}`, `{{run.id}}`, `{{trigger.…}}` | the app under test, the run, what started it |
| `{{run.status}}` | the result so far: `failed` once any step has failed (also one handled by an `error` edge or `continueOnError`), else `passed` |
| `{{$uuid}}`, `{{$now}}`, `{{$timestamp}}`, `{{$randomInt(1, 100)}}`, `{{$randomString(8)}}`, `{{$randomEmail}}` | helpers |
| `{{orders.body.items \| length}}`, `{{input.note \| default('none')}}` | pipes: `json`, `string`, `number`, `length`, `upper`, `lower`, `trim`, `first`, `last`, `urlencode`, `base64`, `default('x')` |

- A value that is a single template keeps its type (a number stays a number); inside longer text it becomes text.
- A template reads a value; it does not compute. `{{a.b > 0}}` or `{{a + 1}}` is an error: compare in a condition
  rule, convert with a pipe.
- Helper and pipe arguments are fixed values: numbers, `true` / `false` / `null`, or text in quotes (`'x'` or
  `"x"`, `\'` for a quote inside). An argument cannot read a path.
- Every `{{` needs a `}}`; a `}}` on its own is plain text (a JSON body may end in `}}`). There is no way to write
  a literal `{{`.
- A few parameters are read as written and cannot hold a template: the `trigger.event` filters, `flow.end` status,
  `logic.repeat` `failIfNotMet`, and the `path` / `regex` of an HTTP `extract` rule. The schema marks them.
- `env`, `vars`, `input`, `target`, `trigger`, `run` and `item` cannot be node ids; `__proto__`, `constructor` and
  `prototype` cannot be node ids or variable, input or output names.

## Rules

Conditions (`logic.condition`, `logic.repeat` `until`) and checks (`check.assert`) are lists of
`{ "left", "op", "right" }`. Operators: `equals`, `notEquals`, `contains`, `notContains`, `startsWith`, `endsWith`,
`matches` (regular expression), `gt`, `gte`, `lt`, `lte`, `in`, and without a right side `exists`, `notExists`,
`isEmpty`, `isNotEmpty`, `isTrue`, `isFalse`. Every other operator needs `right` (`""` compares with empty text).

- `in` takes a comma-separated list (`"pending, paid"`) or a JSON list (`["pending", "paid"]`, saved as the
  comma-separated text).
- `equals` compares plain decimals as numbers (`"200"` equals `200`, `"1.50"` equals `1.5`) and everything else as
  exact text (`"007"` does not equal `"7"`). `gt`, `gte`, `lt` and `lte` compare numbers.
- Status filters (`expectStatus`, `status`): `200`, `2xx`, `200,201`, `200-299` or empty for any; anything else
  (other than a template, where one is allowed) is an error.
- `wait.log` with `regex` saves group 1 as `{{<id>.match}}` and every group as `{{<id>.groups}}` (`groups[0]` is
  the whole match).

## Automation

A flow with a `trigger.event` node and `automation.enabled` starts by itself while Dürbün is open, on the device
and app the event came from. A trigger without its own `appId` listens to the flow's `target.appId`.

- Events that arrive while a run of the flow is going are ignored; the throttle (`automation.throttleMs`) counts
  from the end of the flow's last automatic run.
- At most a few automatic runs go at once, and a flow never runs twice at the same time.
- A flow that keeps starting itself (5 runs in a row, each starting within twice the throttle of the previous
  run's end) has its automation switched off, with a notice.
- Imported shared flows come in with automation off; turn it on in the flow's settings.

## Writing flows with an AI

Flows → **Write with AI** copies a pack with this format, every node type and its parameters, your flows,
environment variable names and the app's recent request addresses (no headers, bodies or query values; ids,
tokens and e-mail addresses in paths show as `:id`, `:token`, `:email`). When you change a flow with it, secret
values in the flow (secret environment variables, secret input defaults) are replaced by the template that reads
them before the pack is copied. Paste it into the assistant you use, paste the answer back, and Dürbün checks it before saving. Read what
the AI wrote before you run it: a flow sends the requests and runs the device actions written in it.
