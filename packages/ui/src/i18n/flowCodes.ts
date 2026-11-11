import { registerMessages, translateOr, type Lang } from './core';

/**
 * Localization of the i18n codes of flows ("Akışlar"), Dürbün packages and automatic backups. Same rules as
 * codes.ts (keys under `code.`, candidates from most to least specific, the last one without params); codes.ts
 * merges FLOW_CODES into SERVER_CODES and FLOW_PREPARE into its derived-param preparers.
 *
 * Params the server really sends:
 *   Step summaries (FlowRunStep.code + params)
 *     flow.step.http                          { method, url, status, duration }   (duration: "142 ms" / "12.5 s")
 *     flow.step.httpBodyInferred              { method, url, status, duration, bodyType: json|text }
 *     flow.step.mockAddedWaiting              { url }
 *     flow.step.openedUrl / appInstalled      { url } / { file }
 *     flow.step.appLaunched|appStopped|appRestarted|appDataCleared|appUninstalled|pushSent   { app }
 *     flow.step.appearance / statusBar       { mode }
 *     flow.step.fontScale / location / textTyped / keyPressed   { scale } / { lat, lon } / { text } / { key }
 *     flow.step.animationsOn / animationsOff  —
 *     flow.step.sawRequest                    { method, url, status }             (status 0 = the request failed)
 *     flow.step.sawLog / sawEvent             { message } / { name }
 *     flow.step.waited                        { duration }
 *     flow.step.checksPassed                  { count }
 *     flow.step.conditionTrue / conditionFalse { explain }  (English "<left> — expected <op> <right>" of the rules that failed)
 *     flow.step.vars                          { names }   ("a, b")
 *     flow.step.screenshot / recordingSaved   { name }
 *     flow.step.recording                     { seconds }
 *     flow.step.mockAdded                     { url }
 *     flow.step.mockOn / mockOff / mockRemoved { rule }   (rule name, else its URL)
 *     flow.step.marker / note                 { label } / { text }
 *     flow.step.subflowPassed                 { flow }    (sub-flow name)
 *     flow.step.iteration / iterationStopped  { index (1-based), count }
 *     flow.step.repeated / repeatMet / repeatNotMet { count }
 *     flow.step.retrying                      { attempt, error }
 *     flow.step.slack / noErrors / disabled / cancelled   —
 *     flow.step.endPassed / endFailed         { message } (the end step's message, when it has one)
 *   Step errors (FlowRunStep.errorCode + params; FlowRun.errorCode of the failing step)
 *     flow.step.timeout                       { seconds }
 *     flow.http.method / invalidUrl / header  { method } / { url ('' = empty) } / { header }
 *     flow.http.failed                        { method, url, error }
 *     flow.http.status                        { method, url, status, duration, expected }
 *     flow.extract.missing                    { name, from: body|header|status|bodyText, path }
 *     flow.regex.invalid                      { pattern } (validation adds { param })
 *     flow.assert.failed / noErrors.found     { count, first }   (first: English text of the first failure)
 *     flow.repeat.notMet                      { count }
 *     flow.call.unknown                       { flow } (step: the id) / { flowId } (validation)
 *     flow.call.depth / call.input / call.failed { max } / { flow, name } / { flow, error }
 *     flow.sdk.missing                        { capability, app ('' = none) }
 *     flow.param.type / param.json            { param, expected } / { param }
 *     flow.mock.invalid / mock.notFound       { error } / { rule }
 *     flow.wait.network / wait.log / wait.event { url | text | name, timeout }   (timeout: "30.0 s")
 *     flow.template.syntax|unknownRoot|unknownHelper|unknownPipe  { ref } (also template.* thrown by the protocol)
 *     flow.node.unknownType                   { type }
 *     flow.app.missing, flow.device.missing, flow.screenshot.missing, flow.recording.missing, flow.slack.empty,
 *     flow.step.error                         { error } (the underlying error text)
 *     slack.failed                            —   (action.*, slack.*, device.* codes pass through from codes.ts)
 *   Run errors (FlowRun.errorCode + errorParams): flow.run.cancelled|interrupted|timeout —, flow.run.internal { error },
 *     flow.limit.steps { count }, flow.limit.visits { node, count }, flow.end.failed { message }; a failing step's code keeps its params
 *   Validation (FlowIssue.code + params)
 *     flow.format / version                   { format } / { version }
 *     flow.id.fixed, flow.node.idFixed        { from, to }
 *     flow.node.idGenerated|duplicateId|reservedId, flow.trigger.added   { id }
 *     flow.node.unknownType                   { type, suggestion ('' = none) }
 *     flow.node.unreachable                   { node }   (label, else id)
 *     flow.nodes.tooMany / edges.tooMany      { max }
 *     flow.edge.unknownNode / intoTrigger     { node }
 *     flow.edge.port                          { port, ports }
 *     flow.param.required                     { param }
 *     flow.param.range                        { param, min, max }   ('' when open)
 *     flow.param.option                       { param, value, options }
 *     flow.param.unknown                      { param, type }
 *     flow.rule.op / rule.right               { op }
 *     flow.param.jsonText / param.fixed       { param }   (param.fixed: also 'extract.path' / 'extract.regex')
 *     flow.param.status                       { param, value }
 *     flow.name.reserved                      { name }
 *     flow.extract.pathSyntax                 { detail } (English)
 *     flow.extract.pathFixed                  { from, to }
 *     flow.extract.name / assign.name / input.name / input.duplicate / output.name   { name }
 *     flow.extract.from                       { value }
 *     flow.template.syntax / unknownRoot      { detail } (English) / { root }
 *     flow.call.unknown                       { flowId }
 *     the rest                                —
 *   Preflight (FlowPreflightIssue.code + params; also the `code` of a skipped step)
 *     preflight.flow.invalid                  { problem, issue, …issue params }   (problem: English validation message; issue: its code)
 *     preflight.device.gone                   { device }    (device id)
 *     preflight.device.offline                { device, state }
 *     preflight.device.nonePlatform           { platform }
 *     preflight.device.noneSkipped            { count }   (device steps that will be skipped)
 *     preflight.device.auto                   { device }
 *     preflight.app.notInstalled              { app, device }
 *     preflight.action.emulator|simulator|tool|platform   { step (English node title), device, action }
 *     preflight.sdk.notConnected              { step, capability }
 *     preflight.call.unknown / call.recursive { flow }
 *     preflight.call.depth                    { flow, max }
 *     preflight.start.unknown                 { node }   (the step id "run from here" asked for)
 *     preflight.env.unknown                   { env }   (environment id)
 *     preflight.env.none                      { keys }
 *     preflight.env.missing / env.empty       { env, keys }
 *     preflight.input.missing                 { name }
 *     preflight.flow.noStart, preflight.flow.empty, preflight.device.none|missing, preflight.slack.notConfigured   —
 *   Notices: flow.automation.failed { flow, error, reason? (FlowRunError code) }, flow.automation.loop { flow, count },
 *            flow.file.unreadable { file, problem },
 *            backup.failed { error }
 *   Package inspect warnings: package.flow.invalid { problem }, package.flow.problems { flow, count }, package.mock.invalid { problem }
 *   Package import notices (PackageImportResult.notices): package.secrets.notRestored —, package.settings.ignored { keys },
 *     package.settings.failed / slack.failed / mocks.saveFailed { error }, package.slack.reconnect —,
 *     package.flow.saveFailed { flow, error }, package.run.failed { run, error }, package.flow.invalid / mock.invalid { problem }
 *   REST `{ error, code }` (errorText adds `detail` = the specific part of the English message):
 *     flow.notFound|tooMany|id.invalid|id.taken|id.reserved|running|engine.closed|run.tooMany|automation.busy|preflight.failed|invalid|format|version|nodes,
 *     flow.fromRequests.empty|gone, flowRun.notFound|notRunning, env.invalid, uiPrefs.invalid|tooLarge, body.invalid,
 *     api.method, package.*, backup.*
 * Derived params (computed here, never sent): `duration` / `timeout` localized ("12,5 sn"), `result` (sawRequest),
 * `expectedText` (param.type), `source` (extract.missing), `needs` (sdk), `stateText` / `platformName` (preflight),
 * `why` (automation.failed: the localized text of `reason`); `explain` loses empty "and"/"or" joints.
 */

