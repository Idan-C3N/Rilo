export interface InboundMessage {
  channel: string;
  channelUserId: string;
  text: string;
  name?: string;
  /** Set when the inbound is a shared contact (channel-verified phone). */
  contact?: { phone: string };
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
  /** Build the channel's registration deep link for a code. */
  registrationLink(code: string): string;
  /** Prompt the user with the channel's share-phone affordance. */
  requestContact(channelUserId: string, text: string): Promise<void>;
}
