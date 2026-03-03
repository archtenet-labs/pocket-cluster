import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerManageClusterTool } from './manage-cluster.js';

export function registerTools(server: McpServer): void {
  registerManageClusterTool(server);
}
