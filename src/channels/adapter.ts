export interface InboundMessage {
  channel: string;
  channelUserId: string;
  text: string;
  name?: string;
}

export interface TypingController {
  start(): void;
  stop(): void;
}

export interface ChannelAdapter {
  readonly channel: string;
  start(): void;
  stop(): Promise<void>;
  send(channelUserId: string, text: string): Promise<void>;
  onMessage(handler: (m: InboundMessage) => Promise<void>): void;
}
