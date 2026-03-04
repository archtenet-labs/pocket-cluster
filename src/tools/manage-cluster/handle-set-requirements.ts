import { computeMinSpecs } from '../../config/resource-requirements.js';
import { HetznerClient } from '../../services/hetzner.js';
import { getNextActionForPhase, readStateOrNull, updatePhase } from '../../state/manager.js';
import { ClusterRequirements, PRICE_CATEGORY_ORDER, ServerPriceCategory, ToolResponse } from '../../types/index.js';
import { categoryLabel, getHetznerToken } from './helpers.js';
import { buildAlternatives, findBestMatch, findCheapestOverall, formatRecommendation } from './server-selection.js';

// ── Step 3: Set Requirements ────────────────────────────────────────────────

export async function handleSetRequirements(
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
