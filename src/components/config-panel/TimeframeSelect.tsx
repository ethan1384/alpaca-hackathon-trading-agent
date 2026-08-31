"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TIMEFRAMES } from "@/config/constants";
import { useConfigStore } from "@/lib/stores/config-store";

export function TimeframeSelect() {
  const { timeframe, setTimeframe } = useConfigStore();

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Historical timeframe</p>
      <Select value={timeframe} onValueChange={(value) => setTimeframe(value as typeof timeframe)}>
        <SelectTrigger>
          <SelectValue placeholder="Select timeframe" />
        </SelectTrigger>
        <SelectContent>
          {TIMEFRAMES.map((item) => (
            <SelectItem key={item} value={item}>
              {item}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        Live stream always delivers 1Min bars. This selector affects REST backfill when the market
        is closed.
      </p>
    </div>
  );
}
