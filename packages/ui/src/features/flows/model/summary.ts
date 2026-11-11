/** One-line description of what a node does, for the canvas card ("GET {{env.baseUrl}}/v1/cart"). */
import type { FlowConditionRule, FlowNode } from '@durbun/protocol';
import { getLanguage, type Lang } from '../../../i18n';
import { formatSpan, optionLabel, ruleText } from './text';

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');

/** `{{env.baseUrl}}/v1/cart` → `/v1/cart` (the base adds nothing on a card). */
function shortUrl(url: string): string {
  return url.replace(/^\{\{\s*env\.[A-Za-z0-9_]+\s*\}\}/, '').replace(/^https?:\/\/[^/]+/, '') || url;
}

function rule(r: FlowConditionRule | undefined, lang: Lang): string {
  return r ? ruleText(r, lang) : '';
}

function duration(ms: unknown, lang: Lang): string {
  const n = typeof ms === 'string' && ms.trim() === '' ? NaN : Number(ms);
  return Number.isFinite(n) ? formatSpan(n, lang) : str(ms);
}

export function nodeSummary(node: FlowNode, lang: Lang = getLanguage()): string {
  const p = node.params ?? {};
  const more = (list: unknown[], one: string) => (list.length > 1 ? `${one} +${list.length - 1}` : one);
  switch (node.type) {
    case 'trigger.event': {
      const ev = str(p.event) || 'crash';
      const label = optionLabel(node.type, 'event', ev, lang);
      const detail = str(p.text) || str(p.url);
      return detail ? `${label}: ${detail}` : label;
    }
    case 'http.request':
      return `${str(p.method) || 'GET'} ${shortUrl(str(p.url))}`.trim();
    case 'wait.network':
    case 'mock.add': {
      const m = str(p.method);
      return `${m && m !== '*' ? `${m} ` : ''}${str(p.url)}`.trim();
    }
    case 'logic.condition':
    case 'check.assert': {
      const list = (Array.isArray(p.rules) ? p.rules : Array.isArray(p.assertions) ? p.assertions : []) as FlowConditionRule[];
      return list.length ? more(list, rule(list[0], lang)) : '';
    }
    case 'logic.repeat': {
      const until = Array.isArray(p.until) ? (p.until as FlowConditionRule[]) : [];
      const count = str(p.count);
      const times = /^\d+$/.test(count) ? (lang === 'tr' ? `${count} kez` : `${count}×`) : count;
      return until.length ? `${times} · ${rule(until[0], lang)}` : times;
    }
    case 'logic.setVariables': {
      const list = (Array.isArray(p.assignments) ? p.assignments : []) as { name?: string; value?: string }[];
      return list.length ? more(list, `${list[0]!.name ?? ''} = ${list[0]!.value ?? ''}`) : '';
    }
    case 'logic.delay':
      return duration(p.durationMs, lang);
    case 'flow.call':
      return str(p.flowId);
    case 'flow.end':
      return [optionLabel(node.type, 'status', str(p.status) || 'passed', lang), str(p.message)].filter(Boolean).join(' · ');
    case 'wait.log':
      return str(p.text);
    case 'wait.event':
      return str(p.name);
    case 'device.openUrl':
      return str(p.url);
    case 'device.installApp':
      return str(p.file).split('/').pop() ?? '';
    case 'device.appearance':
    case 'device.statusBar':
      return optionLabel(node.type, 'mode', str(p.mode), lang);
    case 'device.fontScale':
      return `× ${str(p.scale)}`;
    case 'device.location':
      return `${str(p.lat)}, ${str(p.lon)}`;
    case 'device.inputText':
      return str(p.text);
    case 'device.keyEvent':
      return optionLabel(node.type, 'key', str(p.key), lang);
    case 'device.animations':
      return p.enabled === true ? (lang === 'tr' ? 'Açık' : 'On') : lang === 'tr' ? 'Kapalı' : 'Off';
    case 'device.screenshot':
    case 'device.stopRecording':
      return str(p.name);
    case 'mock.toggle':
      return `${str(p.rule)} → ${p.enabled === false ? (lang === 'tr' ? 'kapalı' : 'off') : lang === 'tr' ? 'açık' : 'on'}`;
    case 'mock.remove':
      return str(p.rule);
    case 'output.marker':
      return str(p.label);
    case 'output.slack':
    case 'output.note':
      return str(p.text).split('\n')[0] ?? '';
    case 'device.launchApp':
    case 'device.stopApp':
    case 'device.restartApp':
    case 'device.clearData':
    case 'device.uninstallApp':
    case 'device.pushNotification': {
      const app = str(p.appId);
      return app && app !== '{{target.appId}}' ? app : '';
    }
    default:
      return '';
  }
}
