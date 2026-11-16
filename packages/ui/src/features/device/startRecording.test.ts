/** `startRecording` / `stopRecording`: the run state, the command sent, the file in the library, failures. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UiToServer } from '@durbun/protocol';
import { __resetCommandsForTests, handleReply, setCommandTransport } from '../../data/commands';
import { setLanguage } from '../../i18n';
import { useMediaLibrary } from './media/store';
import { startRecording, stopRecording, useRecorder } from './stores';

type Cmd = Extract<UiToServer, { type: 'command' }>;
let sent: Cmd[] = [];

beforeEach(() => {
  setLanguage('en');
  sent = [];
  setCommandTransport({ isOpen: () => true, send: (m) => (m.type === 'command' && sent.push(m), true) });
  useRecorder.setState({ runs: {}, errors: {} });
  useMediaLibrary.setState({ status: 'ready', items: [], usedBytes: 0, total: 0, pendingDelete: {}, error: undefined });
});
afterEach(() => __resetCommandsForTests());

const reply = (i: number, data: unknown) => handleReply({ type: 'reply', requestId: sent[i]!.requestId, ok: true, data });
const refuse = (i: number, code: string, error = 'failed') => handleReply({ type: 'reply', requestId: sent[i]!.requestId, ok: false, error, code });

describe('startRecording', () => {
  it('sends screen-record, shows the run while it lasts, puts the file in the library when it ends', async () => {
    const done = startRecording('android:1', 600);
    expect(sent[0]!.command).toEqual({ name: 'device.action', deviceId: 'android:1', action: 'screen-record', params: {} });
    expect(useRecorder.getState().runs['android:1']).toMatchObject({ local: true, stopping: false });
    reply(0, { url: '/api/files/rec-a.mp4', file: '/tmp/rec-a.mp4', durationSec: 12, endedBy: 'limit' });
    await done;
    expect(useRecorder.getState().runs['android:1']).toBeUndefined();
    const items = useMediaLibrary.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'recording', deviceId: 'android:1', url: '/api/files/rec-a.mp4', durationSec: 12 });
  });

  it('a second start on the same device while one runs sends nothing', async () => {
    const first = startRecording('android:1', 600);
    await startRecording('android:1', 600);
    expect(sent).toHaveLength(1);
    reply(0, { url: '/api/files/rec-b.mp4', durationSec: 3 });
    await first;
  });

  it('a refused start is kept as the device error and the run ends', async () => {
    const done = startRecording('android:1', 600);
    refuse(0, 'action.recording.busy', 'A recording is already running');
    await done;
    expect(useRecorder.getState().runs['android:1']).toBeUndefined();
    expect(useRecorder.getState().errors['android:1']).toMatchObject({ kind: 'start' });
  });

  it('a reply without a file is not added', async () => {
    const done = startRecording('android:1', 600);
    reply(0, { nothing: true });
    await done;
    expect(useMediaLibrary.getState().items).toHaveLength(0);
  });

  it('stop: both replies carry the same file, it is added once', async () => {
    const run = startRecording('android:1', 600);
    const stop = stopRecording('android:1');
    expect(sent[1]!.command).toMatchObject({ action: 'screen-record-stop' });
    expect(useRecorder.getState().runs['android:1']).toMatchObject({ local: true, stopping: true });
    const file = { url: '/api/files/rec-c.mp4', file: '/tmp/rec-c.mp4', durationSec: 7, endedBy: 'stop' };
    reply(1, file);
    reply(0, file);
    await Promise.all([run, stop]);
    expect(useMediaLibrary.getState().items.filter((i) => i.url === '/api/files/rec-c.mp4')).toHaveLength(1);
    expect(useRecorder.getState().runs['android:1']).toBeUndefined();
  });

  it('stop of a recording that already ended is not an error', async () => {
    const stop = stopRecording('android:2', Date.now() - 5_000);
    refuse(0, 'action.recording.notRunning');
    await stop;
    expect(useRecorder.getState().errors['android:2']).toBeUndefined();
    expect(useRecorder.getState().runs['android:2']).toBeUndefined();
  });
});
