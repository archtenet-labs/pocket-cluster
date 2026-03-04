import { basename } from 'node:path';
import { PocketClusterState, ServerPriceCategory } from '../../types/index.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

export function getHetznerToken(): string | undefined {
  return process.env['HETZNER_API_TOKEN'];
}

export function sanitizeStateForOutput(state: PocketClusterState): Record<string, unknown> {
  return {
    phase: state.phase,
    provider: state.provider,
    credentialsVerified: state.credentialsVerified,
    hasRequirements: Boolean(state.requirements),
    hasRecommendation: Boolean(state.recommendation),
    requirements: state.requirements,
    recommendation: state.recommendation,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

export function categoryLabel(cat: ServerPriceCategory): string {
  switch (cat) {
    case 'cost-optimised':
      return 'Cost-Optimised (CX/CAX)';
    case 'regular':
      return 'Regular (CPX)';
    case 'dedicated':
      return 'Dedicated (CCX)';
  }
}

/** Haversine distance in km between two lat/lng points */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Derive a short zone code from a Hetzner network_zone string.
 * Takes the part before the first dash and uppercases it.
 *   "eu-central"    → "EU"
 *   "us-west"       → "US"
 *   "ap-southeast"  → "AP"
 * Handles unknown future zones like "sa-east" → "SA" automatically.
 */
export function deriveZoneCode(networkZone: string): string {
  const dash = networkZone.indexOf('-');
  const prefix = dash > 0 ? networkZone.slice(0, dash) : networkZone;
  return prefix.toUpperCase();
}

/**
 * Derive a project name from the project root directory.
 */
export function getProjectName(projectRoot: string): string {
  return basename(projectRoot);
}

/**
 * Build a comprehensive provisioning plan from the current state.
 * Used to present a review summary to the user before provisioning.
 */
export function buildProvisioningPlan(state: PocketClusterState): Record<string, unknown> {
  const projectName = getProjectName(state.projectRoot);
  const serverName = `${projectName}-vm-1`;
  const req = state.requirements!;
  const rec = state.recommendation!;
  const ssh = state.sshKeys!;
  const net = state.networkConfig!;

  const allSshKeyIds = [...ssh.existingKeyIds, ...(ssh.generatedKeyHetznerIds ?? [])];

  const plan: Record<string, unknown> = {
    serverName,
    provisioningOrder: req.useExternalVolume
      ? ['1. Create external volume (XFS)', '2. Create server with volume attached']
      : ['1. Create server'],

    requirements: {
      estimatedDataGb: req.estimatedDataGb,
      expectedWorkload: req.expectedWorkload,
      location: req.location,
      priceCategory: categoryLabel(req.priceCategory),
      useExternalVolume: req.useExternalVolume,
    },

    server: {
      name: serverName,
      type: rec.serverType,
      description: rec.description,
      cpu: `${rec.cpu} vCPU (${rec.cpuType})`,
      memoryGb: rec.memoryGb,
      diskGb: rec.diskGb,
      location: rec.location,
      image: `docker-ce (ID: ${state.imageId ?? 40093247})`,
      monthlyPriceEur: rec.serverMonthlyPriceEur,
    },

    sshKeys: {
      totalCount: allSshKeyIds.length,
      keyIds: allSshKeyIds,
      ...(ssh.existingKeyIds.length > 0 ? { existingKeyIds: ssh.existingKeyIds } : {}),
      ...(ssh.generatedKeyHetznerIds?.length ? { generatedKeyIds: ssh.generatedKeyHetznerIds } : {}),
      ...(ssh.generatedPrivateKeyPath ? { privateKeyPath: ssh.generatedPrivateKeyPath } : {}),
    },

    networking: {
      ipv4: { enabled: true, monthlyPriceEur: rec.primaryIpMonthlyPriceEur },
      ipv6: { enabled: true, monthlyPriceEur: 0 },
      privateNetwork: net.usePrivateNetwork
        ? {
            networkId: net.existingNetworkId ?? net.createdNetworkId,
            ...(net.newNetworkName ? { name: net.newNetworkName } : {}),
            ...(net.newNetworkIpRange ? { ipRange: net.newNetworkIpRange } : {}),
            ...(net.newSubnetIpRange ? { subnetIpRange: net.newSubnetIpRange } : {}),
            isNew: net.createNewNetwork,
          }
        : null,
    },

    costBreakdown: {
      serverEur: rec.serverMonthlyPriceEur,
      ipv4Eur: rec.primaryIpMonthlyPriceEur,
      ...(rec.volumeMonthlyPriceEur > 0 ? { volumeEur: rec.volumeMonthlyPriceEur } : {}),
      totalMonthlyEur: rec.totalMonthlyPriceEur,
    },
  };

  if (req.useExternalVolume && rec.volumeGb > 0) {
    plan.volume = {
      name: `${serverName}-data`,
      sizeGb: rec.volumeGb,
      filesystem: 'xfs',
      monthlyPriceEur: rec.volumeMonthlyPriceEur,
      note: 'Volume will be created BEFORE the server and attached automatically.',
    };
  }

  return plan;
}
