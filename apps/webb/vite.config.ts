import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const server = `http://localhost:${Number(process.env.SERVER_PORT ?? 8787)}`;

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    port: Number(process.env.WEBB_PORT ?? 5175),
    proxy: { "/trpc": { target: server, changeOrigin: true }, "/health": { target: server, changeOrigin: true } },
  },
  preview: {
    port: Number(process.env.WEBB_PORT ?? 5175),
    proxy: { "/trpc": { target: server, changeOrigin: true }, "/health": { target: server, changeOrigin: true } },
  },
});
