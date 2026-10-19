// The browser half: the same SDK calls, which the plugin does swap.
import { initializeApp } from "firebase/app";
import { getDatabase, ref, get, set } from "firebase/database";
import { getFirestore, doc, getDoc, setDoc } from "firebase/firestore";
import { config } from "./config.js";

const app = initializeApp(config);

window.repro = {
  async writeAndRead(tag) {
    await set(ref(getDatabase(app), `ssr/${tag}`), { from: "browser" });
    await setDoc(doc(getFirestore(app), "ssr", tag), { from: "browser" });
    const rtdb = (await get(ref(getDatabase(app), `ssr/${tag}`))).val();
    const firestore = (await getDoc(doc(getFirestore(app), "ssr", tag))).data();
    return { rtdb, firestore };
  },
};
