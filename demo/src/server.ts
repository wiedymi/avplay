import { serve } from "bun";

const port = Number(process.env.PORT ?? 3000);

// CORS headers needed for SharedArrayBuffer
const CORS_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

serve({
  port,

  async fetch(req) {
    const url = new URL(req.url);
    let filePath = url.pathname;

    // Serve index.html for root path
    if (filePath === "/") {
      filePath = "/index.html";
    }

    // Construct the full file path
    const file = Bun.file(`./dist${filePath}`);

    // Check if file exists
    if (await file.exists()) {
      // Determine content type
      let contentType = "application/octet-stream";
      if (filePath.endsWith(".html")) contentType = "text/html";
      else if (filePath.endsWith(".js")) contentType = "application/javascript";
      else if (filePath.endsWith(".css")) contentType = "text/css";
      else if (filePath.endsWith(".json")) contentType = "application/json";
      else if (filePath.endsWith(".wasm")) contentType = "application/wasm";

      return new Response(file, {
        headers: {
          "Content-Type": contentType,
          ...CORS_HEADERS,
        },
      });
    }

    // 404 for missing files
    return new Response("Not Found", {
      status: 404,
      headers: CORS_HEADERS,
    });
  },
});

console.log(`🚀 Static server running at http://localhost:${port}`);
console.log(`📁 Serving files from ./dist`);
console.log(`🔒 CORS headers enabled for SharedArrayBuffer`);