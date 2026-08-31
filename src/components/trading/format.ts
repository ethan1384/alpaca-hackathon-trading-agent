const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const pct = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 2,
});

export function fmtUsd(value: number | undefined): string {
  return value === undefined ? "—" : usd.format(value);
}

/** `value` is a fraction (0.0123 -> "1.23%"). */
export function fmtPct(value: number | undefined): string {
  return value === undefined ? "—" : pct.format(value);
}

export function fmtNum(value: number | undefined, digits = 2): string {
  return value === undefined
    ? "—"
    : value.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function plTone(value: number | undefined): "success" | "danger" | "secondary" {
  if (value === undefined || value === 0) return "secondary";
  return value > 0 ? "success" : "danger";
}
