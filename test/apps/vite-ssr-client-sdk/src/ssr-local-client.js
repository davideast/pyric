// A server-rendered module that calls local-client-lib (#1143).
import { writeAndReadClient } from "local-client-lib";

export async function run(tag) {
  return { value: await writeAndReadClient(tag) };
}
