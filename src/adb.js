/**
 * ADB subprocess wrapper.
 * All calls use spawn without shell=true to prevent injection.
 */
import { spawn } from 'child_process';

/**
 * Runs an adb command and returns stdout as a string.
 * @param {string} adbPath - path to the adb binary
 * @param {string[]} args  - command arguments (NO shell interpolation)
 * @returns {Promise<string>}
 */
export function adbRun(adbPath, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(adbPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    const errChunks = [];
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => errChunks.push(d));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString('utf8'));
      } else {
        const stderr = Buffer.concat(errChunks).toString('utf8');
        reject(new Error(`ADB command failed (exit ${code}): ${stderr.trim()}`));
      }
    });
    proc.on('error', (err) => reject(new Error(`Failed to spawn adb: ${err.message}`)));
  });
}

/**
 * Runs adb exec-out and returns raw bytes (for screenshots).
 */
export function adbRunBinary(adbPath, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(adbPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    const errChunks = [];
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => errChunks.push(d));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        const stderr = Buffer.concat(errChunks).toString('utf8');
        reject(new Error(`ADB command failed (exit ${code}): ${stderr.trim()}`));
      }
    });
    proc.on('error', (err) => reject(new Error(`Failed to spawn adb: ${err.message}`)));
  });
}

// ── Device discovery ──────────────────────────────────────────────────────────

/**
 * Returns list of currently online device serials.
 * @param {string} adbPath
 * @returns {Promise<string[]>}
 */
export async function listDevices(adbPath) {
  const output = await adbRun(adbPath, ['devices']);
  const lines = output.split('\n');
  const serials = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('List of devices')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2 && parts[1] === 'device') {
      serials.push(parts[0]);
    }
  }
  return serials;
}

/**
 * Returns installed package names from pm list packages.
 * @param {string} adbPath
 * @param {string} serial
 * @returns {Promise<string[]>}
 */
export async function listInstalledPackages(adbPath, serial) {
  validateSerial(serial);
  const output = await adbRun(adbPath, ['-s', serial, 'shell', 'pm', 'list', 'packages']);
  const lines = output.split('\n');
  const packages = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('package:')) {
      packages.push(trimmed.slice('package:'.length));
    }
  }
  return packages;
}

// ── Screenshot ────────────────────────────────────────────────────────────────

/**
 * Takes a screenshot and returns raw PNG bytes.
 * Uses exec-out so no temp file is written on device.
 * @param {string} adbPath
 * @param {string} serial
 * @returns {Promise<Buffer>}
 */
