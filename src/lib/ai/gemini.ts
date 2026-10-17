/**
 * Server-only Gemini client with API-key rotation and model fallback.
 *
 * Keys are read from GEMINI_API_KEYS (comma-separated), GEMINI_API_KEY_1..9
 * and GEMINI_API_KEY. Calls round-robin across keys; on 429/403/5xx the next
 * key is tried, then the next model. Never import this from client code.
 */

export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

export interface GeminiRequest {
  /** Plain prompt or explicit parts (e.g. text + inline image). */
  prompt?: string;
  parts?: GeminiPart[];
  system?: string;
  /** Request JSON output (responseMimeType=application/json). */
  json?: boolean;
  /** Optional JSON schema (OpenAPI subset) for structured output. */
  responseSchema?: unknown;
  /** Enable Google Search grounding (not combinable with json mode). */
  googleSearch?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  /** Override the model chain. */
  models?: string[];
  timeoutMs?: number;
  /** Overall budget across all key/model retries (default max(60 s, 2.5 × timeoutMs)). */
  budgetMs?: number;
  /** Gemini 3 thinking level (lower = faster). Omitted when unset. */
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
}

export interface GeminiResponse {
  text: string;
  model: string;
  /** Grounding sources when googleSearch was used. */
  sources: { title: string; uri: string }[];
}

const DEFAULT_MODELS = ["gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-2.5-flash"];

function loadKeys(): string[] {
  const keys: string[] = [];
  const push = (v?: string) => {
    for (const k of (v ?? "").split(",")) {
      const t = k.trim().replace(/^["']|["']$/g, "");
      if (t && !keys.includes(t)) keys.push(t);
    }
  };
  push(process.env.GEMINI_API_KEYS);
  for (let i = 1; i <= 9; i++) push(process.env[`GEMINI_API_KEY_${i}`]);
  push(process.env.GEMINI_API_KEY);
  return keys;
}

let cursor = 0;

export function geminiConfigured(): boolean {
  return loadKeys().length > 0;
}

export function geminiModels(): string[] {
  const preferred = process.env.GEMINI_MODEL;
  return Array.from(new Set([...(preferred ? [preferred] : []), ...DEFAULT_MODELS]));
}

export async function callGemini(req: GeminiRequest): Promise<GeminiResponse> {
  const keys = loadKeys();
  if (keys.length === 0) throw new Error("No Gemini API key configured");
  const models = req.models ?? geminiModels();
  const parts = req.parts ?? [{ text: req.prompt ?? "" }];

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: req.temperature ?? 0.4,
      maxOutputTokens: req.maxOutputTokens ?? 4096,
      ...(req.json ? { responseMimeType: "application/json" } : {}),
      ...(req.responseSchema ? { responseSchema: req.responseSchema } : {}),
      ...(req.thinkingLevel ? { thinkingConfig: { thinkingLevel: req.thinkingLevel } } : {}),
    },
  };
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
  if (req.googleSearch) body.tools = [{ google_search: {} }];

  let lastError: Error | null = null;
  const t0 = Date.now();
  const budget = req.budgetMs ?? Math.max(60000, (req.timeoutMs ?? 45000) * 2.5);
  outer: for (const model of models) {
    for (let attempt = 0; attempt < keys.length; attempt++) {
      if (Date.now() - t0 > budget) {
        lastError = new Error(`Gemini timeout: overall budget of ${Math.round(budget / 1000)} s exceeded`);
        break outer;
      }
      const key = keys[cursor++ % keys.length];
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": key },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(req.timeoutMs ?? 45000),
          }
        );
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          lastError = new Error(`Gemini HTTP ${res.status} on ${model}: ${errText.slice(0, 160)}`);
          // 404/400 = model or request problem: skip remaining keys for this model.
          if (res.status === 404 || res.status === 400) break;
          continue;
        }
        const data = (await res.json()) as {
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string; thought?: boolean }> };
            groundingMetadata?: { groundingChunks?: Array<{ web?: { title?: string; uri?: string } }> };
          }>;
        };
        const cand = data.candidates?.[0];
        const text = cand?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? "").join("") ?? "";
        const sources =
          cand?.groundingMetadata?.groundingChunks
            ?.map((c) => ({ title: c.web?.title ?? "", uri: c.web?.uri ?? "" }))
            .filter((s) => s.uri) ?? [];
        return { text, model, sources };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // a timed-out model is usually slow for every key — move on to the next model
        if (/timeout|abort/i.test(`${lastError.name} ${lastError.message}`)) {
          lastError = new Error(`Gemini timeout on ${model}`);
          break;
        }
      }
    }
  }
  throw lastError ?? new Error("All Gemini models failed");
}

/**
 * Best-effort repair of model JSON: trailing commas, and replies cut off by the
 * token limit (truncated at the last complete element, open brackets closed).
 */
export function repairJson(raw: string): string {
  let out = "";
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  let cut = -1; // length of `out` at the last complete element
  let cutStack: string[] = [];
  for (const ch of raw) {
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") {
      out = out.replace(/,\s*$/, ""); // trailing comma (outside strings only)
      stack.pop();
      out += ch;
      cut = out.length;
      cutStack = stack.slice();
      if (!stack.length) return out;
      continue;
    } else if (ch === "," && stack.length) {
      cut = out.length;
      cutStack = stack.slice();
    }
    out += ch;
  }
  if (!stack.length || cut < 0) return out;
  return out.slice(0, cut).replace(/,\s*$/, "") + cutStack.reverse().join("");
}

/** Parse JSON from a model reply, tolerating ```json fences, stray prose, trailing commas and truncation. */
export function parseJsonLoose<T = unknown>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(raw) as T;
  } catch {
    const start = raw.search(/[[{]/);
    if (start < 0) throw new Error("Model reply was not valid JSON");
    const body = raw.slice(start);
    try {
      const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
      if (end > 0) return JSON.parse(body.slice(0, end + 1)) as T;
    } catch {
      /* fall through to repair */
    }
    try {
      return JSON.parse(repairJson(body)) as T;
    } catch {
      throw new Error("Model reply was not valid JSON");
    }
  }
}

export async function callGeminiJson<T = unknown>(req: GeminiRequest): Promise<{ data: T; model: string }> {
  const r = await callGemini({ ...req, json: true });
  return { data: parseJsonLoose<T>(r.text), model: r.model };
}
