import { useId, useMemo, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { Copy, Ellipsis, Plus, Trash2, X } from 'lucide-react';
import type { MockRule } from '@durbun/protocol';
import { Button, Callout, Checkbox, DropdownMenu, Field, IconButton, Input, SegmentedControl, Select, Toggle, type MenuItem } from '../../../components';
import { useLanguage, useT } from '../../../i18n';
import { formatShortDuration } from '../model/format';
import { reasonPhrase } from '../../network/model/http';
import {
  CONTENT_TYPE_PRESETS,
  DELAY_PRESETS,
  FAIL_ERRORS,
  MATCH_TYPES,
  METHOD_OPTIONS,
  STATUS_PRESETS,
  validateForm,
  type ActionType,
  type FormField,
  type FormIssue,
  type RuleForm,
} from '../model/rules';
import { HeaderRowsEditor } from './HeaderRowsEditor';
import { BodyEditor } from './BodyEditor';
import { LiveTester } from './LiveTester';

export interface KnownApp {
  id: string;
  name: string;
}

export interface RuleEditorProps {
  mode: 'new' | 'edit' | 'draft';
  form: RuleForm;
  onChange: (form: RuleForm) => void;
  dirty: boolean;
  saving: boolean;
  showErrors: boolean;
  onSave: () => void;
  onClose: () => void;
  onDelete?: () => void;
  onDuplicate?: () => void;
  testerDraft: MockRule | null;
  rules: readonly MockRule[];
  insertAt: number;
  knownApps: readonly KnownApp[];
  appNames: ReadonlyMap<string, string>;
}

function DelayInput({ value, onChange, id, invalid, slider }: { value: string; onChange: (v: string) => void; id?: string; invalid?: boolean; slider?: boolean }) {
  const t = useT();
  const lang = useLanguage();
  const n = Number(value) || 0;
  return (
    <div className="mk-delay">
      {slider ? (
        <input
          type="range"
          className="range mk-delay__slider"
          min={0}
          max={10_000}
          step={100}
          value={Math.min(10_000, n)}
          onChange={(e) => onChange(e.target.value)}
          aria-label={t('mocks.editor.delayMs')}
        />
      ) : null}
      <Input id={id} size="sm" mono inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ''))} invalid={invalid} trailing={<span className="mk-unit">{t('mocks.editor.ms')}</span>} wrapperClassName="mk-delay__input" />
      <div className="mk-presets" role="group" aria-label={t('mocks.editor.delayMs')}>
        {DELAY_PRESETS.map((ms) => (
          <button key={ms} type="button" className={clsx('mk-preset', n === ms && 'is-on')} aria-pressed={n === ms} onClick={() => onChange(String(ms))}>
            {formatShortDuration(ms, lang)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Side-panel editor for one mock rule (new, from a request draft, or existing). */
export function RuleEditor(props: RuleEditorProps) {
  const { mode, form, onChange, dirty, saving, showErrors } = props;
  const t = useT();
  const uid = useId();
  const [appInput, setAppInput] = useState('');
  const issues = useMemo(() => validateForm(form), [form]);
  const fieldIssue = (field: FormField): { error?: string; hint?: ReactNode } => {
    const err = issues.errors.find((i) => i.field === field);
    const live = err && (showErrors || err.code === 'regexInvalid' || err.code === 'headerNameInvalid');
    if (err && live) return { error: msg(err) };
    const warn = issues.warnings.find((i) => i.field === field);
    return warn ? { hint: <span className="mk-warn">{msg(warn)}</span> } : {};
  };
  const msg = (i: FormIssue) => t(`mocks.validation.${i.code}`, i.params);
  const set = <K extends keyof RuleForm>(key: K, value: RuleForm[K]) => onChange({ ...form, [key]: value });
  const contentType = form.headers.find((h) => h.enabled && h.name.trim().toLowerCase() === 'content-type')?.value;
  const statusNum = Number(form.status);
  const reason = /^\d{3}$/.test(form.status) ? reasonPhrase(statusNum) : undefined;
  const allApps = form.apps.length === 0;
  const looksGraphql = /graphql/i.test(form.url) && form.match !== 'regex';

  const title = mode === 'edit' ? t('mocks.editor.editTitle') : mode === 'draft' ? t('mocks.editor.draftTitle') : t('mocks.editor.newTitle');
  const moreItems: MenuItem[] = [
    ...(props.onDuplicate ? [{ label: t('mocks.list.duplicate'), icon: Copy, onSelect: props.onDuplicate }] : []),
    ...(props.onDelete ? [{ label: t('mocks.list.delete'), icon: Trash2, danger: true, onSelect: props.onDelete }] : []),
  ];

  const addApp = (id: string) => {
    const v = id.trim();
    if (!v || form.apps.includes(v)) return;
    set('apps', [...form.apps, v]);
    setAppInput('');
  };
  const toggleApp = (id: string) => set('apps', form.apps.includes(id) ? form.apps.filter((a) => a !== id) : [...form.apps, id]);
  const unknownSelected = form.apps.filter((a) => !props.knownApps.some((k) => k.id === a));

  return (
    <section className="mk-editor" aria-label={t('mocks.editor.label')}>
      <header className="mk-editor__head">
        <h2 className="mk-editor__title">
          {title}
          {dirty ? <span className="mk-dirty" title={t('mocks.editor.unsavedTitle')} aria-label={t('mocks.editor.unsavedTitle')} /> : null}
        </h2>
        <Toggle size="sm" checked={form.enabled} onChange={(v) => set('enabled', v)} label={t('mocks.editor.enabled')} className="mk-editor__enabled" />
        {moreItems.length > 0 ? (
          <DropdownMenu items={moreItems} aria-label={t('mocks.toolbar.more')}>
            {(p) => <IconButton icon={Ellipsis} size="sm" label={t('mocks.toolbar.more')} {...p} />}
          </DropdownMenu>
        ) : null}
        <IconButton icon={X} size="sm" label={t('mocks.editor.close')} onClick={props.onClose} />
      </header>
      <div className="mk-editor__body">
        {mode === 'draft' ? (
          <Callout tone="info" compact>
            {t('mocks.editor.fromRequest')}
          </Callout>
        ) : null}
        {mode !== 'edit' ? <p className="mk-note">{t('mocks.editor.newRuleTop')}</p> : null}
        {!form.enabled ? <p className="mk-note mk-warn">{t('mocks.editor.disabledNote')}</p> : null}

        <Field label={t('mocks.editor.name')} htmlFor={`${uid}-name`}>
          <Input id={`${uid}-name`} size="sm" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={t('mocks.editor.namePlaceholder')} />
        </Field>

        <fieldset className="mk-sec">
          <legend className="mk-sec__title">{t('mocks.editor.matchSection')}</legend>
          <div className="mk-line">
            <Field label={t('mocks.editor.method')} htmlFor={`${uid}-method`} error={fieldIssue('method').error} className="mk-line__method">
              <Select
                id={`${uid}-method`}
                size="sm"
                value={form.method}
                onChange={(e) => set('method', e.target.value)}
                options={(METHOD_OPTIONS.includes(form.method) ? METHOD_OPTIONS : [form.method, ...METHOD_OPTIONS]).map((m) => ({ value: m, label: m === '*' ? `* · ${t('mocks.methodAny')}` : m }))}
              />
            </Field>
            <Field label={t('mocks.editor.url')} htmlFor={`${uid}-url`} {...fieldIssue('url')} className="grow">
              <Input
                id={`${uid}-url`}
                size="sm"
                mono
                value={form.url}
                onChange={(e) => set('url', e.target.value)}
                placeholder={t(`mocks.editor.urlPlaceholder.${form.match}`)}
                invalid={!!fieldIssue('url').error}
                spellCheck={false}
              />
            </Field>
          </div>
          <div className="mk-matchrow">
            <SegmentedControl
              size="sm"
              value={form.match}
              onChange={(v) => set('match', v)}
              options={MATCH_TYPES.map((m) => ({ value: m, label: t(`mocks.match.${m}`) }))}
              aria-label={t('mocks.editor.matchType')}
            />
            <span className="mk-hint">{t(`mocks.match.hint.${form.match}`)}</span>
          </div>
          {looksGraphql ? (
            <Callout tone="warn" compact>
              {t('mocks.editor.graphqlShared')}
            </Callout>
          ) : null}
          <LiveTester draft={props.testerDraft} rules={props.rules} insertAt={props.insertAt} appNames={props.appNames} />
        </fieldset>

        <fieldset className="mk-sec">
          <legend className="mk-sec__title">{t('mocks.editor.appsSection')}</legend>
          <Checkbox checked={allApps} onChange={(v) => set('apps', v ? [] : props.knownApps.slice(0, 1).map((a) => a.id))} label={t('mocks.editor.allApps')} />
          {!allApps || unknownSelected.length > 0 ? (
            <div className="mk-apps">
              {props.knownApps.length === 0 ? <p className="mk-hint">{t('mocks.editor.noKnownApps')}</p> : null}
              <div className="mk-apps__chips" role="group" aria-label={t('mocks.editor.appsSection')}>
                {props.knownApps.map((a) => (
                  <button key={a.id} type="button" className={clsx('mk-appchip', form.apps.includes(a.id) && 'is-on')} aria-pressed={form.apps.includes(a.id)} onClick={() => toggleApp(a.id)} title={a.id}>
                    <span>{a.name}</span>
                    <span className="mono mk-appchip__id">{a.id}</span>
                  </button>
                ))}
                {unknownSelected.map((a) => (
                  <button key={a} type="button" className="mk-appchip is-on" aria-pressed onClick={() => toggleApp(a)} title={t('mocks.editor.removeApp', { app: a })}>
                    <span className="mono">{a}</span>
                    <X size={11} aria-hidden />
                  </button>
                ))}
              </div>
              <div className="mk-apps__add">
                <Input
                  size="sm"
                  mono
                  value={appInput}
                  onChange={(e) => setAppInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addApp(appInput);
                    }
                  }}
                  placeholder={t('mocks.editor.addAppPlaceholder')}
                  aria-label={t('mocks.editor.addApp')}
                  wrapperClassName="grow"
                />
                <Button size="sm" variant="ghost" icon={Plus} onClick={() => addApp(appInput)} disabled={!appInput.trim()}>
                  {t('mocks.editor.addApp')}
                </Button>
              </div>
              <p className="mk-hint">{t('mocks.editor.appsHint')}</p>
            </div>
          ) : null}
        </fieldset>

        <fieldset className="mk-sec">
          <legend className="mk-sec__title">{t('mocks.editor.actionSection')}</legend>
          <SegmentedControl<ActionType>
            value={form.type}
            onChange={(v) => set('type', v)}
            options={[
              { value: 'respond', label: t('mocks.actions.respond') },
              { value: 'delay', label: t('mocks.actions.delay') },
              { value: 'fail', label: t('mocks.actions.fail') },
            ]}
            aria-label={t('mocks.editor.actionSection')}
            className="mk-actionseg"
          />
          {form.type === 'respond' ? (
            <>
              <div className="mk-line">
                <Field label={t('mocks.editor.status')} htmlFor={`${uid}-status`} error={fieldIssue('status').error} className="mk-line__status">
                  <Input id={`${uid}-status`} size="sm" mono inputMode="numeric" maxLength={3} value={form.status} onChange={(e) => set('status', e.target.value.replace(/[^\d]/g, ''))} invalid={!!fieldIssue('status').error} />
                </Field>
                <span className={clsx('mk-reason', statusNum >= 400 && 'is-err')}>{reason ?? ''}</span>
              </div>
              <div className="mk-presets mk-presets--status" role="group" aria-label={t('mocks.editor.statusPresets')}>
                {STATUS_PRESETS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={clsx('mk-preset', 'mono', String(s) === form.status && 'is-on', s >= 500 ? 'is-5xx' : s >= 400 ? 'is-4xx' : s >= 300 ? 'is-3xx' : 'is-2xx')}
                    aria-pressed={String(s) === form.status}
                    title={reasonPhrase(s)}
                    onClick={() => set('status', String(s))}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <Field label={t('mocks.editor.headers')} error={fieldIssue('headers').error}>
                <HeaderRowsEditor rows={form.headers} onChange={(rows) => set('headers', rows)} contentTypePresets={CONTENT_TYPE_PRESETS} aria-label={t('mocks.editor.headers')} />
              </Field>
              <Field label={t('mocks.editor.body')} {...fieldIssue('body')}>
                <BodyEditor
                  value={form.body}
                  onChange={(v) => set('body', v)}
                  encoding={form.bodyEncoding}
                  onEncodingChange={(enc) => set('bodyEncoding', enc)}
                  contentType={contentType}
                  rows={10}
                  invalid={!!fieldIssue('body').error}
                  aria-label={t('mocks.editor.body')}
                />
              </Field>
              <Field label={t('mocks.editor.respondDelay')} hint={fieldIssue('respondDelayMs').error ? undefined : t('mocks.editor.respondDelayHint')} error={fieldIssue('respondDelayMs').error}>
                <DelayInput value={form.respondDelayMs} onChange={(v) => set('respondDelayMs', v)} invalid={!!fieldIssue('respondDelayMs').error} />
              </Field>
            </>
          ) : null}
          {form.type === 'delay' ? (
            <Field label={t('mocks.editor.delayMs')} hint={fieldIssue('delayMs').error ? undefined : t('mocks.editor.delayHint')} error={fieldIssue('delayMs').error}>
              <DelayInput value={form.delayMs} onChange={(v) => set('delayMs', v)} invalid={!!fieldIssue('delayMs').error} slider />
            </Field>
          ) : null}
          {form.type === 'fail' ? (
            <>
              <div className="mk-failkinds" role="radiogroup" aria-label={t('mocks.editor.failKind')}>
                {FAIL_ERRORS.map((k) => (
                  <button key={k} type="button" role="radio" aria-checked={form.failError === k} className={clsx('mk-failkind', form.failError === k && 'is-on')} onClick={() => set('failError', k)}>
                    {t(`mocks.errorLabels.${k}`)}
                  </button>
                ))}
              </div>
              <p className="mk-hint">{t('mocks.editor.failHint')}</p>
              <Field label={t('mocks.editor.failMessage')} htmlFor={`${uid}-failmsg`} {...fieldIssue('failMessage')}>
                <Input id={`${uid}-failmsg`} size="sm" value={form.failMessage} onChange={(e) => set('failMessage', e.target.value)} placeholder={t('mocks.editor.failMessagePlaceholder')} />
              </Field>
              <Field label={t('mocks.editor.failDelay')} error={fieldIssue('failDelayMs').error}>
                <DelayInput value={form.failDelayMs} onChange={(v) => set('failDelayMs', v)} invalid={!!fieldIssue('failDelayMs').error} />
              </Field>
            </>
          ) : null}
        </fieldset>
      </div>
      <footer className="mk-editor__foot">
        {showErrors && issues.errors.length > 0 ? (
          <span className="mk-foot__err" role="alert">
            {t('mocks.editor.fixErrors')}
          </span>
        ) : (
          <span className="grow" />
        )}
        <Button variant="ghost" onClick={props.onClose}>
          {t('mocks.editor.cancel')}
        </Button>
        <Button variant="primary" loading={saving} onClick={props.onSave} kbd="Mod+S">
          {mode === 'edit' ? t('mocks.editor.save') : t('mocks.editor.create')}
        </Button>
      </footer>
    </section>
  );
}
