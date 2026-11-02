import { useState } from 'react';
import { ArrowLeft, CornerDownLeft, Delete, House, Keyboard, LayoutGrid, Menu, Power, Send, Volume1, Volume2 } from 'lucide-react';
import type { DeviceInfo } from '@durbun/protocol';
import { Button, Input, Tooltip, type IconType } from '../../components';
import { useT } from '../../i18n';
import { ANDROID_KEYS, hasAction, nonAsciiChars, type AndroidKey } from './model';
import { ActionErrorCallout, DeviceCard, useDeviceAction } from './useAction';

const KEY_ICONS: Record<AndroidKey, IconType> = {
  home: House,
  back: ArrowLeft,
  recents: LayoutGrid,
  menu: Menu,
  enter: CornerDownLeft,
  delete: Delete,
  'volume-down': Volume1,
  'volume-up': Volume2,
  power: Power,
};

export function InputCard({ device }: { device: DeviceInfo }) {
  const t = useT();
  const [text, setText] = useState('');
  const { run, isPending, error, clearError } = useDeviceAction(device.id);
  const bad = nonAsciiChars(text);
  const canText = hasAction(device, 'input-text');
  const canKeys = hasAction(device, 'key-event');

  const send = async () => {
    if (!text || bad.length > 0) return;
    const r = await run({ action: 'input-text', params: { text }, success: t('device.input.sent'), failure: t('device.input.failed') });
    if (r.ok) setText('');
  };

  const press = (key: AndroidKey) =>
    void run({ key: `key-${key}`, action: 'key-event', params: { key }, failure: t('device.input.keyFailed') });

  return (
    <DeviceCard section="input" title={t('device.input.title')} icon={Keyboard}>
      <ActionErrorCallout error={error} onDismiss={clearError} />
      {canText ? (
        <>
          <form
            className="dv-row"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t('device.input.placeholder')}
              aria-label={t('device.input.text')}
              invalid={bad.length > 0}
              className="grow"
              autoComplete="off"
              spellCheck={false}
            />
            <Button type="submit" icon={Send} loading={isPending('input-text')} disabled={!text || bad.length > 0}>
              {t('device.input.send')}
            </Button>
          </form>
          {bad.length > 0 ? <p className="dv-field-error">{t('device.input.ascii', { chars: bad.join(' ') })}</p> : null}
        </>
      ) : null}
      {canKeys ? (
        <>
          <div className="dv-subhead">
            <span>{t('device.input.keys')}</span>
          </div>
          <div className="dv-keys" role="group" aria-label={t('device.input.keys')}>
            {ANDROID_KEYS.map((k) => {
              const Icon = KEY_ICONS[k];
              const label = t(`device.input.key.${k}`);
              return (
                <Tooltip key={k} content={label}>
                  <button type="button" className="dv-key" aria-label={label} disabled={isPending(`key-${k}`)} onClick={() => press(k)}>
                    <Icon size={15} aria-hidden />
                    <span className="dv-key__label">{label}</span>
                  </button>
                </Tooltip>
              );
            })}
          </div>
        </>
      ) : null}
    </DeviceCard>
  );
}
