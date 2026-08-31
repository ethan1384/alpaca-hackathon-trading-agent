import { z } from "zod";

/**
 * The two decisions the LLM is allowed to make. Both are deliberately tiny — the
 * model approves or vetoes an already-chosen structure, it never picks strikes,
 * sizes, or exit levels.
 */

export const EntryDecisionSchema = z.object({
  /** true = let the mechanical entry through; false = skip today. */
  act: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(800),
  /** Named risks the model weighed — surfaced in the decision log. */
  concerns: z.array(z.string().max(240)).max(6).default([]),
});
export type EntryDecision = z.infer<typeof EntryDecisionSchema>;

export const ManageDecisionSchema = z.object({
  action: z.enum(["hold", "close"]),
  reason: z.string().min(1).max(800),
  urgency: z.enum(["low", "medium", "high"]).default("low"),
});
export type ManageDecision = z.infer<typeof ManageDecisionSchema>;
