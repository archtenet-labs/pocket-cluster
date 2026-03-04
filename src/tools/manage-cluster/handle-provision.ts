import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HetznerClient } from '../../services/hetzner.js';
import { readStateOrNull, updatePhase } from '../../state/manager.js';
import { ToolResponse } from '../../types/index.js';
import { getHetznerToken, getProjectName } from './helpers.js';

const STATE_DIR_NAME = '.pocket-cluster';
const PROVISIONED_FILE_NAME = 'provisioned-resources.json';

// ── Step 7: Provision Infrastructure ────────────────────────────────────────

export async function handleProvision(projectRoot: string): Promise<ToolResponse> {
  const state = readStateOrNull(projectRoot);
  if (!state || !state.recommendation || !state.sshKeys || !state.networkConfig) {
    return {
      phase: state?.phase ?? 'uninitialized',
      message: 'Configuration incomplete. Complete all previous steps first.',
      nextAction: 'configure_network',
    };
  }

  if (state.phase !== 'network_configured') {
    return {
      phase: state.phase,
      message: `Cannot provision in phase "${state.phase}". Complete all configuration steps and ensure the phase is "network_configured".`,
      nextAction: state.phase === 'provisioned' ? 'done' : 'configure_network',
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
  const rec = state.recommendation;
  const ssh = state.sshKeys;
  const net = state.networkConfig;
  const projectName = getProjectName(projectRoot);
  const serverName = `${projectName}-vm-1`;

  // Collect all SSH key IDs
  const allSshKeyIds = [...ssh.existingKeyIds, ...(ssh.generatedKeyHetznerIds ?? [])];

  // Mark as provisioning
  updatePhase(projectRoot, 'provisioning', { serverName, lastError: undefined });

  // ── Step 1: Create volume if needed ─────────────────────────────────

  let volumeId: number | undefined;
  let volumeInfo: Record<string, unknown> | undefined;

  if (state.requirements?.useExternalVolume && rec.volumeGb > 0) {
    try {
      const volumeName = `${serverName}-data`;
      const volume = await client.createVolume({
        name: volumeName,
        size: rec.volumeGb,
        location: rec.location,
        format: 'xfs',
        automount: false,
        labels: {
          'managed-by': 'pocket-cluster',
          project: projectName,
        },
      });

      volumeId = volume.id;
      volumeInfo = {
        id: volume.id,
        name: volume.name,
        sizeGb: volume.size,
        format: volume.format,
        linuxDevice: volume.linuxDevice,
      };

      // Save volume info to state
      updatePhase(projectRoot, 'provisioning', {
        serverName,
        provisionedVolume: {
          id: volume.id,
          name: volume.name,
          sizeGb: volume.size,
          format: volume.format,
          linuxDevice: volume.linuxDevice,
        },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      updatePhase(projectRoot, 'network_configured', {
        lastError: `Volume creation failed: ${reason}`,
      });
      return {
        phase: 'network_configured',
        message: `Failed to create volume: ${reason}`,
        nextAction: 'provision',
        details: { error: reason },
      };
    }
  }

  // ── Step 2: Create server ───────────────────────────────────────────

  try {
    // Collect network IDs
    const networkIds: number[] = [];
    if (net.usePrivateNetwork) {
      if (net.existingNetworkId) networkIds.push(net.existingNetworkId);
      if (net.createdNetworkId) networkIds.push(net.createdNetworkId);
    }

    const server = await client.createServer({
      name: serverName,
      serverType: rec.serverType,
      image: state.imageId ?? 40093247,
      location: rec.location,
      sshKeys: allSshKeyIds,
      networks: networkIds.length > 0 ? networkIds : undefined,
      volumes: volumeId ? [volumeId] : undefined,
      automount: volumeId ? true : undefined,
      labels: {
        'managed-by': 'pocket-cluster',
        project: projectName,
      },
    });

    updatePhase(projectRoot, 'provisioned', {
      serverName,
      provisionedServer: {
        id: server.id,
        name: server.name,
        serverType: server.serverType,
        ipv4: server.ipv4,
        ipv6: server.ipv6,
      },
    });

    const connectCmd = ssh.generatedPrivateKeyPath
      ? `ssh -i ${ssh.generatedPrivateKeyPath} root@${server.ipv4}`
      : `ssh root@${server.ipv4}`;

    // ── Save provisioned resources to a separate JSON file ──────────
    const provisionedResources = {
      provisionedAt: new Date().toISOString(),
      server: {
        id: server.id,
        name: server.name,
        serverType: server.serverType,
        ipv4: server.ipv4,
        ipv6: server.ipv6,
        location: rec.location,
        image: `docker-ce (ID: ${state.imageId ?? 40093247})`,
        status: server.status,
      },
      volume: volumeInfo
        ? {
            id: volumeInfo.id,
            name: volumeInfo.name,
            sizeGb: volumeInfo.sizeGb,
            format: volumeInfo.format,
            linuxDevice: volumeInfo.linuxDevice,
          }
        : null,
      sshKeys: {
        keyIds: allSshKeyIds,
        existingKeyIds: ssh.existingKeyIds,
        generatedKeyIds: ssh.generatedKeyHetznerIds ?? [],
        privateKeyPath: ssh.generatedPrivateKeyPath ?? null,
      },
      networking: {
        ipv4: server.ipv4,
        ipv6: server.ipv6,
        privateNetwork: net.usePrivateNetwork
          ? {
              networkId: net.existingNetworkId ?? net.createdNetworkId ?? null,
              name: net.newNetworkName ?? null,
              ipRange: net.newNetworkIpRange ?? null,
            }
          : null,
      },
      cost: {
        serverMonthlyEur: rec.serverMonthlyPriceEur,
        ipv4MonthlyEur: rec.primaryIpMonthlyPriceEur,
        volumeMonthlyEur: rec.volumeMonthlyPriceEur,
        totalMonthlyEur: rec.totalMonthlyPriceEur,
      },
      connectCommand: connectCmd,
      dashboardUrl: 'https://console.hetzner.com/projects',
    };

    const resourcesFilePath = join(projectRoot, STATE_DIR_NAME, PROVISIONED_FILE_NAME);
    writeFileSync(resourcesFilePath, JSON.stringify(provisionedResources, null, 2), 'utf8');

    // Build success message
    const parts: string[] = [
      `Server "${server.name}" (${server.serverType}) created successfully!`,
      '',
      `  IPv4: ${server.ipv4}`,
      `  IPv6: ${server.ipv6}`,
      `  Location: ${rec.location}`,
      `  Image: docker-ce`,
    ];

    if (volumeInfo) {
      parts.push(`  Volume: ${volumeInfo.name} (${volumeInfo.sizeGb} GB, XFS) attached`);
      parts.push(`  Volume device: ${volumeInfo.linuxDevice}`);
    }

    parts.push('');
    parts.push(`Connect with: ${connectCmd}`);
    parts.push('');
    parts.push('Note: It typically takes 2–5 minutes for the server to fully boot and become reachable via SSH.');
    parts.push(`   Check server status navigating to the Hetzner dashboard: https://console.hetzner.com/projects`);

    return {
      phase: 'provisioned',
      message: parts.join('\n'),
      nextAction: 'done',
      details: {
        server: {
          id: server.id,
          name: server.name,
          serverType: server.serverType,
          ipv4: server.ipv4,
          ipv6: server.ipv6,
          location: rec.location,
          status: server.status,
        },
        volume: volumeInfo ?? null,
        sshKeyIds: allSshKeyIds,
        networks: networkIds,
        totalMonthlyPriceEur: rec.totalMonthlyPriceEur,
        connectCommand: connectCmd,
        dashboardUrl: 'https://console.hetzner.com/projects',
        provisionedResourcesFile: `${STATE_DIR_NAME}/${PROVISIONED_FILE_NAME}`,
        instruction: [
          'IMPORTANT: Tell the user that:',
          '',
          '1. It usually takes 2–5 minutes for the new server to fully initialize.',
          '   They should wait before trying to SSH into it.',
          `   They can check the server status and metrics in the Hetzner dashboard: https://console.hetzner.com/projects`,
          '',
          `2. All provisioned resource details have been saved to ${STATE_DIR_NAME}/${PROVISIONED_FILE_NAME}.`,
          '   This file is preserved even if the state is reset, so the user always has a record of what was created.',
          '',
          `3. ⚠ The ${STATE_DIR_NAME}/ directory is in .gitignore and will NOT be pushed to the repository.`,
          '   This is intentional — it may contain sensitive data (SSH private keys, API-derived IDs).',
          '   If the user wants to store provisioned resource details remotely (e.g. for team reference),',
          '   they should manually copy the relevant info to a location outside the config directory',
          '   and make sure no sensitive data (private keys, tokens) is included.',
        ].join('\n'),
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Roll back phase so user can retry
    updatePhase(projectRoot, 'network_configured', {
      lastError: `Server creation failed: ${reason}`,
      serverName,
    });
    return {
      phase: 'network_configured',
      message: `Failed to create server: ${reason}${volumeId ? ` (Note: volume ID ${volumeId} was already created and may need manual cleanup)` : ''}`,
      nextAction: 'provision',
      details: {
        error: reason,
        volumeCreated: volumeId ? { id: volumeId, ...volumeInfo } : null,
      },
    };
  }
}
