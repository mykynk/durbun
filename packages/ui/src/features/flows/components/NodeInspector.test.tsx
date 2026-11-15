import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { FlowDoc } from '@durbun/protocol';
import { NodeInspector } from './NodeInspector';
import { linksInto, linksOf } from '../model/graph';
import '../i18n';

afterEach(cleanup);

const flow: FlowDoc = {
  id: 'f1',
  name: 'Login',
  nodes: [
    { id: 'start', type: 'trigger.manual', position: { x: 0, y: 0 } },
    { id: 'check', type: 'logic.condition', position: { x: 300, y: 0 } },
    { id: 'ok', type: 'logic.delay', position: { x: 600, y: 0 } },
    { id: 'fail', type: 'logic.delay', position: { x: 600, y: 200 } },
  ],
  edges: [
    { from: 'start', to: 'check' },
    { from: 'check', port: 'true', to: 'ok' },
  ],
} as unknown as FlowDoc;

function renderInspector(doc: FlowDoc, id: string, onApply: (f: FlowDoc) => void) {
  return render(
    <NodeInspector
      flow={doc}
      node={doc.nodes.find((n) => n.id === id)!}
      issues={[]}
      flows={[]}
      apply={(edit) => onApply(edit(doc))}
      onRenamed={() => undefined}
      onDelete={() => undefined}
      onDuplicate={() => undefined}
      onRunFromHere={() => undefined}
      onOpenFlow={() => undefined}
    />,
  );
}

describe('step connections without the pointer', () => {
  it('lists the links per port and where the step is reached from', () => {
    expect(linksOf(flow, 'check')).toEqual([{ port: 'true', to: ['ok'] }]);
    expect(linksInto(flow, 'check')).toEqual([{ from: 'start', port: 'out' }]);
  });

  it('connects a port to a step and removes a link', () => {
    let next: FlowDoc | undefined;
    renderInspector(flow, 'check', (f) => (next = f));
    const picker = screen.getByRole('combobox', { name: /“No”/ }) as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: 'fail' } });
    expect(next!.edges).toContainEqual(expect.objectContaining({ from: 'check', port: 'false', to: 'fail' }));
    fireEvent.click(screen.getByRole('button', { name: /^Remove Yes → / }));
    expect(next!.edges.some((e) => e.from === 'check' && e.port === 'true')).toBe(false);
  });
});
