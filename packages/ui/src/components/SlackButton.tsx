import { useState } from 'react';
import { Send } from 'lucide-react';
import { sendToSlack } from '../data/api';
import { useSlackStatus } from '../data/stores/slack';
import { ui } from '../data/stores/ui';
import { errorText, useT } from '../i18n';
import { toSlackText } from '../lib/slack';
import { Button } from './Button';
import { toast } from './Toast';

export interface SlackButtonProps {
  /** The report (light Markdown) to post; converted to Slack's mrkdwn here. */
  report: string;
  disabled?: boolean;
  /** After a successful send (close the dialog). */
  onSent?: () => void;
  /** Before Settings opens on the Slack section (close the dialog first: one modal at a time). */
  onConnect?: () => void;
  variant?: 'primary' | 'secondary';
}

/**
 * "Send to Slack" in share dialogs: posts [report] to the channel of the webhook set in Settings → Slack,
 * only when clicked. Without a webhook it offers to connect one.
 */
export function SlackButton({ report, disabled, onSent, onConnect, variant = 'secondary' }: SlackButtonProps) {
  const t = useT();
  const status = useSlackStatus();
  const [sending, setSending] = useState(false);

  if (!status?.configured) {
    return (
      <Button
        variant="ghost"
        icon={Send}
        disabled={status === null}
        title={t('common.slack.connectTip')}
        onClick={() => {
          onConnect?.();
          ui.openSettings('slack');
        }}
      >
        {t('common.slack.connect')}
      </Button>
    );
  }

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
