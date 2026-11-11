import { useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { CircleAlert, FileUp, Import, Package, TriangleAlert } from 'lucide-react';
import type { PackageConflict } from '@durbun/protocol';
import { Button, Callout, Checkbox, Dialog, SegmentedControl, Spinner, Textarea, pickFiles, toast } from '../../../components';
import { api } from '../../../data';
import type { FlowImportItem } from '../../../data/api';
import { errorText, useT } from '../../../i18n';
import { FLOW_FILE_ACCEPT, readPicked, transfer } from '../../transfer/store';
import { IssueList } from './NodeInspector';

export interface ImportFlowsDialogProps {
  open: boolean;
  /** Text to start with (a dropped/pasted file, an AI answer). */
  text: string | null;
  onClose(): void;
  onImported(ids: string[]): void;
}

/** The server words import problems in English; the common ones get the UI language. */
export function problemText(p: string, t: ReturnType<typeof useT>): string {
  if (p === 'No flow JSON was found in the text') return t('flows.import.problem.noJson');
  if (p === 'A JSON block that is not a flow was ignored') return t('flows.import.problem.notFlow');
  let m = /^Not valid JSON: (.*)$/.exec(p);
  if (m) return t('flows.import.problem.badJson', { detail: m[1]! });
  m = /^Two flows have the id (.*); the second was left out$/.exec(p);
  if (m) return t('flows.import.problem.duplicateId', { id: m[1]! });
  return p;
}

/** Shared by the import dialog and the AI dialog's "paste the answer" step. */
export function useImportPreview(text: string, enabled: boolean) {
  const [state, setState] = useState<{ items: FlowImportItem[]; problems: string[]; error?: unknown; loading: boolean; text: string }>({ items: [], problems: [], loading: false, text: '' });
  useEffect(() => {
    if (!enabled || !text.trim()) {
      setState({ items: [], problems: [], loading: false, text: '' });
      return;
    }
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      api.previewFlowImport(text, ctrl.signal).then(
        (r) => setState({ items: r.items, problems: r.problems, loading: false, text }),
        (err: unknown) => {
          if ((err as { name?: string })?.name === 'AbortError') return;
          setState({ items: [], problems: [], error: err, loading: false, text });
        },
      );
    }, 350);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [text, enabled]);
  return state;
}

