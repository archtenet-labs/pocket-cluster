// ── Workflow Phases ──────────────────────────────────────────────────────────

export type WorkflowPhase =
  | 'uninitialized'
  | 'initialized'
  | 'cloud_checked'
  | 'requirements_set'
  | 'recommendation_approved'
  | 'ready_to_provision';

// ── Cloud Provider ──────────────────────────────────────────────────────────

export type CloudProvider = 'hetzner';

// ── Server Price Category ───────────────────────────────────────────────────

/**
 * Server price categories based on Hetzner product lines:
 *   - cost-optimised: CX (x86 shared) and CAX (Arm64 shared) — cheapest
 *   - regular: CPX (x86 shared, higher clock) — default choice
 *   - dedicated: CCX (dedicated vCPU) — highest performance
 */
export type ServerPriceCategory = 'cost-optimised' | 'regular' | 'dedicated';

/** Ordered from cheapest to most expensive */
export const PRICE_CATEGORY_ORDER: ServerPriceCategory[] = ['cost-optimised', 'regular', 'dedicated'];

// ── Hetzner Types ───────────────────────────────────────────────────────────

export type HetznerServerType = {
  id: number;
  name: string;
  description: string;
  cpu: number;
  cpuType: 'shared' | 'dedicated';
  architecture: 'x86' | 'arm';
  memoryGb: number;
  diskGb: number;
  diskType: 'local' | 'network';
  priceCategory: ServerPriceCategory;
  prices: HetznerLocationPrice[];
};

export type HetznerLocationPrice = {
  location: string;
  monthlyGrossEur: number;
  hourlyGrossEur: number;
};

export type HetznerLocation = {
  name: string;
  description: string;
  city: string;
  country: string;
  networkZone: string;
  latitude: number;
  longitude: number;
};

export type HetznerDatacenter = {
  name: string;
  description: string;
  location: string;
  availableServerTypeIds: number[];
  supportedServerTypeIds: number[];
  latitude: number;
  longitude: number;
};

export type HetznerPrimaryIpPrice = {
  location: string;
  monthlyGrossEur: number;
};

/** Per-GB monthly volume pricing (location-independent) */
export type HetznerVolumePricing = {
  pricePerGbMonthlyGrossEur: number;
};

// ── Cluster Requirements ────────────────────────────────────────────────────

export type ClusterRequirements = {
  estimatedDataGb: number;
  expectedWorkload: 'light' | 'moderate' | 'heavy';
  location: string;
  priceCategory: ServerPriceCategory;
  useExternalVolume: boolean;
};

// ── Server Recommendation ───────────────────────────────────────────────────

export type ServerRecommendation = {
  serverType: string;
  description: string;
  cpu: number;
  cpuType: 'shared' | 'dedicated';
  memoryGb: number;
  diskGb: number;
  location: string;
  priceCategory: ServerPriceCategory;
  serverMonthlyPriceEur: number;
  primaryIpMonthlyPriceEur: number;
  /** External volume size in GB (0 when not using external volume) */
  volumeGb: number;
  /** External volume cost (only when useExternalVolume is enabled) */
  volumeMonthlyPriceEur: number;
  totalMonthlyPriceEur: number;
};

/** A group of alternative server options when exact match is unavailable */
export type AlternativeGroup = {
  label: string;
  reason: string;
  options: ServerRecommendation[];
};

// ── State ───────────────────────────────────────────────────────────────────

export type PocketClusterState = {
  projectRoot: string;
  createdAt: string;
  updatedAt: string;
  phase: WorkflowPhase;
  provider: CloudProvider;
  credentialsVerified: boolean;
  requirements?: ClusterRequirements;
  recommendation?: ServerRecommendation;
  lastError?: string;
};

// ── Tool Response ───────────────────────────────────────────────────────────

export type ToolResponse = {
  phase: WorkflowPhase;
  message: string;
  nextAction: string;
  details?: Record<string, unknown>;
};
