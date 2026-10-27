import { createLocalLlmGateway, localLlmPolicy } from "@swizzle/runtime/local-llm-gateway";

const gateway = createLocalLlmGateway({
  policy: localLlmPolicy(process.env),
  controlToken: process.env.SWIZZLE_LOCAL_LLM_CONTROL_TOKEN ?? "",
});
// Each port is reachable only through its own Compose network.
gateway.inference.listen(8080, "local-llm-inference");
gateway.control.listen(8081, "local-llm-control");
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void gateway.close().then(() => process.exit(0));
  });
}
