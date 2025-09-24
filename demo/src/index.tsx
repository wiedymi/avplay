import { serve } from "bun";
import index from "./index.html";

const server = serve({
  routes: {
    // Serve decoder files from public directory
    "/decoder.js": {
      async GET() {
        return new Response(Bun.file("./public/decoder.js"), {
          headers: {
            "Content-Type": "application/javascript",
          },
        });
      },
    },
    "/decoder-worker.js": {
      async GET() {
        return new Response(Bun.file("./public/decoder-worker.js"), {
          headers: {
            "Content-Type": "application/javascript",
          },
        });
      },
    },

    // Serve index.html for all unmatched routes.
    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url}`);
