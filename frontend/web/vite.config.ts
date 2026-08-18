import { fileURLToPath, URL } from "node:url"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// 后端 Python JSON API 默认运行在 127.0.0.1:8080，可用 VITE_API_TARGET 覆盖。
const API_TARGET = process.env.VITE_API_TARGET || "http://127.0.0.1:8080"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: true,
    allowedHosts: [
      "bitfun-platform.com",
      "version2.bitfun-platform.com",
      "version2app.bitfun-platform.com",
      "devkit.yorha2b.cc",
      "127.0.0.1",
      "localhost",
    ],
    proxy: {
      // 所有后端接口与产物（二维码 / HAP / 媒体）都走 /api 透传
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
      },
      "/static/hpack": {
        target: API_TARGET,
        changeOrigin: true,
      },
      "/hpack": {
        target: API_TARGET,
        changeOrigin: true,
      },
      "/install": {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
})
