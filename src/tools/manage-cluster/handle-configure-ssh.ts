import { HetznerClient } from '../../services/hetzner.js';
import {
  generateSshKeyPair,
  getRelativePrivateKeyPath,
  localKeyPairExists,
  readLocalPublicKey,
} from '../../services/ssh.js';
import { getNextActionForPhase, readStateOrNull, updatePhase } from '../../state/manager.js';
import { HetznerNetwork, HetznerSshKey, SshKeyConfig, ToolResponse } from '../../types/index.js';
import { getHetznerToken } from './helpers.js';

// ── Step 5: Configure SSH Keys ──────────────────────────────────────────────

export async function handleConfigureSsh(
  projectRoot: string,
  sshKeyIds?: number[],
  generateSshKey?: boolean,
): Promise<ToolResponse> {
  const state = readStateOrNull(projectRoot);
  if (!state || !state.recommendation) {
    return {
      phase: state?.phase ?? 'uninitialized',
      message: 'No approved recommendation. Complete previous steps first.',
      nextAction: state?.phase === 'requirements_set' ? 'approve_recommendation' : 'set_requirements',
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

  // Selections are required — available keys were already shown in approve_recommendation
  const selectedIds = sshKeyIds ?? [];
  const shouldGenerate = generateSshKey ?? false;

  if (selectedIds.length === 0 && !shouldGenerate) {
    return {
      phase: state.phase,
      message:
        'At least one SSH key is required. Provide sshKeyIds with existing key ID(s) and/or set generateSshKey to true.',
      nextAction: 'configure_ssh',
    };
  }

  // Validate selected IDs exist
  if (selectedIds.length > 0) {
    let existingKeys: HetznerSshKey[];
    try {
      existingKeys = await client.fetchSshKeys();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        phase: state.phase,
        message: `Failed to verify SSH keys: ${reason}`,
        nextAction: 'configure_ssh',
        details: { error: reason },
      };
    }

    const existingIds = new Set(existingKeys.map((k) => k.id));
    const invalidIds = selectedIds.filter((id) => !existingIds.has(id));
    if (invalidIds.length > 0) {
      return {
        phase: state.phase,
        message: `SSH key ID(s) not found in Hetzner: ${invalidIds.join(', ')}. Call configure_ssh without parameters to see available keys.`,
        nextAction: 'configure_ssh',
      };
    }
  }

  // Generate + upload a new key if requested
  const generatedKeyHetznerIds: number[] = [];
  let generatedKeyPath: string | undefined;
  let generatedKeyInfo: Record<string, unknown> | undefined;

  if (shouldGenerate) {
    try {
      let publicKeyOpenSsh: string;

      if (localKeyPairExists(projectRoot)) {
        // Reuse existing local key — just upload
        publicKeyOpenSsh = readLocalPublicKey(projectRoot)!;
        generatedKeyPath = getRelativePrivateKeyPath();
      } else {
        const keyPair = generateSshKeyPair(projectRoot, 'pocket-cluster');
        publicKeyOpenSsh = keyPair.publicKeyOpenSsh;
        generatedKeyPath = getRelativePrivateKeyPath();
      }

      // Upload to Hetzner
      const keyName = `pocket-cluster-${Date.now()}`;
      const uploaded = await client.uploadSshKey(keyName, publicKeyOpenSsh);
      generatedKeyHetznerIds.push(uploaded.id);

      generatedKeyInfo = {
        hetznerKeyId: uploaded.id,
        hetznerKeyName: uploaded.name,
        fingerprint: uploaded.fingerprint,
        privateKeyPath: generatedKeyPath,
        publicKeyUploaded: true,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        phase: state.phase,
        message: `Failed to generate/upload SSH key: ${reason}`,
        nextAction: 'configure_ssh',
        details: { error: reason },
      };
    }
  }

  // Save SSH config to state — also persist the docker-ce image ID
  const DOCKER_CE_IMAGE_ID = 40093247;

  const sshConfig: SshKeyConfig = {
    existingKeyIds: selectedIds,
    generatedPrivateKeyPath: generatedKeyPath,
    generatedKeyHetznerIds: generatedKeyHetznerIds.length > 0 ? generatedKeyHetznerIds : undefined,
  };

  const updatedState = updatePhase(projectRoot, 'ssh_configured', {
    sshKeys: sshConfig,
    imageId: DOCKER_CE_IMAGE_ID,
    lastError: undefined,
  });
  const next = getNextActionForPhase(updatedState.phase);

  const totalKeys = selectedIds.length + generatedKeyHetznerIds.length;
  const parts: string[] = [];
  if (selectedIds.length > 0) {
    parts.push(`${selectedIds.length} existing key(s)`);
  }
  if (generatedKeyHetznerIds.length > 0) {
    parts.push('1 newly generated key');
  }

  // Fetch available private networks for the next step guidance
  let availableNetworks: HetznerNetwork[] = [];

  let networkFetchError: string | undefined;
  try {
    availableNetworks = await client.fetchNetworks();
  } catch (error) {
    networkFetchError = error instanceof Error ? error.message : String(error);
  }

  const networkGuidanceLines = [
    '',
    'Next, configure networking for the VM.',
    '',
    'Public networking:',
    '  - IPv4 and IPv6 will always be attached to the server.',
    '',
    'Private networking (optional but recommended):',
    availableNetworks.length > 0
      ? `  The project has ${availableNetworks.length} existing private network(s):`
      : '  No existing private networks found in the Hetzner project.',
    ...availableNetworks.map(
      (n) =>
        `    - ID ${n.id}: "${n.name}" (${n.ipRange})${n.subnets.length > 0 ? ` — ${n.subnets.length} subnet(s): ${n.subnets.map((s) => `${s.ipRange} in ${s.networkZone}`).join(', ')}` : ''}`,
    ),
    '',
    'Help the user decide:',
    '1. If they have an existing network in the same network zone as their chosen location, they can reuse it.',
    '2. They can create a new private network (recommended for isolation).',
    '3. They can skip private networking if not needed.',
    '',
    'Once decided, call configure_network with:',
    '  - usePrivateNetwork: true/false',
    '  - existingNetworkId: ID of an existing network (if reusing)',
    '  - createNewNetwork: true to create a new one',
    '  - newNetworkName: name for the new network (if creating)',
    '  - newNetworkIpRange: IP range e.g. "10.0.0.0/16" (if creating)',
    '  - newSubnetIpRange: subnet range e.g. "10.0.1.0/24" (if creating)',
  ]
    .filter((line) => line !== undefined)
    .join('\n');

  const guidanceInstruction = [
    next.description,
    '',
    `SSH configuration complete: ${parts.join(' + ')} — ${totalKeys} key(s) total will be added to the server.`,
    generatedKeyPath
      ? `The private key is at ${generatedKeyPath} — the user can connect with: ssh -i ${generatedKeyPath} root@<server-ip>`
      : '',
    'All configured SSH keys will be injected into the server during provisioning.',
    '',
    `VM Image: The server will be provisioned with the "docker-ce" image (ID: ${DOCKER_CE_IMAGE_ID}) — Ubuntu with Docker CE pre-installed.`,
    networkGuidanceLines,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    phase: updatedState.phase,
    message: `SSH keys configured! ${parts.join(' and ')} will be added to the server. The VM will use the "docker-ce" image (Ubuntu + Docker CE pre-installed).`,
    nextAction: next.nextAction,
    details: {
      sshConfig,
      ...(generatedKeyInfo ? { generatedKey: generatedKeyInfo } : {}),
      image: {
        id: DOCKER_CE_IMAGE_ID,
        name: 'docker-ce',
        osFlavor: 'ubuntu',
        description: 'Ubuntu with Docker CE pre-installed',
      },
      network: {
        availableNetworks: availableNetworks.map((n) => ({
          id: n.id,
          name: n.name,
          ipRange: n.ipRange,
          subnets: n.subnets,
        })),
        ...(networkFetchError ? { fetchError: networkFetchError } : {}),
      },
      instruction: guidanceInstruction,
    },
  };
}
