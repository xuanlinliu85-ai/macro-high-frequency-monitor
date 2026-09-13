import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CLIENT_RELATIVE_PATH = path.join("scripts", "ifind-mcp-client.mjs");

export async function connectLocalIfind(options = {}) {
  const localHome = String(process.env.IFIND_LOCAL_HOME || "").trim();
  if (!localHome) throw new Error("IFIND_PROVIDER=local 要求配置 IFIND_LOCAL_HOME");

  const clientPath = path.resolve(localHome, CLIENT_RELATIVE_PATH);
  await access(clientPath).catch(() => {
    throw new Error(`IFIND_LOCAL_HOME 中缺少 ${CLIENT_RELATIVE_PATH}`);
  });

  const localModule = await import(pathToFileURL(clientPath).href);
  if (typeof localModule.connectIfind !== "function") {
    throw new Error(`本地 iFinD 模块未导出 connectIfind(): ${CLIENT_RELATIVE_PATH}`);
  }

  const connection = await localModule.connectIfind(options);
  for (const method of ["listTools", "callTool", "close"]) {
    if (typeof connection?.[method] !== "function") throw new Error(`本地 iFinD connection 缺少 ${method}()`);
  }
  return connection;
}
