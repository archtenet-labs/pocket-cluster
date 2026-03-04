import { HetznerClient } from '../../services/hetzner.js';
import { localKeyPairExists } from '../../services/ssh.js';
import { getNextActionForPhase, readStateOrNull, updatePhase } from '../../state/manager.js';
import { ToolResponse } from '../../types/index.js';
import { categoryLabel, getHetznerToken } from './helpers.js';

// ── Step 4: Approve Recommendation ──────────────────────────────────────────

export async function handleApproveRecommendation(projectRoot: string): Promise<ToolResponse> {
  const state = readStateOrNull(projectRoot);
  if (!state || !state.recommendation) {
    return {
      phase: state?.phase ?? 'uninitialized',
      message: 'No recommendation to approve. Call with action "set_requirements" first.',
      nextAction: 'set_requirements',
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

  const updatedState = updatePhase(projectRoot, 'recommendation_approved', {
    lastError: undefined,
  });
  const next = getNextActionForPhase(updatedState.phase);

  const rec = state.recommendation;
  const costParts = [
    `server €${rec.serverMonthlyPriceEur.toFixed(2)}`,
    `IPv4 €${rec.primaryIpMonthlyPriceEur.toFixed(2)}`,
  ];
  if (rec.volumeMonthlyPriceEur > 0) {
    costParts.push(`${rec.volumeGb} GB volume €${rec.volumeMonthlyPriceEur.toFixed(2)}`);
  }

  // Fetch available SSH keys in advance so configure_ssh only needs one call
  let availableSshKeys: { id: number; name: string; fingerprint: string }[] = [];
  let sshFetchError: string | undefined;
  try {
    const client = new HetznerClient(token);
    const keys = await client.fetchSshKeys();
    availableSshKeys = keys.map((k) => ({ id: k.id, name: k.name, fingerprint: k.fingerprint }));
  } catch (error) {
    sshFetchError = error instanceof Error ? error.message : String(error);
  }

  const hasLocalKey = localKeyPairExists(projectRoot);

  const sshGuidanceLines = [
    'Present the SSH keys from the list above to the user and help them choose:',
    '',
    availableSshKeys.length > 0
      ? `1. The user has ${availableSshKeys.length} existing SSH key(s) in Hetzner (shown in ssh.availableKeys). They can pick one or more by ID.`
      : '1. No existing SSH keys found in the Hetzner project.',
    '2. Ask if they also want to generate a new ed25519 key pair locally.',
    '   - The key will be saved to .pocket-cluster/ssh/pocket_cluster_ed25519',
    '   - The public key will be automatically uploaded to Hetzner.',
    "   - Recommended if they don't have an SSH key or want a dedicated key for this cluster.",
    hasLocalKey ? '   ⚠ A local key already exists at .pocket-cluster/ssh/ — it will be reused (upload only).' : '',
    '3. Both options work together: the user can select existing keys AND generate a new one.',
    '4. At least one SSH key is required to proceed.',
    '',
    'Once the user decides, call configure_ssh with:',
    '  - sshKeyIds: array of selected existing key IDs (can be empty [])',
    '  - generateSshKey: true to generate + upload a new key, false otherwise',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    phase: updatedState.phase,
    message: `Recommendation approved! Server: ${rec.serverType} (${categoryLabel(rec.priceCategory)}) in ${rec.location}. Total cost: €${rec.totalMonthlyPriceEur.toFixed(2)}/mo (${costParts.join(' + ')}). Next step: configure SSH keys.`,
    nextAction: next.nextAction,
    details: {
      approved: true,
      recommendation: rec,
      requirements: state.requirements,
      ssh: {
        availableKeys: availableSshKeys,
        localKeyExists: hasLocalKey,
        ...(sshFetchError ? { fetchError: sshFetchError } : {}),
      },
      instruction: sshGuidanceLines,
    },
  };
}