/** Flow, package and backup codes, grouped by where they show up. codes.ts spreads them into SERVER_CODES. */
export const FLOW_CODES = {
  /** `FlowRunStep.code` of a step that passed, was skipped or stopped. */
  flowSteps: [
    'flow.step.http',
    'flow.step.sawRequest',
    'flow.step.sawLog',
    'flow.step.sawEvent',
    'flow.step.waited',
    'flow.step.checksPassed',
    'flow.step.conditionTrue',
    'flow.step.conditionFalse',
    'flow.step.vars',
    'flow.step.screenshot',
    'flow.step.recording',
    'flow.step.recordingSaved',
    'flow.step.mockAdded',
    'flow.step.mockOn',
    'flow.step.mockOff',
    'flow.step.mockRemoved',
    'flow.step.marker',
    'flow.step.note',
    'flow.step.slack',
    'flow.step.noErrors',
    'flow.step.subflowPassed',
    'flow.step.iteration',
    'flow.step.iterationStopped',
    'flow.step.repeated',
    'flow.step.repeatMet',
    'flow.step.repeatNotMet',
    'flow.step.retrying',
    'flow.step.disabled',
    'flow.step.cancelled',
    'flow.step.endPassed',
    'flow.step.endFailed',
    'flow.step.httpBodyInferred',
    'flow.step.mockAddedWaiting',
    'flow.step.openedUrl',
    'flow.step.appLaunched',
    'flow.step.appStopped',
    'flow.step.appRestarted',
    'flow.step.appDataCleared',
    'flow.step.appInstalled',
    'flow.step.appUninstalled',
    'flow.step.appearance',
    'flow.step.fontScale',
    'flow.step.location',
    'flow.step.pushSent',
    'flow.step.textTyped',
    'flow.step.keyPressed',
    'flow.step.statusBar',
    'flow.step.animationsOn',
    'flow.step.animationsOff',
  ],
  /** `FlowRunStep.errorCode` (and `code`) of a failed step; the run's `errorCode` when nothing handled it. */
  flowErrors: [
    'flow.step.error',
    'flow.step.timeout',
    'flow.app.missing',
    'flow.device.missing',
    'flow.sdk.missing',
    'flow.http.method',
    'flow.http.invalidUrl',
    'flow.http.header',
    'flow.http.failed',
    'flow.http.status',
    'flow.extract.missing',
    'flow.regex.invalid',
    'flow.assert.failed',
    'flow.noErrors.found',
    'flow.repeat.notMet',
    'flow.call.unknown',
    'flow.call.depth',
    'flow.call.input',
    'flow.call.failed',
    'flow.param.type',
    'flow.param.json',
    'flow.mock.invalid',
    'flow.mock.notFound',
    'flow.screenshot.missing',
    'flow.recording.missing',
    'flow.slack.empty',
    'slack.failed',
    'flow.wait.network',
    'flow.wait.log',
    'flow.wait.event',
    'flow.node.unknownType',
    'flow.template.syntax',
    'flow.template.unknownRoot',
    'flow.template.unknownHelper',
    'flow.template.unknownPipe',
    'flow.end.failed',
  ],
  /** `FlowRun.errorCode` of a run that stopped as a whole. */
  flowRuns: ['flow.run.cancelled', 'flow.run.interrupted', 'flow.run.timeout', 'flow.run.internal', 'flow.limit.steps', 'flow.limit.visits', 'flow.end.failed'],
  /** `notice` messages. */
  flowNotices: ['flow.automation.failed', 'flow.automation.loop', 'flow.file.unreadable', 'backup.failed'],
  /** `FlowIssue.code` (editor, import preview, AI round trip). */
  flowValidation: [
    'flow.invalid',
    'flow.format',
    'flow.version',
    'flow.nodes',
    'flow.nodes.tooMany',
    'flow.edges',
    'flow.edges.tooMany',
    'flow.name.missing',
    'flow.id.fixed',
    'flow.node.invalid',
    'flow.node.unknownType',
    'flow.node.idGenerated',
    'flow.node.idFixed',
    'flow.node.duplicateId',
    'flow.node.reservedId',
    'flow.node.timeout',
    'flow.node.retry',
    'flow.node.params',
    'flow.node.unreachable',
    'flow.param.required',
    'flow.param.type',
    'flow.param.range',
    'flow.param.option',
    'flow.param.unknown',
    'flow.param.jsonText',
    'flow.param.status',
    'flow.param.fixed',
    'flow.mock.delay',
    'flow.name.reserved',
    'flow.rule.op',
    'flow.rule.left',
    'flow.rule.right',
    'flow.extract.name',
    'flow.extract.from',
    'flow.extract.regex',
    'flow.extract.path',
    'flow.extract.pathSyntax',
    'flow.extract.pathFixed',
    'flow.assign.name',
    'flow.inputs',
    'flow.input.name',
    'flow.input.duplicate',
    'flow.outputs',
    'flow.output.name',
    'flow.edge.invalid',
    'flow.edge.unknownNode',
    'flow.edge.port',
    'flow.edge.intoTrigger',
    'flow.edge.duplicate',
    'flow.trigger.added',
    'flow.trigger.missing',
    'flow.trigger.unconnected',
    'flow.target.platform',
    'flow.settings.onUnsupported',
    'flow.settings.timeout',
    'flow.automation.noEvent',
    'flow.call.self',
    'flow.call.unknown',
    'flow.template.syntax',
    'flow.template.unknownRoot',
  ],
  /** `TemplateError.code` of the protocol's template resolver (the UI passes `{ ref }`). */
  templates: ['template.syntax', 'template.unknownRoot', 'template.unknownHelper', 'template.unknownPipe'],
  /** `FlowPreflightIssue.code`; also the `code` of a step skipped because the target cannot run it. */
  preflight: [
    'preflight.flow.invalid',
    'preflight.flow.noStart',
    'preflight.flow.empty',
    'preflight.device.gone',
    'preflight.device.offline',
    'preflight.device.none',
    'preflight.device.nonePlatform',
    'preflight.device.noneSkipped',
    'preflight.device.auto',
    'preflight.device.missing',
    'preflight.app.notInstalled',
    'preflight.action.emulator',
    'preflight.action.simulator',
    'preflight.action.tool',
    'preflight.action.platform',
    'preflight.sdk.notConnected',
    'preflight.slack.notConfigured',
    'preflight.call.unknown',
    'preflight.call.recursive',
    'preflight.env.unknown',
    'preflight.env.none',
    'preflight.env.missing',
    'preflight.env.empty',
    'preflight.input.missing',
    'preflight.start.unknown',
    'preflight.call.depth',
  ],
  /** REST errors and inspect warnings of `.durbun` packages. */
  packages: [
    'package.invalid',
    'package.isFlow',
    'package.isSession',
    'package.version',
    'package.crypto.unknown',
    'package.passphrase.wrong',
    'package.expired',
    'package.flow.invalid',
    'package.flow.problems',
    'package.crypto.invalid',
    'package.passphrase.short',
    'package.tooLarge',
    'package.damaged',
    'package.mock.invalid',
    // Import warnings (PackageImportResult.notices)
    'package.secrets.notRestored',
    'package.settings.ignored',
    'package.settings.failed',
    'package.slack.failed',
    'package.slack.reconnect',
    'package.flow.saveFailed',
    'package.mocks.saveFailed',
    'package.run.failed',
  ],
  /** REST errors of Settings → Backup. */
  backup: [
    'backup.invalid',
    'backup.folder.invalid',
    'backup.folder.unwritable',
    'backup.folder.unavailable',
    'backup.folder.missing',
    'backup.passphrase.short',
    'backup.notFound',
    'backup.unreadable',
    'backup.failed',
  ],
  /** REST `{ error, code }` of the flows API. */
  flowRest: [
    'flow.notFound',
    'flow.tooMany',
    'flow.id.invalid',
    'flow.id.taken',
    'flow.running',
    'flow.engine.closed',
    'flow.run.tooMany',
    'flow.preflight.failed',
    'flow.fromRequests.empty',
    'flow.fromRequests.gone',
    'flowRun.notFound',
    'flowRun.notRunning',
    'env.invalid',
    'uiPrefs.invalid',
    'uiPrefs.tooLarge',
    'body.invalid',
    'api.method',
    'flow.automation.busy',
    'flow.id.reserved',
  ],
} as const satisfies Record<string, readonly string[]>;

