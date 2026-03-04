import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerManageClusterTool } from './manage-cluster/index.js';

export function registerTools(server: McpServer): void {
  registerManageClusterTool(server);
}
