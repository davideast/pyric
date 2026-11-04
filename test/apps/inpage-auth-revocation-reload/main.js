// A page with two Firebase apps signed in to one account, standing in for two
// devices: the user changes their password on the phone, which signs the
// laptop out, as an account settings page promises ("signs you out of your
// other devices").
import { initializeApp } from "firebase/app";
import { createUserWithEmailAndPassword, getAuth, onAuthStateChanged, signInWithEmailAndPassword, updatePassword } from "firebase/auth";

const config = { apiKey: "demo", appId: "demo", projectId: "demo-revocation" };
const laptop = getAuth(initializeApp(config));
const phone = getAuth(initializeApp(config, "phone"));

/** The first auth state after the page loads: the restored session's uid, or null. */
function restoredUid(auth) {
  return new Promise((resolve) => {
    const stop = onAuthStateChanged(auth, (user) => {
      stop();
      resolve(user?.uid ?? null);
    });
  });
}

/** Force a token refresh, as an app does after it learns the account changed, and report the code and who is signed in after. */
async function forceRefresh(auth) {
  let code = null;
  try {
    await auth.currentUser.getIdToken(true);
  } catch (error) {
    code = error?.code ?? String(error);
  }
  return { code, currentUid: auth.currentUser?.uid ?? null };
}

window.devices = {
  async restored() {
    return { laptop: await restoredUid(laptop), phone: await restoredUid(phone) };
  },
  async signInBoth(email, password) {
    const { user } = await createUserWithEmailAndPassword(laptop, email, password);
    await signInWithEmailAndPassword(phone, email, password);
    return user.uid;
  },
  async changePasswordOnPhone(newPassword) {
    await updatePassword(phone.currentUser, newPassword);
  },
  refreshLaptop: () => forceRefresh(laptop),
  refreshPhone: () => forceRefresh(phone),
};
