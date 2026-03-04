import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PocketClusterState, WorkflowPhase } from '../types/index.js';

const STATE_DIR_NAME = '.pocket-cluster';
const STATE_FILE_NAME = 'state.json';
const GITIGNORE_COMMENT = '# Pocket Cluster configuration and data files';
const GITIGNORE_ENTRY = `${STATE_DIR_NAME}/`;

type StatePaths = {
  stateDirPath: string;
  stateFilePath: string;
  gitignorePath: string;
};

function getPaths(projectRoot: string): StatePaths {
  return {
    stateDirPath: join(projectRoot, STATE_DIR_NAME),
    stateFilePath: join(projectRoot, STATE_DIR_NAME, STATE_FILE_NAME),
    gitignorePath: join(projectRoot, '.gitignore'),
  };
}

function getDefaultState(projectRoot: string): PocketClusterState {
  const timestamp = new Date().toISOString();
  return {
    projectRoot,
    createdAt: timestamp,
    updatedAt: timestamp,
    phase: 'initialized',
    provider: 'hetzner',
    credentialsVerified: false,
  };
}

function ensureGitignoreEntry(projectRoot: string): void {
  const { gitignorePath } = getPaths(projectRoot);
  const sectionBlock = `${GITIGNORE_COMMENT}\n${GITIGNORE_ENTRY}\n`;

  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, sectionBlock, 'utf8');
    return;
  }

  const existingContent = readFileSync(gitignorePath, 'utf8');
  const trimmedLines = existingContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const entries = new Set(trimmedLines);

  const hasEntry = entries.has(GITIGNORE_ENTRY);
  const hasComment = entries.has(GITIGNORE_COMMENT);

  if (hasEntry && hasComment) {
    return;
  }

  if (hasEntry && !hasComment) {
    const lines = existingContent.split(/\r?\n/);
    const entryIndex = lines.findIndex((line) => line.trim() === GITIGNORE_ENTRY);

    if (entryIndex >= 0) {
      lines.splice(entryIndex, 0, GITIGNORE_COMMENT);
      const withComment = lines.join('\n');
      const normalized = withComment.endsWith('\n') ? withComment : `${withComment}\n`;
      writeFileSync(gitignorePath, normalized, 'utf8');
      return;
    }

    const normalized = `${existingContent}${existingContent.endsWith('\n') || existingContent.length === 0 ? '' : '\n'}`;
    writeFileSync(gitignorePath, `${normalized}${sectionBlock}`, 'utf8');
    return;
  }

  const separator = existingContent.endsWith('\n\n') || existingContent.length === 0 ? '' : '\n';
  writeFileSync(gitignorePath, `${existingContent}${separator}${sectionBlock}`, 'utf8');
}

function ensureStateDir(projectRoot: string): StatePaths {
  const paths = getPaths(projectRoot);

  if (!existsSync(paths.stateDirPath)) {
    mkdirSync(paths.stateDirPath, { recursive: true });
  }

  ensureGitignoreEntry(projectRoot);
  return paths;
}

/**
 * Check whether a state file already exists for the given project.
 */
export function stateFileExists(projectRoot: string): boolean {
  const { stateFilePath } = getPaths(projectRoot);
  return existsSync(stateFilePath);
}

/**
 * Read state from disk. Returns `null` if no state file exists (does NOT auto-create).
 */
export function readStateOrNull(projectRoot: string): PocketClusterState | null {
  const { stateFilePath } = getPaths(projectRoot);
  if (!existsSync(stateFilePath)) {
    return null;
  }

  const raw = readFileSync(stateFilePath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<PocketClusterState>;

  return {
    ...getDefaultState(projectRoot),
    ...parsed,
    projectRoot,
  };
}

/**
 * Create a fresh state file, overwriting any existing one.
 */
export function createFreshState(projectRoot: string): PocketClusterState {
  ensureStateDir(projectRoot);
  const state = getDefaultState(projectRoot);
  writeStateToDisk(state, projectRoot);
  return state;
}

/**
 * Reset state to initial values while preserving timestamps.
 */
export function resetState(projectRoot: string): PocketClusterState {
  const existing = readStateOrNull(projectRoot);
  const state: PocketClusterState = {
    ...getDefaultState(projectRoot),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  writeStateToDisk(state, projectRoot);
  return state;
}

/**
 * Write the state object to disk.
 */
export function writeStateToDisk(state: PocketClusterState, projectRoot: string): void {
  ensureStateDir(projectRoot);
  const { stateFilePath } = getPaths(projectRoot);
  const nextState: PocketClusterState = {
    ...state,
    projectRoot,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(stateFilePath, JSON.stringify(nextState, null, 2), 'utf8');
}

/**
 * Update a specific phase and write to disk.
 */
export function updatePhase(
  projectRoot: string,
  phase: WorkflowPhase,
  patch?: Partial<PocketClusterState>,
): PocketClusterState {
  const state = readStateOrNull(projectRoot);
  if (!state) {
    throw new Error('Cannot update phase: state file does not exist. Call initialize first.');
  }

  const nextState: PocketClusterState = {
    ...state,
    ...patch,
    phase,
    projectRoot,
  };

  writeStateToDisk(nextState, projectRoot);
  return nextState;
}

/**
 * Determine what the next action should be based on current phase.
 */
export function getNextActionForPhase(phase: WorkflowPhase): { nextAction: string; description: string } {
  switch (phase) {
    case 'uninitialized':
      return {
        nextAction: 'initialize',
        description: 'Initialize the PocketCluster state by calling manage_cluster with action "initialize".',
      };
    case 'initialized':
      return {
        nextAction: 'check_cloud',
        description:
          'Check Hetzner API credentials and fetch available locations. Call manage_cluster with action "check_cloud".',
      };
    case 'cloud_checked':
      return {
        nextAction: 'set_requirements',
        description:
          'Ask the user about their MongoDB requirements (estimated data size in GB, expected workload intensity, and desired location from the list provided) and call manage_cluster with action "set_requirements".',
      };
    case 'requirements_set':
      return {
        nextAction: 'approve_recommendation',
        description:
          'Present the server recommendation and pricing to the user. If they approve, call manage_cluster with action "approve_recommendation".',
      };
    case 'recommendation_approved':
      return {
        nextAction: 'configure_ssh',
        description:
          'SSH keys from Hetzner are listed above. Present them to the user, ask which to use and whether to generate a new one, then call manage_cluster with action "configure_ssh".',
      };
    case 'ssh_configured':
      return {
        nextAction: 'configure_network',
        description:
          'Network configuration step. Present the available private networks and image info shown above. Help the user decide whether to create a new private network or use an existing one (or skip). Then call manage_cluster with action "configure_network".',
      };
    case 'network_configured':
      return {
        nextAction: 'provision',
        description:
          'All configuration is complete. Present the provisioning plan review to the user. If they approve, call manage_cluster with action "provision" to create all resources. If they want to adjust, they can go back to any previous step.',
      };
    case 'ready_to_provision':
      return {
        nextAction: 'provision',
        description:
          'Infrastructure is ready to be provisioned. Call manage_cluster with action "provision" to create all resources.',
      };
    case 'provisioning':
      return {
        nextAction: 'provision',
        description: 'Provisioning is in progress. If it failed, call "provision" again to retry.',
      };
    case 'provisioned':
      return {
        nextAction: 'done',
        description: 'Infrastructure has been provisioned successfully. The server is ready for use.',
      };
  }
}
