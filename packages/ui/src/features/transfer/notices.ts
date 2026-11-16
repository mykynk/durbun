import './i18n';
import { hasMessage, t, tCode } from '../../i18n';

/** A package warning or import notice as the server sends it (`message` is its English text). */
export interface PackageNoticeLike {
  code: string;
  message: string;
  params?: Record<string, string | number> | undefined;
}

/** The ways a mock rule can be wrong (`package.mock.invalid` params.expected); anything else reads "is not valid". */
export const MOCK_EXPECTED = ['required', 'text', 'number', 'range', 'oneOf', 'maxLength', 'base64', 'httpMethod', 'headerList', 'appIdList', 'object', 'tooMany', 'list'] as const;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined);

/** What is wrong with one field of a mock rule, in the UI language. */
export function mockProblemText(params: Record<string, string | number>): string | undefined {
  const field = str(params.field);
  const expected = str(params.expected);
  if (!field || !expected) return undefined;
  const key = `transfer.notice.expected.${expected}`;
  // A rule that is not an object at all, or a list that is too long, has no field the user would recognize.
  return t(hasMessage(key) ? key : 'transfer.notice.expected.other', { ...params, field, expected });
}

/** A flow issue (`params.issue`, a flow check code) in the UI language; the English `problem` when unknown. */
function issueText(params: Record<string, string | number>): string | undefined {
  const issue = str(params.issue);
  const problem = str(params.problem) ?? '';
  if (!issue) return undefined;
  return tCode(issue, params, problem) || undefined;
}

/**
 * The text of a package warning (inspect) or import notice. Codes that carry an English `problem` are worded from
 * their structured params instead (the flow check's own code, the mock field and what it expects), so no English
 * sentence ends up inside a Turkish one; older servers without those params keep the coded text.
 */
export function packageNoticeText(n: PackageNoticeLike): string {
  const p = n.params ?? {};
  if (n.code === 'package.flow.invalid') {
    const issue = issueText(p);
    if (issue) return t('transfer.notice.flowInvalid', { issue });
  }
  if (n.code === 'package.flow.problems') {
    const issue = issueText(p);
    const flow = str(p.flow);
    const count = typeof p.count === 'number' ? p.count : Number(p.count);
    if (issue && flow && Number.isFinite(count)) return t('transfer.notice.flowProblems', { flow, count, issue });
  }
  if (n.code === 'package.mock.invalid') {
    const problem = mockProblemText(p);
    if (problem) {
      const rule = typeof p.rule === 'number' ? p.rule : Number(p.rule);
      const name = str(p.name);
      if (str(p.expected) === 'tooMany') return problem;
      if (name) return t('transfer.notice.mockInvalidNamed', { rule, name, problem });
      if (Number.isFinite(rule) && rule > 0) return t('transfer.notice.mockInvalid', { rule, problem });
      return t('transfer.notice.mockInvalidAny', { problem });
    }
  }
  return n.code ? tCode(n.code, p, n.message) : n.message;
}
