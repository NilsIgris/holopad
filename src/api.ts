// Appels vers la partie Rust (src-tauri/src/lib.rs).

import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { Settings } from "./lib/config";

export interface Status {
  has_data: boolean;
  unlocked: boolean;
  repo: string | null;
  pending_changes: number;
  generated_at: string | null;
  version: string;
}

export interface Doc {
  file: string;
  key: string;
  title: string;
  character: string;
  markdown: string;
  changed_at: string;
  status: "changed" | "new" | null;
  previous_markdown: string | null;
}

export interface SyncResult {
  downloaded: number;
  report: { changed: number; added: number; removed: number; rekeyed: boolean };
  generated_at: string;
}

export const api = {
  getSettings: () => invoke<unknown>("get_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  status: () => invoke<Status>("status"),
  unlock: (passphrase: string) => invoke<void>("unlock", { passphrase }),
  lock: () => invoke<void>("lock"),
  syncDocs: () => invoke<SyncResult>("sync_docs"),
  loadDocs: () => invoke<Doc[]>("load_docs"),
  markDocSeen: (file: string) => invoke<void>("mark_doc_seen", { file }),
};

export async function copyText(text: string): Promise<void> {
  try {
    await writeText(text);
  } catch {
    await navigator.clipboard.writeText(text);
  }
}
