import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const DEFAULT_BASE_URL = "http://219.141.246.230:5223/sse";

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}超时（${timeoutMs}ms）`)), timeoutMs); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function configuredUrl() {
  const apiKey = String(process.env.IFIND_API_KEY || "").trim();
  if (!apiKey) return null;
  const url = new URL(String(process.env.IFIND_MCP_BASE_URL || DEFAULT_BASE_URL));
  url.searchParams.set("api_key", apiKey);
  return url;
}

function contentText(result) {
  return (result?.content || []).filter(item => item?.type === "text").map(item => String(item.text || "")).join("\n").trim();
}

export function parseIfindResult(result) {
  if (result?.isError) throw new Error(contentText(result) || "iFinD MCP 返回错误");
  if (result?.structuredContent) return result.structuredContent;
  const text = contentText(result);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

export async function connectIfind({ timeoutMs = 15_000 } = {}) {
  const url = configuredUrl();
  if (!url) throw new Error("缺少 IFIND_API_KEY");
  const client = new Client({ name: "macro-high-frequency-monitor", version: "2.0.0" }, { capabilities: {} });
  const transport = new SSEClientTransport(url);
  await withTimeout(client.connect(transport), timeoutMs, "iFinD MCP 连接");
  return {
    async listTools() { return withTimeout(client.listTools(), timeoutMs, "iFinD 工具列表"); },
    async callTool(name, args) {
      const result = await withTimeout(client.callTool({ name, arguments: args }), timeoutMs, `iFinD ${name}`);
      return parseIfindResult(result);
    },
    async close() { await transport.close().catch(() => {}); },
  };
}
