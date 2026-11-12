export interface User {
  id: string;
  username: string;
  display_name: string;
  is_admin: boolean;
  disabled: boolean;
  preferences: Record<string, unknown>;
  created_at: string;
  role?: "owner" | "admin" | "member";
  role_ids?: string[];
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
  effective_permissions: string;
  read_seq?: string;
  participants?: User[];
}
export interface GuildRole {
  id: string;
  guild_id: string;
  name: string;
  permissions: string;
}
export interface ChannelOverride {
  role_id: string | null;
  allow: string;
  deny: string;
}
export interface Attachment {
  id: string;
  name: string;
  content_type: string;
  size: number;
  media_status?: "queued" | "processing" | "ready" | "unsupported" | "failed";
}
export interface AttachmentMedia {
  status: NonNullable<Attachment["media_status"]>;
  metadata: null | {
    kind: "image" | "video" | "audio";
    width?: number;
    height?: number;
    duration_seconds?: number;
    has_audio: boolean;
    format: string;
  };
  derivatives: {
    kind: "thumbnail" | "faststart";
    content_type: string;
    size: number;
    width?: number;
    height?: number;
  }[];
  error_code: string | null;
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
  version: 2;
  mode: "dark" | "light";
  accent: string;
  baseColor: string | null;
  contrast: "normal" | "high";
  font: "system" | "serif" | "mono" | "arial" | "verdana" | "imported";
  fontAssetId: string | null;
  fontSize: number;
  compact: boolean;
  density: "comfortable" | "compact" | "spacious";
  background: "plain" | "aurora" | "image";
  wallpaperId: string | null;
  wallpaperOpacity: number;
  sidebarWidth: number;
  membersSide: "left" | "right";
}
export const defaultTheme: Theme = {
  version: 2,
  mode: "dark",
  accent: "#9d8aff",
  baseColor: null,
  contrast: "normal",
  font: "system",
  fontAssetId: null,
  fontSize: 14,
  compact: false,
  density: "comfortable",
  background: "aurora",
  wallpaperId: null,
  wallpaperOpacity: 12,
  sidebarWidth: 240,
  membersSide: "right",
};
