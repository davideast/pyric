// The canary page: the browser side of the planted requests. The harness's
// browser-plants script calls these with each planted URL and reads the
// outcome the page saw. `firebase-config.js` is the run's fake config, written
// by the harness: a `demo-` project and a fake API key.
import firebaseConfig from "./firebase-config.js";

const TIMEOUT_MS = 5_000;

function withTimeout(promise) {
  const limit = new Promise((resolve) => setTimeout(() => resolve("failed: timed out"), TIMEOUT_MS));
  return Promise.race([promise, limit]);
}

function fetchOutcome(url) {
  return withTimeout(fetch(url).then(
    async (response) => {
      await response.arrayBuffer();
      return "succeeded";
    },
    (error) => `failed: ${error.message}`,
  ));
}

function imageOutcome(url) {
  return withTimeout(new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve("succeeded");
    image.onerror = () => resolve("failed: image error");
    image.src = url;
  }));
}

function webSocketOutcome(url) {
  return withTimeout(new Promise((resolve) => {
    const socket = new WebSocket(url);
    socket.onopen = () => {
      socket.close();
      resolve("succeeded");
    };
    socket.onerror = () => resolve("failed: websocket error");
  }));
}

async function controllingWorker() {
  await navigator.serviceWorker.register("/canary-sw.js");
  await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
  await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
  return navigator.serviceWorker.controller;
}

async function serviceWorkerFetchOutcome(url) {
  const worker = await controllingWorker();
  return withTimeout(new Promise((resolve) => {
    const onMessage = (event) => {
      if (event.data.url !== url) return;
      navigator.serviceWorker.removeEventListener("message", onMessage);
      resolve(event.data.outcome);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    worker.postMessage({ url });
  }));
}

window.canary = { config: firebaseConfig, fetchOutcome, imageOutcome, webSocketOutcome, serviceWorkerFetchOutcome };
