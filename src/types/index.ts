// ── Workflow Phases ──────────────────────────────────────────────────────────

export type WorkflowPhase =
  | 'uninitialized'
  | 'initialized'
  | 'cloud_checked'
  | 'requirements_set'
  | 'recommendation_approved'
  | 'ssh_configured'
  | 'network_configured'
  | 'ready_to_provision'
  | 'provisioning'
  | 'provisioned';

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

/** Private network registered in Hetzner Cloud */
export type HetznerNetwork = {
  id: number;
  name: string;
  ipRange: string;
  subnets: HetznerSubnet[];
};

export type HetznerSubnet = {
  type: 'cloud' | 'server' | 'vswitch';
  ipRange: string;
  networkZone: string;
  gateway: string;
};

/** SSH key registered in Hetzner Cloud */
export type HetznerSshKey = {
  id: number;
  name: string;
  fingerprint: string;
  publicKey: string;
};

// ── SSH Key Config ──────────────────────────────────────────────────────────

/** SSH key selection for provisioning */
export type SshKeyConfig = {
  /** IDs of existing Hetzner SSH keys selected by the user */
  existingKeyIds: number[];
  /** Path to a locally generated private key (if created), relative to project root */
  generatedPrivateKeyPath?: string;
  /** ID of the newly uploaded Hetzner SSH key (if generated + uploaded) */
  generatedKeyHetznerIds?: number[];
};

// ── Network Config ──────────────────────────────────────────────────────────

/** Network configuration for provisioning */
export type NetworkConfig = {
  /** Whether to attach a private network */
  usePrivateNetwork: boolean;
  /** ID of an existing private network to use (if selected) */
  existingNetworkId?: number;
  /** Whether to create a new private network */
  createNewNetwork: boolean;
  /** Name for the new private network (if creating) */
  newNetworkName?: string;
  /** IP range for the new private network (e.g. "10.0.0.0/16") */
  newNetworkIpRange?: string;
  /** Subnet IP range (e.g. "10.0.1.0/24") */
  newSubnetIpRange?: string;
  /** Network zone for the subnet (e.g. "eu-central") */
  newSubnetNetworkZone?: string;
  /** ID of the newly created network (set after creation) */
  createdNetworkId?: number;
  /** IPv4 is always attached */
  attachIpv4: true;
  /** IPv6 is always attached */
  attachIpv6: true;
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

// ── Provisioning Result Types ────────────────────────────────────────────────

/** Result of volume provisioning */
export type ProvisionedVolume = {
  id: number;
  name: string;
  sizeGb: number;
  format: string;
  linuxDevice: string;
};

/** Result of server provisioning */
export type ProvisionedServer = {
  id: number;
  name: string;
  serverType: string;
  ipv4: string;
  ipv6: string;
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
  sshKeys?: SshKeyConfig;
  networkConfig?: NetworkConfig;
  /** The docker-ce image ID to use for the VM */
  imageId?: number;
  /** Computed server name ({projectName}-vm-1) */
  serverName?: string;
  /** Provisioned volume info (set after volume creation) */
  provisionedVolume?: ProvisionedVolume;
  /** Provisioned server info (set after server creation) */
  provisionedServer?: ProvisionedServer;
  lastError?: string;
};

// ── Tool Response ───────────────────────────────────────────────────────────

export type ToolResponse = {
  phase: WorkflowPhase;
  message: string;
  nextAction: string;
  details?: Record<string, unknown>;
};
