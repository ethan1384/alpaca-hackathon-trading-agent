"use client";

import { AGENT_PIPELINE_STEPS, type AgentTone } from "@/lib/agent-phase";
import { cn } from "@/lib/utils";

/** Tailwind classes per tone — kept in one place so the hero dot, the pipeline
 * and the feed all agree on what "warn" looks like. */
export const TONE_CLASSES: Record<
  AgentTone,
  { dot: string; text: string; soft: string; border: string }
> = {
  idle: {
    dot: "bg-slate-400",
    text: "text-slate-500 dark:text-slate-400",
    soft: "bg-slate-400/10",
    border: "border-slate-400/40",
  },
  wait: {
    dot: "bg-sky-400",
    text: "text-sky-600 dark:text-sky-400",
    soft: "bg-sky-400/10",
    border: "border-sky-400/40",
  },
  active: {
    dot: "bg-violet-500",
    text: "text-violet-600 dark:text-violet-400",
    soft: "bg-violet-500/10",
    border: "border-violet-500/40",
  },
  ok: {
    dot: "bg-emerald-500",
    text: "text-emerald-600 dark:text-emerald-400",
    soft: "bg-emerald-500/10",
    border: "border-emerald-500/40",
  },
  warn: {
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
    soft: "bg-amber-500/10",
    border: "border-amber-500/40",
  },
  danger: {
    dot: "bg-red-500",
    text: "text-red-600 dark:text-red-400",
    soft: "bg-red-500/10",
    border: "border-red-500/40",
  },
};

interface AgentPipelineProps {
  /** Index into `AGENT_PIPELINE_STEPS` the agent is currently sitting on. */
  step: number;
  tone: AgentTone;
  /** Animate the active step — false when the agent is parked (disabled, standby). */
  live: boolean;
}

/**
 * The cycle rendered as a pipeline: market data → trigger → mechanical setup →
 * LLM → guardrails/order. Steps before the active one read as "done", the
 * active one pulses, the rest stay dim. This mirrors `runAgentCycle()`, so what
 * lights up is the branch the code is actually in.
 */
export function AgentPipeline({ step, tone, live }: AgentPipelineProps) {
  const palette = TONE_CLASSES[tone];

  return (
    <ol className="flex flex-col gap-2 sm:flex-row sm:items-stretch sm:gap-0">
      {AGENT_PIPELINE_STEPS.map((pipelineStep, index) => {
        const done = index < step;
        const active = index === step;

        return (
          <li key={pipelineStep.id} className="flex flex-1 items-center gap-2">
            <div
              className={cn(
                "flex-1 rounded-md border px-3 py-2 transition-colors",
                active
                  ? cn(palette.border, palette.soft)
                  : done
                    ? "border-input bg-muted/40"
                    : "border-dashed border-input",
              )}
            >
              <div className="flex items-center gap-2">
                <span className="relative flex h-2 w-2 shrink-0">
                  {active && live ? (
                    <span
                      className={cn(
                        "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
                        palette.dot,
                      )}
                    />
                  ) : null}
                  <span
                    className={cn(
                      "relative inline-flex h-2 w-2 rounded-full",
                      active
                        ? palette.dot
                        : done
                          ? "bg-muted-foreground/60"
                          : "bg-muted-foreground/25",
                    )}
                  />
                </span>
                <span
                  className={cn(
                    "text-xs font-semibold uppercase tracking-wide",
                    active ? palette.text : done ? "text-foreground/70" : "text-muted-foreground",
                  )}
                >
                  {pipelineStep.label}
                </span>
              </div>
              <p className="mt-1 text-[11px] leading-tight text-muted-foreground">
                {pipelineStep.hint}
              </p>
            </div>
            {index < AGENT_PIPELINE_STEPS.length - 1 ? (
              <span className="hidden h-px w-3 shrink-0 bg-border sm:block" aria-hidden />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
