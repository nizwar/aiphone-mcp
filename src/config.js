/**
 * Config loader — reads app_config.json, personas.json, device_config.json.
 *
 * Config directory resolution order:
 *   1. --config-dir CLI argument
 *   2. AIPHONE_CONFIG_DIR environment variable
 *   3. <package-root>/../config  (default: mcp/../config = project root config/)
 */
import { readFileSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve the config directory from CLI args or env. */
export function resolveConfigDir() {
  // 1. --config-dir flag
  const flagIdx = process.argv.indexOf('--config-dir');
  if (flagIdx !== -1 && process.argv[flagIdx + 1]) {
    return resolve(process.argv[flagIdx + 1]);
  }
  // 2. AIPHONE_CONFIG_DIR env var
  if (process.env.AIPHONE_CONFIG_DIR) {
    return resolve(process.env.AIPHONE_CONFIG_DIR);
  }
  // 3. Default: mcp/src/../../config → project_root/config
  return resolve(__dirname, '..', '..', 'config');
}

export function resolveAdbPath() {
  return process.env.AIPHONE_ADB_PATH || 'adb';
}

/** Loads and returns parsed app_config.json. Returns null if not found. */
export function loadAppConfig(configDir) {
  const path = join(configDir, 'app_config.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Loads and returns the personas array. Returns [] if not found. */
export function loadPersonas(configDir) {
  const path = join(configDir, 'personas.json');
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return raw.personas ?? [];
}

/** Loads and returns the device configs array. Returns [] if not found. */
export function loadDeviceConfigs(configDir) {
  const path = join(configDir, 'device_config.json');
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return raw.devices ?? [];
}
