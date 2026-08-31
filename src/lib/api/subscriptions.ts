/** Add or remove hub subscriptions via `/api/subscriptions`. */
export async function postSubscription(action: "add" | "remove", symbols: string[]): Promise<void> {
  const response = await fetch("/api/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, symbols }),
  });

  const data = (await response.json()) as { ok: boolean; error?: string };
  if (!response.ok || !data.ok) {
    throw new Error(data.error ?? "Échec de la souscription");
  }
}
