#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase, openDatabase } from "./db.js";
import { listEvents } from "./events.js";
import { databasePath, taskmasterHome } from "./paths.js";

const seen = new Set<string>();

function printNewEvents(): void {
  const home = taskmasterHome();
  const projectId = process.env.TASKMASTER_PROJECT_ID?.trim();
  if (!projectId) {
    console.log("[taskmaster] waiting for project id");
    return;
  }
  const db = openDatabase(databasePath(home));
  try {
    const events = listEvents(db, { projectId, limit: 40 }).slice().reverse();
    for (const event of events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      console.log(`${event.createdAt} ${event.type} ${event.summary}`);
    }
  } finally {
    closeDatabase(db);
  }
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  console.log("[taskmaster] event log");
  printNewEvents();
  setInterval(printNewEvents, 1000);
}
