import { OptionSearchButton } from "@/components/options/OptionSearchButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { SymbolInput } from "./SymbolInput";
import { TimeframeSelect } from "./TimeframeSelect";

export function ConfigPanel() {
  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle>Configuration</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <SymbolInput />
        <Separator />
        <OptionSearchButton />
        <Separator />
        <TimeframeSelect />
      </CardContent>
    </Card>
  );
}
