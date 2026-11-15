import { deleteApp, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const email = process.argv[2] ?? "verified@example.com";
const password = process.argv[3] ?? "password123";

const app = initializeApp({ projectId: "demo-app" });
const created = await getAuth(app).createUser({
  email,
  password,
  emailVerified: true,
});
console.log(`seeded ${JSON.stringify({ uid: created.uid, email: created.email, emailVerified: created.emailVerified })}`);
await deleteApp(app);
process.exit(0);
