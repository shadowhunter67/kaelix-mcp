import type { KaelixApiLike } from "./tools.js";
import { KaelixApiError } from "./client.js";

export interface Capabilities {
  localAi: boolean;
}

/**
 * Local-AI tools (kaelix_local_ai_*) call /api/local-ai/*, which only exists
 * on newer Kaelix Dashboard backends. Registering them unconditionally means
 * older backends return a confusing 404 for a tool the client otherwise
 * cannot know is unsupported. This probes once at startup (short timeout,
 * process-lifetime cache) and lets KAELIX_ENABLE_LOCAL_AI_TOOLS override the
 * probe outright ("on" always registers, "off" never does, "auto" probes).
 */
export async function detectCapabilities(
  client: KaelixApiLike,
  mode: "auto" | "on" | "off",
): Promise<Capabilities> {
  if (mode === "on") return { localAi: true };
  if (mode === "off") return { localAi: false };

  try {
    await client.request("/local-ai/status");
    return { localAi: true };
  } catch (error) {
    if (error instanceof KaelixApiError && error.kind === "not_found") {
      return { localAi: false };
    }
    // Network/timeout/backend errors are ambiguous (Ollama down vs. route
    // missing vs. dashboard unreachable) — fail safe by not registering
    // tools that would just fail anyway, rather than guessing.
    return { localAi: false };
  }
}
