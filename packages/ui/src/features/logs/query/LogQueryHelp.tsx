/** Compact reference of the query language (the Logs view renders it inside a popover). */
import { useId } from 'react';
import { clsx } from 'clsx';
import { CornerDownLeft } from 'lucide-react';
import { useT } from '../../../i18n';
import { QueryHighlight } from './QueryHighlight';
import { IS_VALUES, type QueryKey } from './syntax';
import './i18n';
import './query.css';

export interface LogQueryHelpProps {
  /** (addition) Makes the examples clickable: called with the example query. */
  onExample?(query: string): void;
  /** (addition) Render the "Query language" heading (default true; pass false inside a titled popover). */
  showTitle?: boolean;
  className?: string;
}

const KEY_ROWS: ReadonlyArray<{ key: QueryKey; alias?: string; example: string }> = [
  { key: 'tag', example: 'tag:dio' },
  { key: 'message', alias: 'msg', example: 'message:timeout' },
  { key: 'process', alias: 'package', example: 'process:pati' },
  { key: 'pid', example: 'pid:4123' },
  { key: 'level', example: 'level:warn' },
  { key: 'source', example: 'source:app' },
  { key: 'app', example: 'app:Pati' },
  { key: 'is', example: 'is:crash' },
  { key: 'age', example: 'age:5m' },
];

const OPERATORS: ReadonlyArray<{ code: string; id: string }> = [
  { code: 'tag:dio', id: 'contains' },
  { code: 'tag=:dio', id: 'equals' },
  { code: 'tag~:^dio', id: 'regex' },
  { code: '-tag:dio', id: 'not' },
  { code: 'a b', id: 'and' },
  { code: 'a | b', id: 'or' },
  { code: '(a | b) c', id: 'group' },
  { code: '"a b"', id: 'phrase' },
];

const EXAMPLES: ReadonlyArray<{ query: string; id: string }> = [
  { query: 'level:error tag:dio', id: 'errorsDio' },
  { query: 'is:crash | is:anr', id: 'crashAnr' },
  { query: '-tag:chatty age:5m', id: 'quietRecent' },
  { query: 'app:Pati "connection reset"', id: 'patiReset' },
  { query: '(tag:okhttp | tag:dio) level:warn', id: 'netWarn' },
  { query: 'message~:time(d )?out', id: 'timeoutRegex' },
  { query: 'is:json source:app', id: 'jsonApp' },
  { query: 'is:flutter is:stacktrace', id: 'flutterStack' },
];

export function LogQueryHelp({ onExample, showTitle = true, className }: LogQueryHelpProps = {}) {
  const t = useT();
  const uid = useId();
  const h = (name: string) => `${uid}-${name}`;
  return (
    <div className={clsx('lq-help', className)}>
      <div className="lq-help__head">
        {showTitle ? <h3 className="lq-help__title">{t('logsQuery.help.title')}</h3> : null}
        <p className="lq-help__intro">{t('logsQuery.help.intro')}</p>
      </div>

      <section className="lq-help__section" aria-labelledby={h('keys')}>
        <h4 id={h('keys')} className="lq-help__h">
          {t('logsQuery.help.keys')}
        </h4>
        <dl className="lq-help__keys">
          {KEY_ROWS.map((r) => (
            <div key={r.key} className="lq-help__key-row">
              <dt className="lq-help__key">
                <code className="qhl">
                  <span className="qt qt--key">{r.key}</span>
                  <span className="qt qt--operator">:</span>
                </code>
              </dt>
              <dd className="lq-help__desc">
                {t(`logsQuery.keys.${r.key}`)}
                {r.alias ? <span className="lq-help__alias"> · {r.alias}:</span> : null}
              </dd>
              <dd className="lq-help__sample">
                <QueryHighlight query={r.example} />
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="lq-help__section" aria-labelledby={h('ops')}>
        <h4 id={h('ops')} className="lq-help__h">
          {t('logsQuery.help.operators')}
          <span className="lq-help__hnote">{t('logsQuery.help.caseNote')}</span>
        </h4>
        <ul className="lq-help__ops">
          {OPERATORS.map((o) => (
            <li key={o.id} className="lq-help__op">
              <QueryHighlight query={o.code} />
              <span>{t(`logsQuery.help.ops.${o.id}`)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="lq-help__section" aria-labelledby={h('kinds')}>
        <h4 id={h('kinds')} className="lq-help__h">
          {t('logsQuery.help.kinds')}
        </h4>
        <ul className="lq-help__kinds">
          {IS_VALUES.map((v) => (
            <li key={v} className="lq-help__kind">
              <QueryHighlight query={`is:${v}`} />
              <span>{t(`logsQuery.is.${v}`)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="lq-help__section" aria-labelledby={h('examples')}>
        <h4 id={h('examples')} className="lq-help__h">
          {t('logsQuery.help.examples')}
          {onExample ? <span className="lq-help__hnote">{t('logsQuery.help.clickHint')}</span> : null}
        </h4>
        <ul className="lq-help__examples">
          {EXAMPLES.map((ex) => {
            const text = t(`logsQuery.help.examplesText.${ex.id}`);
            const body = (
              <>
                <QueryHighlight query={ex.query} className="lq-help__ex-query" />
                <span className="lq-help__ex-text">{text}</span>
                {onExample ? <CornerDownLeft size={13} className="lq-help__ex-icon" aria-hidden /> : null}
              </>
            );
            return (
              <li key={ex.id}>
                {onExample ? (
                  <button type="button" className="lq-help__ex is-clickable" aria-label={`${t('logsQuery.help.apply', { query: ex.query })} — ${text}`} onClick={() => onExample(ex.query)}>
                    {body}
                  </button>
                ) : (
                  <div className="lq-help__ex">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <p className="lq-help__levels">
        <span className="lq-help__levels-title">{t('logsQuery.help.levels')}</span>
        <span>{t('logsQuery.help.levelsText')}</span>
      </p>
    </div>
  );
}
