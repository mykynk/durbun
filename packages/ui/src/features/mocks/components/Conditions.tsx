import { clsx } from 'clsx';
import { Check, Plus, X } from 'lucide-react';
import { GRAPHQL_OPERATION_TYPES, type GraphqlOperationType } from '@durbun/protocol';
import type { MockRuleReachState } from '../../../data';
import { Button, Callout, DropdownMenu, Field, IconButton, Input, SegmentedControl, type MenuItem } from '../../../components';
import { useT } from '../../../i18n';
import type { RuleForm } from '../model/rules';

/** A GraphQL operation seen in captured traffic at the rule's address (suggestions). */
export interface SeenOperation {
  name: string;
  type?: GraphqlOperationType;
}

export interface RuleReach {
  state: MockRuleReachState;
  reached: string[];
  missing: string[];
}

/** "Pati, Mahalle and Kasa" in the UI language. */
export function listNames(names: readonly string[], lang: string): string {
  const unique = [...new Set(names)];
  try {
    return new Intl.ListFormat(lang, { style: 'long', type: 'conjunction' }).format(unique);
  } catch {
    return unique.join(', ');
  }
}

/** Where a rule with conditions runs: nothing to say for plain rules; a quiet line, an info or a warning otherwise. */
export function ReachNotice({ reach, lang }: { reach: RuleReach | null; lang: string }) {
  const t = useT();
  if (!reach || reach.state === 'plain') return null;
  if (reach.state === 'all') {
    return (
      <p className="mk-reach is-ok" role="status">
        <Check size={13} aria-hidden />
        {t('mocks.gql.reach.all', { count: reach.reached.length, apps: listNames(reach.reached, lang) })}
      </p>
    );
  }
  if (reach.state === 'noApps') {
    return (
      <p className="mk-reach" role="status">
        {t('mocks.gql.reach.noApps')}
      </p>
    );
  }
  const apps = listNames(reach.missing, lang);
  return reach.state === 'nowhere' ? (
    <Callout tone="warn" compact title={t('mocks.gql.reach.nowhereTitle')}>
      {t('mocks.gql.reach.nowhere', { apps })}
    </Callout>
  ) : (
    <Callout tone="warn" compact title={t('mocks.gql.reach.someTitle', { count: new Set(reach.missing).size })}>
      {t('mocks.gql.reach.some', { apps })}
    </Callout>
  );
}

/** The GraphQL operation condition of the rule editor (`when.graphql`). */
export function GraphqlConditionEditor({
  form,
  onChange,
  error,
  seen,
  reach,
  lang,
  idPrefix,
}: {
  form: RuleForm;
  onChange: (patch: Partial<RuleForm>) => void;
  error?: string;
  seen: readonly SeenOperation[];
  reach: RuleReach | null;
  lang: string;
  idPrefix: string;
}) {
  const t = useT();
  const name = form.gqlName.trim();
  const shown = seen.slice(0, 8);
  return (
    <div className="mk-cond" role="group" aria-labelledby={`${idPrefix}-gqltitle`}>
      <div className="mk-cond__head">
        <span className="mk-cond__title" id={`${idPrefix}-gqltitle`}>
          {t('mocks.gql.title')}
        </span>
        <IconButton icon={X} size="xs" label={t('mocks.gql.remove')} onClick={() => onChange({ gqlOn: false, gqlName: '', gqlType: '' })} />
      </div>
      <div className="mk-cond__line">
        <Field label={t('mocks.gql.name')} htmlFor={`${idPrefix}-gqlname`} error={error} className="grow">
          <Input
            id={`${idPrefix}-gqlname`}
            size="sm"
            mono
            value={form.gqlName}
            onChange={(e) => onChange({ gqlName: e.target.value })}
            placeholder={t('mocks.gql.namePlaceholder')}
            invalid={!!error}
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
        <Field label={t('mocks.gql.type')} className="mk-cond__type">
          <SegmentedControl<'' | GraphqlOperationType>
            size="sm"
            value={form.gqlType}
            onChange={(v) => onChange({ gqlType: v })}
            options={[{ value: '', label: t('mocks.gql.anyType') }, ...GRAPHQL_OPERATION_TYPES.map((v) => ({ value: v, label: v }))]}
            aria-label={t('mocks.gql.type')}
          />
        </Field>
      </div>
      {shown.length > 0 ? (
        <div className="mk-cond__seen">
          <span className="mk-hint">{t('mocks.gql.seen')}</span>
          {shown.map((op) => {
            const on = op.name === name && (!form.gqlType || form.gqlType === op.type);
            return (
              <button
                key={`${op.type ?? ''}:${op.name}`}
                type="button"
                className={clsx('mk-op', `mk-op--${op.type ?? 'query'}`, 'mk-op--pick', on && 'is-on')}
                aria-pressed={on}
                onClick={() => onChange({ gqlName: op.name, gqlType: op.type ?? '' })}
              >
                {op.type ? <span className="mk-op__type">{op.type}</span> : null}
                {op.name}
              </button>
            );
          })}
        </div>
      ) : null}
      <p className="mk-hint">{t('mocks.gql.hint')}</p>
      <p className="mk-hint">{t('mocks.gql.unreadable')}</p>
      {form.gqlType ? <p className="mk-hint">{t('mocks.gql.persistedHint')}</p> : null}
      <ReachNotice reach={reach} lang={lang} />
    </div>
  );
}

/** "Add condition" when the rule has none yet (one kind today; the menu leaves room for the next ones). */
export function AddCondition({ onAddGraphql }: { onAddGraphql: () => void }) {
  const t = useT();
  const items: MenuItem[] = [{ label: t('mocks.gql.title'), onSelect: onAddGraphql }];
  return (
    <DropdownMenu items={items} aria-label={t('mocks.editor.conditionsMenu')}>
      {(p) => (
        <Button size="sm" variant="ghost" icon={Plus} className="mk-addcond" {...p}>
          {t('mocks.editor.addCondition')}
        </Button>
      )}
    </DropdownMenu>
  );
}
