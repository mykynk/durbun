import { clsx } from 'clsx';
import { comboLabels } from '../lib/shortcuts';

/** Keycaps for a shortcut combo: <Kbd combo="Mod+K" /> → ⌘ K (macOS) / Ctrl K. */
export function Kbd({ combo, size = 'md', className }: { combo: string; size?: 'sm' | 'md'; className?: string }) {
  const labels = comboLabels(combo);
  return (
    <span className={clsx('kbd-group', size === 'sm' && 'kbd-group--sm', className)} aria-label={labels.join(' ')}>
      {labels.map((l, i) => (
        <kbd key={i} className="kbd">
          {l}
        </kbd>
      ))}
    </span>
  );
}
