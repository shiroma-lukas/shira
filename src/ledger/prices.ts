import type { Provider } from "../contracts/index.js";

/** Dollars per token. Cache prices default to the input price when the provider doesn't list them. */
export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Looks up a model's price; null when unknown, which the ledger records as unknown cost (FR-K1). */
export type PriceLookup = (provider: Provider, model: string) => Price | null;

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function costUsd(price: Price, t: TokenCounts): number {
  return (
    t.inputTokens * price.input +
    t.outputTokens * price.output +
    t.cacheReadTokens * (price.cacheRead ?? price.input) +
    t.cacheWriteTokens * (price.cacheWrite ?? price.input)
  );
}

/** The subset of OpenRouter's `GET /api/v1/models` response the price table reads. */
interface OpenRouterModels {
  data: { id: string; pricing?: Record<string, string | undefined> }[];
}

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

const perToken = (v: string | undefined) => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** Parses OpenRouter's model list into a price table keyed by model id. Models without a usable price are left out. */
export function parseOpenRouterPrices(body: OpenRouterModels): Map<string, Price> {
  const prices = new Map<string, Price>();
  for (const m of body.data) {
    const input = perToken(m.pricing?.prompt);
    const output = perToken(m.pricing?.completion);
    if (input === undefined || output === undefined) continue;
    const cacheRead = perToken(m.pricing?.input_cache_read);
    const cacheWrite = perToken(m.pricing?.input_cache_write);
    prices.set(m.id, {
      input,
      output,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    });
  }
  return prices;
}

/**
 * OpenRouter's public price list, fetched once and refreshed at most every `ttlMs`.
 * Prices on OpenRouter vary by upstream provider; the list gives the price OpenRouter
 * quotes for the model, so the ledger's figure is an estimate, not the invoice.
 */
export class OpenRouterPriceTable {
  private prices = new Map<string, Price>();
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly opts: {
      fetch?: typeof fetch;
      ttlMs?: number;
      url?: string;
      /** Told about failed background refreshes; the previous prices stay in use. */
      onError?: (err: Error) => void;
    } = {},
  ) {}

  private get stale(): boolean {
    return Date.now() - this.fetchedAt >= (this.opts.ttlMs ?? 60 * 60_000);
  }

  /** Refreshes the table if stale. A failed refresh keeps the previous prices and throws. */
  refresh(): Promise<void> {
    if (!this.stale) return Promise.resolve();
    this.inflight ??= (async () => {
      try {
        const res = await (this.opts.fetch ?? fetch)(this.opts.url ?? OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`OpenRouter models list: HTTP ${res.status}`);
        this.prices = parseOpenRouterPrices((await res.json()) as OpenRouterModels);
        this.fetchedAt = Date.now();
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** The model's price from the last fetch. A stale table is refreshed in the background for later lookups. */
  lookup(model: string): Price | null {
    if (this.stale) this.refresh().catch((err: Error) => this.opts.onError?.(err));
    // Claude Code accepts a `[1m]` suffix to mean a 1M context window; OpenRouter strips it.
    return this.prices.get(model.replace(/\[1m\]$/, "")) ?? null;
  }
}
