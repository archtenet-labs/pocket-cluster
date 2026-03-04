import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import sshpk from 'sshpk';

const SSH_DIR_NAME = 'ssh';
const PRIVATE_KEY_FILE = 'pocket_cluster_ed25519';
const PUBLIC_KEY_FILE = `${PRIVATE_KEY_FILE}.pub`;

export type GeneratedKeyPair = {
  /** Absolute path to the private key file */
  privateKeyPath: string;
  /** Absolute path to the public key file */
  publicKeyPath: string;
  /** Public key in OpenSSH format (ssh-ed25519 AAAA...) */
  publicKeyOpenSsh: string;
  /** SHA-256 fingerprint */
  fingerprint: string;
};

/**
 * Get the SSH directory path inside .pocket-cluster.
 */
function getSshDir(projectRoot: string): string {
  return join(projectRoot, '.pocket-cluster', SSH_DIR_NAME);
}

/**
 * Check whether a generated key pair already exists locally.
 */
export function localKeyPairExists(projectRoot: string): boolean {
  const sshDir = getSshDir(projectRoot);
  return existsSync(join(sshDir, PRIVATE_KEY_FILE)) && existsSync(join(sshDir, PUBLIC_KEY_FILE));
}

/**
 * Read the existing local public key in OpenSSH format.
 * Returns null if the key doesn't exist.
 */
export function readLocalPublicKey(projectRoot: string): string | null {
  const pubPath = join(getSshDir(projectRoot), PUBLIC_KEY_FILE);
  if (!existsSync(pubPath)) return null;
  return readFileSync(pubPath, 'utf8').trim();
}

/**
 * Generate a new ed25519 SSH key pair and save it to .pocket-cluster/ssh/.
 *
 * - Private key: .pocket-cluster/ssh/pocket_cluster_ed25519
 * - Public key:  .pocket-cluster/ssh/pocket_cluster_ed25519.pub
 *
 * Returns paths and the public key in OpenSSH format for uploading to Hetzner.
 */
export function generateSshKeyPair(projectRoot: string, comment?: string): GeneratedKeyPair {
  const sshDir = getSshDir(projectRoot);

  // Ensure the directory exists
  if (!existsSync(sshDir)) {
    mkdirSync(sshDir, { recursive: true });
  }

  const privateKeyPath = join(sshDir, PRIVATE_KEY_FILE);
  const publicKeyPath = join(sshDir, PUBLIC_KEY_FILE);

  // Don't overwrite existing keys
  if (existsSync(privateKeyPath)) {
    throw new Error(`SSH key already exists at ${privateKeyPath}. Delete it manually if you want to regenerate.`);
  }

  // Generate ed25519 key pair using sshpk
  const key = sshpk.generatePrivateKey('ed25519');
  if (comment) {
    key.comment = comment;
  }

  const privateKeyStr = key.toString('ssh');
  const publicKeyStr = key.toPublic().toString('ssh');
  const fingerprint = key.fingerprint('sha256').toString();

  // Write private key with restrictive permissions (600)
  writeFileSync(privateKeyPath, privateKeyStr, { encoding: 'utf8', mode: 0o600 });
  // Ensure permissions are set even if writeFileSync doesn't honor mode on some systems
  chmodSync(privateKeyPath, 0o600);

  // Write public key
  writeFileSync(publicKeyPath, publicKeyStr + '\n', 'utf8');

  return {
    privateKeyPath,
    publicKeyPath,
    publicKeyOpenSsh: publicKeyStr,
    fingerprint,
  };
}

/**
 * Get the relative path from project root to the private key file.
 */
export function getRelativePrivateKeyPath(): string {
  return join('.pocket-cluster', SSH_DIR_NAME, PRIVATE_KEY_FILE);
}
