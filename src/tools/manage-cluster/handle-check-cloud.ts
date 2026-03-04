import { HetznerClient } from '../../services/hetzner.js';
import { getNextActionForPhase, readStateOrNull, updatePhase } from '../../state/manager.js';
import { ToolResponse } from '../../types/index.js';
import { getHetznerToken } from './helpers.js';

// ── Step 2: Check Cloud ─────────────────────────────────────────────────────

export async function handleCheckCloud(projectRoot: string): Promise<ToolResponse> {
  const state = readStateOrNull(projectRoot);
  if (!state) {
    return {
      phase: 'uninitialized',
      message: 'State not initialized. Call with action "initialize" first.',
      nextAction: 'initialize',
    };
  }

  const token = getHetznerToken();

  if (!token || token.trim() === '') {
    return {
      phase: state.phase,
      message:
        'Hetzner API token not found. The HETZNER_API_TOKEN environment variable must be set in the MCP server configuration.',
      nextAction: 'check_cloud',
      details: {
        tokenMissing: true,
        setupInstructions: {
          description:
            'Create a Hetzner API token and add it to your MCP server configuration as an environment variable.',
          steps: [
            '1. Go to https://console.hetzner.cloud/ and log in (or create an account).',
            '2. Select or create a project.',
            '3. Navigate to Security → API Tokens.',
            '4. Click "Generate API Token", give it a name (e.g. "pocket-cluster"), and select Read & Write permissions.',
            '5. Copy the generated token.',
            '6. Add it to your MCP server configuration:',
          ],
          configExamples: {
            'VS Code (settings.json or .vscode/mcp.json)': {
              servers: {
                'pocket-cluster': {
                  type: 'stdio',
                  command: 'node',
                  args: ['<path-to>/pocket-cluster/dist/index.js'],
                  env: {
                    HETZNER_API_TOKEN: '<your-token-here>',
                  },
                },
              },
            },
            'Claude Desktop (claude_desktop_config.json)': {
              mcpServers: {
                'pocket-cluster': {
                  command: 'node',
                  args: ['<path-to>/pocket-cluster/dist/index.js'],
                  env: {
                    HETZNER_API_TOKEN: '<your-token-here>',
                  },
                },
              },
            },
          },
          note: 'After updating the configuration, restart the MCP server / AI agent and try again.',
        },
      },
    };
  }

  try {
    const client = new HetznerClient(token);
    const locations = await client.fetchLocations();

    const updatedState = updatePhase(projectRoot, 'cloud_checked', {
      credentialsVerified: true,
      lastError: undefined,
    });
    const next = getNextActionForPhase(updatedState.phase);

    const locationSummary = locations
      .map((l) => `  - ${l.name}: ${l.city}, ${l.country} (${l.networkZone})`)
      .join('\n');

    return {
      phase: updatedState.phase,
      message: `Hetzner API connection verified. ${locations.length} locations available:\n\n${locationSummary}`,
      nextAction: next.nextAction,
      details: {
        credentialsVerified: true,
        locations: locations,
        serverPriceCategories: {
          'cost-optimised': 'CX/CAX lines — cheapest, shared vCPU',
          regular: 'CPX line — shared vCPU, higher clock (default)',
          dedicated: 'CCX line — dedicated vCPU, best performance',
        },
        instruction: next.description,
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    updatePhase(projectRoot, state.phase, { lastError: reason });
    return {
      phase: state.phase,
      message: `Hetzner API token is invalid or the API is unreachable: ${reason}`,
      nextAction: 'check_cloud',
      details: {
        tokenInvalid: true,
        error: reason,
        hint: 'Please verify the token has Read & Write permissions and is not expired.',
      },
    };
  }
}