export async function screenshot(adbPath, serial) {
  validateSerial(serial);
  const bytes = await adbRunBinary(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p']);
  return bytes;
}

// ── UI hierarchy dump ─────────────────────────────────────────────────────────

/**
 * Dumps UIAutomator hierarchy and returns the raw XML string.
 * Tries /dev/tty first, falls back to file-based dump.
 * @param {string} adbPath
 * @param {string} serial
 * @param {string} devicePath - temp file path on device (fallback)
 * @returns {Promise<string>}
 */
export async function uiDump(adbPath, serial, devicePath = '/sdcard/window_dump.xml') {
  validateSerial(serial);
  try {
    const xml = await adbRun(adbPath, ['-s', serial, 'shell', 'uiautomator', 'dump', '/dev/tty']);
    if (xml.includes('<hierarchy')) return xml;
  } catch (_) {
    // fall through to file-based approach
  }
  // Fallback
  await adbRun(adbPath, ['-s', serial, 'shell', 'uiautomator', 'dump', devicePath]);
  const xml = await adbRun(adbPath, ['-s', serial, 'shell', 'cat', devicePath]);
  return xml;
}

// ── Actions ───────────────────────────────────────────────────────────────────

/**
 * Taps the centroid of bounds [x1, y1, x2, y2].
 */
export async function tapBounds(adbPath, serial, bounds) {
  validateSerial(serial);
  const cx = Math.floor((bounds[0] + bounds[2]) / 2);
  const cy = Math.floor((bounds[1] + bounds[3]) / 2);
  await adbRun(adbPath, ['-s', serial, 'shell', 'input', 'tap', String(cx), String(cy)]);
}

/**
 * Taps an absolute point.
 */
export async function tapPoint(adbPath, serial, x, y) {
  validateSerial(serial);
  await adbRun(adbPath, ['-s', serial, 'shell', 'input', 'tap', String(x), String(y)]);
}

/**
 * Double-taps by sending two rapid taps.
 */
export async function doubleTapPoint(adbPath, serial, x, y) {
  validateSerial(serial);
  await adbRun(adbPath, ['-s', serial, 'shell', 'input', 'tap', String(x), String(y)]);
  await new Promise((r) => setTimeout(r, 80));
  await adbRun(adbPath, ['-s', serial, 'shell', 'input', 'tap', String(x), String(y)]);
}

/**
 * Types text via ADB. Text is passed as a literal arg (no shell injection).
 * Note: ADB input text treats %s as space on some ROMs; we replace spaces
 * with %s to handle both old and new ROMs.
 */
export async function typeText(adbPath, serial, text) {
  validateSerial(serial);
  // adb shell input text <arg> splits on spaces at the device shell level,
  // causing only the first word to be typed. Passing a single quoted shell
  // command string avoids this. Single quotes inside text are escaped with
  // the POSIX '\'' technique.
  const escaped = text.replace(/'/g, `'\\''`);
  await adbRun(adbPath, ['-s', serial, 'shell', `input text '${escaped}'`]);
}

/**
 * Swipes from (x1,y1) to (x2,y2).
 */
export async function swipe(adbPath, serial, x1, y1, x2, y2, durationMs = 300) {
  validateSerial(serial);
  await adbRun(adbPath, [
    '-s', serial, 'shell', 'input', 'swipe',
    String(x1), String(y1), String(x2), String(y2), String(durationMs),
  ]);
}

/**
 * Directional swipe on the screen with sensible defaults.
 * direction: 'up' | 'down' | 'left' | 'right'
 */
export async function swipeDirection(adbPath, serial, direction, screenW = 1080, screenH = 1920) {
  const top = Math.round(screenH * 0.15);
  const bottom = Math.round(screenH * 0.85);
  const left = Math.round(screenW * 0.15);
  const right = Math.round(screenW * 0.85);
  const midX = Math.floor(screenW / 2);
  const midY = Math.floor(screenH / 2);

  switch (direction.toLowerCase()) {
    case 'down':
    case 'scroll_down':
      return swipe(adbPath, serial, midX, bottom, midX, top);
    case 'up':
    case 'scroll_up':
      return swipe(adbPath, serial, midX, top, midX, bottom);
    case 'left':
    case 'scroll_left':
      return swipe(adbPath, serial, right, midY, left, midY);
    case 'right':
    case 'scroll_right':
      return swipe(adbPath, serial, left, midY, right, midY);
    default:
      throw new Error(`Unknown swipe direction: "${direction}". Use up|down|left|right.`);
  }
}

/**
 * Presses a key by name or numeric keycode.
 * name: back | home | recent | enter | search | menu | delete | <number>
 */
export async function pressKey(adbPath, serial, key) {
  validateSerial(serial);
  const keyMap = {
    back: 4,
    home: 3,
    recent: 187,
    recents: 187,
    app_switch: 187,
    enter: 66,
    search: 84,
    menu: 82,
    delete: 67,
    backspace: 67,
    escape: 111,
    power: 26,
    volume_up: 24,
    volume_down: 25,
    camera: 27,
    zoom_in: 168,
    zoom_out: 169,
  };
  const lower = key.trim().toLowerCase();
  const code = keyMap[lower] ?? parseInt(lower, 10);
  if (Number.isNaN(code)) {
    throw new Error(`Unknown key "${key}". Use back|home|recent|enter|search|menu|delete|<numeric keycode>.`);
  }
  await adbRun(adbPath, ['-s', serial, 'shell', 'input', 'keyevent', String(code)]);
}

/**
 * Launches an app by Android package name.
 */
export async function launchApp(adbPath, serial, packageName) {
  validateSerial(serial);
  if (!isValidPackageName(packageName)) {
    throw new Error(`Invalid package name: "${packageName}"`);
  }
  await adbRun(adbPath, [
    '-s', serial, 'shell', 'monkey',
    '-p', packageName,
    '-c', 'android.intent.category.LAUNCHER', '1',
  ]);
}

/**
 * Opens a URL via Android intent.
 */
export async function openUrl(adbPath, serial, url) {
  validateSerial(serial);
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error(`URL must start with http:// or https://`);
  }
  await adbRun(adbPath, [
    '-s', serial, 'shell', 'am', 'start',
    '-a', 'android.intent.action.VIEW',
    '-d', url,
  ]);
}

/**
 * Rotates device (0=portrait, 1=landscape, 2=reverse portrait, 3=reverse landscape).
 */
export async function rotate(adbPath, serial, rotation) {
  validateSerial(serial);
  const r = Math.max(0, Math.min(3, Math.floor(rotation)));
  await adbRun(adbPath, ['-s', serial, 'shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0']);
  await adbRun(adbPath, ['-s', serial, 'shell', 'settings', 'put', 'system', 'user_rotation', String(r)]);
}

// ── Foreground app ────────────────────────────────────────────────────────────

/**
 * Returns the current foreground app info by parsing `dumpsys window`.
 * @param {string} adbPath
 * @param {string} serial
 * @returns {Promise<{currentFocus: string|null, focusedApp: string|null}>}
 */
export async function getForegroundApp(adbPath, serial) {
  validateSerial(serial);
  const output = await adbRun(adbPath, ['-s', serial, 'shell', 'dumpsys', 'window']);
  let currentFocus = null;
  let focusedApp = null;
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('mCurrentFocus')) currentFocus = trimmed;
    else if (trimmed.startsWith('mFocusedApp')) focusedApp = trimmed;
  }
  return { currentFocus, focusedApp };
}

