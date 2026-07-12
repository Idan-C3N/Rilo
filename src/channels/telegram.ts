import { Bot } from 'grammy';
import telegramifyMarkdown from 'telegramify-markdown';
import type { ChannelAdapter, InboundMessage, TypingController } from './adapter.js';

export interface BotLike {
  on(event: string, cb: (ctx: any) => Promise<void> | void): void;
  catch?(handler: (err: unknown) => void): void;
  start(): void;
  stop(): Promise<void>;
  api: {
    sendMessage(chatId: string | number, text: string, other?: Record<string, unknown>): Promise<unknown>;
    sendChatAction(chatId: string | number, action: string): Promise<unknown>;
    getMe(): Promise<{ username: string }>;
  };
}

const ERROR_REPLY = '⚠️ Something went wrong handling that. Try again in a moment.';

export interface TelegramDeps {
  token: string;
  makeBot?: (token: string) => BotLike;
  /** Override the bot username (skips getMe); mainly for tests. */
  botUsername?: string;
}

/** Telegram adapter: the generic seams plus a username fetch for deep links. */
export type TelegramAdapter = ChannelAdapter & {
  typingFor(channelUserId: string): TypingController;
  /** Fetch + cache the bot username via getMe; needed before registrationLink. */
  ensureBotUsername(): Promise<string>;
};

const TYPING_INTERVAL_MS = 4000;

export function createTelegramAdapter(deps: TelegramDeps): TelegramAdapter {
  const bot: BotLike = deps.makeBot ? deps.makeBot(deps.token) : (new Bot(deps.token) as unknown as BotLike);
  let handler: ((m: InboundMessage) => Promise<void>) | null = null;
  let botUsername = deps.botUsername ?? '';

  // Route an inbound to the app handler, containing any failure so a crash in
  // the LLM/tool path never tears down grammy's long-polling loop.
  const deliver = async (channelUserId: string, m: InboundMessage) => {
    if (!handler) return;
    try {
      await handler(m);
    } catch (err) {
      console.error(`inbound handler failed for ${channelUserId}:`, err);
      try {
        await bot.api.sendMessage(channelUserId, ERROR_REPLY);
      } catch (sendErr) {
        console.error('failed to send error reply:', sendErr);
      }
    }
  };

  bot.on('message:text', async (ctx: any) => {
    const channelUserId = String(ctx.from.id);
    await deliver(channelUserId, {
      channel: 'telegram',
      channelUserId,
      text: ctx.message.text,
      name: ctx.from.first_name,
    });
  });

  bot.on('message:contact', async (ctx: any) => {
    const channelUserId = String(ctx.from.id);
    // Only a contact the sender shared about THEMSELVES is phone-verified:
    // the request_contact keyboard sets contact.user_id === from.id. An
    // arbitrary attached contact card carries someone else's number (or no
    // user_id) and must NOT count as identity proof — ignore it.
    if (ctx.message.contact.user_id !== ctx.from.id) return;
    await deliver(channelUserId, {
      channel: 'telegram',
      channelUserId,
      text: '',
      name: ctx.from.first_name,
      contact: { phone: ctx.message.contact.phone_number },
    });
  });

  // Backstop: never let any error kill long polling.
  bot.catch?.((err) => {
    console.error('grammy bot error (contained):', err);
  });

  return {
    channel: 'telegram',
    start: () => bot.start(),
    stop: () => bot.stop(),
    onMessage: (h) => { handler = h; },
    ensureBotUsername: async () => {
      if (!botUsername) botUsername = (await bot.api.getMe()).username;
      return botUsername;
    },
    registrationLink: (code) => `https://t.me/${botUsername}?start=${code}`,
    requestContact: async (channelUserId, text) => {
      await bot.api.sendMessage(channelUserId, text, {
        reply_markup: {
          keyboard: [[{ text: '📱 Share my number', request_contact: true }]],
          one_time_keyboard: true,
          resize_keyboard: true,
        },
      });
    },
    send: async (channelUserId, text, opts) => {
      // Telegram fetches URLs to build link previews — for a one-time login link
      // that prefetch would consume the token. Callers can suppress it.
      const extra = opts?.disableLinkPreview ? { link_preview_options: { is_disabled: true } } : {};
      // LLM emits standard Markdown; Telegram needs MarkdownV2 with strict
      // escaping. Convert, then send. On any parse failure fall back to plain
      // so the message is never lost.
      try {
        const md = telegramifyMarkdown(text, 'escape');
        await bot.api.sendMessage(channelUserId, md, { parse_mode: 'MarkdownV2', ...extra });
      } catch (err) {
        console.error(`markdown send failed for ${channelUserId}, sending plain:`, err);
        await bot.api.sendMessage(channelUserId, text, extra);
      }
    },
    typingFor: (channelUserId): TypingController => {
      let timer: ReturnType<typeof setInterval> | null = null;
      return {
        start: () => {
          if (timer) return;
          void bot.api.sendChatAction(channelUserId, 'typing');
          timer = setInterval(() => {
            void bot.api.sendChatAction(channelUserId, 'typing');
          }, TYPING_INTERVAL_MS);
        },
        stop: () => {
          if (timer) clearInterval(timer);
          timer = null;
        },
      };
    },
  };
}
