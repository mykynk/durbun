import { useId, useState } from 'react';
import { clsx } from 'clsx';
import { Check, Moon, Palette, Sun } from 'lucide-react';
import type { DeviceInfo } from '@durbun/protocol';
import { Button, formatNumber } from '../../components';
import { useT } from '../../i18n';
import {
  ANDROID_FONT_MAX,
  ANDROID_FONT_MIN,
  ANDROID_FONT_PRESETS,
  IOS_CONTENT_SIZES,
  IOS_DEFAULT_SIZE_INDEX,
  clampAndroidScale,
  fontScaleMode,
  fontScaleParams,
  hasAction,
} from './model';
import { ActionErrorCallout, DeviceCard, useDeviceAction } from './useAction';

/** Stateless choice buttons: the device does not report its current value, so the last applied one is marked. */
function ChoiceButtons<T extends string>({
  options,
  last,
  pendingKey,
  isPending,
  onPick,
  label,
}: {
  options: { value: T; label: string; icon?: typeof Sun }[];
  last: T | null;
  pendingKey: (v: T) => string;
  isPending: (key: string) => boolean;
  onPick: (v: T) => void;
  label: string;
}) {
  const t = useT();
  return (
    <div className="dv-choices" role="group" aria-label={label}>
      {options.map((o) => (
        <Button
          key={o.value}
          size="sm"
          variant={last === o.value ? 'subtle' : 'secondary'}
          icon={last === o.value ? Check : o.icon}
          loading={isPending(pendingKey(o.value))}
          onClick={() => onPick(o.value)}
          title={last === o.value ? t('device.look.lastApplied') : undefined}
          aria-pressed={last === o.value}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

export function AppearanceCard({ device }: { device: DeviceInfo }) {
  const t = useT();
  const sliderId = useId();
  const { run, isPending, error, clearError } = useDeviceAction(device.id);
  const [lastTheme, setLastTheme] = useState<'light' | 'dark' | null>(null);
  const [lastAnim, setLastAnim] = useState<'on' | 'off' | null>(null);
  const mode = fontScaleMode(device);
  const [androidScale, setAndroidScale] = useState(1);
  const [iosIndex, setIosIndex] = useState(IOS_DEFAULT_SIZE_INDEX);
  const [lastFont, setLastFont] = useState<number | null>(null);

  const setTheme = async (m: 'light' | 'dark') => {
    const r = await run({ key: `appearance-${m}`, action: 'appearance', params: { mode: m }, success: t(`device.look.done.${m}`), failure: t('device.look.failed.theme') });
    if (r.ok) setLastTheme(m);
  };
  const setAnim = async (v: 'on' | 'off') => {
    const r = await run({
      key: `animations-${v}`,
      action: 'animations',
      params: { enabled: v === 'on' },
      success: t(v === 'on' ? 'device.look.done.animOn' : 'device.look.done.animOff'),
      failure: t('device.look.failed.anim'),
    });
    if (r.ok) setLastAnim(v);
  };
  const fontLabel = (value: number) =>
    mode === 'android' ? `${formatNumber(clampAndroidScale(value), { maxFractionDigits: 2 })}×` : t(`device.look.size.${IOS_CONTENT_SIZES[value]?.id ?? 'large'}`);
  const applyFont = async (value: number) => {
    const r = await run({
      key: 'font-scale',
      action: 'font-scale',
      params: fontScaleParams(mode, value),
      success: t('device.look.done.font', { value: fontLabel(value) }),
      failure: t('device.look.failed.font'),
    });
    if (r.ok) setLastFont(mode === 'android' ? clampAndroidScale(value) : value);
  };

  const showTheme = hasAction(device, 'appearance');
  const showFont = hasAction(device, 'font-scale');
  const showAnim = hasAction(device, 'animations');
  const current = mode === 'android' ? androidScale : iosIndex;

  return (
    <DeviceCard section="appearance" title={t('device.look.title')} icon={Palette}>
      <ActionErrorCallout error={error} onDismiss={clearError} />
      {showTheme ? (
        <div className="dv-row dv-row--field">
          <span className="dv-label">{t('device.look.theme')}</span>
          <ChoiceButtons
            label={t('device.look.theme')}
            options={[
              { value: 'light', label: t('device.look.light'), icon: Sun },
              { value: 'dark', label: t('device.look.dark'), icon: Moon },
            ]}
            last={lastTheme}
            pendingKey={(v) => `appearance-${v}`}
            isPending={isPending}
            onPick={(v) => void setTheme(v)}
          />
        </div>
      ) : null}
      {showFont ? (
        <div className="dv-font">
          <div className="dv-row dv-row--field">
            <label className="dv-label" htmlFor={sliderId}>
              {t('device.look.fontScale')}
            </label>
            <span className="dv-font__value tnum">{fontLabel(current)}</span>
          </div>
          {mode === 'android' ? (
            <div className="dv-chips" role="group" aria-label={t('device.look.fontScale')}>
              {ANDROID_FONT_PRESETS.map((p) => (
                <button
                  key={p.scale}
                  type="button"
                  className={clsx('dv-chip', lastFont === p.scale && 'is-active')}
                  aria-pressed={lastFont === p.scale}
                  disabled={isPending('font-scale')}
                  onClick={() => {
                    setAndroidScale(p.scale);
                    void applyFont(p.scale);
                  }}
                >
                  <span>{t(`device.look.font.${p.key}`)}</span>
                  <span className="dv-chip__sub tnum">{formatNumber(p.scale, { maxFractionDigits: 2 })}×</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="dv-row">
            <input
              id={sliderId}
              type="range"
              className="dv-range grow"
              min={mode === 'android' ? ANDROID_FONT_MIN : 0}
              max={mode === 'android' ? ANDROID_FONT_MAX : IOS_CONTENT_SIZES.length - 1}
              step={mode === 'android' ? 0.05 : 1}
              value={current}
              aria-valuetext={fontLabel(current)}
              onChange={(e) => (mode === 'android' ? setAndroidScale(Number(e.target.value)) : setIosIndex(Number(e.target.value)))}
            />
            <Button size="sm" loading={isPending('font-scale')} onClick={() => void applyFont(current)}>
              {t('device.look.apply')}
            </Button>
          </div>
        </div>
      ) : null}
      {showAnim ? (
        <div className="dv-row dv-row--field">
          <span className="dv-label" title={t('device.look.animHint')}>
            {t('device.look.animations')}
          </span>
          <ChoiceButtons
            label={t('device.look.animations')}
            options={[
              { value: 'on', label: t('device.look.animOn') },
              { value: 'off', label: t('device.look.animOff') },
            ]}
            last={lastAnim}
            pendingKey={(v) => `animations-${v}`}
            isPending={isPending}
            onPick={(v) => void setAnim(v)}
          />
        </div>
      ) : null}
      {showAnim ? <p className="dv-hint">{t('device.look.animHint')}</p> : null}
    </DeviceCard>
  );
}
