import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Served under charliepolito.com/apex/. Makes asset URLs and
  // import.meta.env.BASE_URL resolve under /apex/.
  base: "/apex/",
  plugins: [react()],
  build: {
    // Emit into dist/apex so built paths mirror the /apex/ prefix; the
    // Worker's [assets] directory points at dist. See wrangler.toml.
    outDir: "dist/apex",
    emptyOutDir: true,
  },
  server: {
    // Dev only: proxy API calls to a locally running `wrangler dev` (:8787).
    proxy: {
      "/apex/api": "http://localhost:8787",
    },
  },
});
