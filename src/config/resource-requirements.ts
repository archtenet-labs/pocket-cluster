/**
 * Resource requirements table for MongoDB standalone deployments.
 *
 * Maps (dataset size range × workload intensity) → minimum server specs.
 * Edit the RESOURCE_TABLE array below to tweak server selection logic.
 *
 * The first matching row wins (rows are evaluated top-to-bottom), so
 * put more specific / smaller ranges first.
 *
 * Disk is always computed as estimatedDataGb × diskMultiplier, floored to minDiskGb.
 */

export type ResourceRow = {
  /** Upper bound of dataset size (GB) for this row. Use Infinity for "no limit". */
  maxDataGb: number;
  /** Workload levels this row applies to */
  workloads: Array<'light' | 'moderate' | 'heavy'>;
  /** Minimum vCPU cores */
  minCpu: number;
  /** Minimum RAM in GB */
  minMemoryGb: number;
  /** Disk multiplier applied to estimatedDataGb */
  diskMultiplier: number;
  /** Absolute minimum disk in GB regardless of data size */
  minDiskGb: number;
  /** Prefer dedicated CPU over shared */
  preferDedicatedCpu: boolean;
  /** Prefer local (NVMe) disk over network disk */
  preferLocalDisk: boolean;
};

/**
 * Resource selection table.
 *
 * ┌────────────────┬─────────────┬────────┬───────┬──────────────┐
 * │ Dataset Size   │ Workload    │ RAM    │ vCPUs │ Disk mult.   │
 * ├────────────────┼─────────────┼────────┼───────┼──────────────┤
 * │ < 5 GB         │ any         │  2 GB  │  2    │ 2×           │
 * │ 5 – 50 GB      │ light–mod   │  4 GB  │  2    │ 2.5×         │
 * │ 5 – 50 GB      │ heavy       │  8 GB  │  4    │ 3×           │
 * │ 50 – 100 GB    │ light–mod   │  8 GB  │  4    │ 2.5×         │
 * │ 50 – 100 GB    │ heavy       │ 16 GB  │  8    │ 3×           │
 * │ > 100 GB       │ light       │ 16 GB  │  8    │ 2.5×         │
 * │ > 100 GB       │ moderate    │ 32 GB  │ 16    │ 3×           │
 * │ > 100 GB       │ heavy       │ 64 GB  │ 16    │ 3×           │
 * └────────────────┴─────────────┴────────┴───────┴──────────────┘
 *
 * Rows are evaluated top-to-bottom; the first row whose maxDataGb ≥
 * estimatedDataGb AND whose workloads array includes the requested
 * workload is selected.
 */
export const RESOURCE_TABLE: ResourceRow[] = [
  // < 5 GB
  {
    maxDataGb: 5,
    workloads: ['light', 'moderate', 'heavy'],
    minCpu: 2,
    minMemoryGb: 2,
    diskMultiplier: 2,
    minDiskGb: 20,
    preferDedicatedCpu: false,
    preferLocalDisk: false,
  },

  // 5 – 50 GB
  {
    maxDataGb: 50,
    workloads: ['light', 'moderate'],
    minCpu: 2,
    minMemoryGb: 4,
    diskMultiplier: 2.5,
    minDiskGb: 40,
    preferDedicatedCpu: false,
    preferLocalDisk: true,
  },
  {
    maxDataGb: 50,
    workloads: ['heavy'],
    minCpu: 4,
    minMemoryGb: 8,
    diskMultiplier: 3,
    minDiskGb: 40,
    preferDedicatedCpu: true,
    preferLocalDisk: true,
  },

  // 50 – 100 GB
  {
    maxDataGb: 100,
    workloads: ['light', 'moderate'],
    minCpu: 4,
    minMemoryGb: 8,
    diskMultiplier: 2.5,
    minDiskGb: 160,
    preferDedicatedCpu: false,
    preferLocalDisk: true,
  },
  {
    maxDataGb: 100,
    workloads: ['heavy'],
    minCpu: 8,
    minMemoryGb: 16,
    diskMultiplier: 3,
    minDiskGb: 160,
    preferDedicatedCpu: true,
    preferLocalDisk: true,
  },

  // > 100 GB
  {
    maxDataGb: Infinity,
    workloads: ['light'],
    minCpu: 8,
    minMemoryGb: 16,
    diskMultiplier: 2.5,
    minDiskGb: 320,
    preferDedicatedCpu: true,
    preferLocalDisk: true,
  },
  {
    maxDataGb: Infinity,
    workloads: ['moderate'],
    minCpu: 16,
    minMemoryGb: 32,
    diskMultiplier: 3,
    minDiskGb: 320,
    preferDedicatedCpu: true,
    preferLocalDisk: true,
  },
  {
    maxDataGb: Infinity,
    workloads: ['heavy'],
    minCpu: 16,
    minMemoryGb: 64,
    diskMultiplier: 3,
    minDiskGb: 320,
    preferDedicatedCpu: true,
    preferLocalDisk: true,
  },
];

/**
 * Compute minimum server specs from workload + data size.
 * Looks up the first matching row in RESOURCE_TABLE.
 *
 * When `useExternalVolume` is true, disk requirement is relaxed to 0
 * because DB data will live on a separate Hetzner volume.
 * The volume size is datasetSize × 2 (returned separately).
 */
export function computeMinSpecs(
  workload: 'light' | 'moderate' | 'heavy',
  estimatedDataGb: number,
  useExternalVolume = false,
): {
  cpu: number;
  memoryGb: number;
  diskGb: number;
  volumeGb: number;
  preferDedicatedCpu: boolean;
  preferLocalDisk: boolean;
} {
  const row = RESOURCE_TABLE.find((r) => estimatedDataGb <= r.maxDataGb && r.workloads.includes(workload));

  // Fallback to last row (catch-all) if nothing matches — shouldn't happen
  const tier = row ?? RESOURCE_TABLE[RESOURCE_TABLE.length - 1]!;

  if (useExternalVolume) {
    // External volume: VM only needs CPU + RAM; disk is not tied to dataset.
    // Volume size = datasetSize × 2 (data + indexes/overhead).
    // MongoDB logs stay on VM disk to save volume costs.
    return {
      cpu: tier.minCpu,
      memoryGb: tier.minMemoryGb,
      diskGb: 0, // no VM-disk requirement — match on CPU + RAM only
      volumeGb: Math.max(10, Math.ceil(estimatedDataGb * 2)),
      preferDedicatedCpu: tier.preferDedicatedCpu,
      preferLocalDisk: false, // disk type irrelevant when data is on volume
    };
  }

  return {
    cpu: tier.minCpu,
    memoryGb: tier.minMemoryGb,
    diskGb: Math.max(tier.minDiskGb, Math.ceil(estimatedDataGb * tier.diskMultiplier)),
    volumeGb: 0,
    preferDedicatedCpu: tier.preferDedicatedCpu,
    preferLocalDisk: tier.preferLocalDisk,
  };
}
