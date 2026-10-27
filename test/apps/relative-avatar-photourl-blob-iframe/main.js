import { initializeApp } from "firebase/app";
import { getAuth, signInWithPopup, GoogleAuthProvider } from "firebase/auth";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
});
const auth = getAuth(app);

function imageLoads(document, src) {
  return new Promise((resolve) => {
    const img = document.createElement("img");
    img.onload = () => resolve(img.naturalWidth > 0);
    img.onerror = () => resolve(false);
    img.src = src;
    document.body.appendChild(img);
  });
}

const iframeHtml = `<!doctype html>
<html>
<body>
  <script>
    window.addEventListener("message", (event) => {
      const reply = (result) => event.source.postMessage({ type: "avatar-result", ...result }, "*");
      try {
        new URL(event.data.photoURL);
      } catch (error) {
        reply({ loaded: false, error: String(error) });
        return;
      }
      const img = document.createElement("img");
      img.onload = () => reply({ loaded: img.naturalWidth > 0 });
      img.onerror = () => reply({ loaded: false, error: "image error" });
      img.src = event.data.photoURL;
      document.body.appendChild(img);
    });
  </script>
</body>
</html>`;

function imageLoadsInBlobIframe(src) {
  return new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.sandbox = "allow-scripts";
    window.addEventListener("message", function onMessage(event) {
      if (event.source !== iframe.contentWindow || event.data?.type !== "avatar-result") return;
      window.removeEventListener("message", onMessage);
      resolve({ loaded: event.data.loaded, error: event.data.error ?? null });
    });
    iframe.onload = () => iframe.contentWindow.postMessage({ photoURL: src }, "*");
    iframe.src = URL.createObjectURL(new Blob([iframeHtml], { type: "text/html" }));
    document.body.appendChild(iframe);
  });
}

window.signIn = async () => {
  const { user } = await signInWithPopup(auth, new GoogleAuthProvider());
  const { claims } = await user.getIdTokenResult();
  return {
    uid: user.uid,
    photoURL: user.photoURL,
    picture: claims.picture ?? null,
    topLoaded: await imageLoads(document, user.photoURL),
    iframe: await imageLoadsInBlobIframe(user.photoURL),
  };
};
