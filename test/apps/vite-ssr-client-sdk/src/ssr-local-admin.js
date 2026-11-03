// A server-rendered module that calls a package Vite externalizes, which
// imports firebase-admin itself.
import { readUser } from "local-admin-lib";

export async function run() {
  const user = await readUser("someone");
  return { uid: user.uid };
}
