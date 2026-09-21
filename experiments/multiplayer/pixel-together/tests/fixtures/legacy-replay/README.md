# Legacy replay compatibility fixture

These nine source files preserve the earlier eight-case synthetic multiplayer harness. They were extracted from capture fa83f4b2-c445-4997-bbdc-9f66a0d05a6f. No captured results, logs, deployment settings, environment reports or original manifests are included. The test constructs a fresh synthetic manifest in a temporary directory and executes this old source through the public replay API. It therefore checks compatibility without private-bucket access.
