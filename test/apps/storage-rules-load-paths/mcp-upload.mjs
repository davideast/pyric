// Starts the installed `pyric mcp` from the project directory, as an editor
// does, and uploads one object as an unauthenticated caller. With no dev
// server running, `pyric mcp` hosts its own in-process sandbox. Logs one
// line: `<path> allowed` or `<path> denied: <summary>`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const path = process.argv[2] ?? "uploads/a.txt";
const cliDir = join(process.cwd(), "node_modules/@pyric/cli");
const { bin } = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(cliDir, bin.pyric), "mcp"],
  cwd: process.cwd(),
  env: process.env,
  stderr: "inherit",
});
const client = new Client({ name: "storage-rules-load-paths", version: "0" });
await client.connect(transport);

const anonymous = await client.callTool({ name: "auth", arguments: { method: "actAsAnonymous", args: {} } });
if (anonymous.isError) throw new Error(`actAsAnonymous failed: ${JSON.stringify(anonymous.content)}`);

const upload = await client.callTool({
  name: "storage",
  arguments: { method: "uploadBytes", args: { path, contentBase64: Buffer.from("x").toString("base64") } },
});
const text = upload.content?.[0]?.text ?? "";
const summary = text.startsWith("{") ? JSON.parse(text).summary : text;
console.log(upload.isError ? `${path} denied: ${summary}` : `${path} allowed`);
await client.close();
