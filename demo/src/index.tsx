import { serve } from "bun";
import index from "./index.html";

const port = Number(process.env.PORT ?? 3000);

// Helper to add CORS headers to any response
const addCORSHeaders = (response: Response) => {
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  return response;
};

serve({
  port,

  // Main fetch handler that adds headers to ALL responses
  fetch(req) {
    const url = new URL(req.url);

    // Handle specific routes
    if (url.pathname === "/decoder.js") {
      return addCORSHeaders(
        new Response(Bun.file("./public/decoder.js"), {
          headers: {
            "Content-Type": "application/javascript",
          },
        })
      );
    }

    if (url.pathname === "/decoder-worker.js") {
      return addCORSHeaders(
        new Response(Bun.file("./public/decoder-worker.js"), {
          headers: {
            "Content-Type": "application/javascript",
          },
        })
      );
    }

    // Serve index.html for all other routes
    return addCORSHeaders(
      new Response(index.index.toString(), {
        headers: {
          "Content-Type": "text/html",
        },
      })
    );
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,
    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`🚀 Server running at http://localhost:${port}`);
