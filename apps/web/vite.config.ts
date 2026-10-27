import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig, type Plugin } from "vite";

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET;

// Caddy sends the full CSP in production. In dev only framing is refused: a full CSP would block
// Vite's inline HMR preamble, and another port on the tailnet host is same-site, so it could frame
// the signed-in dashboard. The headers go on before Vite's own handlers, because `server.headers`
// skips the 304 that revalidates a cached index.html.
const refuseFraming: Plugin = {
  name: "swizzle-refuse-framing",
  configureServer(server) {
    server.middlewares.use((_request, response, next) => {
      response.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
      response.setHeader("X-Frame-Options", "DENY");
      next();
    });
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), refuseFraming],
  // Workspace imports resolve to source through the swizzle-source export condition, as they do
  // for TypeScript and dependency-cruiser, so the bundle loads the module the type check read.
  resolve: { conditions: ["swizzle-source", ...defaultClientConditions] },
  server: {
    // Loopback only. scripts/dev-stack.mts publishes this port on the same port of the tailnet
    // address with `tailscale serve`, which cannot share it with a 0.0.0.0 listener, and names the
    // tailnet host in WEB_ALLOWED_HOSTS because the forwarded requests keep that Host header.
    host: "127.0.0.1",
    allowedHosts: process.env.WEB_ALLOWED_HOSTS?.split(",") ?? [],
    // scripts/dev-stack.mts assigns WEB_PORT and prints the URL, so Vite takes that port or fails.
    // Without it, as in the e2e run, Vite takes the first free port from 5173 and prints that one.
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: process.env.WEB_PORT !== undefined,
    // scripts/dev-stack.mts and playwright.config.ts name the api the dev server proxies to.
    // Without one, as in `vite build`, there is nothing to proxy.
    proxy:
      apiProxyTarget === undefined
        ? {}
        : {
            "/api": {
              changeOrigin: true,
              rewrite: (path) => path.replace(/^\/api/u, ""),
              target: apiProxyTarget,
            },
          },
  },
});
