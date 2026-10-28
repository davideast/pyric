// `node server.mjs` writes and reads the default instance through the legacy
// databaseURL with firebase-admin, as a project created before about 2020
// configures its server.
import { initializeApp } from "firebase-admin/app";
import { getDatabase, getDatabaseWithUrl } from "firebase-admin/database";

const app = initializeApp({ projectId: "legacy-app", databaseURL: "https://legacy-app.firebaseio.com" });
const db = getDatabase(app);

await db.ref("open/server").set("from server");
console.log(`server read open/page: ${JSON.stringify((await db.ref("open/page").get()).val())}`);
const projectDefault = getDatabaseWithUrl("https://legacy-app-default-rtdb.firebaseio.com", app);
console.log(`server read open/server through the -default-rtdb URL: ${JSON.stringify((await projectDefault.ref("open/server").get()).val())}`);
process.exit(0);
