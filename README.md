# PocketCluster

**⚠️ STATUS: Alpha / Work in Progress**

PocketCluster brings managed database (DBaaS) convenience to bare-metal pricing. It provides an automated, AI-driven workflow to spin up secure, isolated MongoDB clusters on cost-effective cloud providers.

## The Vision

Get the 1-click convenience of an enterprise DBaaS without the massive markup. PocketCluster handles the infrastructure provisioning, network security, and deployment configuration seamlessly, letting developers focus on their product instead of DevOps.

## Core Features (In Development)

- **Agentic Deployments**: Conversational infrastructure setup orchestrated by your local AI coding agents.
- **Secure by Default**: Automated network isolation and strict firewall configuration.
- **GitOps Integration**: Zero-friction CI/CD pipeline generation for continuous management.

_(Full installation instructions and documentation will be created closer to the public Beta release)._

## MCP Starter Tools

PocketCluster now exposes these MCP tools:

- `get_next_step`: Reads `.pocketcluster/state.json` and returns the next recommended action.
- `check_hetzner_pricing`: Fetches Hetzner server pricing and can validate datacenter availability.
- `generate_ssh_key`: Generates local Ed25519/RSA SSH keypairs under `.pocketcluster/keys/`.
- `deploy_infrastructure`: Provisions Hetzner VM + firewall, injects cloud-init, and scaffolds GitOps files.

## Local Development

- Install dependencies: `yarn`
- Build: `yarn build`
- Start MCP server: `yarn start`
- Start with inspector: `yarn start:dev`
