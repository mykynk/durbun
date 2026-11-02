import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { ArrowLeftRight, Drama, FileDown, FileUp, Plus, Power, Save } from 'lucide-react';
import type { MockRule } from '@durbun/protocol';
import { networkStore, saveMocks, ui, useCompiledScope, useHub, useMocks, useNetworkVersion, useUi, type MockRuleDraft } from '../../data';
import {
  Button,
  EmptyState,
  IconButton,
  SearchInput,
  SplitPane,
  Spinner,
  Toggle,
  Toolbar,
  ToolbarSeparator,
  Tooltip,
  confirm,
  downloadText,
  pickFiles,
  toast,
  useCommands,
  useFeatureActive,
  usePersistentState,
  useShortcut,
} from '../../components';
import { errorText, useT } from '../../i18n';
import {
  disableAll,
  duplicateRule,
  emptyForm,
  exportRules,
  formSignature,
  formToRule,
  hitCounts,
  mergeImported,
  moveItem,
  newRuleId,
  parseRulesFile,
  restoreEnabled,
  ruleLabel,
  ruleToForm,
  validateForm,
  type RuleForm,
} from './model/rules';
import { RuleList } from './components/RuleList';
import { RuleEditor, type KnownApp } from './components/RuleEditor';
import { CapabilityHints, ImportDialog, type PendingImport } from './components/Extras';
import { ExplainCallout, pickEmptyReason, useScopeExplain } from '../../sources';
import './i18n';
import './mocks.css';

interface EditorState {
  mode: 'new' | 'edit' | 'draft';
  ruleId?: string;
  form: RuleForm;
  baseline: RuleForm;
}

function matchesSearch(r: MockRule, q: string, summary: string): boolean {
  const s = q.toLowerCase();
  return (
    (r.name ?? '').toLowerCase().includes(s) ||
    r.url.toLowerCase().includes(s) ||
    r.method.toLowerCase() === s ||
    summary.toLowerCase().includes(s) ||
    (r.apps ?? []).some((a) => a.toLowerCase().includes(s))
  );
}

