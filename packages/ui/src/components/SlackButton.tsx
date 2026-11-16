import { useRef, useState } from 'react';
import { ExternalLink, Send, Settings } from 'lucide-react';
import { sendToSlack } from '../data/api';
import { updateSlack, useSlackStatus } from '../data/stores/slack';
import { ui } from '../data/stores/ui';
import { errorText, useLanguage, useT } from '../i18n';
import { SLACK_ADD_URL, toSlackText } from '../lib/slack';
import { Button } from './Button';
import { Input } from './Form';
import { Popover } from './Popover';
import { toast } from './Toast';

export interface SlackButtonProps {
  /** The report (light Markdown) to post; converted to Slack's mrkdwn here. */
  report: string;
  disabled?: boolean;
  /** After a successful send (close the dialog). */
  onSent?: () => void;
  /** Before Settings opens on the Slack section ("All Slack settings": close the dialog first, one modal at a time). */
  onConnect?: () => void;
  variant?: 'primary' | 'secondary';
}

/**
 * "Send to Slack" in share dialogs: posts [report] to the channel of the webhook set in Settings → Slack,
 * only when clicked. Without a webhook it offers to connect one right here, so the dialog and its report stay open
 * and the message can go as soon as the channel is linked.
 */
export function SlackButton({ report, disabled, onSent, onConnect, variant = 'secondary' }: SlackButtonProps) {
  const t = useT();
  const status = useSlackStatus();
  const [sending, setSending] = useState(false);

  if (!status?.configured) return <SlackConnect disabled={status === null} onAllSettings={onConnect} />;

  const send = async () => {
    if (sending || disabled) return;
    setSending(true);
    try {
      const footer = status.sender ? t('common.slack.footerFrom', { sender: status.sender }) : t('common.slack.footer');
      await sendToSlack(toSlackText(report, { cutNote: t('common.slack.cutNote'), footer }));
      toast.success(t('common.slack.sent'));
      onSent?.();
    } catch (err) {
      toast.error(t('common.slack.failed'), { description: errorText(err) });
    } finally {
      setSending(false);
    }
  };

  return (
    <Button variant={variant} icon={Send} loading={sending} disabled={disabled} title={status.hint ? `${t('common.slack.sendTip')} · ${status.hint}` : t('common.slack.sendTip')} onClick={() => void send()}>
      {t('common.slack.send')}
    </Button>
  );
}

/** Links a channel without leaving the dialog: paste the webhook, or open the full Slack settings. */
function SlackConnect({ disabled, onAllSettings }: { disabled: boolean; onAllSettings?: () => void }) {
  const t = useT();
  const lang = useLanguage();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const link = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    try {
      await updateSlack({ webhookUrl: url.trim() });
      setUrl('');
      setOpen(false);
      toast.success(t('shell.settings.slackLinked'), { description: t('common.slack.linkedHere') });
    } catch (err) {
      toast.error(t('shell.settings.saveFailed'), { description: errorText(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button ref={ref} variant="ghost" icon={Send} disabled={disabled} title={t('common.slack.connectTip')} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        {t('common.slack.connect')}
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} side="top" align="end" width={360} role="dialog" aria-label={t('common.slack.connect')} className="slack-connect">
        <form
          className="slack-connect__form"
          onSubmit={(e) => {
            e.preventDefault();
            void link();
          }}
        >
          <div className="slack-connect__title">{t('common.slack.connect')}</div>
          <p className="slack-connect__hint">{t('shell.settings.slackWebhookHint')}</p>
          <a className="btn btn--secondary btn--sm slack-connect__add" href={`${SLACK_ADD_URL}?lang=${lang}`} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={14} aria-hidden />
            <span className="btn__label">{t('shell.settings.slackAppAdd')}</span>
          </a>
          {/* A password field: the URL is the secret, and dialogs get shown in screen shares. */}
          <Input
            size="sm"
            mono
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={url}
            placeholder="https://hooks.slack.com/services/…"
            aria-label={t('shell.settings.slackWebhook')}
            onChange={(e) => setUrl(e.target.value)}
            autoFocus
          />
          <div className="slack-connect__actions">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              icon={Settings}
              onClick={() => {
                setOpen(false);
                onAllSettings?.();
                ui.openSettings('slack');
              }}
            >
              {t('common.slack.allSettings')}
            </Button>
            <span className="grow" />
            <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!url.trim()}>
              {t('shell.settings.slackLink')}
            </Button>
          </div>
        </form>
      </Popover>
    </>
  );
}
