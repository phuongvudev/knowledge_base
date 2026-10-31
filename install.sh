#!/bin/bash
# 1-Click Auto Setup for all AI Clients (Claude Desktop, Cursor, Antigravity, Windsurf)

cd "$(dirname "$0")"

echo "Building Knowledge Base..."
npm run build

echo ""
echo "Configuring AI Clients automatically..."
npm run setup
