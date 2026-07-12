export interface InboundMessage {
  channel: string;
  channelUserId: string;
  text: string;
  name?: string;
}

export interface SendOptions {
  /** Suppress the channel's URL preview (e.g. so a link isn't prefetched). */
  disableLinkPreview?: boolean;
}

export interface TypingController {
  start(): void;
  stop(): void;
}

export interface ChannelAdapter {
  readonly channel: string;
  start(): void;
  stop(): Promise<void>;
  send(channelUserId: string, text: string, opts?: SendOptions): Promise<void>;
  onMessage(handler: (m: InboundMessage) => Promise<void>): void;
}
