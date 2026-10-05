import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import esbuild from "esbuild";
import express from "express";
import { eq } from "drizzle-orm";
import { db, pool, workspaceConversationsTable, workspaceMessagesTable } from "@workspace/db";
import { apiErrorHandler } from "../src/middlewares/apiErrorHandler.ts";

if (process.env.NODE_ENV !== "test" || !process.env.DATABASE_URL) {
  throw new Error("Requires NODE_ENV=test and a development DATABASE_URL.");
}

const owner = `workspace-test-${randomUUID()}`;
let outputDir, server, baseUrl, conversationId;
// Only the auth/provider boundaries are simulated. The real route, schemas,
// ownership checks and PostgreSQL transaction are exercised below.
globalThis.__workspaceAiTest = { key: "fixture-key", baseUrl: "https://example.test", outcome: "success", calls: 0 };

async function request(method, route, body, actor = owner) {
  const response = await fetch(`${baseUrl}/api/workspace${route}`, {
    method,
    headers: { "x-test-actor": actor, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

before(async () => {
  outputDir = await mkdtemp(new URL("./.workspace-message-route-", import.meta.url).pathname);
  const outfile = path.join(outputDir, "workspace.mjs");
  await esbuild.build({
    entryPoints: [new URL("../src/routes/workspace.ts", import.meta.url).pathname],
    outfile, bundle: true, platform: "node", format: "esm", packages: "external",
    define: {
      "process.env.AI_INTEGRATIONS_OPENAI_API_KEY": "globalThis.__workspaceAiTest.key",
      "process.env.AI_INTEGRATIONS_OPENAI_BASE_URL": "globalThis.__workspaceAiTest.baseUrl",
    },
    plugins: [{
      name: "workspace-test-boundaries",
      setup(build) {
        build.onResolve({ filter: /^@clerk\/express$/ }, () => ({ path: "clerk", namespace: "fixture" }));
        build.onResolve({ filter: /^openai$/ }, () => ({ path: "openai", namespace: "fixture" }));
        build.onLoad({ filter: /^clerk$/, namespace: "fixture" }, () => ({
          contents: `export const getAuth = req => ({ userId: req.headers["x-test-actor"] === "anonymous" ? null : req.headers["x-test-actor"] });
            export const clerkClient = { users: { getUser: async () => ({ privateMetadata: {} }) } };`,
          loader: "js",
        }));
        build.onLoad({ filter: /^openai$/, namespace: "fixture" }, () => ({
          contents: `export default class OpenAI {
            constructor(options) {
              globalThis.__workspaceAiTest.options = options;
              this.chat = { completions: { create: async request => {
                const state = globalThis.__workspaceAiTest;
                state.calls++;
                state.request = request;
                if (state.outcome === "timeout") throw { name: "APIConnectionTimeoutError" };
                if (typeof state.outcome === "number") throw { status: state.outcome };
                return { choices: [{ message: { content: state.outcome === "empty" ? "" : "What kind of business are you opening?" } }] };
              } } };
            }
          }`, loader: "js",
        }));
      },
    }],
  });
  const { default: router } = await import(pathToFileURL(outfile).href);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { warn() {}, error() {}, info() {} }; next(); });
  app.use("/api", router);
  app.use(apiErrorHandler);
  server = await new Promise(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const created = await request("POST", "/conversations", { mode: "live" });
  assert.equal(created.status, 201);
  conversationId = created.body.id;
});

after(async () => {
  if (conversationId) {
    await db.delete(workspaceMessagesTable).where(eq(workspaceMessagesTable.conversationId, conversationId));
    await db.delete(workspaceConversationsTable).where(eq(workspaceConversationsTable.id, conversationId));
  }
  if (server) await new Promise(resolve => server.close(resolve));
  if (outputDir) await rm(outputDir, { recursive: true, force: true });
  delete globalThis.__workspaceAiTest;
  await pool.end();
});

test("typing payloads and access errors never reach AI", async () => {
  const route = `/conversations/${conversationId}/messages`;
  assert.equal((await request("POST", route, { content: "   " })).status, 400);
  assert.equal((await request("POST", route, { content: "Opening a shop" }, "anonymous")).status, 401);
  assert.equal((await request("POST", route, { content: "Opening a shop" }, "other-owner")).status, 404);
  assert.equal(globalThis.__workspaceAiTest.calls, 0);
});

test("missing AI configuration and provider failures are actionable and do not save partial messages", async () => {
  const state = globalThis.__workspaceAiTest;
  const route = `/conversations/${conversationId}/messages`;
  state.key = undefined;
  let result = await request("POST", route, { content: "What should I check for opening a food business?" });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, "AI_NOT_CONFIGURED");
  state.key = "fixture-key";
  for (const [outcome, status, code] of [
    [401, 503, "AI_ACCESS_REJECTED"],
    [429, 429, "AI_RATE_LIMITED"],
    ["timeout", 504, "AI_TIMEOUT"],
    [400, 502, "AI_REQUEST_REJECTED"],
    ["empty", 502, "AI_EMPTY_RESPONSE"],
  ]) {
    state.outcome = outcome;
    result = await request("POST", route, { content: "What should I check for opening a food business?" });
    assert.equal(result.status, status);
    assert.equal(result.body.code, code);
    assert.match(result.body.error, /not saved/);
    if (outcome === 429) assert.equal(result.headers.get("retry-after"), "30");
  }
  const history = await request("GET", route);
  assert.deepEqual(history.body, []);
});

test("successful AI question and static reply persist and survive a history reload", async () => {
  const state = globalThis.__workspaceAiTest;
  state.outcome = "success";
  const question = "What should I check for opening a food business?";
  const route = `/conversations/${conversationId}/messages`;
  const result = await request("POST", route, { content: `  ${question}  ` });
  assert.equal(result.status, 201);
  assert.match(result.body.message.content, /What kind of business/);
  assert.equal(state.options.timeout, 25_000);
  assert.equal(state.options.maxRetries, 0);
  assert.equal(state.request.model, "gpt-5.4-mini");
  assert.equal(state.request.max_completion_tokens, 8192);
  const history = await request("GET", route);
  assert.equal(history.body.length, 2);
  assert.equal(history.body[0].content, question);
  assert.equal(history.body[1].id, result.body.message.id);
});