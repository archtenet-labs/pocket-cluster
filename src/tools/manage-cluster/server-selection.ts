import {
  AlternativeGroup,
  HetznerDatacenter,
  HetznerLocation,
  HetznerPrimaryIpPrice,
  HetznerServerType,
  PRICE_CATEGORY_ORDER,
  ServerPriceCategory,
  ServerRecommendation,
} from '../../types/index.js';
import { deriveZoneCode, haversineKm } from './helpers.js';

// ── Server Selection ────────────────────────────────────────────────────────

export type MinSpecs = {
  cpu: number;
  memoryGb: number;
  diskGb: number;
  preferDedicatedCpu: boolean;
  preferLocalDisk: boolean;
};

/** Returns true when the server meets ALL minimum specs (CPU, RAM, disk). */
export function meetsSpecs(server: HetznerServerType, specs: MinSpecs): boolean {
  return server.cpu >= specs.cpu && server.memoryGb >= specs.memoryGb && server.diskGb >= specs.diskGb;
}

export function toRecommendation(
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

export function formatRecommendation(rec: ServerRecommendation): Record<string, unknown> {
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
export function findBestMatch(
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
export function findCheapestInCategory(
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
export function findCheapestOverall(
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
export function collectOptionsAtLocation(
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
export function buildAlternatives(
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
