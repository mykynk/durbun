import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Check, Copy } from 'lucide-react';
import { copyText } from '../lib/clipboard';
import { t } from '../i18n/core';
import { Tooltip } from './Tooltip';
import { toast } from './Toast';

export interface CopyButtonProps {
  /** Text to copy, or a function producing it on click (for large values). */
  value: string | (() => string);
  /** Tooltip / accessible label (default "Kopyala"). */
  label?: string;
  /** Visible text next to the icon (button style). */
  text?: string;
  size?: 'xs' | 'sm' | 'md';
  /** Show a toast after copying (default false; the icon turns into a check). */
  toastOnCopy?: boolean | string;
  className?: string;
  onCopied?: () => void;
}

/** Copy-to-clipboard button with a brief ✓ confirmation. */
export function CopyButton({ value, label, text, size = 'sm', toastOnCopy, className, onCopied }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const doCopy = async () => {
    const v = typeof value === 'function' ? value() : value;
    const ok = await copyText(v);
    if (!ok) {
      toast.error(t('common.copyFailed'));
      return;
    }
    setCopied(true);
    onCopied?.();
    if (toastOnCopy) toast.success(typeof toastOnCopy === 'string' ? toastOnCopy : t('common.copied'));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1200);
  };
  const iconSize = size === 'xs' ? 12 : size === 'sm' ? 13 : 15;
  const Icon = copied ? Check : Copy;
  const tip = copied ? t('common.copied') : (label ?? t('common.copy'));
  if (text) {
    return (
      <button type="button" className={clsx('btn', 'btn--secondary', size === 'md' ? 'btn--md' : 'btn--sm', copied && 'is-copied', className)} onClick={doCopy}>
        <Icon size={iconSize} aria-hidden />
        <span className="btn__label">{copied ? t('common.copied') : text}</span>
      </button>
    );
  }
  return (
    <Tooltip content={tip}>
      <button
        type="button"
        aria-label={label ?? t('common.copy')}
        className={clsx('icon-btn', 'icon-btn--ghost', `icon-btn--${size}`, 'copy-btn', copied && 'is-copied', className)}
        onClick={doCopy}
      >
        <Icon size={iconSize} aria-hidden />
      </button>
    </Tooltip>
  );
}
