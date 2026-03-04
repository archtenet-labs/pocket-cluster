import { HetznerClient } from '../../services/hetzner.js';
import { getNextActionForPhase, readStateOrNull, updatePhase } from '../../state/manager.js';
import { NetworkConfig, ToolResponse } from '../../types/index.js';
import { buildProvisioningPlan, getHetznerToken } from './helpers.js';

// ── Step 6: Configure Network ───────────────────────────────────────────────

export async function handleConfigureNetwork(
  projectRoot: string,
  params: {
    usePrivateNetwork?: boolean;
    existingNetworkId?: number;
    createNewNetwork?: boolean;
    newNetworkName?: string;
    newNetworkIpRange?: string;
    newSubnetIpRange?: string;
  },
): Promise<ToolResponse> {
  const state = readStateOrNull(projectRoot);
  if (!state || !state.recommendation || !state.sshKeys) {
    return {
      phase: state?.phase ?? 'uninitialized',
      message: 'SSH keys not configured yet. Complete previous steps first.',
      nextAction: state?.phase === 'recommendation_approved' ? 'configure_ssh' : 'configure_ssh',
    };
  }

  const token = getHetznerToken();
  if (!token) {
    return {
      phase: state.phase,
      message: 'HETZNER_API_TOKEN environment variable is missing.',
      nextAction: 'check_cloud',
    };
  }

  const client = new HetznerClient(token);
  const usePrivateNetwork = params.usePrivateNetwork ?? false;

  // ── No private network requested ──────────────────────────────────────

  if (!usePrivateNetwork) {
    const networkConfig: NetworkConfig = {
      usePrivateNetwork: false,
      createNewNetwork: false,
      attachIpv4: true,
      attachIpv6: true,
    };

    const updatedState = updatePhase(projectRoot, 'network_configured', {
      networkConfig,
      lastError: undefined,
    });
    const next = getNextActionForPhase(updatedState.phase);
    const provisioningPlan = buildProvisioningPlan(updatedState);

    return {
      phase: updatedState.phase,
      message:
        'Network configured: IPv4 and IPv6 will be attached. No private network selected. All configuration steps are complete — review the provisioning plan below.',
      nextAction: next.nextAction,
      details: {
        networkConfig,
        provisioningPlan,
        instruction: buildReviewInstruction(next.description),
      },
    };
  }

  // ── Use existing private network ──────────────────────────────────────

  if (params.existingNetworkId && !params.createNewNetwork) {
    // Validate the network exists
    try {
      const networks = await client.fetchNetworks();
      const network = networks.find((n) => n.id === params.existingNetworkId);

      if (!network) {
        const available = networks.map((n) => `  - ID ${n.id}: "${n.name}" (${n.ipRange})`).join('\n');
        return {
          phase: state.phase,
          message: `Network ID ${params.existingNetworkId} not found. Available networks:\n${available || '  (none)'}`,
          nextAction: 'configure_network',
          details: { availableNetworks: networks },
        };
      }

      // Check if the network has a subnet in the correct zone
      const location = state.requirements?.location;
      const locationHint = location
        ? ` Make sure it has a subnet in the network zone matching location "${location}".`
        : '';

      const networkConfig: NetworkConfig = {
        usePrivateNetwork: true,
        existingNetworkId: network.id,
        createNewNetwork: false,
        attachIpv4: true,
        attachIpv6: true,
      };

      const updatedState = updatePhase(projectRoot, 'network_configured', {
        networkConfig,
        lastError: undefined,
      });
      const next = getNextActionForPhase(updatedState.phase);
      const provisioningPlan = buildProvisioningPlan(updatedState);

      return {
        phase: updatedState.phase,
        message: `Network configured: IPv4 + IPv6 + private network "${network.name}" (${network.ipRange}) will be attached.${locationHint} All configuration steps are complete — review the provisioning plan below.`,
        nextAction: next.nextAction,
        details: {
          networkConfig,
          selectedNetwork: {
            id: network.id,
            name: network.name,
            ipRange: network.ipRange,
            subnets: network.subnets,
          },
          provisioningPlan,
          instruction: buildReviewInstruction(next.description),
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        phase: state.phase,
        message: `Failed to verify network: ${reason}`,
        nextAction: 'configure_network',
        details: { error: reason },
      };
    }
  }

  // ── Create a new private network ──────────────────────────────────────

  if (params.createNewNetwork) {
    const networkName = params.newNetworkName ?? `pocket-cluster-${Date.now()}`;
    const ipRange = params.newNetworkIpRange ?? '10.0.0.0/16';
    const subnetIpRange = params.newSubnetIpRange ?? '10.0.1.0/24';

    // Resolve the network zone from the recommendation's location
    let networkZone: string;
    try {
      const locations = await client.fetchLocations();
      const targetLocation = locations.find((l) => l.name === state.recommendation!.location);
      if (!targetLocation) {
        return {
          phase: state.phase,
          message: `Could not resolve network zone for location "${state.recommendation!.location}".`,
          nextAction: 'configure_network',
        };
      }
      networkZone = targetLocation.networkZone;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        phase: state.phase,
        message: `Failed to resolve network zone: ${reason}`,
        nextAction: 'configure_network',
        details: { error: reason },
      };
    }

    // Create the network
    try {
      const created = await client.createNetwork(networkName, ipRange, subnetIpRange, networkZone);

      const networkConfig: NetworkConfig = {
        usePrivateNetwork: true,
        createNewNetwork: true,
        newNetworkName: networkName,
        newNetworkIpRange: ipRange,
        newSubnetIpRange: subnetIpRange,
        newSubnetNetworkZone: networkZone,
        createdNetworkId: created.id,
        attachIpv4: true,
        attachIpv6: true,
      };

      const updatedState = updatePhase(projectRoot, 'network_configured', {
        networkConfig,
        lastError: undefined,
      });
      const next = getNextActionForPhase(updatedState.phase);
      const provisioningPlan = buildProvisioningPlan(updatedState);

      return {
        phase: updatedState.phase,
        message: `Network configured: IPv4 + IPv6 + new private network "${networkName}" (${ipRange}, subnet ${subnetIpRange} in ${networkZone}) created and will be attached. All configuration steps are complete — review the provisioning plan below.`,
        nextAction: next.nextAction,
        details: {
          networkConfig,
          createdNetwork: {
            id: created.id,
            name: created.name,
            ipRange: created.ipRange,
            subnets: created.subnets,
          },
          provisioningPlan,
          instruction: buildReviewInstruction(next.description),
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        phase: state.phase,
        message: `Failed to create private network: ${reason}`,
        nextAction: 'configure_network',
        details: { error: reason },
      };
    }
  }

  // ── Missing parameters ────────────────────────────────────────────────

  // User said usePrivateNetwork=true but didn't specify how
  let availableNetworks: { id: number; name: string; ipRange: string }[] = [];
  try {
    const networks = await client.fetchNetworks();
    availableNetworks = networks.map((n) => ({ id: n.id, name: n.name, ipRange: n.ipRange }));
  } catch {
    // Non-critical — continue with guidance
  }

  return {
    phase: state.phase,
    message:
      'Private networking is enabled but no network specified. Either provide existingNetworkId to use an existing network, or set createNewNetwork to true.',
    nextAction: 'configure_network',
    details: {
      availableNetworks,
      instruction: [
        "The user wants a private network but hasn't specified which one.",
        'Present the available networks above and ask:',
        '1. Do they want to use an existing network? If so, provide existingNetworkId.',
        '2. Do they want to create a new one? If so, set createNewNetwork: true.',
        '   Optionally provide: newNetworkName, newNetworkIpRange (default "10.0.0.0/16"), newSubnetIpRange (default "10.0.1.0/24").',
        '   The subnet network zone will be auto-detected from the server location.',
      ].join('\n'),
    },
  };
}

// ── Review Instruction Builder ──────────────────────────────────────────────

function buildReviewInstruction(baseDescription: string): string {
  return [
    baseDescription,
    '',
    '══════════════════════════════════════════════════════════',
    '  PROVISIONING PLAN REVIEW',
    '══════════════════════════════════════════════════════════',
    '',
    'Present the complete provisioning plan (in details.provisioningPlan) to the user',
    'in a clear, well-formatted summary. Include ALL sections:',
    '',
    '1. SERVER — name, type, CPU, RAM, disk, image, location',
    '2. SSH KEYS — how many, existing vs generated, private key path',
    '3. NETWORKING — IPv4, IPv6, private network details',
    '4. VOLUME — size, filesystem (XFS), if applicable',
    '5. COST BREAKDOWN — itemised monthly costs and total',
    '',
    'Then ask the user to review and choose:',
    '',
    '  ✅ APPROVE — Call manage_cluster with action "provision" to create all resources.',
    '     During provisioning: if an external volume is needed, it will be created FIRST',
    '     (formatted as XFS) and then attached to the server on creation.',
    '',
    '  🔧 ADJUST — The user can go back to any previous step to tweak settings:',
    '     • Server type / requirements → call "set_requirements" (then re-approve)',
    '     • SSH keys → call "configure_ssh"',
    '     • Network config → call "configure_network"',
    '',
    'Wait for the user\'s explicit approval before calling "provision".',
  ].join('\n');
}
