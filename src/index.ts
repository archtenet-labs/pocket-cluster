#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerTools } from './tools/index.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = resolve(currentDir, '../package.json');

type PackageMetadata = {
  name: string;
  version: string;
};

function loadPackageMetadata(filePath: string): PackageMetadata {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };

    if (typeof parsed.name !== 'string' || parsed.name.trim() === '') {
      throw new Error('Missing or invalid "name" field');
    }

    if (typeof parsed.version !== 'string' || parsed.version.trim() === '') {
      throw new Error('Missing or invalid "version" field');
    }

    return {
      name: parsed.name,
      version: parsed.version,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load package metadata from ${filePath}: ${reason}`, {
      cause: error,
    });
  }
}

const packageMetadata = loadPackageMetadata(packageJsonPath);

const server = new McpServer({
  name: packageMetadata.name,
  version: packageMetadata.version,
});

registerTools(server);

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('PocketCluster MCP server running on stdio');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
