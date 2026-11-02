import { useId, useState } from 'react';
import { clsx } from 'clsx';
import { MapPin } from 'lucide-react';
import type { DeviceInfo } from '@durbun/protocol';
import { Button, Input } from '../../components';
import { useT } from '../../i18n';
import { LOCATION_PRESETS, parseCoordinatePair, validateLocation } from './model';
import { ActionErrorCallout, DeviceCard, useDeviceAction } from './useAction';

export function LocationCard({ device }: { device: DeviceInfo }) {
  const t = useT();
  const id = useId();
  const { run, isPending, error, clearError } = useDeviceAction(device.id);
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [fieldError, setFieldError] = useState<'lat' | 'lon' | null>(null);
  const [last, setLast] = useState<{ place: string; preset?: string } | null>(null);

  // Coordinates keep the map-style dot decimals in every language ("41.0082, 28.9784").
  const coords = (la: number, lo: number) => `${Number(la.toFixed(5))}, ${Number(lo.toFixed(5))}`;

  const apply = async (la: number, lo: number, place: string, preset?: string) => {
    const r = await run({ key: preset ? `loc-${preset}` : 'loc-custom', action: 'location', params: { lat: la, lon: lo }, success: t('device.loc.done', { place }), failure: t('device.loc.failed') });
    if (r.ok) setLast({ place, preset });
  };

  const applyCustom = () => {
    const v = validateLocation(lat, lon);
    if ('error' in v) {
      setFieldError(v.error);
      return;
    }
    setFieldError(null);
    void apply(v.lat, v.lon, coords(v.lat, v.lon));
  };

  return (
    <DeviceCard section="location" title={t('device.loc.title')} icon={MapPin} description={last ? t('device.loc.current', { place: last.place }) : undefined}>
      <ActionErrorCallout error={error} onDismiss={clearError} />
      <div className="dv-subhead">
        <span>{t('device.loc.presets')}</span>
      </div>
      <div className="dv-chips" role="group" aria-label={t('device.loc.presets')}>
        {LOCATION_PRESETS.map((p) => {
          const name = t(`device.loc.city.${p.id}`);
          return (
            <button
              key={p.id}
              type="button"
              className={clsx('dv-chip', last?.preset === p.id && 'is-active')}
              aria-pressed={last?.preset === p.id}
              disabled={isPending(`loc-${p.id}`)}
              title={coords(p.lat, p.lon)}
              onClick={() => {
                setLat(String(p.lat));
                setLon(String(p.lon));
                setFieldError(null);
                void apply(p.lat, p.lon, name, p.id);
              }}
            >
              {name}
            </button>
          );
        })}
      </div>
      <div className="dv-subhead">
        <span>{t('device.loc.custom')}</span>
      </div>
      <form
        className="dv-row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          applyCustom();
        }}
      >
        <label className="dv-coord">
          <span className="dv-coord__label">{t('device.loc.lat')}</span>
          <Input
            id={`${id}-lat`}
            size="sm"
            mono
            inputMode="decimal"
            value={lat}
            invalid={fieldError === 'lat'}
            placeholder="41.0082"
            onChange={(e) => {
              const pair = parseCoordinatePair(e.target.value);
              if (pair) {
                setLat(String(pair.lat));
                setLon(String(pair.lon));
              } else setLat(e.target.value);
              setFieldError(null);
            }}
          />
        </label>
        <label className="dv-coord">
          <span className="dv-coord__label">{t('device.loc.lon')}</span>
          <Input
            id={`${id}-lon`}
            size="sm"
            mono
            inputMode="decimal"
            value={lon}
            invalid={fieldError === 'lon'}
            placeholder="28.9784"
            onChange={(e) => {
              setLon(e.target.value);
              setFieldError(null);
            }}
          />
        </label>
        <div className="dv-coord__actions">
          <Button type="submit" size="sm" variant="primary" loading={isPending('loc-custom')} disabled={!lat.trim() || !lon.trim()}>
            {t('device.loc.apply')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title={t('device.loc.clearHint')}
            onClick={() => {
              setLat('');
              setLon('');
              setFieldError(null);
              setLast(null);
            }}
          >
            {t('device.loc.clear')}
          </Button>
        </div>
      </form>
      {fieldError ? <p className="dv-field-error">{t(fieldError === 'lat' ? 'device.loc.latError' : 'device.loc.lonError')}</p> : <p className="dv-hint">{t('device.loc.pasteHint')}</p>}
    </DeviceCard>
  );
}
