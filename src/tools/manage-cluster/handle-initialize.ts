import {
  createFreshState,
  getNextActionForPhase,
  readStateOrNull,
  resetState,
  stateFileExists,
} from '../../state/manager.js';
import { ToolResponse } from '../../types/index.js';
import { sanitizeStateForOutput } from './helpers.js';

// ── Step 1: Initialize ──────────────────────────────────────────────────────

export function handleInitialize(projectRoot: string, continueExisting?: boolean): ToolResponse {
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
