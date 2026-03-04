import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolResponse } from '../../types/index.js';
import { textContent, toPrettyJson } from '../utils.js';
import { handleApproveRecommendation } from './handle-approve-recommendation.js';
import { handleCheckCloud } from './handle-check-cloud.js';
import { handleConfigureNetwork } from './handle-configure-network.js';
import { handleConfigureSsh } from './handle-configure-ssh.js';
import { handleInitialize } from './handle-initialize.js';
import { handleProvision } from './handle-provision.js';
import { handleSetRequirements } from './handle-set-requirements.js';

// ── Tool Registration ───────────────────────────────────────────────────────

export function registerManageClusterTool(server: McpServer): void {
  server.registerTool(
    'manage_cluster',
    {
      description: [
        'Guided step-by-step MongoDB cluster provisioning wizard for Hetzner Cloud.',
        'Call this tool repeatedly with different actions to progress through the workflow:',
        '  1. "initialize" — Create or load state file, resume or start over.',
        '  2. "check_cloud" — Validate Hetzner API token and fetch available locations.',
        '  3. "set_requirements" — Provide DB requirements (data size, workload, location, price category) and get a server recommendation.',
        '  4. "approve_recommendation" — Approve the recommendation to proceed.',
        '  5. "configure_ssh" — List Hetzner SSH keys, select existing ones and/or generate a new key pair locally.',
        '  6. "configure_network" — Configure networking: always attaches IPv4 + IPv6, optionally create or attach a private network.',
        '     After network is configured, a full provisioning plan review is shown. The user can approve or go back to adjust.',
        '  7. "provision" — Create the infrastructure (volume if needed, then server). Requires user approval from step 6.',
        '',
        'Server price categories:',
        '  - "cost-optimised" — CX/CAX lines, cheapest shared vCPU',
        '  - "regular" (default) — CPX line, shared vCPU with higher clock',
        '  - "dedicated" — CCX line, dedicated vCPU',
        '',
        'Optional: useExternalVolume (default false) — store DB data on a separate Hetzner volume instead of local VM disk.',
        'Benefits: better reliability, easy resizing & migration. When enabled, VM disk size is ignored for matching (CPU+RAM only),',
        'volume is sized at 2× estimated data, and MongoDB logs stay on local VM disk to save costs.',
        '',
        'Each response includes the current phase, a message, and the next action to call.',
      ].join('\n'),
      inputSchema: {
        action: z.enum([
          'initialize',
          'check_cloud',
          'set_requirements',
          'approve_recommendation',
          'configure_ssh',
          'configure_network',
          'provision',
        ]),
        projectRoot: z.string().optional().describe('Path to the target project root directory. Defaults to cwd.'),
        continueExisting: z
          .boolean()
          .optional()
          .describe('For "initialize": true to continue from existing state, false to reset.'),
        estimatedDataGb: z
          .number()
          .optional()
          .describe('For "set_requirements": estimated data size in GB (default: 10).'),
        expectedWorkload: z
          .enum(['light', 'moderate', 'heavy'])
          .optional()
          .describe('For "set_requirements": expected workload intensity (default: "light").'),
        location: z
          .string()
          .optional()
          .describe('For "set_requirements": desired Hetzner location (e.g. "fsn1", "nbg1", "hel1").'),
        priceCategory: z
          .enum(['cost-optimised', 'regular', 'dedicated'])
          .optional()
          .describe('For "set_requirements": server price category (default: "regular").'),
        useExternalVolume: z
          .boolean()
          .optional()
          .describe(
            'For "set_requirements": store DB data on a separate Hetzner volume instead of local VM disk. Better reliability, easy resizing & migration. Default: false.',
          ),
        sshKeyIds: z
          .array(z.number())
          .optional()
          .describe('For "configure_ssh": array of existing Hetzner SSH key IDs to use for the server.'),
        generateSshKey: z
          .boolean()
          .optional()
          .describe(
            'For "configure_ssh": true to generate a new ed25519 key pair locally in .pocket-cluster/ssh/ and upload it to Hetzner. Default: false.',
          ),
        usePrivateNetwork: z
          .boolean()
          .optional()
          .describe('For "configure_network": whether to attach a private network to the VM. Default: false.'),
        existingNetworkId: z
          .number()
          .optional()
          .describe('For "configure_network": ID of an existing Hetzner private network to attach.'),
        createNewNetwork: z
          .boolean()
          .optional()
          .describe('For "configure_network": true to create a new private network. Default: false.'),
        newNetworkName: z
          .string()
          .optional()
          .describe('For "configure_network": name for the new private network (auto-generated if omitted).'),
        newNetworkIpRange: z
          .string()
          .optional()
          .describe(
            'For "configure_network": IP range for the new network, e.g. "10.0.0.0/16". Default: "10.0.0.0/16".',
          ),
        newSubnetIpRange: z
          .string()
          .optional()
          .describe('For "configure_network": subnet IP range, e.g. "10.0.1.0/24". Default: "10.0.1.0/24".'),
      },
    },
    async ({
      action,
      projectRoot,
      continueExisting,
      estimatedDataGb,
      expectedWorkload,
      location,
      priceCategory,
      useExternalVolume,
      sshKeyIds,
      generateSshKey,
      usePrivateNetwork,
      existingNetworkId,
      createNewNetwork,
      newNetworkName,
      newNetworkIpRange,
      newSubnetIpRange,
    }) => {
      const root = projectRoot ?? process.cwd();

      try {
        let response: ToolResponse;

        switch (action) {
          case 'initialize':
            response = handleInitialize(root, continueExisting);
            break;

          case 'check_cloud':
            response = await handleCheckCloud(root);
            break;

          case 'set_requirements':
            response = await handleSetRequirements(root, {
              estimatedDataGb,
              expectedWorkload,
              location,
              priceCategory,
              useExternalVolume: useExternalVolume ?? false,
            });
            break;

          case 'approve_recommendation':
            response = await handleApproveRecommendation(root);
            break;

          case 'configure_ssh':
            response = await handleConfigureSsh(root, sshKeyIds, generateSshKey);
            break;

          case 'configure_network':
            response = await handleConfigureNetwork(root, {
              usePrivateNetwork,
              existingNetworkId,
              createNewNetwork,
              newNetworkName,
              newNetworkIpRange,
              newSubnetIpRange,
            });
            break;

          case 'provision':
            response = await handleProvision(root);
            break;
        }

        return textContent(toPrettyJson(response));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return textContent(
          toPrettyJson({
            phase: 'unknown',
            message: `Unexpected error: ${reason}`,
            nextAction: action,
            details: { error: reason },
          }),
        );
      }
    },
  );
}
