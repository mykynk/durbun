import { useMemo } from 'react';
import { clsx } from 'clsx';
import { Braces, CircleCheck, CircleX, FileUp, Minimize2, Eraser } from 'lucide-react';
import { Button, SegmentedControl, Textarea, formatBytes, pickFiles, toast } from '../../../components';
import { useT } from '../../../i18n';
import '../i18n';
import '../mocks.css';

export interface BodyEditorProps {
  value: string;
  onChange: (value: string) => void;
  encoding?: 'utf8' | 'base64';
  /** Shows the Text / Base64 switch and the file loader. */
  onEncodingChange?: (encoding: 'utf8' | 'base64') => void;
  /** Content-Type of the body: JSON validation turns on for JSON types (and JSON-looking text). */
  contentType?: string;
  placeholder?: string;
  rows?: number;
  id?: string;
  invalid?: boolean;
  'aria-label'?: string;
  'aria-describedby'?: string;
}

const MAX_FILE = 8 * 1024 * 1024;

function base64Size(b64: string): number {
  const clean = b64.replace(/\s+/g, '');
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - pad);
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Body text area with JSON validation / formatting and an optional base64 mode for binary content. */
export function BodyEditor({ value, onChange, encoding = 'utf8', onEncodingChange, contentType, placeholder, rows = 10, id, invalid, ...aria }: BodyEditorProps) {
  const t = useT();
  const jsonish = encoding === 'utf8' && (/json/i.test(contentType ?? '') || /^\s*[[{]/.test(value));
  const json = useMemo(() => {
    if (!jsonish || !value.trim()) return null;
    try {
      return { ok: true as const, value: JSON.parse(value) as unknown };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }, [jsonish, value]);
  const size = encoding === 'base64' ? base64Size(value) : new TextEncoder().encode(value).length;

  const loadFile = async () => {
    const [file] = await pickFiles({});
    if (!file) return;
    if (file.size > MAX_FILE) {
      toast.error(t('mocks.body.fileTooLarge', { max: formatBytes(MAX_FILE) }));
      return;
    }
    try {
      const isText = /^text\/|json|xml|javascript|csv|yaml/i.test(file.type);
      if (isText && encoding === 'utf8') onChange(await file.text());
      else {
        onChange(await fileToBase64(file));
        onEncodingChange?.('base64');
      }
      toast.success(t('mocks.body.fileLoaded', { name: file.name, size: formatBytes(file.size) }));
    } catch (err) {
      toast.error(t('mocks.body.fileFailed'), { description: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className={clsx('mk-body', invalid && 'is-invalid')}>
      <div className="mk-body__bar">
        {onEncodingChange ? (
          <SegmentedControl
            size="sm"
            value={encoding}
            onChange={onEncodingChange}
            options={[
              { value: 'utf8', label: t('mocks.body.text') },
              { value: 'base64', label: t('mocks.body.base64'), tooltip: t('mocks.body.base64Hint') },
            ]}
            aria-label={t('mocks.body.encoding')}
          />
        ) : null}
        {json ? (
          json.ok ? (
            <span className="mk-body__status mk-body__status--ok">
              <CircleCheck size={13} aria-hidden />
              {t('mocks.body.validJson')}
            </span>
          ) : (
            <span className="mk-body__status mk-body__status--bad" title={json.error}>
              <CircleX size={13} aria-hidden />
              <span className="truncate">{t('mocks.body.invalidJson', { message: json.error })}</span>
            </span>
          )
        ) : null}
        <span className="grow" />
        <span className="mk-body__size tnum">{formatBytes(size)}</span>
        {json?.ok ? (
          <>
            <Button size="sm" variant="ghost" icon={Braces} onClick={() => onChange(JSON.stringify(json.value, null, 2))}>
              {t('mocks.body.format')}
            </Button>
            <Button size="sm" variant="ghost" icon={Minimize2} onClick={() => onChange(JSON.stringify(json.value))}>
              {t('mocks.body.minify')}
            </Button>
          </>
        ) : null}
        {onEncodingChange ? (
          <Button size="sm" variant="ghost" icon={FileUp} onClick={() => void loadFile()}>
            {t('mocks.body.loadFile')}
          </Button>
        ) : null}
        {value ? (
          <Button size="sm" variant="ghost" icon={Eraser} onClick={() => onChange('')}>
            {t('mocks.body.clear')}
          </Button>
        ) : null}
      </div>
      <Textarea
        id={id}
        mono
        value={value}
        rows={rows}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder={placeholder ?? (encoding === 'base64' ? t('mocks.body.base64Placeholder') : t('mocks.body.placeholder'))}
        invalid={invalid || (json !== null && !json.ok)}
        onChange={(e) => onChange(e.target.value)}
        className="mk-body__area"
        aria-label={aria['aria-label'] ?? t('mocks.body.label')}
        aria-describedby={aria['aria-describedby']}
      />
    </div>
  );
}
