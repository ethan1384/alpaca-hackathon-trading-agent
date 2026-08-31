#!/usr/bin/env node
// One-shot migration: upload local `.agent/` state to Vercel Blob before enabling
// the production cron. Requires BLOB_READ_WRITE_TOKEN (from Vercel → Storage → Blob).
//
//   BLOB_READ_WRITE_TOKEN=… node scripts/upload-agent-state.mjs
//   AGENT_LOG_DIR=.agent node scripts/upload-agent-state.mjs

import { readFile } from "node:fs/promises";
import path from "node:path";
import { put } from "@vercel/blob";

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const LOG_DIR = process.env.AGENT_LOG_DIR ?? ".agent";
const STATE_KEY = "agent/agent-state.json";
const DECISIONS_KEY = "agent/decisions.jsonl";

if (!TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN is required");
  process.exit(1);
}

const putOpts = {
  access: "private",
  token: TOKEN,
  addRandomSuffix: false,
  allowOverwrite: true,
};

async function uploadFile(localName, blobKey, contentType) {
  const file = path.join(LOG_DIR, localName);
  let contents;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log(`skip ${localName} (not found)`);
      return;
    }
    throw error;
  }
  await put(blobKey, contents, { ...putOpts, contentType });
  console.log(`uploaded ${file} → ${blobKey} (${contents.length} bytes)`);
}

await uploadFile("agent-state.json", STATE_KEY, "application/json");
await uploadFile("decisions.jsonl", DECISIONS_KEY, "application/x-ndjson");
console.log("done — set AGENT_STORAGE=blob on Vercel and redeploy");
