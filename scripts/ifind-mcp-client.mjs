import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}超时（${timeoutMs}ms）`)), timeoutMs); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function configuredConnection() {
  const apiKey = String(process.env.IFIND_API_KEY || "").trim();
  if (!apiKey) return null;
  const configured = String(process.env.IFIND_MCP_BASE_URL || "").trim();
  if (!configured) throw new Error("缺少 IFIND_MCP_BASE_URL；请显式配置 HTTPS endpoint，可信内网/VPN 的 HTTP endpoint 需同时设置 IFIND_MCP_ALLOW_INSECURE_HTTP=1");
  const url = new URL(configured);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("IFIND_MCP_BASE_URL 仅支持 HTTPS 或显式授权的 HTTP endpoint");
  if (url.username || url.password || [...url.searchParams.keys()].some(key => /(?:api.?key|token|secret|auth)/i.test(key))) {
    throw new Error("IFIND_MCP_BASE_URL 不得携带凭据；API key 通过 Authorization header 传输");
  }
  if (url.protocol === "http:" && process.env.IFIND_MCP_ALLOW_INSECURE_HTTP !== "1") {
    throw new Error("HTTP endpoint 仅限可信内网/VPN，并要求 IFIND_MCP_ALLOW_INSECURE_HTTP=1 显式授权");
  }
  const authorization = `Bearer ${apiKey}`;
  const authenticatedFetch = (input, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set("Authorization", authorization);
    return fetch(input, { ...init, headers });
  };
  return { url, authorization, authenticatedFetch };
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
  const connection = configuredConnection();
  if (!connection) throw new Error("缺少 IFIND_API_KEY");
  const client = new Client({ name: "macro-high-frequency-monitor", version: "2.0.1" }, { capabilities: {} });
  const transport = new SSEClientTransport(connection.url, {
    eventSourceInit: { fetch: connection.authenticatedFetch },
    requestInit: { headers: { Authorization: connection.authorization } },
  });
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