registerMessages('code', {
  tr: {
    /* ── step summaries ── */
    'flow.step.http': ['{method} {url} → {status} · {duration}', '{method} {url} → {status}', 'İstek gönderildi, yanıt geldi'],
    'flow.step.sawRequest': ['{method} {url} → {result}', '{method} {url}', 'Beklenen istek görüldü'],
    'flow.step.sawLog': ['Log satırı: {message}', 'Beklenen log satırı geldi'],
    'flow.step.sawEvent': ['“{name}” olayı geldi', 'Beklenen olay geldi'],
    'flow.step.waited': ['{duration} beklendi', 'Beklendi'],
    'flow.step.checksPassed': ['{count, number} kontrol geçti', 'Kontroller geçti'],
    'flow.step.conditionTrue': 'Koşul sağlandı',
    'flow.step.conditionFalse': ['Koşul sağlanmadı: {explain}', 'Koşul sağlanmadı'],
    'flow.step.vars': ['Değişkenler ayarlandı: {names}', 'Değişkenler ayarlandı'],
    'flow.step.screenshot': ['Ekran görüntüsü alındı: {name}', 'Ekran görüntüsü alındı'],
    'flow.step.recording': ['Ekran kaydı başladı (en fazla {seconds, number} sn)', 'Ekran kaydı başladı'],
    'flow.step.recordingSaved': ['Ekran kaydı kaydedildi: {name}', 'Ekran kaydı kaydedildi'],
    'flow.step.mockAdded': ['Mock kuralı eklendi: {url}', 'Mock kuralı eklendi'],
    'flow.step.mockOn': ['Mock kuralı açıldı: {rule}', 'Mock kuralı açıldı'],
    'flow.step.mockOff': ['Mock kuralı kapatıldı: {rule}', 'Mock kuralı kapatıldı'],
    'flow.step.mockRemoved': ['Mock kuralı silindi: {rule}', 'Mock kuralı silindi'],
    'flow.step.marker': ['İşaret eklendi: {label}', 'İşaret eklendi'],
    'flow.step.note': ['{text}', 'Not'],
    'flow.step.slack': 'Slack’e gönderildi',
    'flow.step.noErrors': 'Çökme ya da hata yok',
    'flow.step.subflowPassed': ['{flow} alt akışı geçti', 'Alt akış geçti'],
    'flow.step.iteration': ['Tur {index, number} / {count, number}', 'Turlar sürüyor'],
    'flow.step.iterationStopped': ['{count, number} turun {index, number}. turunda durduruldu', 'Turlar durduruldu'],
    'flow.step.repeated': ['{count, number} tur tamamlandı', 'Turlar tamamlandı'],
    'flow.step.repeatMet': ['{count, number}. turda koşul sağlandı', 'Koşul sağlandı'],
    'flow.step.repeatNotMet': ['{count, number} tur bitti; koşul sağlanmadı', 'Turlar bitti; koşul sağlanmadı'],
    'flow.step.retrying': ['{attempt, number}. deneme başarısız: {error}; yeniden deneniyor', '{attempt, number}. deneme başarısız; yeniden deneniyor', 'Yeniden deneniyor'],
    'flow.step.disabled': 'Kapalı olduğu için atlandı',
    'flow.step.cancelled': 'Durduruldu',
    'flow.step.endPassed': ['Akış bitti: geçti — {message}', 'Akış bitti: geçti'],
    'flow.step.endFailed': ['Akış bitti: başarısız — {message}', 'Akış bitti: başarısız'],
    'flow.step.httpBodyInferred': [
      '{method} {url} → {status} · {duration} (gövde {bodyType} olarak gönderildi; adımda gövde türünü seçin)',
      '{method} {url} → {status} (gövde {bodyType} olarak gönderildi; adımda gövde türünü seçin)',
      'İstek gönderildi; gövde türü adımda seçili değildi, tahmin edildi',
    ],
    'flow.step.mockAddedWaiting': [
      'Mock kuralı eklendi: {url} (uygulama henüz bağlı değil; bağlanınca kural geçerli olur)',
      'Mock kuralı eklendi (uygulama henüz bağlı değil; bağlanınca kural geçerli olur)',
    ],
    'flow.step.openedUrl': ['Açıldı: {url}', 'Bağlantı açıldı'],
    'flow.step.appLaunched': ['{app} başlatıldı', 'Uygulama başlatıldı'],
    'flow.step.appStopped': ['{app} durduruldu', 'Uygulama durduruldu'],
    'flow.step.appRestarted': ['{app} yeniden başlatıldı', 'Uygulama yeniden başlatıldı'],
    'flow.step.appDataCleared': ['{app} verileri silindi', 'Uygulama verileri silindi'],
    'flow.step.appInstalled': ['{file} yüklendi', 'Uygulama yüklendi'],
    'flow.step.appUninstalled': ['{app} kaldırıldı', 'Uygulama kaldırıldı'],
    'flow.step.appearance': ['Görünüm: {mode}', 'Görünüm değiştirildi'],
    'flow.step.fontScale': ['Yazı boyutu ×{scale}', 'Yazı boyutu değiştirildi'],
    'flow.step.location': ['Konum: {lat}, {lon}', 'Konum ayarlandı'],
    'flow.step.pushSent': ['{app} uygulamasına bildirim gönderildi', 'Bildirim gönderildi'],
    'flow.step.textTyped': ['Yazıldı: “{text}”', 'Metin yazıldı'],
    'flow.step.keyPressed': ['Tuşa basıldı: {key}', 'Tuşa basıldı'],
    'flow.step.statusBar': ['Durum çubuğu: {mode}', 'Durum çubuğu değiştirildi'],
    'flow.step.animationsOn': 'Animasyonlar açıldı',
    'flow.step.animationsOff': 'Animasyonlar kapatıldı',

    /* ── step errors ── */
    'flow.step.error': ['Adım başarısız oldu: {error}', 'Adım başarısız oldu'],
    'flow.step.timeout': ['Adım {seconds, number} sn içinde bitmedi', 'Adım zamanında bitmedi'],
    'flow.app.missing': 'Uygulama belli değil: adıma bir uygulama kimliği yazın ya da çalıştırmanın uygulamasını seçin',
    'flow.device.missing': 'Bu adım bir cihaz gerektiriyor; çalıştırma için bir cihaz seçin',
    'flow.sdk.missing': [
      '{app} Dürbün SDK’sıyla bağlı değil; {needs}',
      '{app} Dürbün SDK’sıyla bağlı değil; bu adım uygulamayı SDK olmadan göremez',
      'Dürbün SDK’sıyla bağlı uygulama yok; bu adım SDK olmadan çalışmaz',
    ],
    'flow.http.method': ['Geçersiz HTTP metodu: {method}', 'Geçersiz HTTP metodu'],
    'flow.http.invalidUrl': ['Geçersiz URL: {url} (http:// ya da https:// ile başlamalı)', 'URL boş ya da geçersiz'],
    'flow.http.header': ['“{header}” başlığı geçersiz: adında izin verilmeyen bir karakter ya da değerinde satır sonu var', 'Geçersiz başlık'],
    'flow.http.failed': ['{method} {url} için yanıt alınamadı: {error}', '{method} {url} için yanıt alınamadı', 'İstek için yanıt alınamadı'],
    'flow.http.status': [
      'Durum kodu {status} geldi, {expected} bekleniyordu ({method} {url})',
      'Durum kodu {status} geldi, {expected} bekleniyordu',
      'Beklenmeyen durum kodu',
    ],
    'flow.extract.missing': ['{name} yanıttan okunamadı ({source} {path})', '{name} yanıttan okunamadı ({source})', '{name} yanıttan okunamadı', 'Yanıttan bir değer okunamadı'],
    'flow.regex.invalid': ['Geçersiz regex: {pattern}', 'Geçersiz regex'],
    'flow.assert.failed': [
      { one: 'Kontrol başarısız: {first}', other: '{count, number} kontrol başarısız; ilki: {first}' },
      '{count, number} kontrol başarısız',
      'Kontrol başarısız',
    ],
    'flow.noErrors.found': [
      { one: 'Bir sorun bulundu: {first}', other: '{count, number} sorun bulundu; ilki: {first}' },
      '{count, number} sorun bulundu',
      'Çökme ya da hata bulundu',
    ],
    'flow.repeat.notMet': ['Koşul {count, number} turda sağlanmadı', 'Koşul turlar içinde sağlanmadı'],
    'flow.call.unknown': ['“{flow}” akışı yok', '“{flowId}” kimlikli akış yok; onu da içe aktarın ya da akış kimliğini düzeltin', 'Çağrılan akış bulunamadı'],
    'flow.call.depth': ['Alt akışlar en fazla {max, number} kat iç içe çalışabilir', 'Alt akışlar çok derin iç içe'],
    'flow.call.input': ['{flow} için “{name}” girdisi gerekli', 'Alt akışın gerekli bir girdisi eksik'],
    'flow.call.failed': ['{flow} alt akışı başarısız: {error}', '{flow} alt akışı başarısız oldu', 'Alt akış başarısız oldu'],
    'flow.param.type': ['{param}: {expectedText} olmalı', '{param}: değer türü yanlış', 'Değer türü yanlış'],
    'flow.param.json': ['{param} geçerli bir JSON değil', 'Değer geçerli bir JSON değil'],
    'flow.mock.invalid': ['Mock kuralı geçersiz: {error}', 'Mock kuralı geçersiz'],
    'flow.mock.notFound': ['“{rule}” adında mock kuralı yok', 'Mock kuralı bulunamadı'],
    'flow.screenshot.missing': 'Cihaz ekran görüntüsünü vermedi',
    'flow.recording.missing': 'Cihaz ekran kaydını vermedi',
    'flow.slack.empty': 'Slack mesajı boş',
    'slack.failed': 'Slack’e gönderilemedi',
    'flow.wait.network': ['{timeout} içinde “{url}” ile eşleşen istek gelmedi', '“{url}” ile eşleşen istek gelmedi', 'Beklenen istek gelmedi'],
    'flow.wait.log': ['{timeout} içinde “{text}” ile eşleşen log satırı gelmedi', '“{text}” ile eşleşen log satırı gelmedi', 'Beklenen log satırı gelmedi'],
    'flow.wait.event': ['Uygulama {timeout} içinde “{name}” olayını göndermedi', 'Uygulama “{name}” olayını göndermedi', 'Beklenen olay gelmedi'],
    'flow.node.unknownType': ['Bilinmeyen adım türü “{type}”; “{suggestion}” mı demek istediniz?', 'Bilinmeyen adım türü: {type}', 'Bilinmeyen adım türü'],
    'flow.template.syntax': ['Şablon okunamadı: {ref}', 'Şablon yazımı hatalı: {detail}', 'Şablon yazımı hatalı'],
    'flow.template.unknownRoot': [
      'Şablon henüz olmayan bir değeri okuyor: {ref}',
      'Şablon hiçbir şey okumuyor: “{root}” adında adım yok (adım kimliği, vars, env, input, target, trigger ya da run kullanın)',
      'Şablon tanınmayan bir ad okuyor',
    ],
    'flow.template.unknownHelper': ['Bilinmeyen şablon yardımcısı: {ref}', 'Bilinmeyen şablon yardımcısı'],
    'flow.template.unknownPipe': ['Şablonda bilinmeyen dönüştürme (pipe): {ref}', 'Şablonda bilinmeyen dönüştürme (pipe)'],
    'flow.end.failed': ['Akış başarısız olarak bitirildi: {message}', 'Akış “başarısız” sonuyla bitirildi'],

    /* ── run errors ── */
    'flow.run.cancelled': 'Çalıştırma durduruldu',
    'flow.run.interrupted': 'Çalıştırma sürerken Dürbün kapandı',
    'flow.run.timeout': 'Çalıştırma, akışın süre sınırı içinde bitmedi',
    'flow.run.internal': ['Dürbün’de bir iç hata oluştu; çalıştırma durdu ({error})', 'Dürbün’de bir iç hata oluştu; çalıştırma durdu'],
    'flow.limit.steps': ['Çalıştırma {count, number} adım sınırına ulaştı; akışta sonsuz bir döngü olabilir', 'Çalıştırma adım sınırına ulaştı; akışta sonsuz bir döngü olabilir'],
    'flow.limit.visits': ['“{node}” adımı {count, number} kez çalıştı; akışta sonsuz bir döngü olabilir', 'Bir adım çok kez çalıştı; akışta sonsuz bir döngü olabilir'],

    /* ── notices ── */
    'flow.automation.failed': [
      '“{flow}” otomatik akışı başlatılamadı: {why}',
      '“{flow}” otomatik akışı başlatılamadı: {error}',
      '“{flow}” otomatik akışı başlatılamadı',
      'Otomatik bir akış başlatılamadı',
    ],
    'flow.automation.loop': [
      '“{flow}” akışının otomatik çalıştırması kapatıldı: art arda {count, number} kez, bir önceki çalıştırma biter bitmez yeniden başladı',
      '“{flow}” akışının otomatik çalıştırması kapatıldı: bir önceki çalıştırma biter bitmez yeniden başlayıp duruyordu',
      'Bir akışın otomatik çalıştırması kapatıldı: kendini art arda yeniden başlatıyordu',
    ],
    'flow.file.unreadable': [
      '{file} akış dosyası okunamadı ({problem}); dosyaya dokunulmadı',
      '{file} akış dosyası okunamadı; dosyaya dokunulmadı',
      'Bir akış dosyası okunamadı; dosyaya dokunulmadı',
    ],
    'backup.failed': ['Otomatik yedekleme başarısız oldu: {error}', 'Yedekleme başarısız oldu: {detail}', 'Yedekleme başarısız oldu'],

    /* ── validation ── */
    'flow.invalid': 'Bu bir Dürbün akışı değil (JSON nesnesi bekleniyordu)',
    'flow.format': ['Bu bir Dürbün akışı değil (biçim: {format})', 'Bu bir Dürbün akışı değil'],
    'flow.version': ['Bu Dürbün, akış sürümü {version} olan dosyaları okuyamıyor; Dürbün’ü güncelleyin', 'Bu Dürbün bu akış sürümünü okuyamıyor; Dürbün’ü güncelleyin'],
    'flow.nodes': 'Akışın adım listesi (nodes) eksik ya da liste değil',
    'flow.nodes.tooMany': ['Bir akışta en fazla {max, number} adım olabilir', 'Akışta çok fazla adım var'],
    'flow.edges': 'Akışın bağlantı listesi (edges) liste değil',
    'flow.edges.tooMany': ['Bir akışta en fazla {max, number} bağlantı olabilir', 'Akışta çok fazla bağlantı var'],
    'flow.name.missing': 'Akışın adı yoktu; geçici bir ad verildi',
    'flow.id.fixed': ['“{from}” akış kimliği “{to}” olarak düzeltildi (yalnızca a-z, 0-9, - ve _)', 'Akış kimliği düzeltildi (yalnızca a-z, 0-9, - ve _)'],
    'flow.node.invalid': 'Bir adım JSON nesnesi değil',
    'flow.node.idGenerated': ['Kimliği olmayan bir adıma “{id}” kimliği verildi', 'Kimliği olmayan bir adıma kimlik verildi'],
    'flow.node.idFixed': ['“{from}” adım kimliği “{to}” olarak düzeltildi (yalnızca harf, rakam ve _)', 'Bir adım kimliği düzeltildi (yalnızca harf, rakam ve _)'],
    'flow.node.duplicateId': ['İki adım aynı kimliği kullanıyor: {id}', 'İki adım aynı kimliği kullanıyor'],
    'flow.node.reservedId': ['“{id}” şablonlar için ayrılmış; başka bir adım kimliği seçin', 'Bu adım kimliği şablonlar için ayrılmış; başka bir kimlik seçin'],
    'flow.node.timeout': 'Adımın zaman aşımı 100 ms ile 24 saat arasında olmalı',
    'flow.node.retry': 'Yeniden deneme sayısı 0 ile 100 arasında olmalı',
    'flow.node.params': 'Adımın parametreleri (params) bir nesne olmalı',
    'flow.node.unreachable': ['“{node}” adımına hiçbir tetikleyiciden ulaşılmıyor', 'Bu adıma hiçbir tetikleyiciden ulaşılmıyor'],
    'flow.param.required': ['{param} gerekli', 'Gerekli bir değer eksik'],
    'flow.param.range': ['{param}, {min, number} ile {max, number} arasında olmalı', '{param} izin verilen aralığın dışında', 'Değer izin verilen aralığın dışında'],
    'flow.param.option': ['{param} şunlardan biri olmalı: {options} (“{value}” geçersiz)', '{param} şunlardan biri olmalı: {options}', 'Geçersiz seçenek'],
    'flow.param.unknown': ['{type} adımında “{param}” diye bir parametre yok; yok sayıldı', 'Tanınmayan bir parametre yok sayıldı'],
    'flow.rule.op': ['Bilinmeyen karşılaştırma: “{op}”', 'Bilinmeyen karşılaştırma'],
    'flow.rule.left': 'Kuralın sol tarafı boş',
    'flow.rule.right': ['“{op}” karşılaştırması bir sağ taraf ister; karşılaştırılacak değeri yazın', 'Kuralın sağ tarafı eksik'],
    'flow.param.jsonText': ['{param} JSON olarak yazılmıştı; JSON metni olarak tutuldu', 'Bir değer JSON olarak yazılmıştı; JSON metni olarak tutuldu'],
    'flow.param.status': ['{param}: “{value}” bir durum kodu filtresi değil (200, 2xx, 200,201 ya da 200-299 yazın)', 'Durum kodu filtresi hatalı (200, 2xx, 200,201 ya da 200-299 yazın)'],
    'flow.param.fixed': ['{param} olduğu gibi okunur: şablon içeremez, sabit bir değer yazın', 'Bu değer olduğu gibi okunur: şablon içeremez, sabit bir değer yazın'],
    'flow.mock.delay': '“Geciktir” mock’u için 0’dan büyük bir gecikme (ms) yazın',
    'flow.name.reserved': ['“{name}” ayrılmış bir ad; başka bir ad seçin', 'Bu ad ayrılmış; başka bir ad seçin'],
    'flow.extract.pathSyntax': ['Okuma yolu hatalı: {detail} (gövde yolu items[0].id gibi yazılır)', 'Okuma yolu hatalı (gövde yolu items[0].id gibi yazılır)'],
    'flow.extract.pathFixed': ['“{from}” yolu “{to}” olarak okundu (yol gövdeden başlar, “$” yazılmaz)', 'Okuma yolu düzeltildi (yol gövdeden başlar, “$” yazılmaz)'],
    'flow.extract.name': ['Değişken adı “{name}” geçersiz: yalnızca harf, rakam ve _ kullanılabilir', 'Değişken adında yalnızca harf, rakam ve _ kullanılabilir'],
    'flow.extract.from': [
      'Değer yanıtın gövdesinden, bir başlığından, durum kodundan ya da gövde metninden okunabilir (“{value}” geçersiz)',
      'Değer yanıtın gövdesinden, bir başlığından, durum kodundan ya da gövde metninden okunabilir',
    ],
    'flow.extract.regex': 'Okuma kuralındaki regex geçersiz',
    'flow.extract.path': 'Başlıktan okumak için başlığın adını yazın',
    'flow.assign.name': ['Değişken adı “{name}” geçersiz: yalnızca harf, rakam ve _ kullanılabilir', 'Değişken adında yalnızca harf, rakam ve _ kullanılabilir'],
    'flow.inputs': 'Girdi listesi (inputs) geçersiz: her girdinin bir adı olmalı',
    'flow.input.name': ['Girdi adı “{name}” geçersiz: yalnızca harf, rakam ve _ kullanılabilir', 'Girdi adında yalnızca harf, rakam ve _ kullanılabilir'],
    'flow.input.duplicate': ['İki girdi aynı adı taşıyor: {name}', 'İki girdi aynı adı taşıyor'],
    'flow.outputs': 'Çıktı listesi (outputs) geçersiz: her çıktının bir adı ve değeri olmalı',
    'flow.output.name': ['Çıktı adı “{name}” geçersiz: yalnızca harf, rakam ve _ kullanılabilir', 'Çıktı adında yalnızca harf, rakam ve _ kullanılabilir'],
    'flow.edge.invalid': 'Bağlantı geçersiz: nereden (from) ve nereye (to) gittiği yazılmalı',
    'flow.edge.unknownNode': ['Bağlantının ucundaki “{node}” adımı yok', 'Bağlantının ucundaki adım yok'],
    'flow.edge.port': ['Bu adımın “{port}” çıkışı yok (çıkışları: {ports})', 'Bu adımın böyle bir çıkışı yok'],
    'flow.edge.intoTrigger': ['“{node}” bir tetikleyici; ona bağlantı gelemez', 'Tetikleyicilere bağlantı gelemez'],
    'flow.edge.duplicate': ['{from} → {to} bağlantısı iki kez vardı; fazlası kaldırıldı', 'Aynı bağlantı iki kez vardı; fazlası kaldırıldı'],
    'flow.trigger.added': ['Akışta tetikleyici yoktu; başa “{id}” elle başlatma tetikleyicisi eklendi', 'Akışta tetikleyici yoktu; başa bir elle başlatma tetikleyicisi eklendi'],
    'flow.trigger.missing': 'Akışın bir tetikleyicisi olmalı (elle başlatma ya da olay)',
    'flow.trigger.unconnected': 'Bu tetikleyici hiçbir adıma bağlı değil',
    'flow.target.platform': 'Hedef platform Android, iOS ya da herhangi biri (any) olmalı',
    'flow.settings.onUnsupported': 'Desteklenmeyen adımlar ayarı skip (atla) ya da fail (başarısız say) olmalı',
    'flow.settings.timeout': 'Akışın süre sınırı 1 sn ile 24 saat arasında olmalı',
    'flow.automation.noEvent': 'Otomatik çalıştırma açık ama akışta olay tetikleyicisi yok',
    'flow.call.self': 'Bir akış kendini çağıramaz',

    /* ── template errors ── */
    'template.syntax': ['Şablon okunamadı: {ref}', 'Şablon yazımı hatalı'],
    'template.unknownRoot': ['Şablon henüz olmayan bir değeri okuyor: {ref}', 'Şablon tanınmayan bir ad okuyor'],
    'template.unknownHelper': ['Bilinmeyen şablon yardımcısı: {ref}', 'Bilinmeyen şablon yardımcısı'],
    'template.unknownPipe': ['Şablonda bilinmeyen dönüştürme (pipe): {ref}', 'Şablonda bilinmeyen dönüştürme (pipe)'],

    /* ── preflight ── */
    'preflight.flow.invalid': ['Akışta düzeltilmesi gereken bir hata var: {problem}', 'Akışta düzeltilmesi gereken bir hata var'],
    'preflight.flow.noStart': 'Akışta başlanacak bir adım yok',
    'preflight.flow.empty': 'Başlangıç hiçbir adıma bağlı değil; çalıştıracak bir şey yok',
    'preflight.device.gone': ['Seçilen cihaz artık bağlı değil ({device})', 'Seçilen cihaz artık bağlı değil'],
    'preflight.device.offline': ['{device} hazır değil ({stateText})', '{device} hazır değil', 'Seçilen cihaz hazır değil'],
    'preflight.device.none': 'Bağlı cihaz yok; akışta cihaz adımları var',
    'preflight.device.nonePlatform': ['Bağlı {platformName} cihazı yok; akışta cihaz adımları var', 'Akışın platformunda bağlı cihaz yok; akışta cihaz adımları var'],
    'preflight.device.noneSkipped': [
      { one: 'Bağlı cihaz yok; cihaz adımı atlanacak', other: 'Bağlı cihaz yok; {count, number} cihaz adımı atlanacak' },
      'Bağlı cihaz yok; cihaz adımları atlanacak',
    ],
    'preflight.device.auto': ['{device} üzerinde çalışacak. Başka bir cihaz için hedefi değiştirin.', 'Cihaz kendiliğinden seçildi. Başka bir cihaz için hedefi değiştirin.'],
    'preflight.device.missing': 'Bu adım bağlı bir cihaz gerektiriyor',
    'preflight.app.notInstalled': ['{device} cihazında {app} görülmedi', 'Cihazda {app} görülmedi', 'Uygulama cihazda görülmedi'],
    'preflight.action.emulator': ['{device} bu adımı çalıştıramaz: yalnızca Android emülatöründe çalışır', 'Bu adım yalnızca Android emülatöründe çalışır'],
    'preflight.action.simulator': ['{device} bu adımı çalıştıramaz: yalnızca iOS simülatöründe çalışır', 'Bu adım yalnızca iOS simülatöründe çalışır'],
    'preflight.action.tool': ['{device} bu adımı şu an çalıştıramaz: gerekli bir araç eksik', 'Bu adım şu an çalıştırılamıyor: gerekli bir araç eksik'],
    'preflight.action.platform': ['{device} bu adımı desteklemiyor', 'Bu cihazın platformu bu adımı desteklemiyor'],
    'preflight.sdk.notConnected': [
      'Uygulama şu an Dürbün SDK’sıyla bağlı değil; {needs}. Adım başlayınca bağlantıyı kısa bir süre bekler',
      'Uygulama şu an Dürbün SDK’sıyla bağlı değil; adım başlayınca bağlantıyı kısa bir süre bekler',
    ],
    'preflight.slack.notConfigured': 'Slack bağlı değil (Ayarlar → Slack)',
    'preflight.call.unknown': ['Bu adımın çalıştırdığı “{flow}” akışı yok', 'Bu adımın çalıştırdığı akış yok'],
    'preflight.call.recursive': [
      '{flow} kendini çağırıyor (doğrudan ya da başka akışlar üzerinden); çemberi kapatan çağrıyı kaldırın',
      'Bir alt akış kendini çağırıyor; çemberi kapatan çağrıyı kaldırın',
    ],
    'preflight.env.unknown': ['“{env}” ortamı yok', 'Seçilen ortam yok'],
    'preflight.env.none': ['Akış ortam değişkenlerini okuyor ({keys}) ama ortam seçilmedi', 'Akış ortam değişkenlerini okuyor ama ortam seçilmedi'],
    'preflight.env.missing': ['{env} ortamında eksik değişken: {keys}', 'Seçilen ortamda bazı değişkenler eksik'],
    'preflight.env.empty': ['{env} ortamında boş değişken: {keys}', 'Seçilen ortamda bazı değişkenler boş'],
    'preflight.input.missing': ['“{name}” girdisi gerekli', 'Gerekli bir girdi eksik'],
    'preflight.start.unknown': ['Başlanacak “{node}” adımı akışta yok; akışı yeniden açıp tekrar deneyin', 'Başlanacak adım akışta yok; akışı yeniden açıp tekrar deneyin'],
    'preflight.call.depth': [
      'Alt akışlar {flow} akışında {max, number} kattan derine iniyor',
      'Alt akışlar en fazla {max, number} kat iç içe çalışabilir',
      'Alt akışlar çok derin iç içe',
    ],

    /* ── packages ── */
    'package.invalid': 'Bu dosya geçerli bir Dürbün paketi değil',
    'package.isFlow': 'Bu bir akış dosyası: Akışlar’dan içe aktarın',
    'package.isSession': 'Bu bir oturum kaydı: “Oturum içe aktar” ile açın',
    'package.version': 'Bu Dürbün bu paket sürümünü okuyamıyor; Dürbün’ü güncelleyin',
    'package.crypto.unknown': 'Paketteki şifreleme bu Dürbün sürümünde tanınmıyor',
    'package.passphrase.wrong': 'Parola yanlış ya da dosya kaydedildikten sonra değiştirilmiş',
    'package.expired': 'Dosya artık açık değil; yeniden seçin',
    'package.flow.invalid': ['Paketteki bir akış okunamadı: {problem}', 'Paketteki bir akış okunamadı'],
    'package.flow.problems': ['{flow} akışında {count, number} hata var', 'Paketteki bir akışta hata var'],
    'package.crypto.invalid': 'Paketin şifreli kısmı bozuk',
    'package.passphrase.short': 'Parola çok kısa; en az 8 karakter kullanın',
    'package.tooLarge': ['Dosya çok büyük (en fazla {limit})', 'Dosya çok büyük'],
    'package.damaged': 'Dosya bozuk ya da eksik; hâlâ eşitleniyor olabilir',
    'package.mock.invalid': ['Paketteki bir mock kuralı okunamadı: {problem}', 'Paketteki bir mock kuralı okunamadı'],
    'package.secrets.notRestored': 'Gizli değerler gelmedi: paket parolayla korunuyor',
    'package.settings.ignored': ['Tanınmayan ayarlar atlandı: {keys}', 'Tanınmayan ayarlar atlandı'],
    'package.settings.failed': ['Ayarlar uygulanamadı: {error}', 'Ayarlar uygulanamadı'],
    'package.slack.failed': ['Slack bağlantısı geri yüklenemedi: {error}', 'Slack bağlantısı geri yüklenemedi'],
    'package.slack.reconnect': 'Slack’i Ayarlar’dan yeniden bağlayın: bağlantı yalnızca şifreli bir yedekle taşınır',
    'package.flow.saveFailed': ['{flow} kaydedilemedi: {error}', '{flow} kaydedilemedi', 'Bir akış kaydedilemedi'],
    'package.mocks.saveFailed': ['Mock kuralları kaydedilemedi: {error}', 'Mock kuralları kaydedilemedi'],
    'package.run.failed': ['{run} çalıştırması alınamadı: {error}', '{run} çalıştırması alınamadı', 'Bir çalıştırma alınamadı'],

    /* ── backup ── */
    'backup.invalid': 'Yedekleme ayarları geçersiz',
    'backup.folder.invalid': 'Klasörün tam yolunu seçin (/ ya da ~ ile başlayan)',
    'backup.folder.unwritable': ['Dürbün bu klasöre yazamıyor: {detail}', 'Dürbün bu klasöre yazamıyor'],
    'backup.folder.unavailable': [
      'Yedek klasörüne ulaşılamıyor ({detail}); disk takılı değil ya da eşitleme hesabından çıkılmış olabilir',
      'Yedek klasörüne ulaşılamıyor; disk takılı değil ya da eşitleme hesabından çıkılmış olabilir',
    ],
    'backup.folder.missing': 'Önce yedekler için bir klasör seçin',
    'backup.passphrase.short': 'Parola çok kısa; daha uzun bir parola seçin',
    'backup.notFound': 'Yedek bulunamadı',
    'backup.unreadable': ['Yedek okunamadı: {detail}', 'Yedek okunamadı'],

    /* ── flows REST ── */
    'flow.notFound': 'Akış bulunamadı; silinmiş olabilir',
    'flow.tooMany': 'Akış sayısı sınırına ulaşıldı; yenisi için birini silin',
    'flow.id.invalid': ['Geçersiz akış kimliği: {detail}', 'Geçersiz akış kimliği'],
    'flow.id.taken': 'Bu kimliği başka bir akış kullanıyor',
    'flow.running': 'Akış çalışıyor; önce durdurun',
    'flow.engine.closed': 'Dürbün kapanıyor; akış başlatılmadı',
    'flow.run.tooMany': 'Aynı anda çalışabilecek akış sınırına ulaşıldı; birinin bitmesini bekleyin',
    'flow.preflight.failed': 'Ön kontrol, akışın çalışmasını engelleyen bir sorun buldu',
    'flow.fromRequests.empty': 'En az bir istek seçin',
    'flow.fromRequests.gone': 'Seçilen istekler artık bellekte değil',
    'flowRun.notFound': 'Çalıştırma bulunamadı',
    'flowRun.notRunning': 'Bu çalıştırma zaten bitmiş',
    'env.invalid': 'Ortamlar kaydedilemedi: veri geçersiz',
    'uiPrefs.invalid': 'Arayüz tercihleri geçersiz',
    'uiPrefs.tooLarge': 'Arayüz tercihleri çok büyük',
    'body.invalid': 'İstek gövdesi bir JSON nesnesi olmalı',
    'api.method': 'Bu işleme izin verilmiyor',
    'flow.automation.busy': 'Akış zaten çalışıyor ya da aynı anda çok fazla otomatik çalıştırma var',
    'flow.id.reserved': 'Bu kimlik Dürbün’e ayrılmış; başka bir akış kimliği seçin',

    /* ── pieces of derived params ── */
    flowPart: {
      ms: '{n, number} ms',
      seconds: '{n, number} sn',
      requestFailed: 'başarısız',
      expected: {
        text: 'metin',
        number: 'bir sayı',
        boolean: 'true ya da false',
        keyValue: 'ad–değer çiftleri listesi',
        rules: 'kural listesi',
        rule: 'bir kural',
        extracts: 'okuma kuralları listesi',
        extract: 'bir okuma kuralı',
        assignments: 'atama listesi',
        mapping: 'ad–değer nesnesi',
        numberOrList: 'bir sayı ya da liste',
      },
      extractFrom: { body: 'yanıt gövdesi', header: 'başlık', status: 'durum kodu', bodyText: 'gövde metni' },
      sdkNeeds: {
        network: 'bu adım ağ isteklerini SDK üzerinden görür',
        events: 'bu adım uygulama olaylarını SDK üzerinden görür',
        mocks: 'mock kuralları uygulamaya SDK üzerinden ulaşır',
        logs: 'bu adım uygulama loglarını SDK üzerinden okur',
      },
      deviceState: { offline: 'çevrimdışı', unauthorized: 'izin bekleniyor', disconnected: 'bağlı değil' },
      platform: { android: 'Android', ios: 'iOS' },
    },
  },
  en: {
    /* ── step summaries ── */
    'flow.step.http': ['{method} {url} → {status} · {duration}', '{method} {url} → {status}', 'Request sent, response received'],
    'flow.step.sawRequest': ['{method} {url} → {result}', '{method} {url}', 'Saw the expected request'],
    'flow.step.sawLog': ['Log line: {message}', 'The expected log line came in'],
    'flow.step.sawEvent': ['Event “{name}” received', 'The expected event came in'],
    'flow.step.waited': ['Waited {duration}', 'Waited'],
    'flow.step.checksPassed': [{ one: '{count, number} check passed', other: '{count, number} checks passed' }, 'Checks passed'],
    'flow.step.conditionTrue': 'Condition true',
    'flow.step.conditionFalse': ['Condition false: {explain}', 'Condition false'],
    'flow.step.vars': ['Variables set: {names}', 'Variables set'],
    'flow.step.screenshot': ['Screenshot saved: {name}', 'Screenshot saved'],
    'flow.step.recording': ['Screen recording started (up to {seconds, number} s)', 'Screen recording started'],
    'flow.step.recordingSaved': ['Screen recording saved: {name}', 'Screen recording saved'],
    'flow.step.mockAdded': ['Mock rule added: {url}', 'Mock rule added'],
    'flow.step.mockOn': ['Mock rule on: {rule}', 'Mock rule turned on'],
    'flow.step.mockOff': ['Mock rule off: {rule}', 'Mock rule turned off'],
    'flow.step.mockRemoved': ['Mock rule removed: {rule}', 'Mock rule removed'],
    'flow.step.marker': ['Marker added: {label}', 'Marker added'],
    'flow.step.note': ['{text}', 'Note'],
    'flow.step.slack': 'Sent to Slack',
    'flow.step.noErrors': 'No crashes or errors',
    'flow.step.subflowPassed': ['Sub-flow {flow} passed', 'Sub-flow passed'],
    'flow.step.iteration': ['Iteration {index, number} of {count, number}', 'Iterating'],
    'flow.step.iterationStopped': ['Stopped at iteration {index, number} of {count, number}', 'Iterations stopped'],
    'flow.step.repeated': [{ one: '{count, number} iteration done', other: '{count, number} iterations done' }, 'Iterations done'],
    'flow.step.repeatMet': ['Condition met at iteration {count, number}', 'Condition met'],
    'flow.step.repeatNotMet': [{ one: '{count, number} iteration done; condition not met', other: '{count, number} iterations done; condition not met' }, 'Iterations done; condition not met'],
    'flow.step.retrying': ['Attempt {attempt, number} failed: {error}; retrying', 'Attempt {attempt, number} failed; retrying', 'Retrying'],
    'flow.step.disabled': 'Turned off; skipped',
    'flow.step.cancelled': 'Stopped',
    'flow.step.endPassed': ['Flow ended: passed — {message}', 'Flow ended: passed'],
    'flow.step.endFailed': ['Flow ended: failed — {message}', 'Flow ended: failed'],
    'flow.step.httpBodyInferred': [
      '{method} {url} → {status} · {duration} (the body was sent as {bodyType}; set the body type on the step)',
      '{method} {url} → {status} (the body was sent as {bodyType}; set the body type on the step)',
      'Request sent; the step had no body type, so it was guessed',
    ],
    'flow.step.mockAddedWaiting': [
      'Mock rule added: {url} (the app is not connected yet; the rule applies once it connects)',
      'Mock rule added (the app is not connected yet; the rule applies once it connects)',
    ],
    'flow.step.openedUrl': ['Opened {url}', 'Link opened'],
    'flow.step.appLaunched': ['Started {app}', 'App started'],
    'flow.step.appStopped': ['Stopped {app}', 'App stopped'],
    'flow.step.appRestarted': ['Restarted {app}', 'App restarted'],
    'flow.step.appDataCleared': ['Cleared the data of {app}', 'App data cleared'],
    'flow.step.appInstalled': ['Installed {file}', 'App installed'],
    'flow.step.appUninstalled': ['Uninstalled {app}', 'App uninstalled'],
    'flow.step.appearance': ['Appearance: {mode}', 'Appearance changed'],
    'flow.step.fontScale': ['Font size ×{scale}', 'Font size changed'],
    'flow.step.location': ['Location {lat}, {lon}', 'Location set'],
    'flow.step.pushSent': ['Notification sent to {app}', 'Notification sent'],
    'flow.step.textTyped': ['Typed “{text}”', 'Text typed'],
    'flow.step.keyPressed': ['Pressed {key}', 'Key pressed'],
    'flow.step.statusBar': ['Status bar: {mode}', 'Status bar changed'],
    'flow.step.animationsOn': 'Animations on',
    'flow.step.animationsOff': 'Animations off',

    /* ── step errors ── */
    'flow.step.error': ['The step failed: {error}', 'The step failed'],
    'flow.step.timeout': ['The step did not finish within {seconds, number} s', 'The step did not finish in time'],
    'flow.app.missing': 'No app id: set one on the step or choose the run’s app',
    'flow.device.missing': 'This step needs a device; choose one for the run',
    'flow.sdk.missing': [
      '{app} is not connected with the Dürbün SDK; {needs}',
      '{app} is not connected with the Dürbün SDK, so this step cannot see it',
      'No app with the Dürbün SDK is connected; this step does not work without it',
    ],
    'flow.http.method': ['Invalid HTTP method: {method}', 'Invalid HTTP method'],
    'flow.http.invalidUrl': ['Invalid URL: {url} (it must start with http:// or https://)', 'The URL is empty or invalid'],
    'flow.http.header': ['Invalid header “{header}”: a character not allowed in its name, or a line break in its value', 'Invalid header'],
    'flow.http.failed': ['{method} {url} failed: {error}', '{method} {url} failed: no response', 'The request got no response'],
    'flow.http.status': ['Expected status {expected}, got {status} ({method} {url})', 'Expected status {expected}, got {status}', 'Unexpected status code'],
    'flow.extract.missing': [
      'Could not read {name} from the response ({source} {path})',
      'Could not read {name} from the response ({source})',
      'Could not read {name} from the response',
      'Could not read a value from the response',
    ],
    'flow.regex.invalid': ['Invalid regular expression: {pattern}', 'Invalid regular expression'],
    'flow.assert.failed': [
      { one: 'Check failed: {first}', other: '{count, number} checks failed; first: {first}' },
      { one: '{count, number} check failed', other: '{count, number} checks failed' },
      'A check failed',
    ],
    'flow.noErrors.found': [
      { one: 'Found a problem: {first}', other: 'Found {count, number} problems; first: {first}' },
      { one: 'Found {count, number} problem', other: 'Found {count, number} problems' },
      'Found crashes or errors',
    ],
    'flow.repeat.notMet': [{ one: 'The condition did not hold within {count, number} iteration', other: 'The condition did not hold within {count, number} iterations' }, 'The condition did not hold'],
    'flow.call.unknown': ['The flow “{flow}” does not exist', 'No flow with id “{flowId}”; import it too, or fix the flow id', 'The called flow was not found'],
    'flow.call.depth': ['Sub-flows can nest at most {max, number} levels deep', 'Sub-flows nest too deep'],
    'flow.call.input': ['{flow} needs the input “{name}”', 'A required sub-flow input is missing'],
    'flow.call.failed': ['Sub-flow {flow} failed: {error}', 'Sub-flow {flow} failed', 'The sub-flow failed'],
    'flow.param.type': ['{param} must be {expectedText}', '{param} has the wrong type', 'Wrong value type'],
    'flow.param.json': ['{param} is not valid JSON', 'The value is not valid JSON'],
    'flow.mock.invalid': ['The mock rule is invalid: {error}', 'The mock rule is invalid'],
    'flow.mock.notFound': ['No mock rule “{rule}”', 'Mock rule not found'],
    'flow.screenshot.missing': 'The device did not return a screenshot',
    'flow.recording.missing': 'The device did not return the recording',
    'flow.slack.empty': 'The Slack message is empty',
    'slack.failed': 'Could not send to Slack',
    'flow.wait.network': ['No request matching “{url}” within {timeout}', 'No request matching “{url}”', 'The expected request did not come'],
    'flow.wait.log': ['No log line matching “{text}” within {timeout}', 'No log line matching “{text}”', 'The expected log line did not come'],
    'flow.wait.event': ['The app did not send the event “{name}” within {timeout}', 'The app did not send the event “{name}”', 'The expected event did not come'],
    'flow.node.unknownType': ['Unknown step type “{type}”; did you mean “{suggestion}”?', 'Unknown step type: {type}', 'Unknown step type'],
    'flow.template.syntax': ['Cannot read the template {ref}', 'Template syntax error: {detail}', 'Template syntax error'],
    'flow.template.unknownRoot': [
      'The template reads something that does not exist yet: {ref}',
      'The template reads nothing: no step is called “{root}” (use a step id, vars, env, input, target, trigger or run)',
      'The template reads an unknown name',
    ],
    'flow.template.unknownHelper': ['Unknown template helper: {ref}', 'Unknown template helper'],
    'flow.template.unknownPipe': ['Unknown template pipe: {ref}', 'Unknown template pipe'],
    'flow.end.failed': ['The flow was ended as failed: {message}', 'The flow ended as failed'],

    /* ── run errors ── */
    'flow.run.cancelled': 'The run was stopped',
    'flow.run.interrupted': 'Dürbün was closed during the run',
    'flow.run.timeout': 'The run did not finish within the flow’s time limit',
    'flow.run.internal': ['Internal error in Dürbün; the run stopped ({error})', 'Internal error in Dürbün; the run stopped'],
    'flow.limit.steps': ['The run reached the limit of {count, number} steps; the flow may have an endless loop', 'The run reached its step limit; the flow may have an endless loop'],
    'flow.limit.visits': ['Step “{node}” ran {count, number} times; the flow may have an endless loop', 'A step ran too many times; the flow may have an endless loop'],

    /* ── notices ── */
    'flow.automation.failed': [
      'The automatic flow “{flow}” could not start: {error}',
      'The automatic flow “{flow}” could not start: {why}',
      'The automatic flow “{flow}” could not start',
      'An automatic flow could not start',
    ],
    'flow.automation.loop': [
      'Automation for “{flow}” was switched off: it started {count, number} times in a row right after its previous run',
      'Automation for “{flow}” was switched off: it kept starting again right after its previous run',
      'Automation for a flow was switched off: it kept starting itself again',
    ],
    'flow.file.unreadable': [
      'The flow file {file} could not be read ({problem}); it was left as it is',
      'The flow file {file} could not be read; it was left as it is',
      'A flow file could not be read; it was left as it is',
    ],
    'backup.failed': ['The automatic backup failed: {error}', 'The backup failed: {detail}', 'The backup failed'],

    /* ── validation ── */
    'flow.invalid': 'This is not a Dürbün flow (expected a JSON object)',
    'flow.format': ['This is not a Dürbün flow (format “{format}”)', 'This is not a Dürbün flow'],
    'flow.version': ['This Dürbün cannot read flow version {version}; update Dürbün', 'This Dürbün cannot read this flow version; update Dürbün'],
    'flow.nodes': 'The flow’s step list (nodes) is missing or not a list',
    'flow.nodes.tooMany': ['A flow can have at most {max, number} steps', 'The flow has too many steps'],
    'flow.edges': 'The flow’s connection list (edges) is not a list',
    'flow.edges.tooMany': ['A flow can have at most {max, number} connections', 'The flow has too many connections'],
    'flow.name.missing': 'The flow had no name; it got a placeholder name',
    'flow.id.fixed': ['Flow id “{from}” is now “{to}” (only a-z, 0-9, - and _)', 'The flow id was fixed (only a-z, 0-9, - and _)'],
    'flow.node.invalid': 'A step is not a JSON object',
    'flow.node.idGenerated': ['A step had no id; it is now “{id}”', 'A step without an id got one'],
    'flow.node.idFixed': ['Step id “{from}” is now “{to}” (letters, digits and _ only)', 'A step id was fixed (letters, digits and _ only)'],
    'flow.node.duplicateId': ['Two steps use the id {id}', 'Two steps use the same id'],
    'flow.node.reservedId': ['“{id}” is reserved for templates; pick another step id', 'This step id is reserved for templates; pick another'],
    'flow.node.timeout': 'The step timeout must be between 100 ms and 24 hours',
    'flow.node.retry': 'Retries must be between 0 and 100',
    'flow.node.params': 'The step’s params must be an object',
    'flow.node.unreachable': ['“{node}” is never reached from a trigger', 'This step is never reached from a trigger'],
    'flow.param.required': ['{param} is required', 'A required value is missing'],
    'flow.param.range': ['{param} must be between {min, number} and {max, number}', '{param} is out of range', 'The value is out of range'],
    'flow.param.option': ['{param} must be one of {options} (got “{value}”)', '{param} must be one of {options}', 'Invalid option'],
    'flow.param.unknown': ['Unknown parameter “{param}” for {type} (ignored)', 'An unknown parameter was ignored'],
    'flow.rule.op': ['Unknown operator “{op}”', 'Unknown operator'],
    'flow.rule.left': 'A rule needs a left side',
    'flow.rule.right': ['“{op}” compares with a right side; write the value to compare with', 'The rule needs a right side'],
    'flow.param.jsonText': ['{param} was written as JSON; it is kept as JSON text', 'A value was written as JSON; it is kept as JSON text'],
    'flow.param.status': ['{param}: “{value}” is not a status filter (use 200, 2xx, 200,201 or 200-299)', 'Not a status filter (use 200, 2xx, 200,201 or 200-299)'],
    'flow.param.fixed': ['{param} is read as written: use a fixed value, not a template', 'This value is read as written: use a fixed value, not a template'],
    'flow.mock.delay': 'A “Delay” mock needs a delay (ms) above 0',
    'flow.name.reserved': ['“{name}” is a reserved name; pick another', 'This name is reserved; pick another'],
    'flow.extract.pathSyntax': ['Bad path: {detail} (a body path looks like items[0].id)', 'Bad path (a body path looks like items[0].id)'],
    'flow.extract.pathFixed': ['The path “{from}” was read as “{to}” (paths start at the body, without “$”)', 'A path was fixed (paths start at the body, without “$”)'],
    'flow.extract.name': ['Variable name “{name}” is invalid: use letters, digits or _', 'Variable names can only use letters, digits or _'],
    'flow.extract.from': ['A value can be read from the body, a header, the status or the body text (got “{value}”)', 'A value can be read from the body, a header, the status or the body text'],
    'flow.extract.regex': 'The extract rule’s regular expression is invalid',
    'flow.extract.path': 'Reading a header needs the header name',
    'flow.assign.name': ['Variable name “{name}” is invalid: use letters, digits or _', 'Variable names can only use letters, digits or _'],
    'flow.inputs': 'The inputs list is invalid: each input needs a name',
    'flow.input.name': ['Input name “{name}” is invalid: use letters, digits or _', 'Input names can only use letters, digits or _'],
    'flow.input.duplicate': ['Two inputs are called {name}', 'Two inputs have the same name'],
    'flow.outputs': 'The outputs list is invalid: each output needs a name and a value',
    'flow.output.name': ['Output name “{name}” is invalid: use letters, digits or _', 'Output names can only use letters, digits or _'],
    'flow.edge.invalid': 'A connection needs a from and a to',
    'flow.edge.unknownNode': ['The connection leads to a step that does not exist: “{node}”', 'The connection leads to a step that does not exist'],
    'flow.edge.port': ['This step has no “{port}” port (ports: {ports})', 'This step has no such port'],
    'flow.edge.intoTrigger': ['“{node}” is a trigger; nothing can lead into it', 'Nothing can lead into a trigger'],
    'flow.edge.duplicate': ['The connection {from} → {to} was there twice; the extra one was removed', 'A duplicate connection was removed'],
    'flow.trigger.added': ['The flow had no trigger; a manual start “{id}” was added at the start', 'The flow had no trigger; a manual start was added at the start'],
    'flow.trigger.missing': 'A flow needs a trigger (manual start or event)',
    'flow.trigger.unconnected': 'This trigger leads nowhere',
    'flow.target.platform': 'The target platform must be Android, iOS or any',
    'flow.settings.onUnsupported': 'The unsupported steps setting must be skip or fail',
    'flow.settings.timeout': 'The flow’s time limit must be between 1 s and 24 hours',
    'flow.automation.noEvent': 'Automation is on but the flow has no event trigger',
    'flow.call.self': 'A flow cannot call itself',

    /* ── template errors ── */
    'template.syntax': ['Cannot read the template {ref}', 'Template syntax error'],
    'template.unknownRoot': ['The template reads something that does not exist yet: {ref}', 'The template reads an unknown name'],
    'template.unknownHelper': ['Unknown template helper: {ref}', 'Unknown template helper'],
    'template.unknownPipe': ['Unknown template pipe: {ref}', 'Unknown template pipe'],

    /* ── preflight ── */
    'preflight.flow.invalid': ['The flow has an error to fix: {problem}', 'The flow has an error to fix'],
    'preflight.flow.noStart': 'The flow has no step to start from',
    'preflight.flow.empty': 'The start is not connected to any step, so there is nothing to run',
    'preflight.device.gone': ['The chosen device is no longer connected ({device})', 'The chosen device is no longer connected'],
    'preflight.device.offline': ['{device} is not ready ({stateText})', '{device} is not ready', 'The chosen device is not ready'],
    'preflight.device.none': 'No device is connected; the flow has device steps',
    'preflight.device.nonePlatform': ['No {platformName} device is connected; the flow has device steps', 'No device of the flow’s platform is connected; the flow has device steps'],
    'preflight.device.noneSkipped': [
      { one: 'No device is connected; the device step will be skipped', other: 'No device is connected; {count, number} device steps will be skipped' },
      'No device is connected; device steps will be skipped',
    ],
    'preflight.device.auto': ['Runs on {device}. Change the target to use another device.', 'The device was picked automatically. Change the target to use another one.'],
    'preflight.device.missing': 'This step needs a connected device',
    'preflight.app.notInstalled': ['{app} was not seen on {device}', '{app} was not seen on the device', 'The app was not seen on the device'],
    'preflight.action.emulator': ['{step} works only on an Android emulator, not on {device}', '{step} works only on an Android emulator', 'This step works only on an Android emulator'],
    'preflight.action.simulator': ['{step} works only on the iOS simulator, not on {device}', '{step} works only on the iOS simulator', 'This step works only on the iOS simulator'],
    'preflight.action.tool': ['{step} is not available on {device} right now (a tool is missing)', 'This step is not available right now (a tool is missing)'],
    'preflight.action.platform': ['{step} is not supported on {device}', 'This step is not supported on this device’s platform'],
    'preflight.sdk.notConnected': [
      'The app is not connected with the Dürbün SDK yet; {needs}. The step waits a moment for it when it starts',
      'The app is not connected with the Dürbün SDK yet; the step waits a moment for it when it starts',
    ],
    'preflight.slack.notConfigured': 'Slack is not connected (Settings → Slack)',
    'preflight.call.unknown': ['This step runs the flow “{flow}”, which does not exist', 'This step runs a flow that does not exist'],
    'preflight.call.recursive': ['{flow} calls itself (directly or through other flows); remove the call that closes the circle', 'A sub-flow calls itself; remove the call that closes the circle'],
    'preflight.env.unknown': ['The environment “{env}” does not exist', 'The chosen environment does not exist'],
    'preflight.env.none': ['The flow reads environment variables ({keys}) but no environment is chosen', 'The flow reads environment variables but no environment is chosen'],
    'preflight.env.missing': ['Missing in {env}: {keys}', 'Some variables are missing in the chosen environment'],
    'preflight.env.empty': ['Empty in {env}: {keys}', 'Some variables are empty in the chosen environment'],
    'preflight.input.missing': ['The input “{name}” is required', 'A required input is missing'],
    'preflight.start.unknown': ['The step “{node}” to start from is not in the flow; reopen the flow and try again', 'The step to start from is not in the flow; reopen the flow and try again'],
    'preflight.call.depth': ['Sub-flows nest deeper than {max, number} levels at {flow}', 'Sub-flows can nest at most {max, number} levels deep', 'Sub-flows nest too deep'],

    /* ── packages ── */
    'package.invalid': 'This file is not a valid Dürbün package',
    'package.isFlow': 'This is a flow file: import it in Flows',
    'package.isSession': 'This is a recorded session: open it with “Import session”',
    'package.version': 'This Dürbün cannot read this package version; update Dürbün',
    'package.crypto.unknown': 'The package uses an encryption this Dürbün does not know',
    'package.passphrase.wrong': 'The passphrase is wrong, or the file was changed after it was saved',
    'package.expired': 'The file is no longer open; choose it again',
    'package.flow.invalid': ['A flow in the package could not be read: {problem}', 'A flow in the package could not be read'],
    'package.flow.problems': [{ one: '{flow} has {count, number} problem', other: '{flow} has {count, number} problems' }, 'A flow in the package has problems'],
    'package.crypto.invalid': 'The encrypted part of the package is damaged',
    'package.passphrase.short': 'The passphrase is too short; use at least 8 characters',
    'package.tooLarge': ['The file is too large (limit {limit})', 'The file is too large'],
    'package.damaged': 'The file is damaged or incomplete; it may still be syncing',
    'package.mock.invalid': ['A mock rule in the package could not be read: {problem}', 'A mock rule in the package could not be read'],
    'package.secrets.notRestored': 'Secrets were not restored: the package is protected with a passphrase',
    'package.settings.ignored': ['Unknown settings were ignored: {keys}', 'Unknown settings were ignored'],
    'package.settings.failed': ['Settings were not applied: {error}', 'Settings were not applied'],
    'package.slack.failed': ['Slack was not restored: {error}', 'Slack was not restored'],
    'package.slack.reconnect': 'Connect Slack again in Settings: the link travels only in an encrypted backup',
    'package.flow.saveFailed': ['{flow} could not be saved: {error}', '{flow} could not be saved', 'A flow could not be saved'],
    'package.mocks.saveFailed': ['Mock rules were not saved: {error}', 'Mock rules were not saved'],
    'package.run.failed': ['The run {run} could not be brought in: {error}', 'The run {run} could not be brought in', 'A run could not be brought in'],

    /* ── backup ── */
    'backup.invalid': 'Invalid backup settings',
    'backup.folder.invalid': 'Choose a full folder path (starting with / or ~)',
    'backup.folder.unwritable': ['Dürbün cannot write to this folder: {detail}', 'Dürbün cannot write to this folder'],
    'backup.folder.unavailable': [
      'The backup folder is not available ({detail}); a disk may be unplugged or the sync service signed out',
      'The backup folder is not available; a disk may be unplugged or the sync service signed out',
    ],
    'backup.folder.missing': 'Choose a folder for the backups first',
    'backup.passphrase.short': 'The passphrase is too short; choose a longer one',
    'backup.notFound': 'Backup not found',
    'backup.unreadable': ['The backup could not be read: {detail}', 'The backup could not be read'],

    /* ── flows REST ── */
    'flow.notFound': 'Flow not found; it may have been deleted',
    'flow.tooMany': 'You have reached the flow limit; delete one to add another',
    'flow.id.invalid': ['Invalid flow id: {detail}', 'Invalid flow id'],
    'flow.id.taken': 'Another flow already uses this id',
    'flow.running': 'The flow is running; stop it first',
    'flow.engine.closed': 'Dürbün is shutting down; the flow was not started',
    'flow.run.tooMany': 'Too many runs at once; wait for one to finish',
    'flow.preflight.failed': 'The preflight found a problem that keeps the flow from running',
    'flow.fromRequests.empty': 'Choose at least one request',
    'flow.fromRequests.gone': 'The chosen requests are no longer in memory',
    'flowRun.notFound': 'Run not found',
    'flowRun.notRunning': 'This run has already ended',
    'env.invalid': 'Could not save the environments: invalid data',
    'uiPrefs.invalid': 'Invalid UI preferences',
    'uiPrefs.tooLarge': 'The UI preferences are too large',
    'body.invalid': 'The request body must be a JSON object',
    'api.method': 'Method not allowed',
    'flow.automation.busy': 'The flow is running already, or too many automatic runs are going',
    'flow.id.reserved': 'This id is reserved by Dürbün; choose another flow id',

    /* ── pieces of derived params ── */
    flowPart: {
      ms: '{n, number} ms',
      seconds: '{n, number} s',
      requestFailed: 'failed',
      expected: {
        text: 'text',
        number: 'a number',
        boolean: 'true or false',
        keyValue: 'a list of name–value pairs',
        rules: 'a list of rules',
        rule: 'a rule',
        extracts: 'a list of extract rules',
        extract: 'an extract rule',
        assignments: 'a list of assignments',
        mapping: 'an object of names and values',
        numberOrList: 'a number or a list',
      },
      extractFrom: { body: 'body', header: 'header', status: 'status', bodyText: 'body text' },
      sdkNeeds: {
        network: 'this step sees network requests through the SDK',
        events: 'this step sees app events through the SDK',
        mocks: 'mock rules reach the app through the SDK',
        logs: 'this step reads app logs through the SDK',
      },
      deviceState: { offline: 'offline', unauthorized: 'waiting for permission', disconnected: 'disconnected' },
      platform: { android: 'Android', ios: 'iOS' },
    },
  },
});

