import { configureDiagnostics, diagnostic } from "./remote-diagnostics";
import { createGenerationHost } from "./generation-host";
import { createAiConnections } from "./generation-ai-connections";
import { compileFamilyApp } from "./app-compiler";
const connections = createAiConnections();
const host = createGenerationHost(async (spec) => connections.model(spec?.modelConfig), compileFamilyApp);
self.addEventListener("connect", ((event: MessageEvent) => {
  const port = event.ports[0];
  port.addEventListener("message", (event) => {
    if (Object.hasOwn(event.data ?? {}, "kinDiagnostics")) configureDiagnostics(event.data.kinDiagnostics);
    if (event.data?.kinControl === "attach-ai" && event.ports[0]) {
      diagnostic("ai-port-received");
      connections.attach(event.ports[0]);
      diagnostic("ai-port-attached");
    }
  });
  host.connect(port);
  port.start();
}) as EventListener);