/** Mocks tab ("Mock'lar"): ordered rule list, editor with a live tester, master switch, import/export. */
export default function MocksView() {
  const t = useT();
  const active = useFeatureActive();
  const rules = useMocks((s) => s.rules);
  const loaded = useMocks((s) => s.loaded);
  // App stats change with every batch; subscribe only to what this view shows (identity, connection, caps).
  const appsSig = useHub((s) =>
    Object.values(s.apps)
      .map((a) => [a.id, a.app.id, a.app.name, a.deviceId, a.connected ? 1 : 0, a.sdk.platform, a.capabilities.join(','), a.connectedAt].join('\u0001'))
      .join('\u0002'),
  );
  const allApps = useMemo(() => Object.values(useHub.getState().apps).sort((a, b) => b.connectedAt - a.connectedAt), [appsSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const compiled = useCompiledScope();
  // The scoped app cannot apply mocks (no SDK / VM service only): say why instead of the capability bar.
  const scopeExplain = useScopeExplain();
  const mocksStructural = pickEmptyReason('mocks', scopeExplain).structural && scopeExplain.kind !== 'none';
  const scopeKey =
    compiled.scope.kind === 'all'
      ? 'all'
      : compiled.scope.kind === 'device'
        ? `d:${compiled.scope.deviceId}`
        : `a:${compiled.deviceId ?? ''}|${compiled.bundleId ?? ''}:${[...(compiled.appIds ?? [])].sort().join(',')}`;
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [master, setMaster] = usePersistentState<{ remembered: string[] }>('mocks.master', { remembered: [] });

  /* ── derived ── */
  const v = useNetworkVersion({ throttleMs: 1000, enabled: active });
  const hits = useMemo(() => hitCounts(networkStore.list()), [v]); // eslint-disable-line react-hooks/exhaustive-deps
  const knownApps: KnownApp[] = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of allApps) if (!map.has(a.app.id)) map.set(a.app.id, a.app.name);
    return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [allApps]);
  const appNames = useMemo(() => new Map(knownApps.map((a) => [a.id, a.name])), [knownApps]);
  const scopedApps = useMemo(() => {
    const s = compiled.scope;
    if (s.kind === 'all') return allApps;
    if (s.kind === 'device') return allApps.filter((a) => a.deviceId === s.deviceId);
    return allApps.filter((a) => compiled.appIds?.has(a.id));
  }, [allApps, scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const enabledCount = rules.filter((r) => r.enabled).length;
  const visibleIds = useMemo(() => {
    const q = query.trim();
    if (!q) return null;
    return new Set(rules.filter((r) => matchesSearch(r, q, '')).map((r) => r.id));
  }, [rules, query]);

  const dirty = !!editor && (editor.mode === 'draft' || formSignature(editor.form) !== formSignature(editor.baseline));
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  /* ── persistence ── */
  const persist = useCallback(
    async (next: MockRule[], success?: string): Promise<MockRule[] | null> => {
      try {
        const saved = await saveMocks(next);
        if (success) toast.success(success);
        return saved;
      } catch (err) {
        toast.error(t('mocks.saveFailed'), { description: errorText(err) });
        return null;
      }
    },
    [t],
  );

  const confirmDiscard = useCallback(async (): Promise<boolean> => {
    if (!dirtyRef.current) return true;
    return confirm({ title: t('mocks.editor.unsavedTitle'), message: t('mocks.editor.unsavedMessage'), confirmLabel: t('mocks.editor.discard'), danger: true });
  }, [t]);

  const openRule = useCallback(
    async (id: string) => {
      if (editor?.mode === 'edit' && editor.ruleId === id) return;
      if (!(await confirmDiscard())) return;
      const rule = useMocks.getState().rules.find((r) => r.id === id);
      if (!rule) {
        toast.info(t('mocks.noSelection.title'));
        return;
      }
      const form = ruleToForm(rule);
      setShowErrors(false);
      setEditor({ mode: 'edit', ruleId: id, form, baseline: form });
    },
    [editor, confirmDiscard, t],
  );

  const openNew = useCallback(
    async (draft?: MockRuleDraft) => {
      if (!(await confirmDiscard())) return;
      const form = draft ? ruleToForm(draft) : emptyForm();
      setShowErrors(false);
      setEditor({ mode: draft ? 'draft' : 'new', form, baseline: draft ? emptyForm() : form });
    },
    [confirmDiscard],
  );

  const closeEditor = useCallback(async () => {
    if (!(await confirmDiscard())) return;
    setEditor(null);
    setShowErrors(false);
  }, [confirmDiscard]);

  const save = async () => {
    if (!editor || saving) return;
    const { errors } = validateForm(editor.form);
    if (errors.length > 0) {
      setShowErrors(true);
      return;
    }
    const current = useMocks.getState().rules;
    const existing = editor.mode === 'edit' ? current.find((r) => r.id === editor.ruleId) : undefined;
    const rule = formToRule(editor.form, existing ? { id: existing.id, createdAt: existing.createdAt } : { id: newRuleId(), createdAt: Date.now() });
    const next = existing ? current.map((r) => (r.id === existing.id ? rule : r)) : [rule, ...current];
    setSaving(true);
    const saved = await persist(next, existing ? t('mocks.editor.saved') : t('mocks.editor.created'));
    setSaving(false);
    if (!saved) return;
    const canonical = saved.find((r) => r.id === rule.id) ?? rule;
    const form = ruleToForm(canonical);
    setShowErrors(false);
    setEditor({ mode: 'edit', ruleId: canonical.id, form, baseline: form });
  };

  /* ── list actions ── */
  const toggleRule = (id: string, enabled: boolean) => {
    const next = rules.map((r) => (r.id === id ? { ...r, enabled } : r));
    setEditor((e) => (e && e.ruleId === id ? { ...e, form: { ...e.form, enabled }, baseline: { ...e.baseline, enabled } } : e));
    void persist(next);
  };

  const moveRule = (from: number, to: number) => {
    const rule = rules[from];
    if (!rule || to < 0 || to >= rules.length || from === to) return;
    void persist(moveItem(rules, from, to)).then((ok) => {
      if (ok) toast.info(t('mocks.order.moved', { name: ruleLabel(rule), position: to + 1 }), { duration: 2000, id: 'mocks-moved' });
    });
  };

  const duplicate = async (id: string) => {
    const copyId = newRuleId();
    const saved = await persist(duplicateRule(rules, id, { id: copyId, now: Date.now(), nameSuffix: t('mocks.list.copySuffix') }));
    const copy = saved?.find((r) => r.id === copyId);
    if (copy && !dirtyRef.current) {
      const form = ruleToForm(copy);
      setEditor({ mode: 'edit', ruleId: copy.id, form, baseline: form });
    }
  };

  const remove = async (id: string) => {
    const index = rules.findIndex((r) => r.id === id);
    const rule = rules[index];
    if (!rule) return;
    const ok = await confirm({ title: t('mocks.deleteConfirm.title'), message: t('mocks.deleteConfirm.message', { name: ruleLabel(rule) }), confirmLabel: t('mocks.deleteConfirm.confirm'), danger: true });
    if (!ok) return;
    const saved = await persist(rules.filter((r) => r.id !== id));
    if (!saved) return;
    if (editor?.ruleId === id) setEditor(null);
    toast.success(t('mocks.deleted'), {
      action: {
        label: t('mocks.undo'),
        onClick: () => {
          const cur = useMocks.getState().rules;
          const restored = cur.slice();
          restored.splice(Math.min(index, restored.length), 0, rule);
          void persist(restored);
        },
      },
      duration: 7000,
    });
  };

  /* ── master switch ── */
  const toggleMaster = async () => {
    if (rules.length === 0) return;
    if (enabledCount > 0) {
      const { rules: next, remembered } = disableAll(rules);
      if (await persist(next, t('mocks.master.turnedOff'))) {
        setMaster({ remembered });
        setEditor((e) => (e ? { ...e, form: { ...e.form, enabled: false }, baseline: { ...e.baseline, enabled: false } } : e));
      }
    } else {
      const next = restoreEnabled(rules, master.remembered);
      const count = next.filter((r) => r.enabled).length;
      if (await persist(next, t('mocks.master.turnedOn', { count }))) {
        setMaster({ remembered: [] });
        setEditor((e) => {
          if (!e?.ruleId) return e;
          const r = next.find((x) => x.id === e.ruleId);
          return r ? { ...e, form: { ...e.form, enabled: r.enabled }, baseline: { ...e.baseline, enabled: r.enabled } } : e;
        });
      }
    }
  };

  /* ── import / export ── */
  const exportAll = () => {
    if (rules.length === 0) {
      toast.info(t('mocks.io.nothingToExport'));
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    downloadText(exportRules(rules), `durbun-mocks-${stamp}.json`, 'application/json');
    toast.success(t('mocks.io.exported', { count: rules.length }));
  };
  const importFromFile = async () => {
    const [file] = await pickFiles({ accept: '.json,application/json' });
    if (!file) return;
    try {
      const text = await file.text();
      const { rules: parsed, issues } = parseRulesFile(text);
      setPendingImport({ file: file.name, rules: parsed, issues });
    } catch (err) {
      toast.error(t('mocks.io.readFailed'), { description: errorText(err) });
    }
  };
  const confirmImport = async (mode: 'append' | 'replace') => {
    if (!pendingImport) return;
    const imported = pendingImport.rules;
    setPendingImport(null);
    if (mode === 'replace' && editor) setEditor(null);
    await persist(mergeImported(useMocks.getState().rules, imported, mode), t('mocks.io.imported', { count: imported.length }));
  };

  /* ── cross-feature focus ── */
  const focus = useUi((s) => s.focus);
  useEffect(() => {
    if (!focus) return;
    if (focus.kind === 'mock') {
      ui.consumeFocus(focus.seq);
      void openRule(focus.ruleId);
    } else if (focus.kind === 'mockDraft') {
      ui.consumeFocus(focus.seq);
      void openNew(focus.draft);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq]);

  // Keep the editor honest when its rule disappears (deleted elsewhere / import replace).
  useEffect(() => {
    if (editor?.mode === 'edit' && editor.ruleId && loaded && !rules.some((r) => r.id === editor.ruleId)) {
      setEditor((e) => (e ? { ...e, mode: 'new', ruleId: undefined } : e));
    }
  }, [rules, editor, loaded]);

  /* ── shortcuts & palette ── */
  const kb = active && !pendingImport;
  useShortcut('Mod+S', () => void save(), { enabled: kb && !!editor, allowInInputs: true });
  useShortcut('Escape', () => void closeEditor(), { enabled: kb && !!editor, allowInInputs: false });
  const group = t('common.groups.mocks');
  useCommands([
    { id: 'mocks.new', title: t('mocks.commands.new'), group, icon: Plus, keywords: ['mock', 'new', 'yeni', 'kural', 'rule'], run: () => void openNew() },
    { id: 'mocks.toggleAll', title: t('mocks.commands.toggleAll'), group, icon: Power, keywords: ['mock', 'all', 'tüm', 'kapat', 'aç', 'disable'], run: () => void toggleMaster(), disabled: rules.length === 0 },
    { id: 'mocks.export', title: t('mocks.commands.export'), group, icon: FileDown, keywords: ['export', 'dışa aktar', 'json'], run: exportAll },
    { id: 'mocks.import', title: t('mocks.commands.import'), group, icon: FileUp, keywords: ['import', 'içe aktar', 'json'], run: () => void importFromFile() },
    ...(editor ? [{ id: 'mocks.save', title: t('mocks.commands.save'), group, icon: Save, shortcut: 'Mod+S', keywords: ['save', 'kaydet'], run: () => void save() }] : []),
  ]);

  /* ── tester draft ── */
  const testerDraft = useMemo(() => {
    if (!editor || !editor.form.url.trim()) return null;
    return formToRule(editor.form, { id: editor.ruleId ?? '__durbun_draft__', createdAt: 0 });
  }, [editor]);

  /* ── render ── */
  const empty = loaded && rules.length === 0 && !editor;
  return (
    <div className="mk fill">
      <Toolbar className="mk-toolbar" aria-label={t('mocks.toolbar.label')}>
        <SearchInput className="mk-search" value={query} onChange={setQuery} placeholder={t('mocks.toolbar.search')} shortcut={['/', 'Mod+F']} shortcutEnabled={active && !pendingImport} size="sm" />
        <ToolbarSeparator />
        <Tooltip content={t('mocks.master.hint')}>
          <span className="mk-master">
            <Toggle checked={enabledCount > 0} onChange={() => void toggleMaster()} disabled={rules.length === 0} label={t('mocks.master.label')} size="sm" />
          </span>
        </Tooltip>
        <span className="toolbar__spacer" />
        <IconButton icon={FileUp} label={t('mocks.toolbar.import')} onClick={() => void importFromFile()} />
        <IconButton icon={FileDown} label={t('mocks.toolbar.export')} onClick={exportAll} disabled={rules.length === 0} />
        <Button size="sm" variant="primary" icon={Plus} onClick={() => void openNew()}>
          {t('mocks.toolbar.newRule')}
        </Button>
      </Toolbar>
      {rules.length > 0 ? (
        <div className={clsx('mk-banner', enabledCount > 0 ? 'is-active' : 'is-off')} role="status">
          <Drama size={14} aria-hidden />
          <span>{enabledCount > 0 ? t('mocks.master.active', { count: enabledCount }) : t('mocks.master.inactive')}</span>
        </div>
      ) : null}
      {mocksStructural ? <ExplainCallout capability="mocks" className="mk-explain" /> : <CapabilityHints apps={scopedApps} />}
      <SplitPane id="mocks.editor" sizedPane="second" defaultSize={600} minSize={420} maxSize={0.72} collapsed={editor ? null : 'second'} onOverlayDismiss={() => void closeEditor()} className="mk-split">
        <div className="mk-listpane">
          {!loaded ? (
            <div className="mk-loading">
              <Spinner size={16} />
            </div>
          ) : empty ? (
            <EmptyState
              size="lg"
              tone="accent"
              icon={Drama}
              title={t('mocks.empty.title')}
              description={t('mocks.empty.description')}
              actions={
                <>
                  <Button variant="primary" icon={Plus} onClick={() => void openNew()}>
                    {t('mocks.empty.create')}
                  </Button>
                  <Button variant="ghost" icon={ArrowLeftRight} onClick={() => ui.setTab('network')}>
                    {t('mocks.empty.openNetwork')}
                  </Button>
                  <Button variant="ghost" icon={FileUp} onClick={() => void importFromFile()}>
                    {t('mocks.empty.import')}
                  </Button>
                </>
              }
            >
              <p className="mk-hint">{t('mocks.empty.tip')}</p>
            </EmptyState>
          ) : (
            <>
              <p className="mk-order">
                {t('mocks.order.firstMatch')} <span className="mk-dimtext">{visibleIds ? t('mocks.order.searchNoDrag') : t('mocks.order.dragHint')}</span>
              </p>
              {visibleIds && visibleIds.size === 0 ? (
                <EmptyState size="sm" title={t('mocks.list.noResults')} />
              ) : (
                <RuleList
                  rules={rules}
                  visibleIds={visibleIds}
                  selectedId={editor?.ruleId ?? null}
                  hits={hits}
                  appNames={appNames}
                  onOpen={(id) => void openRule(id)}
                  onToggle={toggleRule}
                  onMove={moveRule}
                  onDuplicate={(id) => void duplicate(id)}
                  onDelete={(id) => void remove(id)}
                />
              )}
            </>
          )}
        </div>
        {editor ? (
          <RuleEditor
            key={editor.ruleId ?? editor.mode}
            mode={editor.mode}
            form={editor.form}
            onChange={(form) => setEditor((e) => (e ? { ...e, form } : e))}
            dirty={dirty}
            saving={saving}
            showErrors={showErrors}
            onSave={() => void save()}
            onClose={() => void closeEditor()}
            onDelete={editor.mode === 'edit' && editor.ruleId ? () => void remove(editor.ruleId!) : undefined}
            onDuplicate={editor.mode === 'edit' && editor.ruleId ? () => void duplicate(editor.ruleId!) : undefined}
            testerDraft={testerDraft}
            rules={rules}
            insertAt={0}
            knownApps={knownApps}
            appNames={appNames}
          />
        ) : (
          <span />
        )}
      </SplitPane>
      {pendingImport ? <ImportDialog pending={pendingImport} existing={rules.length} onClose={() => setPendingImport(null)} onConfirm={(mode) => void confirmImport(mode)} /> : null}
    </div>
  );
}
