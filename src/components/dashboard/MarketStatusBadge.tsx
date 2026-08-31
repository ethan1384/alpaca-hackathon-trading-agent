import { Badge } from "@/components/ui/badge";
import type { ClockResponseBody, HubConnectionState } from "@/domain/sse-events";

interface MarketStatusBadgeProps {
  clock?: ClockResponseBody;
  connectionState: HubConnectionState;
}

export function MarketStatusBadge({ clock, connectionState }: MarketStatusBadgeProps) {
  const marketVariant = clock?.isOpen ? "success" : "warning";
  const marketLabel = clock?.isOpen ? "Market open" : "Market closed";
  const paperLabel = clock?.paper ? "Paper" : "Live";
  const paperVariant = clock?.paper ? "secondary" : "danger";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={marketVariant}>{marketLabel}</Badge>
      <Badge variant={paperVariant}>{paperLabel}</Badge>
      {clock?.feed && <Badge variant="outline">Feed: {clock.feed}</Badge>}
      <Badge variant={connectionState === "connected" ? "success" : "outline"}>
        Stream: {connectionState}
      </Badge>
    </div>
  );
}
