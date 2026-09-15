import * as firestore from "firebase/firestore";
import * as database from "firebase/database";
import { db, rtdb } from "./data";

export const warningScenarios = {
  firestoreDenial: () =>
    firestore.setDoc(firestore.doc(db, "scenario-denials/budget"), {
      budget: -1,
    }),
  rtdbDenial: () =>
    database.set(database.ref(rtdb, "scenarioDenials/budget"), { budget: -1 }),
  async firestoreIndex() {
    const path = `scenarios/indexes/queries-${crypto.randomUUID()}`;
    await firestore.setDoc(firestore.doc(db, `${path}/one`), {
      author: "alice",
      budget: 5,
    });
    return firestore.getDocs(
      firestore.query(
        firestore.collection(db, path),
        firestore.where("author", "==", "alice"),
        firestore.orderBy("budget", "desc"),
      ),
    );
  },
  rtdbIndex: () =>
    database.get(
      database.query(
        database.ref(rtdb, `scenarios/index-${crypto.randomUUID()}`),
        database.orderByChild("budget"),
        database.equalTo(5),
      ),
    ),
};
export async function warningBurstPlan(_service: "firestore" | "rtdb") {
  return { count: 80, delay: 100 };
}