/* ────────────────────────────── derived params ────────────────────────────── */

type FlowParams = Record<string, string | number | boolean | null | undefined>;
type FlowPreparer = (p: FlowParams, lang: Lang) => { key?: string; params?: FlowParams } | void;

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

/** A `code.flowPart.*` piece ('' when unknown; `name` comes from the server, so only plain tokens are looked up). */
function piece(lang: Lang, key: string, name?: string, params?: FlowParams): string {
  if (name !== undefined && !/^[\w-]+$/.test(name)) return '';
  return translateOr(lang, `code.flowPart.${name === undefined ? key : `${key}.${name}`}`, params, '');
}

/** The server's English duration ("142 ms", "12.5 s") in the UI language ("12,5 sn"); other text unchanged. */
function localDuration(v: unknown, lang: Lang): string {
  const text = str(v).trim();
  const m = /^(\d+(?:\.\d+)?) ?(ms|s)$/.exec(text);
  if (!m) return text;
  return piece(lang, m[2] === 'ms' ? 'ms' : 'seconds', undefined, { n: Number(m[1]) }) || text;
}

/** Drops the empty joints the server leaves between rules that held (" and x — expected …" → "x — expected …"). */
function cleanExplain(v: unknown): string {
  let t = str(v).trim();
  for (let prev = ''; prev !== t; ) {
    prev = t;
    t = t
      .replace(/^(?:and|or)(?:\s+|$)/, '')
      .replace(/\s+(?:and|or)$/, '')
      .replace(/\s+(and|or)\s+(?:and|or)(?=\s)/g, ' $1')
      .trim();
  }
  return t;
}

