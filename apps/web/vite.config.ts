import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig, type Plugin } from "vite";

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET;

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
  resolve: { conditions: ["swizzle-source", ...defaultClientConditions] },
  server: {
    host: "127.0.0.1",
    allowedHosts: process.env.WEB_ALLOWED_HOSTS?.split(",") ?? [],
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: process.env.WEB_PORT !== undefined,
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