// ── Wireless ADB (TCP/IP) ────────────────────────────────────────────────────

/**
 * Enables TCP/IP mode on a USB-connected device so it can be connected wirelessly.
 * Must be called while the device is still on USB.
 * @param {string} adbPath
 * @param {string} serial - USB-connected device serial
 * @param {number} port   - TCP port to listen on (default 5555)
 */
export async function adbTcpip(adbPath, serial, port = 5555) {
  validateSerial(serial);
  const p = Math.max(1, Math.min(65535, Math.floor(port)));
  await adbRun(adbPath, ['-s', serial, 'tcpip', String(p)]);
}

/**
 * Gets the device's network interfaces and IP addresses by parsing `adb shell ip route`.
 * Returns an array of { iface, network, ip } objects, one per route entry.
 * @param {string} adbPath
 * @param {string} serial
 * @returns {Promise<Array<{iface: string, network: string, ip: string}>>}
 */
export async function getDeviceIp(adbPath, serial) {
  validateSerial(serial);
  const output = await adbRun(adbPath, ['-s', serial, 'shell', 'ip', 'route']);
  const results = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Example: "192.168.101.0/24 dev wlan0 proto kernel scope link src 192.168.101.7"
    const ifaceMatch = trimmed.match(/dev\s+(\S+)/);
    const srcMatch   = trimmed.match(/src\s+(\d+\.\d+\.\d+\.\d+)/);
    const netMatch   = trimmed.match(/^(\S+)/);
    if (ifaceMatch && srcMatch) {
      results.push({
        iface:   ifaceMatch[1],
        network: netMatch ? netMatch[1] : '',
        ip:      srcMatch[1],
      });
    }
  }
  return results;
}

/**
 * Connects to a device over TCP/IP (wireless ADB).
 * @param {string} adbPath
 * @param {string} ip
 * @param {number} port - default 5555
 * @returns {Promise<string>} raw adb connect output
 */
export async function adbConnect(adbPath, ip, port = 5555) {
  if (!isValidIp(ip)) throw new Error(`Invalid IP address: "${ip}"`);
  const p = Math.max(1, Math.min(65535, Math.floor(port)));
  const output = await adbRun(adbPath, ['connect', `${ip}:${p}`]);
  return output.trim();
}

/**
 * Disconnects a TCP/IP ADB target (or all TCP/IP devices if target omitted).
 * @param {string} adbPath
 * @param {string} [target] - "ip:port" or omit to disconnect all
 * @returns {Promise<string>}
 */
export async function adbDisconnect(adbPath, target) {
  const args = (target && target.trim()) ? ['disconnect', target.trim()] : ['disconnect'];
  const output = await adbRun(adbPath, args);
  return output.trim();
}

// ── App control (extended) ────────────────────────────────────────────────────

/**
 * Force-stops an app by package name.
 */
export async function forceStopApp(adbPath, serial, packageName) {
  validateSerial(serial);
  if (!isValidPackageName(packageName)) throw new Error(`Invalid package name: "${packageName}"`);
  await adbRun(adbPath, ['-s', serial, 'shell', 'am', 'force-stop', packageName]);
}

/**
 * Returns true if a package is installed on the device.
 * @returns {Promise<boolean>}
 */
