import type { FitCheck } from "./fit";

export type Visibility = "private" | "link" | "public";
export type Status = "draft" | "sent" | "won" | "lost" | "archived";

export const VISIBILITIES: Visibility[] = ["private", "link", "public"];
export const STATUSES: Status[] = ["draft", "sent", "won", "lost", "archived"];

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  private: "Team only",
  link: "Client link + password",
  public: "Public link",
};

export interface Proposal {
  id: string;
  slug: string;
  title: string;
  client: string | null;
  description: string | null;
  tags: string[];
  status: Status;
  visibility: Visibility;
  /** Internal tracking key only. Clients use /prezlab/<link_name>. */
  share_token: string;
  link_name: string | null;
  sealed_password: string | null;
  password_version: number;
  created_by_email: string | null;
  created_by_name: string | null;
  uploaded_by_email: string | null;
  uploaded_by_name: string | null;
  uploaded_at: string | null;
  taken_down_at: string | null;
  taken_down_by_email: string | null;
  taken_down_by_name: string | null;
  takedown_reason: string | null;
  takedown_link_name: string | null;
  /** Screen check of the current files (migration 0006). See lib/fit.ts. */
  fit_check: FitCheck | null;
  fit_checked_at: string | null;
  storage_prefix: string;
  entry_file: string;
  content_hash: string | null;
  file_count: number;
  source_path: string | null;
  proposal_date: string | null;
  created_at: string;
  updated_at: string;
  imported_at: string | null;
}

export interface ViewCount {
  proposal_id: string;
  views: number;
  unique_visitors: number;
  last_viewed_at: string | null;
}

export interface ProposalStats {
  views: number;
  unique_visitors: number;
  clicks: number;
  avg_seconds: number | null;
  avg_scroll_depth: number | null;
  last_viewed_at: string | null;
}

export type EventType = "view" | "click" | "scroll" | "heartbeat" | "leave";
export const EVENT_TYPES: EventType[] = ["view", "click", "scroll", "heartbeat", "leave"];

export interface ProposalEvent {
  id: number;
  proposal_id: string;
  session_id: string;
  visitor_id: string;
  type: EventType;
  is_internal: boolean;
  data: Record<string, unknown>;
  page_path: string | null;
  referrer: string | null;
  user_agent: string | null;
  country: string | null;
  created_at: string;
}

export type ActivityAction =
  | "uploaded"
  | "replaced_files"
  | "updated_details"
  | "changed_access"
  | "changed_link"
  | "changed_password"
  | "deleted"
  | "taken_down";

export interface ProposalActivity {
  id: number;
  proposal_id: string | null;
  proposal_title: string;
  actor_email: string | null;
  actor_name: string | null;
  action: ActivityAction;
  details: Record<string, unknown>;
  created_at: string;
}
