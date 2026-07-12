import { describe, it, expect, vi } from 'vitest';
import { createTelegramAdapter } from '../../src/channels/telegram.js';

function fakeBot(opts: { username?: string } = {}) {
  const calls: any = { sendMessage: [], sendChatAction: [] };
  const handlers: Record<string, (ctx: any) => Promise<void>> = {};
  return {
    calls,
    fire: (ctx: any) => handlers['message:text']!(ctx),
    fireEvent: (event: string, ctx: any) => handlers[event]!(ctx),
    bot: {
      on: (event: string, cb: any) => { handlers[event] = cb; },
      start: () => {},
      stop: async () => {},
      api: {
        sendMessage: async (id: string, text: string, other?: any) => { calls.sendMessage.push([id, text, other]); },
        sendChatAction: async (id: string, a: string) => { calls.sendChatAction.push([id, a]); },
        getMe: async () => ({ username: opts.username ?? 'rilo_bot' }),
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

  it('disableLinkPreview passes link_preview_options; default does not', async () => {
    const f = fakeBot();
    const adapter = createTelegramAdapter({ token: 'x', makeBot: () => f.bot as any });
    await adapter.send('42', 'http://host/login?token=abc', { disableLinkPreview: true });
    const [, , other] = f.calls.sendMessage[0];
    expect(other).toMatchObject({ parse_mode: 'MarkdownV2', link_preview_options: { is_disabled: true } });

    await adapter.send('42', 'plain');
    const [, , other2] = f.calls.sendMessage[1];
    expect(other2).toEqual({ parse_mode: 'MarkdownV2' });
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

  it('registrationLink builds a t.me deep link once the bot username is known', async () => {
    const f = fakeBot({ username: 'rilo_bot' });
    const adapter = createTelegramAdapter({ token: 'x', makeBot: () => f.bot as any });
    await adapter.ensureBotUsername();
    expect(adapter.registrationLink('abc123')).toBe('https://t.me/rilo_bot?start=abc123');
  });

  it('requestContact sends a message with a request_contact keyboard button', async () => {
    const f = fakeBot();
    const adapter = createTelegramAdapter({ token: 'x', makeBot: () => f.bot as any });
    await adapter.requestContact('55', 'Tap to share your number.');
    const [id, text, other] = f.calls.sendMessage[0];
    expect(id).toBe('55');
    expect(text).toContain('Tap to share your number.');
    const btn = other.reply_markup.keyboard[0][0];
    expect(btn.request_contact).toBe(true);
  });

  it('maps an inbound shared contact to InboundMessage.contact', async () => {
    const f = fakeBot();
    const adapter = createTelegramAdapter({ token: 'x', makeBot: () => f.bot as any });
    const received: any[] = [];
    adapter.onMessage(async (m) => { received.push(m); });
    adapter.start();
    await f.fireEvent('message:contact', {
      from: { id: 66, first_name: 'Cara' },
      message: { contact: { phone_number: '+972501234567', user_id: 66 } },
    });
    expect(received[0]).toEqual({
      channel: 'telegram',
      channelUserId: '66',
      text: '',
      name: 'Cara',
      contact: { phone: '+972501234567' },
    });
  });

  it('ignores a contact card that is not the sender\'s own (spoof guard)', async () => {
    const f = fakeBot();
    const adapter = createTelegramAdapter({ token: 'x', makeBot: () => f.bot as any });
    const received: any[] = [];
    adapter.onMessage(async (m) => { received.push(m); });
    adapter.start();
    // Attached contact card carrying someone else's number: user_id absent /
    // mismatched. Must NOT be treated as a verified phone share.
    await f.fireEvent('message:contact', {
      from: { id: 66, first_name: 'Cara' },
      message: { contact: { phone_number: '+972509999999', user_id: 77 } },
    });
    await f.fireEvent('message:contact', {
      from: { id: 66, first_name: 'Cara' },
      message: { contact: { phone_number: '+972509999999' } },
    });
    expect(received).toEqual([]);
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
