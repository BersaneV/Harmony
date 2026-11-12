import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "media", test: /node_modules\/livekit/ },
            {
              name: "markdown",
              test: /node_modules\/(react-markdown|remark|rehype|micromark|mdast|hast|unified)/,
            },
          ],
        },
      },
    },
  },
});
