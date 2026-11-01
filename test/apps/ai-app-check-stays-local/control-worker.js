// The egress control: fetches the URL the page sends and reports whether it failed.
self.onconnect = (event) => {
  const port = event.ports[0];
  port.onmessage = async (message) => {
    try {
      await fetch(message.data);
      port.postMessage("answered");
    } catch {
      port.postMessage("failed");
    }
  };
};
