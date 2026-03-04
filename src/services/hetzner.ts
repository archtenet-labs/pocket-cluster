import {
  HetznerDatacenter,
  HetznerLocation,
  HetznerNetwork,
  HetznerPrimaryIpPrice,
  HetznerServerType,
  HetznerSshKey,
  HetznerVolumePricing,
  ServerPriceCategory,
} from '../types/index.js';

type HetznerApiResponse<T> = T & {
  error?: {
    code: string;
    message: string;
  };
};

/**
 * Derive price category from server type name prefix.
 *   CX / CAX → cost-optimised
 *   CPX      → regular
 *   CCX      → dedicated
 */
function derivePriceCategory(name: string, cpuType: string): ServerPriceCategory {
  const upper = name.toUpperCase();
  if (upper.startsWith('CCX') || cpuType === 'dedicated') return 'dedicated';
  if (upper.startsWith('CPX')) return 'regular';
  // CX, CAX, and anything else shared → cost-optimised
  return 'cost-optimised';
}

export class HetznerClient {
  private readonly baseUrl = 'https://api.hetzner.cloud/v1';

  constructor(private readonly token: string) {
    if (!token.trim()) {
      throw new Error('Hetzner API token is required');
    }
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });

    const text = await response.text();
    const payload = text ? (JSON.parse(text) as HetznerApiResponse<T>) : ({} as HetznerApiResponse<T>);

    if (!response.ok || payload.error) {
      const details = payload.error ? `${payload.error.code}: ${payload.error.message}` : text;
      throw new Error(`Hetzner API request failed (${response.status}) for ${path}: ${details}`);
    }

    return payload as T;
  }

  /**
   * Validate the API token by making a lightweight API call.
   */
  async validateToken(): Promise<boolean> {
    await this.request<{ locations: unknown[] }>('/locations?per_page=1');
    return true;
  }

  /**
   * Fetch all available locations from Hetzner (with coordinates).
   */
  async fetchLocations(): Promise<HetznerLocation[]> {
    const payload = await this.request<{
      locations: Array<{
        name: string;
        description: string;
        city: string;
        country: string;
        network_zone: string;
        latitude: number;
        longitude: number;
      }>;
    }>('/locations');

    return payload.locations.map((loc) => ({
      name: loc.name,
      description: loc.description,
      city: loc.city,
      country: loc.country,
      networkZone: loc.network_zone,
      latitude: loc.latitude,
      longitude: loc.longitude,
    }));
  }

  /**
   * Fetch all datacenters with per-datacenter server availability.
   */
  async fetchDatacenters(): Promise<HetznerDatacenter[]> {
    const payload = await this.request<{
      datacenters: Array<{
        name: string;
        description: string;
        location: {
          name: string;
          latitude: number;
          longitude: number;
        };
        server_types: {
          available: number[];
          supported: number[];
        };
      }>;
    }>('/datacenters');

    return payload.datacenters.map((dc) => ({
      name: dc.name,
      description: dc.description,
      location: dc.location.name,
      availableServerTypeIds: dc.server_types.available,
      supportedServerTypeIds: dc.server_types.supported,
      latitude: dc.location.latitude,
      longitude: dc.location.longitude,
    }));
  }

  /**
   * Fetch all server types with per-location pricing, id, architecture, and price category.
   */
  async fetchAllServerTypes(): Promise<HetznerServerType[]> {
    const payload = await this.request<{
      server_types: Array<{
        id: number;
        name: string;
        description: string;
        cores: number;
        cpu_type: string;
        architecture: string;
        memory: number;
        disk: number;
        storage_type: string;
        prices: Array<{
          location: string;
          price_monthly: { gross: string };
          price_hourly: { gross: string };
        }>;
      }>;
    }>('/server_types?per_page=50');

    return payload.server_types
      .map((st) => ({
        id: st.id,
        name: st.name,
        description: st.description,
        cpu: st.cores,
        cpuType: (st.cpu_type === 'dedicated' ? 'dedicated' : 'shared') as 'shared' | 'dedicated',
        architecture: (st.architecture === 'arm' ? 'arm' : 'x86') as 'x86' | 'arm',
        memoryGb: st.memory,
        diskGb: st.disk,
        diskType: (st.storage_type === 'local' ? 'local' : 'network') as 'local' | 'network',
        priceCategory: derivePriceCategory(st.name, st.cpu_type),
        prices: st.prices
          .filter((p) => p.location && p.price_monthly.gross !== '0.0000')
          .map((p) => ({
            location: p.location,
            monthlyGrossEur: Number(p.price_monthly.gross),
            hourlyGrossEur: Number(p.price_hourly.gross),
          })),
      }))
      .filter((st) => st.prices.length > 0)
      .sort((a, b) => {
        const aMin = Math.min(...a.prices.map((p) => p.monthlyGrossEur));
        const bMin = Math.min(...b.prices.map((p) => p.monthlyGrossEur));
        return aMin - bMin;
      });
  }

  /**
   * Fetch primary IPv4 pricing per location from the /pricing endpoint.
   */
  async fetchPrimaryIpPricing(): Promise<HetznerPrimaryIpPrice[]> {
    const payload = await this.request<{
      pricing: {
        primary_ips: Array<{
          type: string;
          prices: Array<{
            location: string;
            price_monthly: { gross: string };
          }>;
        }>;
      };
    }>('/pricing');

    const ipv4Entry = payload.pricing.primary_ips.find((ip) => ip.type === 'ipv4');
    if (!ipv4Entry) {
      return [];
    }

    return ipv4Entry.prices.map((p) => ({
      location: p.location,
      monthlyGrossEur: Number(p.price_monthly.gross),
    }));
  }

  /**
   * Fetch volume pricing (per-GB monthly cost) from the /pricing endpoint.
   */
  async fetchVolumePricing(): Promise<HetznerVolumePricing> {
    const payload = await this.request<{
      pricing: {
        volume: {
          price_per_gb_month: { gross: string };
        };
      };
    }>('/pricing');

    return {
      pricePerGbMonthlyGrossEur: Number(payload.pricing.volume.price_per_gb_month.gross),
    };
  }

  /**
   * Fetch all SSH keys registered in the Hetzner Cloud project.
   */
  async fetchSshKeys(): Promise<HetznerSshKey[]> {
    const payload = await this.request<{
      ssh_keys: Array<{
        id: number;
        name: string;
        fingerprint: string;
        public_key: string;
      }>;
    }>('/ssh_keys');

    return payload.ssh_keys.map((k) => ({
      id: k.id,
      name: k.name,
      fingerprint: k.fingerprint,
      publicKey: k.public_key,
    }));
  }

  /**
   * Upload a new SSH public key to the Hetzner Cloud project.
   */
  async uploadSshKey(name: string, publicKey: string): Promise<HetznerSshKey> {
    const payload = await this.request<{
      ssh_key: {
        id: number;
        name: string;
        fingerprint: string;
        public_key: string;
      };
    }>('/ssh_keys', {
      method: 'POST',
      body: JSON.stringify({ name, public_key: publicKey }),
    });

    return {
      id: payload.ssh_key.id,
      name: payload.ssh_key.name,
      fingerprint: payload.ssh_key.fingerprint,
      publicKey: payload.ssh_key.public_key,
    };
  }

  /**
   * Fetch all private networks in the Hetzner Cloud project.
   */
  async fetchNetworks(): Promise<HetznerNetwork[]> {
    const payload = await this.request<{
      networks: Array<{
        id: number;
        name: string;
        ip_range: string;
        subnets: Array<{
          type: string;
          ip_range: string;
          network_zone: string;
          gateway: string;
        }>;
      }>;
    }>('/networks');

    return payload.networks.map((n) => ({
      id: n.id,
      name: n.name,
      ipRange: n.ip_range,
      subnets: n.subnets.map((s) => ({
        type: s.type as 'cloud' | 'server' | 'vswitch',
        ipRange: s.ip_range,
        networkZone: s.network_zone,
        gateway: s.gateway,
      })),
    }));
  }

  /**
   * Create a new volume (block storage).
   */
  async createVolume(params: {
    name: string;
    size: number;
    location: string;
    format?: string;
    automount?: boolean;
    labels?: Record<string, string>;
  }): Promise<{
    id: number;
    name: string;
    size: number;
    format: string;
    linuxDevice: string;
    status: string;
  }> {
    const payload = await this.request<{
      volume: {
        id: number;
        name: string;
        size: number;
        format: string;
        linux_device: string;
        status: string;
      };
    }>('/volumes', {
      method: 'POST',
      body: JSON.stringify({
        name: params.name,
        size: params.size,
        location: params.location,
        format: params.format ?? 'xfs',
        automount: params.automount ?? false,
        labels: params.labels ?? {},
      }),
    });

    return {
      id: payload.volume.id,
      name: payload.volume.name,
      size: payload.volume.size,
      format: payload.volume.format,
      linuxDevice: payload.volume.linux_device,
      status: payload.volume.status,
    };
  }

  /**
   * Create a new server with all associated resources.
   */
  async createServer(params: {
    name: string;
    serverType: string;
    image: number;
    location: string;
    sshKeys: number[];
    networks?: number[];
    volumes?: number[];
    automount?: boolean;
    labels?: Record<string, string>;
  }): Promise<{
    id: number;
    name: string;
    ipv4: string;
    ipv6: string;
    serverType: string;
    status: string;
  }> {
    const body: Record<string, unknown> = {
      name: params.name,
      server_type: params.serverType,
      image: params.image,
      location: params.location,
      ssh_keys: params.sshKeys,
      public_net: {
        enable_ipv4: true,
        enable_ipv6: true,
      },
      start_after_create: true,
      labels: params.labels ?? {},
    };

    if (params.networks && params.networks.length > 0) {
      body.networks = params.networks;
    }
    if (params.volumes && params.volumes.length > 0) {
      body.volumes = params.volumes;
      body.automount = params.automount ?? true;
    }

    const payload = await this.request<{
      server: {
        id: number;
        name: string;
        public_net: {
          ipv4: { ip: string };
          ipv6: { ip: string };
        };
        server_type: { name: string };
        status: string;
      };
    }>('/servers', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return {
      id: payload.server.id,
      name: payload.server.name,
      ipv4: payload.server.public_net.ipv4.ip,
      ipv6: payload.server.public_net.ipv6.ip,
      serverType: payload.server.server_type.name,
      status: payload.server.status,
    };
  }

  /**
   * Create a new private network with a subnet.
   */
  async createNetwork(
    name: string,
    ipRange: string,
    subnetIpRange: string,
    networkZone: string,
  ): Promise<HetznerNetwork> {
    const payload = await this.request<{
      network: {
        id: number;
        name: string;
        ip_range: string;
        subnets: Array<{
          type: string;
          ip_range: string;
          network_zone: string;
          gateway: string;
        }>;
      };
    }>('/networks', {
      method: 'POST',
      body: JSON.stringify({
        name,
        ip_range: ipRange,
        subnets: [
          {
            type: 'cloud',
            ip_range: subnetIpRange,
            network_zone: networkZone,
          },
        ],
      }),
    });

    return {
      id: payload.network.id,
      name: payload.network.name,
      ipRange: payload.network.ip_range,
      subnets: payload.network.subnets.map((s) => ({
        type: s.type as 'cloud' | 'server' | 'vswitch',
        ipRange: s.ip_range,
        networkZone: s.network_zone,
        gateway: s.gateway,
      })),
    };
  }
}
