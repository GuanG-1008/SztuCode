import path from "node:path";
import { existsSync } from "node:fs";

export type CcswitchProvider = { id: string; name: string; base_url: string; model: string; api_key: string; has_api_key: boolean; is_current: boolean };

export async function listCcswitchProviders(): Promise<CcswitchProvider[]> {
  const configured = process.env.SZTU_CCSWITCH_DB;
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const databasePath = path.resolve(configured ? configured.replace(/^~(?=[/\\])/, home) : path.join(home, ".cc-switch", "cc-switch.db"));
  if (!existsSync(databasePath)) return [];
  try {
    const { DatabaseSync } = await import("node:sqlite"); const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const rows = database.prepare("SELECT id, name, app_type, settings_config, is_current FROM providers").all() as Array<Record<string, unknown>>;
      return rows.flatMap((row) => {
        if (!new Set(["claude", "claude-desktop"]).has(String(row.app_type ?? ""))) return [];
        let payload: { env?: Record<string, unknown> }; try { payload = JSON.parse(String(row.settings_config ?? "")) as typeof payload; } catch { return []; }
        const env = payload.env ?? {}; const base_url = String(env.ANTHROPIC_BASE_URL ?? "").trim(); const api_key = String(env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? "").trim(); const model = String(env.ANTHROPIC_MODEL ?? env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "").trim();
        if (!base_url || !api_key || !model) return [];
        return [{ id: String(row.id), name: String(row.name ?? row.id), base_url, model, api_key, has_api_key: true, is_current: Boolean(row.is_current) }];
      });
    } finally { database.close(); }
  } catch { return []; }
}
