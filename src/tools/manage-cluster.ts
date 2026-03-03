import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { computeMinSpecs } from '../config/resource-requirements.js';
import { HetznerClient } from '../services/hetzner.js';
import {
  createFreshState,
  getNextActionForPhase,
  readStateOrNull,
  resetState,
  stateFileExists,
  updatePhase,
} from '../state/manager.js';
import {
  AlternativeGroup,
  ClusterRequirements,
  HetznerDatacenter,
  HetznerLocation,
  HetznerPrimaryIpPrice,
  HetznerServerType,
  HetznerVolumePricing,
  PRICE_CATEGORY_ORDER,
  PocketClusterState,
  ServerPriceCategory,
  ServerRecommendation,
  ToolResponse,
} from '../types/index.js';
import { textContent, toPrettyJson } from './utils.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function getHetznerToken(): string | undefined {
  return process.env['HETZNER_API_TOKEN'];
}

function sanitizeStateForOutput(state: PocketClusterState): Record<string, unknown> {
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

function categoryLabel(cat: ServerPriceCategory): string {
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
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
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
function deriveZoneCode(networkZone: string): string {
  const dash = networkZone.indexOf('-');
  const prefix = dash > 0 ? networkZone.slice(0, dash) : networkZone;
  return prefix.toUpperCase();
}

// ── Step 1: Initialize ──────────────────────────────────────────────────────

function handleInitialize(projectRoot: string, continueExisting?: boolean): ToolResponse {
  const exists = stateFileExists(projectRoot);

  if (!exists) {
    const state = createFreshState(projectRoot);
    const next = getNextActionForPhase(state.phase);
    return {
      phase: state.phase,
      message:
        'PocketCluster state initialized. Created state file at ./.pocket-cluster/state.json and added .pocket-cluster/ to .gitignore.',
      nextAction: next.nextAction,
      details: {
        stateCreated: true,
        instruction: next.description,
      },
    };
  }

  if (continueExisting === undefined) {
    const state = readStateOrNull(projectRoot)!;
    const next = getNextActionForPhase(state.phase);
    return {
      phase: state.phase,
      message: `Existing PocketCluster state found at phase "${state.phase}". Would you like to continue from where you left off or start over? Call this tool again with continueExisting set to true or false.`,
      nextAction: 'initialize',
      details: {
        existingState: true,
        currentPhase: state.phase,
        provider: state.provider,
        credentialsVerified: state.credentialsVerified,
        hasRequirements: Boolean(state.requirements),
        hasRecommendation: Boolean(state.recommendation),
        continueInstruction: next.description,
      },
    };
  }

  if (continueExisting) {
    const state = readStateOrNull(projectRoot)!;
    const next = getNextActionForPhase(state.phase);
    return {
      phase: state.phase,
      message: `Continuing from phase "${state.phase}".`,
      nextAction: next.nextAction,
      details: {
        instruction: next.description,
        currentState: sanitizeStateForOutput(state),
      },
    };
  }

  const state = resetState(projectRoot);
  const next = getNextActionForPhase(state.phase);
  return {
    phase: state.phase,
    message: 'State has been reset. Starting fresh.',
    nextAction: next.nextAction,
    details: {
      stateReset: true,
      instruction: next.description,
    },
  };
}

// ── Step 2: Check Cloud ─────────────────────────────────────────────────────

async function handleCheckCloud(projectRoot: string): Promise<ToolResponse> {
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

// ── Step 3: Set Requirements ────────────────────────────────────────────────

async function handleSetRequirements(
  projectRoot: string,
  params: {
    estimatedDataGb?: number;
    expectedWorkload?: string;
    location?: string;
    priceCategory?: string;
    useExternalVolume?: boolean;
  },
): Promise<ToolResponse> {
  const state = readStateOrNull(projectRoot);
  if (!state || state.phase === 'initialized' || state.phase === 'uninitialized') {
    return {
      phase: state?.phase ?? 'uninitialized',
      message: 'Cloud provider not checked yet. Call with action "check_cloud" first.',
      nextAction: 'check_cloud',
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

  if (!params.location) {
    return {
      phase: state.phase,
      message: 'Location is required. Please specify a Hetzner location (e.g. "fsn1", "nbg1", "hel1").',
      nextAction: 'set_requirements',
    };
  }

  const priceCategory = (params.priceCategory as ServerPriceCategory) ?? 'regular';
  if (!PRICE_CATEGORY_ORDER.includes(priceCategory)) {
    return {
      phase: state.phase,
      message: `Invalid priceCategory "${priceCategory}". Must be one of: cost-optimised, regular, dedicated.`,
      nextAction: 'set_requirements',
    };
  }

  const useExternalVolume = params.useExternalVolume ?? false;

  const requirements: ClusterRequirements = {
    estimatedDataGb: params.estimatedDataGb ?? 10,
    expectedWorkload: (params.expectedWorkload as 'light' | 'moderate' | 'heavy') ?? 'light',
    location: params.location,
    priceCategory,
    useExternalVolume,
  };

  // Fetch everything in parallel
  try {
    const client = new HetznerClient(token);
    const [allServers, datacenters, ipPricing, locations, volumePricing] = await Promise.all([
      client.fetchAllServerTypes(),
      client.fetchDatacenters(),
      client.fetchPrimaryIpPricing(),
      client.fetchLocations(),
      client.fetchVolumePricing(),
    ]);

    // Validate location
    const targetLocation = locations.find((l) => l.name === requirements.location);
    if (!targetLocation) {
      const available = locations.map((l) => `${l.name} (${l.city}, ${l.country})`).join(', ');
      return {
        phase: state.phase,
        message: `Invalid location "${requirements.location}". Available locations: ${available}`,
        nextAction: 'set_requirements',
        details: { availableLocations: locations },
      };
    }

    // Compute minimum specs from resource table
    const minSpecs = computeMinSpecs(requirements.expectedWorkload, requirements.estimatedDataGb, useExternalVolume);

    // Get IP cost for the target location
    const ipPrice = ipPricing.find((p) => p.location === requirements.location);
    const ipMonthlyCost = ipPrice?.monthlyGrossEur ?? 0;

    // Compute volume cost (0 when not using external volume)
    const volumeMonthlyCost = useExternalVolume ? minSpecs.volumeGb * volumePricing.pricePerGbMonthlyGrossEur : 0;

    // Find datacenter(s) for the target location
    const targetDcs = datacenters.filter((dc) => dc.location === requirements.location);
    // Merge available IDs across all DCs at this location
    const availableIds = new Set(targetDcs.flatMap((dc) => dc.availableServerTypeIds));

    // Try to find exact match: meets specs + desired category + available at location
    const result = findBestMatch(
      allServers,
      minSpecs,
      priceCategory,
      requirements.location,
      availableIds,
      ipMonthlyCost,
      volumeMonthlyCost,
      minSpecs.volumeGb,
    );

    // Find the absolute cheapest across ALL locations and categories
    const cheapest = findCheapestOverall(
      allServers,
      minSpecs,
      ipPricing,
      datacenters,
      locations,
      volumeMonthlyCost,
      minSpecs.volumeGb,
    );

    // Build alternatives so the user sees the full picture
    const alternatives = buildAlternatives(
      allServers,
      minSpecs,
      priceCategory,
      requirements.location,
      availableIds,
      ipMonthlyCost,
      ipPricing,
      datacenters,
      locations,
      targetLocation,
      volumeMonthlyCost,
      minSpecs.volumeGb,
    );

    const formattedAlternatives = alternatives.map((g) => ({
      label: g.label,
      reason: g.reason,
      options: g.options.map(formatRecommendation),
    }));

    // Include cheapestOverall only if it's different from the recommendation
    const cheapestOverall =
      cheapest && result && cheapest.totalMonthlyPriceEur < result.totalMonthlyPriceEur
        ? formatRecommendation(cheapest)
        : cheapest && !result
          ? formatRecommendation(cheapest)
          : null;

    // Build minSpecs summary for response
    const minSpecsSummary: Record<string, unknown> = {
      cpu: minSpecs.cpu,
      memoryGb: minSpecs.memoryGb,
      ...(useExternalVolume
        ? { vmDisk: 'any (data on external volume)', volumeGb: minSpecs.volumeGb }
        : { diskGb: minSpecs.diskGb }),
    };

    const specsLabel = useExternalVolume
      ? `${minSpecs.cpu} vCPU / ${minSpecs.memoryGb} GB RAM + ${minSpecs.volumeGb} GB volume`
      : `${minSpecs.cpu} vCPU / ${minSpecs.memoryGb} GB RAM / ${minSpecs.diskGb} GB disk`;

    if (result) {
      // Exact match found — save as recommendation, show alternatives + cheapest overall
      const updatedState = updatePhase(projectRoot, 'requirements_set', {
        requirements,
        recommendation: result,
        lastError: undefined,
      });
      const next = getNextActionForPhase(updatedState.phase);

      const isCheapestOverall = !cheapestOverall;
      const message = isCheapestOverall
        ? 'Server recommendation ready — this is the cheapest available option matching your criteria.'
        : 'Server recommendation ready — exact match found, but a cheaper option exists at another location.';

      const guidanceInstruction = [
        next.description,
        '',
        'Guide the user through the alternatives below:',
        '1. Present the primary recommendation first with full pricing breakdown.',
        cheapestOverall
          ? '2. Highlight that a cheaper option exists (see cheapestOverall) and explain the trade-off (different location or server type).'
          : '2. Mention the alternatives are available if they want to explore.',
        '3. Walk through same-zone options explaining price/performance differences between categories.',
        '4. If other-zone options exist (marked with ⚠), explain they are in a different network zone which means higher network latency.',
        '5. Help the user weigh cost vs. location proximity vs. server capabilities.',
        useExternalVolume
          ? '6. Note: an external volume is enabled. Explain that DB data will live on the volume for better reliability and easier migration, while MongoDB logs stay on the VM disk to save costs.'
          : '',
        `${useExternalVolume ? '7' : '6'}. Once they decide, either call approve_recommendation (if they accept the primary) or call set_requirements again with the chosen location and/or priceCategory.`,
      ]
        .filter(Boolean)
        .join('\n');

      return {
        phase: updatedState.phase,
        message,
        nextAction: next.nextAction,
        details: {
          requirements,
          minSpecs: minSpecsSummary,
          recommendation: formatRecommendation(result),
          ...(cheapestOverall ? { cheapestOverall } : {}),
          alternatives: formattedAlternatives,
          instruction: guidanceInstruction,
        },
      };
    }

    // No exact match at the user's chosen location + category
    const noMatchGuidance = [
      'No exact match was found. Guide the user through the alternatives:',
      cheapestOverall
        ? '1. Start with the cheapestOverall — the absolute cheapest server meeting specs across all locations and categories.'
        : '1. Start with the first alternative group as the best available option.',
      '2. Walk through same-zone options first — these have the lowest latency to the originally requested location.',
      '3. If other-zone options exist (marked with ⚠), explain they are in a different network zone which will add latency but may offer better pricing or availability.',
      '4. For each option, explain the price category (cost-optimised vs regular vs dedicated) and what it means for performance.',
      '5. Help the user choose based on their priorities: cost, proximity, or performance.',
      useExternalVolume
        ? '6. Note: an external volume is enabled. Explain that DB data will live on the volume for better reliability and easier migration, while MongoDB logs stay on the VM disk to save costs.'
        : '',
      `${useExternalVolume ? '7' : '6'}. Once they decide, call set_requirements again with the chosen location and priceCategory.`,
    ]
      .filter(Boolean)
      .join('\n');

    return {
      phase: state.phase,
      message: `No ${categoryLabel(priceCategory)} server meeting ${specsLabel} is available at ${requirements.location}. Here are alternative options:`,
      nextAction: 'set_requirements',
      details: {
        requirements,
        minSpecs: minSpecsSummary,
        exactMatchAvailable: false,
        ...(cheapestOverall ? { cheapestOverall } : {}),
        alternatives: formattedAlternatives,
        instruction: noMatchGuidance,
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      phase: state.phase,
      message: `Failed to fetch server data: ${reason}`,
      nextAction: 'set_requirements',
      details: { error: reason },
    };
  }
}

// ── Server Selection ────────────────────────────────────────────────────────

type MinSpecs = {
  cpu: number;
  memoryGb: number;
  diskGb: number;
  preferDedicatedCpu: boolean;
  preferLocalDisk: boolean;
};

/** Returns true when the server meets ALL minimum specs (CPU, RAM, disk). */
function meetsSpecs(server: HetznerServerType, specs: MinSpecs): boolean {
  return server.cpu >= specs.cpu && server.memoryGb >= specs.memoryGb && server.diskGb >= specs.diskGb;
}

function toRecommendation(
  server: HetznerServerType,
  location: string,
  ipMonthlyCost: number,
  volumeMonthlyCost = 0,
  volumeGb = 0,
): ServerRecommendation | null {
  const price = server.prices.find((p) => p.location === location);
  if (!price) return null;
  return {
    serverType: server.name,
    description: server.description,
    cpu: server.cpu,
    cpuType: server.cpuType,
    memoryGb: server.memoryGb,
    diskGb: server.diskGb,
    location,
    priceCategory: server.priceCategory,
    serverMonthlyPriceEur: price.monthlyGrossEur,
    primaryIpMonthlyPriceEur: ipMonthlyCost,
    volumeGb,
    volumeMonthlyPriceEur: volumeMonthlyCost,
    totalMonthlyPriceEur: price.monthlyGrossEur + ipMonthlyCost + volumeMonthlyCost,
  };
}

function formatRecommendation(rec: ServerRecommendation): Record<string, unknown> {
  const parts = [`Server: €${rec.serverMonthlyPriceEur.toFixed(2)}/mo`];
  parts.push(`IPv4: €${rec.primaryIpMonthlyPriceEur.toFixed(2)}/mo`);
  if (rec.volumeMonthlyPriceEur > 0) {
    parts.push(`Volume: €${rec.volumeMonthlyPriceEur.toFixed(2)}/mo`);
  }
  parts.push(`= €${rec.totalMonthlyPriceEur.toFixed(2)}/mo`);

  const pricing: Record<string, unknown> = {
    serverMonthlyEur: rec.serverMonthlyPriceEur,
    primaryIpMonthlyEur: rec.primaryIpMonthlyPriceEur,
  };
  if (rec.volumeMonthlyPriceEur > 0) {
    pricing['volumeMonthlyEur'] = rec.volumeMonthlyPriceEur;
  }
  pricing['totalMonthlyEur'] = rec.totalMonthlyPriceEur;
  pricing['note'] = parts.join(' + ').replace(' + =', ' =');

  return {
    serverType: rec.serverType,
    description: rec.description,
    specs:
      rec.volumeGb > 0
        ? `${rec.cpu} ${rec.cpuType} vCPU, ${rec.memoryGb} GB RAM, ${rec.diskGb} GB VM disk + ${rec.volumeGb} GB external volume`
        : `${rec.cpu} ${rec.cpuType} vCPU, ${rec.memoryGb} GB RAM, ${rec.diskGb} GB disk`,
    location: rec.location,
    priceCategory: rec.priceCategory,
    pricing,
  };
}

/**
 * Find the cheapest server at `location` that meets `specs` with the desired `category`
 * and is actually available (in `availableIds`). Returns null if nothing qualifies.
 */
function findBestMatch(
  allServers: HetznerServerType[],
  specs: MinSpecs,
  category: ServerPriceCategory,
  location: string,
  availableIds: Set<number>,
  ipMonthlyCost: number,
  volumeMonthlyCost = 0,
  volumeGb = 0,
): ServerRecommendation | null {
  const candidates = allServers
    .filter(
      (s) =>
        s.priceCategory === category &&
        availableIds.has(s.id) &&
        meetsSpecs(s, specs) &&
        s.prices.some((p) => p.location === location),
    )
    .sort((a, b) => {
      const aPrice = a.prices.find((p) => p.location === location)?.monthlyGrossEur ?? Infinity;
      const bPrice = b.prices.find((p) => p.location === location)?.monthlyGrossEur ?? Infinity;
      return aPrice - bPrice;
    });

  for (const c of candidates) {
    const rec = toRecommendation(c, location, ipMonthlyCost, volumeMonthlyCost, volumeGb);
    if (rec) return rec;
  }
  return null;
}

/**
 * Find the cheapest available server at a location for a given category
 * that meets the minimum specs. Returns null if nothing qualifies.
 */
function findCheapestInCategory(
  allServers: HetznerServerType[],
  specs: MinSpecs,
  category: ServerPriceCategory,
  location: string,
  availableIds: Set<number>,
  ipMonthlyCost: number,
  volumeMonthlyCost = 0,
  volumeGb = 0,
): ServerRecommendation | null {
  return findBestMatch(allServers, specs, category, location, availableIds, ipMonthlyCost, volumeMonthlyCost, volumeGb);
}

/**
 * Find the absolute cheapest server meeting specs across ALL locations
 * and ALL categories. Returns null if nothing qualifies at all.
 */
function findCheapestOverall(
  allServers: HetznerServerType[],
  specs: MinSpecs,
  allIpPricing: HetznerPrimaryIpPrice[],
  datacenters: HetznerDatacenter[],
  allLocations: HetznerLocation[],
  volumeMonthlyCost = 0,
  volumeGb = 0,
): ServerRecommendation | null {
  let cheapest: ServerRecommendation | null = null;

  for (const loc of allLocations) {
    const dcs = datacenters.filter((dc) => dc.location === loc.name);
    const availableIds = new Set(dcs.flatMap((dc) => dc.availableServerTypeIds));
    const ipCost = allIpPricing.find((p) => p.location === loc.name)?.monthlyGrossEur ?? 0;

    for (const category of PRICE_CATEGORY_ORDER) {
      const best = findCheapestInCategory(
        allServers,
        specs,
        category,
        loc.name,
        availableIds,
        ipCost,
        volumeMonthlyCost,
        volumeGb,
      );
      if (best && (!cheapest || best.totalMonthlyPriceEur < cheapest.totalMonthlyPriceEur)) {
        cheapest = best;
      }
    }
  }

  return cheapest;
}

/**
 * Collect cheapest server per category at a given location.
 * Returns recommendations sorted by total price (cheapest first).
 */
function collectOptionsAtLocation(
  allServers: HetznerServerType[],
  specs: MinSpecs,
  locationName: string,
  datacenters: HetznerDatacenter[],
  allIpPricing: HetznerPrimaryIpPrice[],
  volumeMonthlyCost = 0,
  volumeGb = 0,
): ServerRecommendation[] {
  const dcs = datacenters.filter((dc) => dc.location === locationName);
  const availableIds = new Set(dcs.flatMap((dc) => dc.availableServerTypeIds));
  const ipCost = allIpPricing.find((p) => p.location === locationName)?.monthlyGrossEur ?? 0;

  const options: ServerRecommendation[] = [];
  for (const cat of PRICE_CATEGORY_ORDER) {
    const best = findCheapestInCategory(
      allServers,
      specs,
      cat,
      locationName,
      availableIds,
      ipCost,
      volumeMonthlyCost,
      volumeGb,
    );
    if (best) options.push(best);
  }
  return options.sort((a, b) => a.totalMonthlyPriceEur - b.totalMonthlyPriceEur);
}

/**
 * Build grouped alternative options using zone-based grouping.
 *
 * 1. Same location — cheapest server per OTHER category.
 * 2. Same zone — all other locations in the same network zone, cheapest per category.
 * 3. Other zones — all locations in other zones, cheapest per category (flagged as different zone).
 *
 * Every server shown strictly meets the minimum specs.
 */
function buildAlternatives(
  allServers: HetznerServerType[],
  specs: MinSpecs,
  desiredCategory: ServerPriceCategory,
  location: string,
  availableIds: Set<number>,
  ipMonthlyCost: number,
  allIpPricing: HetznerPrimaryIpPrice[],
  datacenters: HetznerDatacenter[],
  allLocations: HetznerLocation[],
  targetLocation: HetznerLocation,
  volumeMonthlyCost = 0,
  volumeGb = 0,
): AlternativeGroup[] {
  const groups: AlternativeGroup[] = [];
  const targetZone = deriveZoneCode(targetLocation.networkZone);

  // ── 1. Same location — other categories ───────────────────────────────

  const sameLocOptions: ServerRecommendation[] = [];
  for (const cat of PRICE_CATEGORY_ORDER) {
    if (cat === desiredCategory) continue;
    const best = findCheapestInCategory(
      allServers,
      specs,
      cat,
      location,
      availableIds,
      ipMonthlyCost,
      volumeMonthlyCost,
      volumeGb,
    );
    if (best) sameLocOptions.push(best);
  }
  if (sameLocOptions.length > 0) {
    sameLocOptions.sort((a, b) => a.totalMonthlyPriceEur - b.totalMonthlyPriceEur);
    groups.push({
      label: `${location} — other server types`,
      reason: `Same location (${targetLocation.city}), different price category`,
      options: sameLocOptions,
    });
  }

  // ── 2. Same zone — other locations sorted by distance ─────────────────

  const sameZoneLocations = allLocations
    .filter((l) => l.name !== location && deriveZoneCode(l.networkZone) === targetZone)
    .map((l) => ({
      ...l,
      distance: haversineKm(targetLocation.latitude, targetLocation.longitude, l.latitude, l.longitude),
    }))
    .sort((a, b) => a.distance - b.distance);

  for (const loc of sameZoneLocations) {
    const options = collectOptionsAtLocation(
      allServers,
      specs,
      loc.name,
      datacenters,
      allIpPricing,
      volumeMonthlyCost,
      volumeGb,
    );
    if (options.length > 0) {
      groups.push({
        label: `${loc.name} (${loc.city}, ${Math.round(loc.distance)} km) — same zone ${targetZone}`,
        reason: `Same network zone (${targetLocation.networkZone}), ${Math.round(loc.distance)} km from ${location}`,
        options,
      });
    }
  }

  // ── 3. Other zones — grouped by zone, locations sorted by distance ────

  const otherZoneLocations = allLocations
    .filter((l) => deriveZoneCode(l.networkZone) !== targetZone)
    .map((l) => ({
      ...l,
      zone: deriveZoneCode(l.networkZone),
      distance: haversineKm(targetLocation.latitude, targetLocation.longitude, l.latitude, l.longitude),
    }))
    .sort((a, b) => a.distance - b.distance);

  // Group by zone code, preserving distance order within each zone
  const zoneMap = new Map<string, typeof otherZoneLocations>();
  for (const loc of otherZoneLocations) {
    const existing = zoneMap.get(loc.zone) ?? [];
    existing.push(loc);
    zoneMap.set(loc.zone, existing);
  }

  for (const [zone, zoneLocs] of zoneMap) {
    for (const loc of zoneLocs) {
      const options = collectOptionsAtLocation(
        allServers,
        specs,
        loc.name,
        datacenters,
        allIpPricing,
        volumeMonthlyCost,
        volumeGb,
      );
      if (options.length > 0) {
        groups.push({
          label: `${loc.name} (${loc.city}, ${Math.round(loc.distance)} km) — zone ${zone} ⚠`,
          reason: `Different network zone (${loc.networkZone}) — higher latency from ${targetZone} locations`,
          options,
        });
      }
    }
  }

  return groups;
}

// ── Step 4: Approve Recommendation ──────────────────────────────────────────

function handleApproveRecommendation(projectRoot: string): ToolResponse {
  const state = readStateOrNull(projectRoot);
  if (!state || !state.recommendation) {
    return {
      phase: state?.phase ?? 'uninitialized',
      message: 'No recommendation to approve. Call with action "set_requirements" first.',
      nextAction: 'set_requirements',
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
  return {
    phase: updatedState.phase,
    message: `Recommendation approved! Server: ${rec.serverType} (${categoryLabel(rec.priceCategory)}) in ${rec.location}. Total cost: €${rec.totalMonthlyPriceEur.toFixed(2)}/mo (${costParts.join(' + ')}). Ready for infrastructure provisioning.`,
    nextAction: next.nextAction,
    details: {
      approved: true,
      recommendation: rec,
      requirements: state.requirements,
      instruction: next.description,
    },
  };
}

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
        '  4. "approve_recommendation" — Approve the recommendation to proceed to provisioning.',
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
        action: z.enum(['initialize', 'check_cloud', 'set_requirements', 'approve_recommendation']),
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
            response = handleApproveRecommendation(root);
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
