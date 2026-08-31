import type { OptionChainResponseBody, OptionExpirationsResponseBody } from "@/domain/sse-events";
import type { OptionChainType } from "@/domain/types";

/** Fetch the available expiration dates for an underlying from `/api/options/contracts`. */
export async function fetchOptionExpirations(
  underlying: string,
): Promise<OptionExpirationsResponseBody> {
  const response = await fetch(
    `/api/options/contracts?underlying=${encodeURIComponent(underlying)}`,
  );
  const data = (await response.json()) as OptionExpirationsResponseBody & { error?: string };
  if (!response.ok) {
    throw new Error(data.error ?? `Échéances indisponibles pour ${underlying}`);
  }
  return data;
}

export interface OptionChainArgs {
  underlying: string;
  expiration: string;
  type?: OptionChainType;
  strikeGte?: number;
  strikeLte?: number;
  moneyness?: number;
}

/** Fetch the enriched option chain (greeks + IV) for an underlying + expiration. */
export async function fetchOptionChain(args: OptionChainArgs): Promise<OptionChainResponseBody> {
  const params = new URLSearchParams({
    underlying: args.underlying,
    expiration: args.expiration,
  });
  if (args.type && args.type !== "all") {
    params.set("type", args.type);
  }
  if (args.strikeGte != null) {
    params.set("strikeGte", String(args.strikeGte));
  }
  if (args.strikeLte != null) {
    params.set("strikeLte", String(args.strikeLte));
  }
  if (args.moneyness != null) {
    params.set("moneyness", String(args.moneyness));
  }

  const response = await fetch(`/api/options/contracts?${params.toString()}`);
  const data = (await response.json()) as OptionChainResponseBody & { error?: string };
  if (!response.ok) {
    throw new Error(data.error ?? "Chaîne d'options indisponible");
  }
  return data;
}
