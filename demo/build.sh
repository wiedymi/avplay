#!/bin/bash
set -e

echo "🔨 Building demo..."

# Clean dist directory
rm -rf dist
mkdir -p dist

# Build the HTML and assets with Bun
echo "📦 Building HTML and assets..."
bun build ./src/index.html --outdir ./dist

# Copy decoder files
echo "📋 Copying decoder files..."
# Copy all decoder and worker from ../avplay/decoder/dist/
if [ -d "../avplay/decoder/dist/" ]; then
  echo "  - Copying decoder and worker files from ../avplay/decoder/dist/"
  cp ../avplay/decoder/dist/decoder*.js ./dist/ 2>/dev/null || true
  cp ../avplay/decoder/dist/decoder*.wasm ./dist/ 2>/dev/null || true
  cp ../avplay/decoder/dist/*worker*.js ./dist/ 2>/dev/null || true
fi

echo "✅ Build complete! Files in ./dist/"
echo ""
echo "To start the server, run:"
echo "  bun run serve"
