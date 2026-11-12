export interface User {
  id: string;
  username: string;
  display_name: string;
  is_admin: boolean;
  disabled: boolean;
  preferences: Record<string, unknown>;
  created_at: string;
  role?: "owner" | "admin" | "member";
}
export interface Session {
  access_token: string;
  refresh_token: string;
  user: User;
}
export interface Guild {
  id: string;
  name: string;
  owner_id: string;
}
export interface Channel {
  id: string;
  guild_id: string | null;
  name: string;
  kind: "text" | "voice" | "dm" | "group";
  last_seq: string;
  read_seq?: string;
  participants?: User[];
}
export interface Attachment {
  id: string;
  name: string;
  content_type: string;
  size: number;
}
export interface Message {
  id: string;
  channel_id: string;
  author: User;
  content: string;
  seq: string;
  event_seq: string;
  client_nonce: string;
  created_at: string;
  edited_at: string | null;
  deleted: boolean;
  reactions: { emoji: string; count: number; me: boolean }[];
  attachments: Attachment[];
}
export interface MessagePage {
  items: Message[];
  has_more: boolean;
  cursor: string;
}
export interface Friend {
  id: string;
  user: User;
  status: "pending" | "accepted";
  incoming: boolean;
}
export interface Instance {
  name: string;
  version: string;
  registration: string;
  max_upload_bytes: number;
  max_video_bitrate: number;
}
export interface MediaToken {
  token: string;
  url: string;
  room: string;
  max_video_bitrate: number;
}
export interface AuditEvent {
  id: string;
  action: string;
  actor_id?: string;
  target_id?: string;
  created_at: string;
  detail?: unknown;
}
export interface Items<T> {
  items: T[];
}
export interface Theme {
  mode: "dark" | "light";
  accent: string;
  font: "system" | "serif" | "mono";
  fontSize: number;
  compact: boolean;
  background: "plain" | "aurora";
}
export const defaultTheme: Theme = {
  mode: "dark",
  accent: "#9d8aff",
  font: "system",
  fontSize: 14,
  compact: false,
  background: "aurora",
};
