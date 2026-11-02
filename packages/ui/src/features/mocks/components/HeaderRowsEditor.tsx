import { useId } from 'react';
import { clsx } from 'clsx';
import { ListPlus, Plus, Trash2 } from 'lucide-react';
import { Button, Checkbox, DropdownMenu, IconButton, Input } from '../../../components';
import { useT } from '../../../i18n';
import { headerRow, isValidHeaderName, type HeaderRow } from '../model/rules';
import '../i18n';
import '../mocks.css';

export interface HeaderRowsEditorProps {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
  /** Quick values for Content-Type (adds or replaces the content-type row). */
  contentTypePresets?: readonly string[];
  'aria-label'?: string;
  /** Rows can be switched off without deleting them (replay editor). */
  toggleable?: boolean;
}

/** Editable list of HTTP header rows (name / value, optional enable checkbox). */
export function HeaderRowsEditor({ rows, onChange, contentTypePresets, toggleable, ...aria }: HeaderRowsEditorProps) {
  const t = useT();
  const listId = useId();
  const update = (id: string, patch: Partial<HeaderRow>) => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const remove = (id: string) => onChange(rows.filter((r) => r.id !== id));
  const add = () => onChange([...rows, headerRow()]);
  const setContentType = (value: string) => {
    const i = rows.findIndex((r) => r.name.trim().toLowerCase() === 'content-type');
    if (i >= 0) onChange(rows.map((r, k) => (k === i ? { ...r, value, enabled: true } : r)));
    else onChange([...rows, headerRow('content-type', value)]);
  };
  return (
    <div className="mk-hdrs" role="group" aria-label={aria['aria-label'] ?? t('mocks.headersEditor.label')}>
      {rows.length === 0 ? <div className="mk-hdrs__empty">{t('mocks.headersEditor.empty')}</div> : null}
      {rows.map((r) => {
        const badName = r.name.trim() !== '' && !isValidHeaderName(r.name.trim());
        return (
          <div key={r.id} className={clsx('mk-hdrs__row', toggleable && !r.enabled && 'is-off')}>
            {toggleable ? <Checkbox checked={r.enabled} onChange={(v) => update(r.id, { enabled: v })} aria-label={t('mocks.headersEditor.enabled')} /> : null}
            <Input
              size="sm"
              mono
              value={r.name}
              placeholder={t('mocks.headersEditor.name')}
              aria-label={t('mocks.headersEditor.name')}
              invalid={badName}
              list={`${listId}-names`}
              onChange={(e) => update(r.id, { name: e.target.value })}
              className="mk-hdrs__name"
            />
            <Input
              size="sm"
              mono
              value={r.value}
              placeholder={t('mocks.headersEditor.value')}
              aria-label={t('mocks.headersEditor.value')}
              onChange={(e) => update(r.id, { value: e.target.value })}
              className="mk-hdrs__value"
            />
            <IconButton icon={Trash2} size="sm" label={t('mocks.headersEditor.remove')} onClick={() => remove(r.id)} />
          </div>
        );
      })}
      <datalist id={`${listId}-names`}>
        {COMMON_HEADERS.map((h) => (
          <option key={h} value={h} />
        ))}
      </datalist>
      <div className="mk-hdrs__bar">
        <Button size="sm" variant="ghost" icon={Plus} onClick={add}>
          {t('mocks.headersEditor.add')}
        </Button>
        {contentTypePresets && contentTypePresets.length > 0 ? (
          <DropdownMenu items={contentTypePresets.map((v) => ({ label: <span className="mono">{v}</span>, onSelect: () => setContentType(v) }))} align="start" aria-label={t('mocks.headersEditor.presets')}>
            {(p) => (
              <Button size="sm" variant="ghost" icon={ListPlus} {...p}>
                {t('mocks.headersEditor.presets')}
              </Button>
            )}
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}

const COMMON_HEADERS = [
  'content-type',
  'cache-control',
  'authorization',
  'accept',
  'accept-language',
  'cookie',
  'set-cookie',
  'location',
  'etag',
  'retry-after',
  'x-request-id',
  'access-control-allow-origin',
  'www-authenticate',
];
