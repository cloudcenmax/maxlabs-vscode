import assert from "node:assert/strict";
import test from "node:test";
import { CloudWorkspace, skillCatalog, toolLabel } from "../dist/cloud.js";

const connections = [
  { id: "c1", name: "First service", enabled: true, tools: [{ name: "search", description: "Search things" }] },
  { id: "c2", name: "Disabled service", enabled: false, tools: [{ name: "hidden", description: "Not available" }] },
  { id: "c3", name: "Empty service", enabled: true, tools: [] },
];
const definitions = [
  { name: "mcp_c1_abcdef", description: "Connected tool from First service: search.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
];
const skills = [
  { id: "skill-1", slug: "review", name: "Code Review", description: "Review a change carefully.", enabled: true },
  { id: "skill-2", slug: "off", name: "Disabled Skill", description: "Hidden.", enabled: false },
];

function fakeClient(details = {}) {
  const calls = [];
  return {
    calls,
    async get(path) {
      calls.push({ method: "GET", path });
      if (path === "/connections") return { data: connections };
      if (path.startsWith("/tools?")) return { data: definitions };
      if (path === "/skills") return { data: skills };
      if (path.startsWith("/skills/")) return { data: details[decodeURIComponent(path.slice("/skills/".length))] };
      throw new Error(`unexpected path ${path}`);
    },
    async post(path, body, key) {
      calls.push({ method: "POST", path, body, key });
      return { data: { echo: body.arguments, ok: true } };
    },
  };
}

test("cloud workspace loads only enabled, approved connected tools", async () => {
  const client = fakeClient();
  const workspace = new CloudWorkspace(client);
  const tools = await workspace.loadTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].schema.name, "mcp_c1_abcdef");
  assert.deepEqual(tools[0].schema.parameters.required, ["query"]);
  assert.equal(tools[0].readOnly, false);
  const toolsCall = client.calls.find((call) => call.path.startsWith("/tools?"));
  assert.match(toolsCall.path, /connection_ids\[\]=c1/);
  assert.doesNotMatch(toolsCall.path, /c2|c3/);
});

test("connected tools execute through the account workspace with an idempotency key", async () => {
  const client = fakeClient();
  const workspace = new CloudWorkspace(client);
  const [tool] = await workspace.loadTools();
  const result = await tool.execute({ query: "hello" });
  assert.equal(result.isError, undefined);
  assert.match(result.text, /"echo"/);
  const post = client.calls.find((call) => call.method === "POST");
  assert.equal(post.path, "/tools/mcp_c1_abcdef");
  assert.deepEqual(post.body, { arguments: { query: "hello" }, connection_ids: ["c1"] });
  assert.match(post.key, /^[0-9a-f-]{36}$/);
});

test("cloud workspace loads enabled skills and exposes progressive disclosure", async () => {
  const client = fakeClient({
    "skill-1": { body: "Do a careful review.", files: [{ path: "references/checklist.md", bytes: 7, content: "checklist" }] },
  });
  const workspace = new CloudWorkspace(client);
  const loaded = await workspace.loadSkills();
  assert.deepEqual(loaded.map((skill) => skill.name), ["Code Review"]);
  const catalog = skillCatalog(loaded);
  assert.match(catalog, /Code Review/);
  assert.match(catalog, /call the skill tool/);

  const tool = workspace.createSkillTool(loaded);
  const loadedSkill = await tool.execute({ name: "review" });
  assert.match(loadedSkill.text, /Skill: Code Review/);
  assert.match(loadedSkill.text, /Do a careful review/);
  assert.match(loadedSkill.text, /references\/checklist\.md/);

  const file = await tool.execute({ name: "Code Review", file: "references/checklist.md" });
  assert.match(file.text, /checklist/);
  const unknown = await tool.execute({ name: "Missing" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /Code Review/);

  const detailReads = client.calls.filter((call) => call.path === "/skills/skill-1");
  assert.equal(detailReads.length, 1, "skill detail should be cached");
});

test("cloud tool labels hide internal MCP identifiers", () => {
  assert.equal(toolLabel("mcp_c1_abcdef"), "connected tool");
  assert.equal(toolLabel("skill"), "skill");
  assert.equal(toolLabel("bash"), "bash");
});

test("connected definitions cannot override local tools or the skill loader", async () => {
  const client = fakeClient();
  const get = client.get.bind(client);
  client.get = async (path) => path.startsWith("/tools?") ? { data: [{ name: "read" }, { name: "skill" }, ...definitions] } : get(path);
  const tools = await new CloudWorkspace(client).loadTools();
  assert.deepEqual(tools.map((tool) => tool.schema.name), ["mcp_c1_abcdef"]);
});
