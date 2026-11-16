import { useState } from 'react';
import { Button, Callout } from '../../../components';
import { useT } from '../../../i18n';

/**
 * A save was refused because another window changed the rules first. The list already shows that window's rules;
 * the user picks which change stays, and each button says what it throws away.
 */
export function ConflictNotice({ onReload, onOverwrite }: { onReload: () => void; onOverwrite: () => Promise<void> }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <Callout
      tone="warn"
      title={t('mocks.conflict.title')}
      className="mk-conflict"
      actions={
        <>
          <Button size="sm" variant="primary" onClick={onReload} disabled={busy}>
            {t('mocks.conflict.reload')}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setBusy(true);
              void onOverwrite().finally(() => setBusy(false));
            }}
            loading={busy}
          >
            {t('mocks.conflict.overwrite')}
          </Button>
        </>
      }
    >
      <p>{t('mocks.conflict.body')}</p>
      <ul className="mk-conflict__choices">
        <li>
          <strong>{t('mocks.conflict.reload')}:</strong> {t('mocks.conflict.reloadHint')}
        </li>
        <li>
          <strong>{t('mocks.conflict.overwrite')}:</strong> {t('mocks.conflict.overwriteHint')}
        </li>
      </ul>
    </Callout>
  );
}
