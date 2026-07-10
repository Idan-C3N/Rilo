import { describe, it, expect, vi } from 'vitest';
import { createTelegramAdapter } from '../../src/channels/telegram.js';

function fakeBot() {
  const calls: any = { sendMessage: [], sendChatAction: [] };
  let handler: (ctx: any) => Promise<void>;
  return {
    calls,
    fire: (ctx: any) => handler(ctx),
    bot: {
      on: (_event: string, cb: any) => { handler = cb; },
      start: () => {},
      stop: async () => {},
      api: {
        sendMessage: async (id: string, text: string, other?: any) => { calls.sendMessage.push([id, text, other]); },
        sendChatAction: async (id: string, a: string) => { calls.sendChatAction.push([id, a]); },
      },
    },
  };
}

describe('telegram adapter', () => {
  it('routes inbound text to the handler and can send', async () => {
    const f = fakeBot();
    const adapter = createTelegramAdapter({ token: 'x', makeBot: () => f.bot as any });
    const received: any[] = [];
    adapter.onMessage(async (m) => { received.push(m); });
    adapter.start();
    await f.fire({ from: { id: 42, first_name: 'Ann' }, message: { text: 'hi' } });
    expect(received[0]).toEqual({ channel: 'telegram', channelUserId: '42', text: 'hi', name: 'Ann' });
    await adapter.send('42', 'yo');
    const [id, text, other] = f.calls.sendMessage[0];
    expect(id).toBe('42');
    expect(text).toContain('yo');
    expect(other).toEqual({ parse_mode: 'MarkdownV2' });
  });

  it('converts markdown bold to Telegram MarkdownV2', async () => {
    const f = fakeBot();
    const adapter = createTelegramAdapter({ token: 'x', makeBot: () => f.bot as any });
    await adapter.send('42', 'a **message** here');
    const [, text, other] = f.calls.sendMessage[0];
    // MarkdownV2 bold is single-asterisk; standard '**' must be converted.
    expect(text).toContain('*message*');
    expect(text).not.toContain('**message**');
    expect(other).toEqual({ parse_mode: 'MarkdownV2' });
  });

  it('typing controller sends typing immediately and repeats on interval', () => {
    vi.useFakeTimers();
    const f = fakeBot();
    const adapter = createTelegramAdapter({ token: 'x', makeBot: () => f.bot as any });
    const t = adapter.typingFor('7');
    t.start();
    expect(f.calls.sendChatAction).toEqual([['7', 'typing']]);
    vi.advanceTimersByTime(4000);
    expect(f.calls.sendChatAction.length).toBe(2);
    t.stop();
    vi.advanceTimersByTime(8000);
    expect(f.calls.sendChatAction.length).toBe(2);
    vi.useRealTimers();
  });

  it('double start() does not leak a second interval', () => {
    vi.useFakeTimers();
    const f = fakeBot();
    const adapter = createTelegramAdapter({ token: 'x', makeBot: () => f.bot as any });
    const t = adapter.typingFor('7');
    t.start();
    t.start(); // guarded: must be a no-op, not a second immediate send / second interval
    expect(f.calls.sendChatAction).toEqual([['7', 'typing']]);
    vi.advanceTimersByTime(4000);
    expect(f.calls.sendChatAction.length).toBe(2); // one interval, not two
    t.stop();
    vi.advanceTimersByTime(8000);
    expect(f.calls.sendChatAction.length).toBe(2); // stop cleared the single interval
    vi.useRealTimers();
  });
});
