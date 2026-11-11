import { useEffect, useMemo, useState } from 'react';
import { Copy, FileDown, Import, ShieldCheck, Sparkles } from 'lucide-react';
import type { PackageConflict } from '@durbun/protocol';
import { Button, Callout, Checkbox, Dialog, SegmentedControl, Textarea, copyText, downloadText, formatBytes, toast } from '../../../components';
import { api, useCompiledScope, useFlows } from '../../../data';
import type { AiPackRequest } from '../../../data/api';
import { errorText, useLanguage, useT } from '../../../i18n';
import { ImportPreview, importCount, runImport, useImportPreview } from './ImportDialog';

export interface AiPackDialogProps {
  open: boolean;
  /** Edit this flow (its JSON goes into the pack); null = a new flow. */
  flowId: string | null;
  onClose(): void;
  onImported(ids: string[]): void;
}

type Include = Required<NonNullable<AiPackRequest['include']>>;

/**
 * "Yapay zekâyla yaz": Dürbün never calls an AI. It writes a Markdown pack (the goal, the flow format, recent
 * requests of the app, other flows) the user gives to their own assistant, then imports the answer.
 */
export function AiPackDialog({ open, flowId, onClose, onImported }: AiPackDialogProps) {
  const t = useT();
  const lang = useLanguage();
  const scope = useCompiledScope();
  const editing = useFlows((s) => (flowId ? s.summaries.find((f) => f.id === flowId) : undefined));
  const [goal, setGoal] = useState('');
  const [include, setInclude] = useState<Include>({ schema: true, requests: true, flows: true, environments: true });
  const [packLang, setPackLang] = useState<'tr' | 'en'>(lang);
  const [building, setBuilding] = useState<'copy' | 'download' | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [answer, setAnswer] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [conflict, setConflict] = useState<PackageConflict>(flowId ? 'replace' : 'keepBoth');
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAnswer('');
    setSize(null);
    setConflict(flowId ? 'replace' : 'keepBoth');
    setPackLang(lang);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, flowId]);

  const preview = useImportPreview(answer, open);
  const sig = useMemo(() => preview.items.map((i) => i.flow.id).join('\u0001'), [preview.items]);
  useEffect(() => setPicked(new Set(preview.items.filter((i) => !(i.exists && !i.differs)).map((i) => i.flow.id))), [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = importCount(preview.items, picked, conflict);

  const build = async (mode: 'copy' | 'download') => {
    setBuilding(mode);
    try {
      const req: AiPackRequest = {
        include,
        language: packLang,
        ...(goal.trim() ? { goal: goal.trim() } : {}),
        ...(flowId ? { flowId } : {}),
        ...(scope.bundleId ? { appId: scope.bundleId } : {}),
        ...(scope.deviceId ? { deviceId: scope.deviceId } : {}),
      };
      const { markdown } = await api.aiPack(req);
      setSize(new Blob([markdown]).size);
      if (mode === 'copy') {
        if (await copyText(markdown)) toast.success(t('flows.ai.copied'), { description: t('flows.ai.copiedHint') });
        else toast.error(t('flows.ai.copyFailed'));
      } else {
        downloadText(markdown, `durbun-ai-${flowId ?? 'new-flow'}.md`, 'text/markdown;charset=utf-8');
      }
    } catch (err) {
      toast.error(t('flows.ai.buildFailed'), { description: errorText(err) });
    } finally {
      setBuilding(null);
    }
  };

  const toggle = (k: keyof Include) => (v: boolean) => setInclude((s) => ({ ...s, [k]: v }));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? t('flows.ai.titleEdit', { name: editing.name }) : t('flows.ai.title')}
      description={t('flows.ai.description')}
      icon={Sparkles}
      size="lg"
      footer={
        <>
          <span className="grow" />
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button
            variant="primary"
            icon={Import}
            loading={importing}
            disabled={!chosen || preview.loading || preview.text !== answer}
            onClick={async () => {
              setImporting(true);
              const ids = await runImport(preview.items, picked, conflict, t);
              setImporting(false);
              if (ids) onImported(ids);
            }}
          >
            {chosen ? t('flows.import.button', { count: chosen }) : t('flows.import.buttonNone')}
          </Button>
        </>
      }
    >
      <div className="fl-ai">
        <section className="fl-ai__step">
          <h3>
            <span className="fl-ai__num">1</span>
            {t('flows.ai.step1')}
          </h3>
          <Textarea
            rows={3}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder={editing ? t('flows.ai.goalEditPlaceholder') : t('flows.ai.goalPlaceholder')}
            aria-label={t('flows.ai.goal')}
          />
          <div className="fl-ai__includes" role="group" aria-label={t('flows.ai.include')}>
            <Checkbox checked={include.schema} onChange={toggle('schema')} label={t('flows.ai.inc.schema')} />
            <Checkbox checked={include.requests} onChange={toggle('requests')} label={scope.bundleId ? t('flows.ai.inc.requestsOf', { app: scope.app?.app.name ?? scope.bundleId }) : t('flows.ai.inc.requests')} />
            <Checkbox checked={include.flows} onChange={toggle('flows')} label={t('flows.ai.inc.flows')} />
            <Checkbox checked={include.environments} onChange={toggle('environments')} label={t('flows.ai.inc.environments')} />
          </div>
          <div className="fl-ai__row">
            <span className="fl-ai__label">{t('flows.ai.language')}</span>
            <SegmentedControl<'tr' | 'en'>
              size="sm"
              value={packLang}
              onChange={setPackLang}
              aria-label={t('flows.ai.language')}
              options={[
                { value: 'tr', label: 'Türkçe' },
                { value: 'en', label: 'English' },
              ]}
            />
            <span className="grow" />
            {size !== null ? <span className="fl-ai__size tnum">{formatBytes(size)}</span> : null}
            <Button size="sm" variant="ghost" icon={FileDown} loading={building === 'download'} disabled={!!building} onClick={() => void build('download')}>
              {t('flows.ai.download')}
            </Button>
            <Button size="sm" variant="primary" icon={Copy} loading={building === 'copy'} disabled={!!building} onClick={() => void build('copy')}>
              {t('flows.ai.copy')}
            </Button>
          </div>
          <Callout tone="info" icon={ShieldCheck} compact>
            {t('flows.ai.privacy')}
          </Callout>
        </section>
        <section className="fl-ai__step">
          <h3>
            <span className="fl-ai__num">2</span>
            {t('flows.ai.step2')}
          </h3>
          <Textarea mono rows={6} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={t('flows.ai.answerPlaceholder')} aria-label={t('flows.ai.answer')} spellCheck={false} />
          {answer.trim() ? (
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
            <p className="fl-insp__hint">{t('flows.ai.answerHint')}</p>
          )}
        </section>
      </div>
    </Dialog>
  );
}
