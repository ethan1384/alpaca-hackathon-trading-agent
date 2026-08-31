import type { MarketHub } from "@/server/hub/market-hub";

declare global {
  // eslint-disable-next-line no-var
  var __marketHub: MarketHub | undefined;
}