/** Choice of flows to import with their problems and what happens to flows that already exist. */
export function ImportPreview({
  items,
  problems,
  error,
  loading,
  picked,
  onPicked,
  conflict,
  onConflict,
}: {
  items: FlowImportItem[];
  problems: string[];
  error?: unknown;
  loading: boolean;
  picked: ReadonlySet<string>;
  onPicked(next: Set<string>): void;
  conflict: PackageConflict;
  onConflict(c: PackageConflict): void;
}) {
  const t = useT();
  const [openIssues, setOpenIssues] = useState<string | null>(null);
  const clashes = items.filter((i) => i.exists && i.differs).length;
  if (loading && !items.length) {
    return (
      <div className="fl-import__loading">
        <Spinner size={14} /> {t('flows.import.reading')}
      </div>
    );
  }
  if (error) {
    return (
      <Callout tone="danger" compact>
        {errorText(error)}
      </Callout>
    );
  }
  return (
    <div className="fl-import__preview">
      {problems.length ? (
        <Callout tone="warn" compact title={t('flows.import.problems', { count: problems.length })}>
          <ul className="fl-import__problems">
            {problems.slice(0, 8).map((p, i) => (
              <li key={i}>{problemText(p, t)}</li>
            ))}
          </ul>
        </Callout>
      ) : null}
      {items.length ? (
        <ul className="fl-import__items" aria-label={t('flows.import.found', { count: items.length })}>
          {items.map((it) => {
            const errors = it.issues.filter((i) => i.level === 'error').length;
            const warns = it.issues.length - errors;
            // What importing does with it under the chosen conflict rule.
            const state = !it.exists ? 'new' : !it.differs ? 'same' : conflict === 'keepBoth' ? 'copy' : conflict === 'skip' ? 'skipped' : 'changed';
            return (
              <li key={it.flow.id} className="fl-import__item">
                <Checkbox
                  checked={picked.has(it.flow.id)}
                  onChange={(c) => {
                    const next = new Set(picked);
                    if (c) next.add(it.flow.id);
                    else next.delete(it.flow.id);
                    onPicked(next);
                  }}
                  aria-label={it.flow.name}
                />
                <div className="fl-import__text">
                  <div className="fl-import__name">{it.flow.name}</div>
                  <div className="fl-import__meta">
                    <code>{it.flow.id}</code> · {t('flows.list.steps', { count: it.nodes })}
                  </div>
                </div>
                <span className={clsx('fl-chip', state === 'new' || state === 'copy' ? 'is-passed' : state === 'changed' ? 'is-warn' : '')}>{t(`flows.import.state.${state}`)}</span>
                {errors || warns ? (
                  <button type="button" className={clsx('fl-issues-chip', errors ? 'is-error' : 'is-warn')} onClick={() => setOpenIssues((o) => (o === it.flow.id ? null : it.flow.id))} aria-expanded={openIssues === it.flow.id}>
                    {errors ? <CircleAlert size={12} aria-hidden /> : <TriangleAlert size={12} aria-hidden />}
                    {errors ? t('flows.header.errors', { count: errors }) : t('flows.header.warnings', { count: warns })}
                  </button>
                ) : null}
                {openIssues === it.flow.id ? (
                  <div className="fl-import__issues">
                    <IssueList issues={it.issues} nodes={it.flow.nodes} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : !loading ? (
        <p className="fl-insp__hint">{t('flows.import.none')}</p>
      ) : null}
      {items.some((i) => i.issues.some((x) => x.level === 'error')) ? <p className="fl-insp__hint">{t('flows.import.draftHint')}</p> : null}
      {clashes ? (
        <div className="fl-import__conflict">
          <span>{t('flows.import.clashes', { count: clashes })}</span>
          <SegmentedControl<PackageConflict>
            size="sm"
            value={conflict}
            onChange={onConflict}
            aria-label={t('flows.import.conflictLabel')}
            options={[
              { value: 'keepBoth', label: t('flows.import.conflict.keepBoth') },
              { value: 'replace', label: t('flows.import.conflict.replace') },
              { value: 'skip', label: t('flows.import.conflict.skip') },
            ]}
          />
        </div>
      ) : null}
    </div>
  );
}

/** How many flows an import saves: the picked ones, without changed ones the conflict rule skips. */
export function importCount(items: readonly FlowImportItem[], picked: ReadonlySet<string>, conflict: PackageConflict): number {
  return items.filter((i) => picked.has(i.flow.id) && !(i.exists && i.differs && conflict === 'skip')).length;
}

export async function runImport(items: FlowImportItem[], picked: ReadonlySet<string>, conflict: PackageConflict, t: ReturnType<typeof useT>): Promise<string[] | null> {
  const flows = items.filter((i) => picked.has(i.flow.id)).map((i) => i.flow);
  try {
    const r = await api.importFlows(flows, conflict);
    if (r.saved.length) toast.success(t('flows.import.done', { count: r.saved.length }), r.skipped ? { description: t('flows.import.skipped', { count: r.skipped }) } : undefined);
    else toast.info(t('flows.import.nothing'), r.skipped ? { description: t('flows.import.skipped', { count: r.skipped }) } : undefined);
    return r.saved.map((s) => s.id);
  } catch (err) {
    toast.error(t('flows.import.failed'), { description: errorText(err) });
    return null;
  }
}

/** Flow files, AI answers or pasted JSON → validated preview → import. */
export function ImportFlowsDialog({ open, text: initial, onClose, onImported }: ImportFlowsDialogProps) {
  const t = useT();
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [conflict, setConflict] = useState<PackageConflict>('keepBoth');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setText(initial ?? '');
      setConflict('keepBoth');
    }
  }, [open, initial]);
  const preview = useImportPreview(text, open);
  const sig = useMemo(() => preview.items.map((i) => i.flow.id).join('\u0001'), [preview.items]);
  useEffect(() => setPicked(new Set(preview.items.filter((i) => !(i.exists && !i.differs)).map((i) => i.flow.id))), [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const isPackage = /"format"\s*:\s*"durbun-package"/.test(text.slice(0, 2000));
  const chosen = importCount(preview.items, picked, conflict);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('flows.import.title')}
      description={t('flows.import.description')}
      icon={Import}
      size="lg"
      footer={
        <>
          <Button
            variant="ghost"
            icon={FileUp}
            onClick={async () => {
              const files = await pickFiles({ accept: FLOW_FILE_ACCEPT, multiple: true });
              if (!files.length) return;
              const { pkg, texts } = await readPicked(files);
              if (pkg) {
                onClose();
                transfer.openImport(pkg.text, pkg.name);
                if (texts.length) toast.info(t('flows.import.packageAlone'));
                return;
              }
              setText(texts.length === 1 ? texts[0]! : `[${texts.map((x) => x.trim()).join(',\n')}]`);
            }}
          >
            {t('flows.import.pickFile')}
          </Button>
          <span className="grow" />
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            icon={Import}
            loading={busy}
            disabled={!chosen || preview.loading || preview.text !== text}
            onClick={async () => {
              setBusy(true);
              const ids = await runImport(preview.items, picked, conflict, t);
              setBusy(false);
              if (ids) onImported(ids);
            }}
          >
            {chosen ? t('flows.import.button', { count: chosen }) : t('flows.import.buttonNone')}
          </Button>
        </>
      }
    >
      <div className="fl-import">
        <Textarea
          className="fl-import__text-area"
          mono
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('flows.import.placeholder')}
          aria-label={t('flows.import.textLabel')}
          spellCheck={false}
        />
        {isPackage ? (
          <Callout
            tone="info"
            compact
            actions={
              <Button
                size="sm"
                icon={Package}
                onClick={() => {
                  onClose();
                  transfer.openImport(text);
                }}
              >
                {t('flows.import.openPackage')}
              </Button>
            }
          >
            {t('flows.import.isPackage')}
          </Callout>
        ) : null}
        {text.trim() ? (
          <ImportPreview
            items={preview.items}
            problems={preview.problems}
            error={preview.error}
            loading={preview.loading}
            picked={picked}
            onPicked={setPicked}
            conflict={conflict}
            onConflict={setConflict}
          />
        ) : (
          <p className="fl-insp__hint">{t('flows.import.hint')}</p>
        )}
      </div>
    </Dialog>
  );
}