export async function isAppInstalled(adbPath, serial, packageName) {
  validateSerial(serial);
  if (!isValidPackageName(packageName)) throw new Error(`Invalid package name: "${packageName}"`);
  // Pass packageName as filter arg to pm list packages to reduce output
  const output = await adbRun(adbPath, ['-s', serial, 'shell', 'pm', 'list', 'packages', packageName]);
  return output.split('\n').some((line) => line.trim() === `package:${packageName}`);
}

// ── Screen info ───────────────────────────────────────────────────────────────

/**
 * Returns the physical screen size as { width, height } by parsing `wm size`.
 */
export async function getScreenSize(adbPath, serial) {
  validateSerial(serial);
  const output = await adbRun(adbPath, ['-s', serial, 'shell', 'wm', 'size']);
  const m = output.match(/(\d+)x(\d+)/);
  if (!m) throw new Error(`Could not parse screen size from: ${output.trim()}`);
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

/**
 * Returns the raw UIAutomator XML string.
 * Alias for uiDump — useful when the caller wants unparsed XML.
 */
export async function getRawUiXml(adbPath, serial, devicePath = '/sdcard/window_dump.xml') {
  return uiDump(adbPath, serial, devicePath);
}

// ── Smart input ───────────────────────────────────────────────────────────────

/**
 * Selects all text in the focused field and replaces it with new text.
 * Sends CTRL+A (select all) → DEL (delete selection) → input text.
 */
export async function clearInputAndType(adbPath, serial, text) {
  validateSerial(serial);
  await adbRun(adbPath, ['-s', serial, 'shell', 'input', 'keyevent', '277']); // KEYCODE_CTRL_A
  await adbRun(adbPath, ['-s', serial, 'shell', 'input', 'keyevent', '67']);  // KEYCODE_DEL
  const escaped = text.replace(/'/g, `'\\''`);
  await adbRun(adbPath, ['-s', serial, 'shell', `input text '${escaped}'`]);
}

// ── Navigation shortcuts ──────────────────────────────────────────────────────

/**
 * Opens the notification shade.
 * Uses cmd statusbar (API 28+) with swipe fallback for older devices.
 */
export async function openNotifications(adbPath, serial) {
  validateSerial(serial);
  try {
    await adbRun(adbPath, ['-s', serial, 'shell', 'cmd', 'statusbar', 'expand-notifications']);
  } catch {
    const size = await getScreenSize(adbPath, serial).catch(() => ({ width: 1080, height: 1920 }));
    await swipe(adbPath, serial, Math.floor(size.width / 2), 0, Math.floor(size.width / 2), Math.floor(size.height * 0.5), 400);
  }
}

// ── Device info ───────────────────────────────────────────────────────────────

/**
 * Returns comprehensive device hardware and system information.
 * Batches multiple ADB shell calls for efficiency.
 * @param {string} adbPath
 * @param {string} serial
 * @returns {Promise<object>}
 */
export async function getDeviceInfo(adbPath, serial) {
  validateSerial(serial);

  // Helper: run a single getprop and return trimmed value (never throws)
  const prop = async (key) => {
    try {
      const v = await adbRun(adbPath, ['-s', serial, 'shell', 'getprop', key]);
      return v.trim();
    } catch { return null; }
  };

  // Helper: run a shell command and return trimmed output (never throws)
  const shell = async (...cmd) => {
    try {
      const v = await adbRun(adbPath, ['-s', serial, 'shell', ...cmd]);
      return v.trim();
    } catch { return null; }
  };

  // ── Hardware / identity (parallel batch) ──────────────────────────────────
  const [
    model, brand, manufacturer, device, boardPlatform,
    androidVersion, sdkVersion, buildId, buildType, buildFingerprint,
    serialNo, abi,
  ] = await Promise.all([
    prop('ro.product.model'),
    prop('ro.product.brand'),
    prop('ro.product.manufacturer'),
    prop('ro.product.device'),
    prop('ro.board.platform'),
    prop('ro.build.version.release'),
    prop('ro.build.version.sdk'),
    prop('ro.build.display.id'),
    prop('ro.build.type'),
    prop('ro.build.fingerprint'),
    prop('ro.serialno'),
    prop('ro.product.cpu.abi'),
  ]);

  // ── Screen ────────────────────────────────────────────────────────────────
  const [wmSize, wmDensity] = await Promise.all([
    shell('wm', 'size'),
    shell('wm', 'density'),
  ]);
  const sizeMatch = wmSize ? wmSize.match(/(\d+)x(\d+)/) : null;
  const densityMatch = wmDensity ? wmDensity.match(/(\d+)/) : null;

  // ── Battery ───────────────────────────────────────────────────────────────
  const batteryRaw = await shell('dumpsys', 'battery');
  const battery = {};
  if (batteryRaw) {
    for (const line of batteryRaw.split('\n')) {
      const m = line.match(/^\s*([^:]+):\s*(.+)$/);
      if (m) battery[m[1].trim()] = m[2].trim();
    }
  }

  // ── Memory ────────────────────────────────────────────────────────────────
  const memRaw = await shell('cat', '/proc/meminfo');
  const mem = {};
  if (memRaw) {
    for (const line of memRaw.split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)\s*kB/);
      if (m) mem[m[1]] = parseInt(m[2], 10) * 1024; // bytes
    }
  }

  // ── Storage ───────────────────────────────────────────────────────────────
  const parseDF = (raw) => {
    if (!raw) return null;
    const lines = raw.split('\n').filter((l) => l.trim() && !l.startsWith('Filesystem'));
    const out = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 6) {
        out.push({
          filesystem: parts[0],
          size_bytes: parseDfSize(parts[1]),
          used_bytes: parseDfSize(parts[2]),
          avail_bytes: parseDfSize(parts[3]),
          mount: parts[5],
        });
      }
    }
    return out.length ? out : null;
  };

  const [dfData, dfSdcard] = await Promise.all([
    shell('df', '/data'),
    shell('df', '/sdcard'),
  ]);

  // ── Network interfaces ────────────────────────────────────────────────────
  const ipRoute = await shell('ip', 'route');
  const ifaces = [];
  if (ipRoute) {
    for (const line of ipRoute.split('\n')) {
      const t = line.trim();
      const ifaceM = t.match(/dev\s+(\S+)/);
      const srcM   = t.match(/src\s+(\d+\.\d+\.\d+\.\d+)/);
      const netM   = t.match(/^(\S+)/);
      if (ifaceM && srcM) {
        ifaces.push({ iface: ifaceM[1], network: netM ? netM[1] : '', ip: srcM[1] });
      }
    }
  }

  // ── Assemble result ───────────────────────────────────────────────────────
  return {
    device: {
      model,
      brand,
      manufacturer,
      device,
      board_platform: boardPlatform,
      serial: serialNo,
      cpu_abi: abi,
    },
    software: {
      android_version: androidVersion,
      sdk_level: sdkVersion ? parseInt(sdkVersion, 10) : null,
      build_id: buildId,
      build_type: buildType,
      build_fingerprint: buildFingerprint,
    },
    screen: {
      width: sizeMatch ? parseInt(sizeMatch[1], 10) : null,
      height: sizeMatch ? parseInt(sizeMatch[2], 10) : null,
      density_dpi: densityMatch ? parseInt(densityMatch[1], 10) : null,
    },
    battery: {
      level: battery['level'] ? parseInt(battery['level'], 10) : null,
      status: battery['status'] ?? null,
      health: battery['health'] ?? null,
      plugged: battery['plugged'] ?? null,
      voltage_mv: battery['voltage'] ? parseInt(battery['voltage'], 10) : null,
      temperature_c: battery['temperature'] ? (parseInt(battery['temperature'], 10) / 10) : null,
      technology: battery['technology'] ?? null,
    },
    memory: {
      total_bytes: mem['MemTotal'] ?? null,
      free_bytes: mem['MemFree'] ?? null,
      available_bytes: mem['MemAvailable'] ?? null,
      cached_bytes: mem['Cached'] ?? null,
    },
    storage: [
      ...(parseDF(dfData) ?? []),
      ...(parseDF(dfSdcard) ?? []),
    ],
    network_interfaces: ifaces,
  };
}

/** Parses df size strings like "10G", "512M", "1024K", "4096" → bytes. */
function parseDfSize(str) {
  if (!str) return null;
  const m = str.match(/^(\d+(?:\.\d+)?)([KMGTP]?)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 };
  return Math.round(n * (mult[unit] ?? 1));
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Guards against path traversal / injection via serial.
 * A valid ADB serial is: alphanumeric, colon, dash, underscore, dot, port.
 */
function validateSerial(serial) {
  if (!serial || !/^[A-Za-z0-9:.\.\-_]+$/.test(serial)) {
    throw new Error(`Invalid device serial: "${serial}"`);
  }
}

/**
 * Validates an Android package name (reverse-DNS format).
 */
function isValidPackageName(pkg) {
  return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(pkg);
}

/**
 * Validates an IPv4 address.
 */
function isValidIp(ip) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) &&
    ip.split('.').every((o) => parseInt(o, 10) <= 255);
}