const withDuration: FlowPreparer = (p, lang) => ({ params: { ...p, duration: localDuration(p.duration, lang) } });
const withTimeout: FlowPreparer = (p, lang) => ({ params: { ...p, timeout: localDuration(p.timeout, lang) } });
const withNeeds: FlowPreparer = (p, lang) => ({ params: { ...p, needs: piece(lang, 'sdkNeeds', str(p.capability)) } });

/** Derived params of flow codes; codes.ts merges them into its preparers. */
export const FLOW_PREPARE: Record<string, FlowPreparer> = {
  'flow.step.http': withDuration,
  'flow.step.httpBodyInferred': withDuration,
  'flow.http.status': withDuration,
  'flow.step.waited': withDuration,
  'flow.wait.network': withTimeout,
  'flow.wait.log': withTimeout,
  'flow.wait.event': withTimeout,
  'flow.step.sawRequest': (p, lang) => {
    const status = typeof p.status === 'number' ? p.status : Number(str(p.status));
    return { params: { ...p, result: Number.isFinite(status) && status > 0 ? String(status) : p.status === undefined ? '' : piece(lang, 'requestFailed') } };
  },
  'flow.step.conditionFalse': (p) => ({ params: { ...p, explain: cleanExplain(p.explain) } }),
  'flow.param.type': (p, lang) => ({ params: { ...p, expectedText: piece(lang, 'expected', str(p.expected)) } }),
  'flow.extract.missing': (p, lang) => ({ params: { ...p, source: piece(lang, 'extractFrom', str(p.from)) || str(p.from) } }),
  'flow.sdk.missing': withNeeds,
  'preflight.sdk.notConnected': withNeeds,
  'preflight.device.offline': (p, lang) => ({ params: { ...p, stateText: piece(lang, 'deviceState', str(p.state)) } }),
  'preflight.device.nonePlatform': (p, lang) => ({ params: { ...p, platformName: piece(lang, 'platform', str(p.platform)) } }),
  'flow.automation.failed': (p, lang) => {
    const reason = str(p.reason);
    return { params: { ...p, why: /^[\w.]+$/.test(reason) ? translateOr(lang, `code.${reason}`, undefined, '') : '' } };
  },
};
