import "server-only";

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { get, put } from "@vercel/blob";
import { getEnv } from "@/config/env";

/**
 * Agent working memory + [O5] decision log persistence.
 *
 * Local dev uses `${AGENT_LOG_DIR}/` on disk. Production on Vercel uses Vercel
 * Blob when `AGENT_STORAGE=blob` and `BLOB_READ_WRITE_TOKEN` is set — the
 * serverless filesystem is ephemeral and must not hold state.
 */

export const BLOB_AGENT_STATE_KEY = "agent/agent-state.json";
export const BLOB_DECISIONS_KEY = "agent/decisions.jsonl";

export type AgentStorageBackend = "filesystem" | "blob";

function filesystemStatePath(): string {
  return path.join(getEnv().AGENT_LOG_DIR, "agent-state.json");
}

function filesystemDecisionsPath(): string {
  return path.join(getEnv().AGENT_LOG_DIR, "decisions.jsonl");
}

/** Resolved once per process; reset via `__resetAgentPersistenceForTests`. */
let cachedBackend: AgentStorageBackend | null = null;

export function resolveAgentStorageBackend(): AgentStorageBackend {
  if (cachedBackend) {
    return cachedBackend;
  }
  const env = getEnv();
  if (env.AGENT_STORAGE === "blob" && env.BLOB_READ_WRITE_TOKEN) {
    cachedBackend = "blob";
    return cachedBackend;
  }
  if (env.AGENT_STORAGE === "blob" && !env.BLOB_READ_WRITE_TOKEN) {
    console.warn(
      "[agent-persistence] AGENT_STORAGE=blob but BLOB_READ_WRITE_TOKEN is missing — using filesystem",
    );
  }
  cachedBackend = "filesystem";
  return cachedBackend;
}

async function readBlobText(key: string): Promise<string | null> {
  const token = getEnv().BLOB_READ_WRITE_TOKEN;
  if (!token) {
    return null;
  }
  try {
    const result = await get(key, { access: "private", token, useCache: false });
    if (!result) {
      return null;
    }
    return await new Response(result.stream).text();
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      return null;
    }
    throw error;
  }
}

async function writeBlobText(key: string, contents: string): Promise<void> {
  const token = getEnv().BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new Error("BLOB_READ_WRITE_TOKEN is required for blob storage");
  }
  await put(key, contents, {
    access: "private",
    token,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: key.endsWith(".jsonl") ? "application/x-ndjson" : "application/json",
  });
}

/** Read agent-state.json contents, or null when missing. */
export async function readAgentStateText(): Promise<string | null> {
  if (resolveAgentStorageBackend() === "blob") {
    return readBlobText(BLOB_AGENT_STATE_KEY);
  }
  try {
    return await readFile(filesystemStatePath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** Overwrite agent-state.json. */
export async function writeAgentStateText(contents: string): Promise<void> {
  if (resolveAgentStorageBackend() === "blob") {
    await writeBlobText(BLOB_AGENT_STATE_KEY, contents);
    return;
  }
  const file = filesystemStatePath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, "utf8");
}

/** Read the full decisions.jsonl tail, or empty string when missing. */
export async function readDecisionsText(): Promise<string> {
  if (resolveAgentStorageBackend() === "blob") {
    return (await readBlobText(BLOB_DECISIONS_KEY)) ?? "";
  }
  try {
    return await readFile(filesystemDecisionsPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

/** Append one JSONL line to decisions.jsonl. */
export async function appendDecisionLine(line: string): Promise<void> {
  if (resolveAgentStorageBackend() === "blob") {
    const existing = await readDecisionsText();
    await writeBlobText(BLOB_DECISIONS_KEY, `${existing}${line}\n`);
    return;
  }
  const file = filesystemDecisionsPath();
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${line}\n`, "utf8");
}

/** Test hook. */
export function __resetAgentPersistenceForTests(): void {
  cachedBackend = null;
}
