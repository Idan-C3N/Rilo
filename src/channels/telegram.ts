import { Bot } from 'grammy';
import type { ChannelAdapter, InboundMessage, TypingController } from './adapter.js';

export interface BotLike {
  on(event: 'message:text', cb: (ctx: any) => Promise<void> | void): void;
  catch?(handler: (err: unknown) => void): void;
  start(): void;
  stop(): Promise<void>;
  api: {
    sendMessage(chatId: string | number, text: string): Promise<unknown>;
    sendChatAction(chatId: string | number, action: string): Promise<unknown>;
  };
}

const ERROR_REPLY = '⚠️ Something went wrong handling that. Try again in a moment.';

export interface TelegramDeps {
  token: string;
  makeBot?: (token: string) => BotLike;
}

const TYPING_INTERVAL_MS = 4000;

export function createTelegramAdapter(
  deps: TelegramDeps,
): ChannelAdapter & { typingFor(channelUserId: string): TypingController } {
  const bot: BotLike = deps.makeBot ? deps.makeBot(deps.token) : (new Bot(deps.token) as unknown as BotLike);
  let handler: ((m: InboundMessage) => Promise<void>) | null = null;

  bot.on('message:text', async (ctx: any) => {
    if (!handler) return;
    const channelUserId = String(ctx.from.id);
    // A failure in the app handler (LLM error, tool crash, etc.) must NOT
    // propagate to grammy — an unhandled middleware error tears down the whole
    // polling loop. Contain it here: log, and let the user know.
    try {
      await handler({
        channel: 'telegram',
        channelUserId,
        text: ctx.message.text,
        name: ctx.from.first_name,
      });
    } catch (err) {
      console.error(`inbound handler failed for ${channelUserId}:`, err);
      try {
        await bot.api.sendMessage(channelUserId, ERROR_REPLY);
      } catch (sendErr) {
        console.error('failed to send error reply:', sendErr);
      }
    }
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
    send: async (channelUserId, text) => {
      await bot.api.sendMessage(channelUserId, text);
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
