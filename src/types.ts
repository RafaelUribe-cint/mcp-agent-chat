export interface Session {
  name: string;
  registeredAt: number;
  lastSeen: number;
}

export interface Message {
  id: string;
  from: string;
  to: string;
  content: string;
  sentAt: number;
  replyTo?: string;
}
