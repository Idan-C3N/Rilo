export interface InboundMessage {
  channelUserId: string;
  text: string;
  name?: string;
}

export interface TypingController {
  start(): void;
  stop(): void;
}

export interface ChannelAdapter {
  start(): void;
  stop(): Promise<void>;
  send(channelUserId: string, text: string): Promise<void>;
  onMessage(handler: (m: InboundMessage) => Promise<void>): void;
}
