/**
 * aiphone-mcp — MCP server for AI-powered Android device control.
 *
 * Exposes MCP tools that mirror the Dart lib/ implementation so an LLM
 * in LM Studio (or any MCP host) can directly control Android devices via ADB.
 *
 * Usage (LM Studio config):
 *   "aiphone": { "command": "npx", "args": ["aiphone-mcp"] }
 *
 * Optional env vars:
 *   AIPHONE_CONFIG_DIR  – path to the config/ folder (default: ../config)
 *   AIPHONE_ADB_PATH    – path to adb binary      (default: adb)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import * as adbClient from './adb.js';
import { parseUiXml, compactElements, findElement } from './uiparser.js';
import { processScreenshot, mimeType } from './image.js';
import {
  resolveConfigDir,
  resolveAdbPath,
  loadAppConfig,
  loadDeviceConfigs,
} from './config.js';

// ── Bootstrap ────────────────────────────────────────────────────────────────

const CONFIG_DIR = resolveConfigDir();
const ADB_PATH = resolveAdbPath();

const server = new Server(
  { name: 'aiphone-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

// ── Tool definitions ─────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ── Device discovery ────────────────────────────────────────────────────
    {
      name: 'list_devices',
      description:
        'Lists all currently connected and online ADB Android device serials. ' +
        'Call this first to discover which devices are available.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },

    // ── Screen observation ──────────────────────────────────────────────────
    {
      name: 'take_screenshot',
      description:
        'PREFERRED for any visual task. ' +
        'Takes a screenshot of the device screen and returns it as an optimized image you can see directly. ' +
        'Use this FIRST when you need to: observe the current screen, verify an action worked, ' +
        'read on-screen text or images, detect UI state, or understand layout. ' +
        'Supports resizing (max_width / max_height) and format conversion (webp, jpeg, png). ' +
        'Defaults to WebP 75% quality — best size/quality for vision. ' +
        'DO NOT rely solely on get_ui_elements for visual understanding — always take a screenshot when sight matters.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: {
            type: 'string',
            description: 'ADB device serial (from list_devices).',
          },
          max_width: {
            type: 'integer',
            description: 'Maximum output width in pixels. Image is scaled down proportionally. Default 1080.',
            default: 1080,
          },
          max_height: {
            type: 'integer',
            description: 'Maximum output height in pixels. Image is scaled down proportionally. Default 1920.',
            default: 1920,
          },
          format: {
            type: 'string',
            enum: ['webp', 'jpeg', 'png'],
            description: 'Output image format. webp = smallest, png = lossless. Default webp.',
            default: 'webp',
          },
          quality: {
            type: 'integer',
            description: 'Compression quality 1–100 (not used for png). Default 75.',
            default: 75,
          },
        },
        required: ['device_id'],
      },
    },
    {
      name: 'get_ui_elements',
      description:
        'Returns a structured list of interactive UI elements (id, text, content_desc, bounds, clickable flag). ' +
        'Use this to get tap targets and element coordinates — NOT as a substitute for visual observation. ' +
        'For understanding what is on screen visually, call take_screenshot first. ' +
        'Best used AFTER take_screenshot to find the exact bounds of an element you want to interact with.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: {
            type: 'string',
            description: 'ADB device serial (from list_devices).',
          },
          limit: {
            type: 'integer',
            description: 'Max number of elements to return (default 30, max 150). Prioritises clickable elements.',
            default: 30,
          },
        },
        required: ['device_id'],
      },
    },

    // ── Touch actions ───────────────────────────────────────────────────────
    {
      name: 'tap',
      description:
        'Taps the device screen at absolute coordinates (x, y). ' +
        'Obtain x,y from the center of an element\'s bounds returned by get_ui_elements.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          x: { type: 'integer', description: 'X coordinate in device pixels.' },
          y: { type: 'integer', description: 'Y coordinate in device pixels.' },
        },
        required: ['device_id', 'x', 'y'],
      },
    },
    {
      name: 'double_tap',
      description: 'Double-taps the device screen at absolute coordinates (x, y).',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          x: { type: 'integer', description: 'X coordinate.' },
          y: { type: 'integer', description: 'Y coordinate.' },
        },
        required: ['device_id', 'x', 'y'],
      },
    },
    {
      name: 'tap_element',
      description:
        'Taps the center of a UI element identified by its bounds [x1, y1, x2, y2] from get_ui_elements.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          bounds: {
            type: 'array',
            items: { type: 'integer' },
            minItems: 4,
            maxItems: 4,
            description: 'Element bounds as [x1, y1, x2, y2].',
          },
        },
        required: ['device_id', 'bounds'],
      },
    },

    // ── Text input ──────────────────────────────────────────────────────────
    {
      name: 'type_text',
      description:
        'Types text into the currently focused input field via ADB. ' +
        'Tap the target field first to focus it, then call this tool.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          text: { type: 'string', description: 'Text to type.' },
        },
        required: ['device_id', 'text'],
      },
    },

    // ── Swipe / scroll ──────────────────────────────────────────────────────
    {
      name: 'swipe',
      description:
        'Performs a swipe gesture. Use directional shortcuts (up/down/left/right) for ' +
        'scrolling, or provide explicit coordinates for custom swipes.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          direction: {
            type: 'string',
            enum: ['up', 'down', 'left', 'right'],
            description: 'Directional swipe shortcut. Mutually exclusive with x1/y1/x2/y2.',
          },
          x1: { type: 'integer', description: 'Start X (custom swipe).' },
          y1: { type: 'integer', description: 'Start Y (custom swipe).' },
          x2: { type: 'integer', description: 'End X (custom swipe).' },
          y2: { type: 'integer', description: 'End Y (custom swipe).' },
          duration_ms: {
            type: 'integer',
            description: 'Swipe duration in milliseconds (default 300).',
            default: 300,
          },
        },
        required: ['device_id'],
      },
    },

    // ── Key events ──────────────────────────────────────────────────────────
    {
      name: 'press_key',
      description:
        'Presses a hardware or virtual key on the device. ' +
        'Use named keys: back, home, recent, enter, search, menu, delete, ' +
        'power, volume_up, volume_down, zoom_in, zoom_out. ' +
        'Or pass a numeric Android keycode.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          key: {
            type: 'string',
            description: 'Key name (back|home|recent|enter|search|menu|delete|...) or numeric keycode.',
          },
        },
        required: ['device_id', 'key'],
      },
    },

    // ── App control ─────────────────────────────────────────────────────────
    {
      name: 'open_app',
      description:
        'Launches an Android app by its package name using the LAUNCHER intent. ' +
        'Use list_installed_apps to discover package names.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          package_name: {
            type: 'string',
            description: 'Android package name (e.g. com.instagram.android).',
          },
        },
        required: ['device_id', 'package_name'],
      },
    },
    {
      name: 'open_url',
      description: 'Opens a URL in the device default browser via Android intent.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          url: { type: 'string', description: 'Full URL starting with http:// or https://.' },
        },
        required: ['device_id', 'url'],
      },
    },
    {
      name: 'list_installed_apps',
      description: 'Returns all installed package names on the device.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
        },
        required: ['device_id'],
      },
    },

    // ── Foreground app ───────────────────────────────────────────────────────
    {
      name: 'get_foreground_app',
      description:
        'Returns the app currently visible to the user (foreground). ' +
        'Shows the active window focus and focused app from dumpsys window, ' +
        'including package name and activity. Use this to confirm which app is open before acting.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial (from list_devices).' },
        },
        required: ['device_id'],
      },
    },

    // ── Config ──────────────────────────────────────────────────────────────
    {
      name: 'get_app_config',
      description:
        'Returns the current aiphone app_config.json settings (Ollama endpoints, models, ' +
        'ADB paths, safety keywords, execution limits, etc.).',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'list_device_configs',
      description: 'Returns per-device persona assignments stored in device_config.json.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },

    // ── Wireless ADB ─────────────────────────────────────────────────────────
    {
      name: 'adb_connect',
      description:
        'Connects to an Android device over TCP/IP (wireless ADB). ' +
        'Call enable_wireless_adb + get_device_ip first (while device is on USB), then disconnect USB and call this.',
      inputSchema: {
        type: 'object',
        properties: {
          ip:   { type: 'string',  description: 'Device IP address (e.g. 192.168.1.42).' },
          port: { type: 'integer', description: 'ADB TCP port (default 5555).', default: 5555 },
        },
        required: ['ip'],
      },
    },
    {
      name: 'adb_disconnect',
      description: 'Disconnects a TCP/IP ADB device. Omit target to disconnect all wireless devices.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'IP:port to disconnect (e.g. 192.168.1.42:5555). Omit to disconnect all.' },
        },
        required: [],
      },
    },
    {
      name: 'enable_wireless_adb',
      description:
        'Switches a USB-connected device to TCP/IP mode for wireless ADB. ' +
        'Device must be on USB first. Follow with get_device_ip, then disconnect USB, then adb_connect.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string',  description: 'ADB device serial of the USB-connected device.' },
          port:      { type: 'integer', description: 'TCP port to listen on (default 5555).', default: 5555 },
        },
        required: ['device_id'],
      },
    },
    {
      name: 'get_device_ip',
      description:
        "Returns the device's current WiFi IP address. " +
        'Use this after enable_wireless_adb to get the IP needed for adb_connect.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
        },
        required: ['device_id'],
      },
    },

    // ── App control (extended) ───────────────────────────────────────────────
    {
      name: 'force_stop_app',
      description: 'Force-stops an app by package name. Equivalent to Settings → App → Force Stop. Use to reset app state.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id:    { type: 'string', description: 'ADB device serial.' },
          package_name: { type: 'string', description: 'Android package name (e.g. com.instagram.android).' },
        },
        required: ['device_id', 'package_name'],
      },
    },
    {
      name: 'is_app_installed',
      description: 'Checks if an app package is installed on the device. Returns installed/not-installed.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id:    { type: 'string', description: 'ADB device serial.' },
          package_name: { type: 'string', description: 'Android package name to check.' },
        },
        required: ['device_id', 'package_name'],
      },
    },

    // ── Screen info ──────────────────────────────────────────────────────────
    {
      name: 'get_screen_size',
      description: 'Returns the physical screen resolution (width x height in pixels) of the device.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
        },
        required: ['device_id'],
      },
    },
    {
      name: 'dump_ui_xml',
      description:
        'Returns the raw UIAutomator XML hierarchy string. ' +
        'Use get_ui_elements for parsed/structured data, or this for full raw detail.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
        },
        required: ['device_id'],
      },
    },

    // ── Element selector tools ───────────────────────────────────────────────
    {
      name: 'find_element',
      description:
        'Finds a UI element using a flexible selector object. Returns id, bounds, text, and properties. ' +
        'Selector priority: resourceId (exact) → text (substring) → contentDesc (substring) → className (exact). ' +
        'All selector fields are optional but at least one must be provided.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          selector: {
            type: 'object',
            description: 'Selector — provide one or more fields.',
            properties: {
              text:         { type: 'string',  description: 'Substring match against element text.' },
              resourceId:   { type: 'string',  description: 'Exact match against resource-id (e.g. com.app:id/login_button).' },
              contentDesc:  { type: 'string',  description: 'Substring match against content-desc.' },
              className:    { type: 'string',  description: 'Exact match against class (e.g. android.widget.Button).' },
              clickableOnly:{ type: 'boolean', description: 'If true, only match clickable elements.' },
            },
          },
        },
        required: ['device_id', 'selector'],
      },
    },
    {
      name: 'tap_by_selector',
      description:
        'Finds a UI element by selector then taps its center. ' +
        'Preferred over raw tap when element text or resource-id is known.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          selector: {
            type: 'object',
            properties: {
              text:         { type: 'string' },
              resourceId:   { type: 'string' },
              contentDesc:  { type: 'string' },
              className:    { type: 'string' },
              clickableOnly:{ type: 'boolean' },
            },
          },
        },
        required: ['device_id', 'selector'],
      },
    },
    {
      name: 'wait_for_element',
      description:
        'Polls the UI hierarchy until an element matching the selector appears, or times out. ' +
        'Use after actions that trigger loading, navigation, or animations.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          selector: {
            type: 'object',
            properties: {
              text:         { type: 'string' },
              resourceId:   { type: 'string' },
              contentDesc:  { type: 'string' },
              className:    { type: 'string' },
              clickableOnly:{ type: 'boolean' },
            },
          },
          timeout_seconds: { type: 'number', description: 'Max wait time in seconds (default 10, max 60).', default: 10 },
        },
        required: ['device_id', 'selector'],
      },
    },
    {
      name: 'type_in_element',
      description:
        'Finds an input element by selector, taps it to focus, clears existing text, then types new text. ' +
        'The complete "fill a field" action.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          selector: {
            type: 'object',
            description: 'Selector for the input field.',
            properties: {
              text:        { type: 'string' },
              resourceId:  { type: 'string' },
              contentDesc: { type: 'string' },
              className:   { type: 'string' },
            },
          },
          text: { type: 'string', description: 'Text to type into the field.' },
        },
        required: ['device_id', 'selector', 'text'],
      },
    },
    {
      name: 'assert_element_exists',
      description: 'Verifies a UI element matching the selector exists on screen. Returns PASS/FAIL with element details.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          selector: {
            type: 'object',
            properties: {
              text:         { type: 'string' },
              resourceId:   { type: 'string' },
              contentDesc:  { type: 'string' },
              className:    { type: 'string' },
              clickableOnly:{ type: 'boolean' },
            },
          },
        },
        required: ['device_id', 'selector'],
      },
    },

    // ── Navigation shortcuts ─────────────────────────────────────────────────
    {
      name: 'go_home',
      description: 'Presses the Home button, returning to the Android home screen.',
      inputSchema: {
        type: 'object',
        properties: { device_id: { type: 'string', description: 'ADB device serial.' } },
        required: ['device_id'],
      },
    },
    {
      name: 'go_back',
      description: 'Presses the Back button to navigate to the previous screen.',
      inputSchema: {
        type: 'object',
        properties: { device_id: { type: 'string', description: 'ADB device serial.' } },
        required: ['device_id'],
      },
    },
    {
      name: 'open_notifications',
      description: 'Opens the Android notification shade.',
      inputSchema: {
        type: 'object',
        properties: { device_id: { type: 'string', description: 'ADB device serial.' } },
        required: ['device_id'],
      },
    },
    {
      name: 'open_recents',
      description: 'Opens the recent apps / app switcher screen.',
      inputSchema: {
        type: 'object',
        properties: { device_id: { type: 'string', description: 'ADB device serial.' } },
        required: ['device_id'],
      },
    },

    // ── State validation ─────────────────────────────────────────────────────
    {
      name: 'assert_foreground_app',
      description:
        'Checks that a specific app package is currently in the foreground. ' +
        'Returns PASS/FAIL with current mCurrentFocus and mFocusedApp.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id:    { type: 'string', description: 'ADB device serial.' },
          package_name: { type: 'string', description: 'Expected foreground package name.' },
        },
        required: ['device_id', 'package_name'],
      },
    },

    // ── Device info ─────────────────────────────────────────────────────────
    {
      name: 'get_device_info',
      description:
        'Returns comprehensive device hardware and system information retrieved via ADB. ' +
        'Includes: model, brand, manufacturer, device codename, CPU ABI, board platform, serial number; ' +
        'Android version, SDK level, build ID/type/fingerprint; ' +
        'screen resolution and density; ' +
        'battery level, status, health, plug state, voltage (mV), temperature (°C); ' +
        'RAM totals (total/free/available/cached in bytes); ' +
        'storage partitions (/data, /sdcard) with size/used/available; ' +
        'and all active network interfaces with IP addresses.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial (from list_devices).' },
        },
        required: ['device_id'],
      },
    },

    // ── Rotation ────────────────────────────────────────────────────────────
    {
      name: 'rotate_screen',
      description:
        'Sets device rotation. 0=portrait, 1=landscape, 2=reverse portrait, 3=reverse landscape.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          rotation: {
            type: 'integer',
            enum: [0, 1, 2, 3],
            description: '0=portrait, 1=landscape, 2=reverse portrait, 3=reverse landscape.',
          },
        },
        required: ['device_id', 'rotation'],
      },
    },
  ],
}));

// ── Tool handlers ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {

      // ── list_devices ──────────────────────────────────────────────────────
      case 'list_devices': {
        const serials = await adbClient.listDevices(ADB_PATH);
        if (serials.length === 0) {
          return text('No Android devices connected. Make sure USB debugging is enabled and the device is authorized.');
        }
        return text(`Connected devices (${serials.length}):\n${serials.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`);
      }

      // ── take_screenshot ───────────────────────────────────────────────────
      case 'take_screenshot': {
        const { device_id } = requireArgs(args, ['device_id']);
        const rawPng = await adbClient.screenshot(ADB_PATH, device_id);
        const result = await processScreenshot(rawPng, {
          maxWidth:  args.max_width  ?? 1080,
          maxHeight: args.max_height ?? 1920,
          format:    args.format     ?? 'webp',
          quality:   args.quality    ?? 75,
        });
        const b64 = result.buffer.toString('base64');
        const saved = Math.round((1 - result.buffer.length / result.originalBytes) * 100);
        return {
          content: [
            {
              type: 'text',
              text:
                `Screenshot from device ${device_id}: ` +
                `${result.width}x${result.height}px, ` +
                `${result.format}, ` +
                `${(result.buffer.length / 1024).toFixed(1)} KB ` +
                `(${saved}% smaller than raw PNG of ${(result.originalBytes / 1024).toFixed(1)} KB).`,
            },
            { type: 'image', data: b64, mimeType: mimeType(result.format) },
          ],
        };
      }

      // ── get_ui_elements ───────────────────────────────────────────────────
      case 'get_ui_elements': {
        const { device_id } = requireArgs(args, ['device_id']);
        const limit = Math.min(150, Math.max(1, args.limit ?? 30));
        const xml = await adbClient.uiDump(ADB_PATH, device_id);
        const elements = parseUiXml(xml);
        const compact = compactElements(elements, limit);
        const summary =
          `UI elements on device ${device_id} (showing ${compact.length} of ${elements.length} total, prioritised by clickable):\n` +
          JSON.stringify(compact, null, 2);
        return text(summary);
      }

      // ── tap ───────────────────────────────────────────────────────────────
      case 'tap': {
        const { device_id, x, y } = requireArgs(args, ['device_id', 'x', 'y']);
        await adbClient.tapPoint(ADB_PATH, device_id, Number(x), Number(y));
        return text(`Tapped at (${x}, ${y}) on device ${device_id}.`);
      }

      // ── double_tap ────────────────────────────────────────────────────────
      case 'double_tap': {
        const { device_id, x, y } = requireArgs(args, ['device_id', 'x', 'y']);
        await adbClient.doubleTapPoint(ADB_PATH, device_id, Number(x), Number(y));
        return text(`Double-tapped at (${x}, ${y}) on device ${device_id}.`);
      }

      // ── tap_element ───────────────────────────────────────────────────────
      case 'tap_element': {
        const { device_id, bounds } = requireArgs(args, ['device_id', 'bounds']);
        if (!Array.isArray(bounds) || bounds.length !== 4) {
          throw new Error('bounds must be an array of 4 integers [x1, y1, x2, y2].');
        }
        await adbClient.tapBounds(ADB_PATH, device_id, bounds.map(Number));
        const cx = Math.floor((bounds[0] + bounds[2]) / 2);
        const cy = Math.floor((bounds[1] + bounds[3]) / 2);
        return text(`Tapped element center at (${cx}, ${cy}) on device ${device_id}.`);
      }

      // ── type_text ─────────────────────────────────────────────────────────
      case 'type_text': {
        const { device_id, text: inputText } = requireArgs(args, ['device_id', 'text']);
        if (typeof inputText !== 'string' || inputText.length === 0) {
          throw new Error('"text" must be a non-empty string.');
        }
        await adbClient.typeText(ADB_PATH, device_id, inputText);
        return text(`Typed ${inputText.length} character(s) on device ${device_id}.`);
      }

      // ── swipe ─────────────────────────────────────────────────────────────
      case 'swipe': {
        const { device_id } = requireArgs(args, ['device_id']);
        const durationMs = args.duration_ms ?? 300;
        if (args.direction) {
          await adbClient.swipeDirection(ADB_PATH, device_id, args.direction);
          return text(`Swiped ${args.direction} on device ${device_id}.`);
        }
        const { x1, y1, x2, y2 } = requireArgs(args, ['x1', 'y1', 'x2', 'y2']);
        await adbClient.swipe(ADB_PATH, device_id, Number(x1), Number(y1), Number(x2), Number(y2), Number(durationMs));
        return text(`Swiped (${x1},${y1}) → (${x2},${y2}) in ${durationMs}ms on device ${device_id}.`);
      }

      // ── press_key ─────────────────────────────────────────────────────────
      case 'press_key': {
        const { device_id, key } = requireArgs(args, ['device_id', 'key']);
        await adbClient.pressKey(ADB_PATH, device_id, String(key));
        return text(`Pressed key "${key}" on device ${device_id}.`);
      }

      // ── open_app ──────────────────────────────────────────────────────────
      case 'open_app': {
        const { device_id, package_name } = requireArgs(args, ['device_id', 'package_name']);
        await adbClient.launchApp(ADB_PATH, device_id, package_name);
        return text(`Launched app "${package_name}" on device ${device_id}.`);
      }

      // ── open_url ──────────────────────────────────────────────────────────
      case 'open_url': {
        const { device_id, url } = requireArgs(args, ['device_id', 'url']);
        await adbClient.openUrl(ADB_PATH, device_id, url);
        return text(`Opened URL "${url}" on device ${device_id}.`);
      }

      // ── list_installed_apps ───────────────────────────────────────────────
      case 'list_installed_apps': {
        const { device_id } = requireArgs(args, ['device_id']);
        const packages = await adbClient.listInstalledPackages(ADB_PATH, device_id);
        return text(
          `Installed packages on ${device_id} (${packages.length} total):\n${packages.sort().join('\n')}`,
        );
      }

      // ── get_foreground_app ────────────────────────────────────────────────
      case 'get_foreground_app': {
        const { device_id } = requireArgs(args, ['device_id']);
        const { currentFocus, focusedApp } = await adbClient.getForegroundApp(ADB_PATH, device_id);
        const lines = [
          `Foreground app on device ${device_id}:`,
          `  mCurrentFocus : ${currentFocus ?? '(not found)'}`,
          `  mFocusedApp   : ${focusedApp ?? '(not found)'}`,
        ];
        return text(lines.join('\n'));
      }

      // ── get_app_config ────────────────────────────────────────────────────
      case 'get_app_config': {
        const config = loadAppConfig(CONFIG_DIR);
        if (!config) {
          return text(`app_config.json not found in config directory: ${CONFIG_DIR}`);
        }
        // Strip internal comment field
        const { _comment, ...clean } = config;
        return text(JSON.stringify(clean, null, 2));
      }

      // ── list_device_configs ───────────────────────────────────────────────
      case 'list_device_configs': {
        const configs = loadDeviceConfigs(CONFIG_DIR);
        if (configs.length === 0) {
          return text('No device configurations found. Devices may not have assigned personas yet.');
        }
        return text(JSON.stringify(configs, null, 2));
      }

      // ── rotate_screen ─────────────────────────────────────────────────────
      case 'rotate_screen': {
        const { device_id, rotation } = requireArgs(args, ['device_id', 'rotation']);
        await adbClient.rotate(ADB_PATH, device_id, Number(rotation));
        const labels = ['portrait', 'landscape', 'reverse portrait', 'reverse landscape'];
        return text(`Rotated device ${device_id} to ${labels[rotation] ?? rotation}.`);
      }

      // ── adb_connect ───────────────────────────────────────────────────────
      case 'adb_connect': {
        const { ip } = requireArgs(args, ['ip']);
        const result = await adbClient.adbConnect(ADB_PATH, String(ip), Number(args.port ?? 5555));
        return text(`ADB connect result: ${result}`);
      }

      // ── adb_disconnect ────────────────────────────────────────────────────
      case 'adb_disconnect': {
        const result = await adbClient.adbDisconnect(ADB_PATH, args.target);
        return text(`ADB disconnect result: ${result}`);
      }

      // ── enable_wireless_adb ───────────────────────────────────────────────
      case 'enable_wireless_adb': {
        const { device_id } = requireArgs(args, ['device_id']);
        await adbClient.adbTcpip(ADB_PATH, device_id, Number(args.port ?? 5555));
        return text(
          `TCP/IP mode enabled on device ${device_id} (port ${args.port ?? 5555}). ` +
          `Now call get_device_ip, then disconnect USB and call adb_connect.`
        );
      }

      // ── get_device_ip ─────────────────────────────────────────────────────
      case 'get_device_ip': {
        const { device_id } = requireArgs(args, ['device_id']);
        const routes = await adbClient.getDeviceIp(ADB_PATH, device_id);
        if (!routes || routes.length === 0) {
          return text(`No network interfaces found on device ${device_id}. Ensure the device has an active network connection.`);
        }
        const lines = [
          `Network interfaces on device ${device_id} (${routes.length} route${routes.length > 1 ? 's' : ''}):`,
          ...routes.map((r) => `  ${r.iface.padEnd(12)} ${r.ip.padEnd(18)} network: ${r.network}`),
        ];
        return text(lines.join('\n'));
      }

      // ── force_stop_app ────────────────────────────────────────────────────
      case 'force_stop_app': {
        const { device_id, package_name } = requireArgs(args, ['device_id', 'package_name']);
        await adbClient.forceStopApp(ADB_PATH, device_id, package_name);
        return text(`Force-stopped "${package_name}" on device ${device_id}.`);
      }

      // ── is_app_installed ──────────────────────────────────────────────────
      case 'is_app_installed': {
        const { device_id, package_name } = requireArgs(args, ['device_id', 'package_name']);
        const installed = await adbClient.isAppInstalled(ADB_PATH, device_id, package_name);
        return text(`"${package_name}" is ${installed ? 'INSTALLED' : 'NOT installed'} on device ${device_id}.`);
      }

      // ── get_screen_size ───────────────────────────────────────────────────
      case 'get_screen_size': {
        const { device_id } = requireArgs(args, ['device_id']);
        const { width, height } = await adbClient.getScreenSize(ADB_PATH, device_id);
        return text(`Screen size of device ${device_id}: ${width} x ${height} pixels.`);
      }

      // ── dump_ui_xml ───────────────────────────────────────────────────────
      case 'dump_ui_xml': {
        const { device_id } = requireArgs(args, ['device_id']);
        const xml = await adbClient.getRawUiXml(ADB_PATH, device_id);
        return text(xml);
      }

      // ── find_element ──────────────────────────────────────────────────────
      case 'find_element': {
        const { device_id, selector } = requireArgs(args, ['device_id', 'selector']);
        const el = findElement(parseUiXml(await adbClient.uiDump(ADB_PATH, device_id)), selector);
        if (!el) return text(`No element found matching selector: ${JSON.stringify(selector)}`);
        return text(`Element found:\n${JSON.stringify(el, null, 2)}`);
      }

      // ── tap_by_selector ───────────────────────────────────────────────────
      case 'tap_by_selector': {
        const { device_id, selector } = requireArgs(args, ['device_id', 'selector']);
        const el = findElement(parseUiXml(await adbClient.uiDump(ADB_PATH, device_id)), selector);
        if (!el) throw new Error(`No element found matching selector: ${JSON.stringify(selector)}`);
        await adbClient.tapBounds(ADB_PATH, device_id, el.bounds);
        const cx = Math.floor((el.bounds[0] + el.bounds[2]) / 2);
        const cy = Math.floor((el.bounds[1] + el.bounds[3]) / 2);
        return text(`Tapped "${el.text || el.contentDesc || el.id}" at (${cx}, ${cy}) on device ${device_id}.`);
      }

      // ── wait_for_element ──────────────────────────────────────────────────
      case 'wait_for_element': {
        const { device_id, selector } = requireArgs(args, ['device_id', 'selector']);
        const timeoutSec = Math.min(60, Math.max(1, Number(args.timeout_seconds ?? 10)));
        const intervalMs = 1500;
        const deadline = Date.now() + timeoutSec * 1000;
        let el = null;
        while (Date.now() < deadline) {
          el = findElement(parseUiXml(await adbClient.uiDump(ADB_PATH, device_id)), selector);
          if (el) break;
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
        }
        if (!el) return text(`Element not found within ${timeoutSec}s. Selector: ${JSON.stringify(selector)}`);
        return text(`Element appeared:\n${JSON.stringify(el, null, 2)}`);
      }

      // ── type_in_element ───────────────────────────────────────────────────
      case 'type_in_element': {
        const { device_id, selector, text: inputText } = requireArgs(args, ['device_id', 'selector', 'text']);
        const el = findElement(parseUiXml(await adbClient.uiDump(ADB_PATH, device_id)), selector);
        if (!el) throw new Error(`No element found matching selector: ${JSON.stringify(selector)}`);
        await adbClient.tapBounds(ADB_PATH, device_id, el.bounds);
        await new Promise((r) => setTimeout(r, 300));
        await adbClient.clearInputAndType(ADB_PATH, device_id, inputText);
        return text(`Typed into "${el.text || el.contentDesc || el.id}" on device ${device_id}.`);
      }

      // ── assert_element_exists ─────────────────────────────────────────────
      case 'assert_element_exists': {
        const { device_id, selector } = requireArgs(args, ['device_id', 'selector']);
        const el = findElement(parseUiXml(await adbClient.uiDump(ADB_PATH, device_id)), selector);
        if (!el) return text(`FAIL: No element found matching selector: ${JSON.stringify(selector)}`);
        return text(`PASS: Element exists.\n${JSON.stringify(el, null, 2)}`);
      }

      // ── go_home ───────────────────────────────────────────────────────────
      case 'go_home': {
        const { device_id } = requireArgs(args, ['device_id']);
        await adbClient.pressKey(ADB_PATH, device_id, 'home');
        return text(`Pressed Home on device ${device_id}.`);
      }

      // ── go_back ───────────────────────────────────────────────────────────
      case 'go_back': {
        const { device_id } = requireArgs(args, ['device_id']);
        await adbClient.pressKey(ADB_PATH, device_id, 'back');
        return text(`Pressed Back on device ${device_id}.`);
      }

      // ── open_notifications ────────────────────────────────────────────────
      case 'open_notifications': {
        const { device_id } = requireArgs(args, ['device_id']);
        await adbClient.openNotifications(ADB_PATH, device_id);
        return text(`Opened notification shade on device ${device_id}.`);
      }

      // ── open_recents ──────────────────────────────────────────────────────
      case 'open_recents': {
        const { device_id } = requireArgs(args, ['device_id']);
        await adbClient.pressKey(ADB_PATH, device_id, 'recent');
        return text(`Opened recent apps on device ${device_id}.`);
      }

      // ── get_device_info ────────────────────────────────────────────────────
      case 'get_device_info': {
        const { device_id } = requireArgs(args, ['device_id']);
        const info = await adbClient.getDeviceInfo(ADB_PATH, device_id);
        // Format human-readable alongside raw JSON
        const fmt = (bytes) => bytes == null ? 'N/A' : `${(bytes / 1024 / 1024).toFixed(0)} MB`;
        const lines = [
          `Device: ${info.device.manufacturer} ${info.device.model} (${info.device.device})`,
          `Brand: ${info.device.brand} | CPU ABI: ${info.device.cpu_abi} | Platform: ${info.device.board_platform}`,
          `Serial: ${info.device.serial}`,
          ``,
          `Android: ${info.software.android_version} (SDK ${info.software.sdk_level}) — Build: ${info.software.build_id} [${info.software.build_type}]`,
          ``,
          `Screen: ${info.screen.width}×${info.screen.height} @ ${info.screen.density_dpi} dpi`,
          ``,
          `Battery: ${info.battery.level}% | ${info.battery.status} | Health: ${info.battery.health} | Plugged: ${info.battery.plugged}`,
          `  Voltage: ${info.battery.voltage_mv} mV | Temp: ${info.battery.temperature_c} °C | Tech: ${info.battery.technology}`,
          ``,
          `Memory: Total ${fmt(info.memory.total_bytes)} | Free ${fmt(info.memory.free_bytes)} | Available ${fmt(info.memory.available_bytes)} | Cached ${fmt(info.memory.cached_bytes)}`,
          ``,
          `Storage:`,
          ...info.storage.map((s) => `  ${s.mount}: ${fmt(s.avail_bytes)} free / ${fmt(s.size_bytes)} total (${s.filesystem})`),
          ``,
          `Network:`,
          ...info.network_interfaces.map((n) => `  ${n.iface}: ${n.ip} (${n.network})`),
          ``,
          `--- Raw JSON ---`,
          JSON.stringify(info, null, 2),
        ];
        return text(lines.join('\n'));
      }

      // ── assert_foreground_app ─────────────────────────────────────────────
      case 'assert_foreground_app': {
        const { device_id, package_name } = requireArgs(args, ['device_id', 'package_name']);
        const { currentFocus, focusedApp } = await adbClient.getForegroundApp(ADB_PATH, device_id);
        const combined = `${currentFocus ?? ''} ${focusedApp ?? ''}`;
        const pass = combined.includes(package_name);
        return text(
          `${pass ? 'PASS' : 'FAIL'}: Expected "${package_name}" in foreground.\n` +
          `  mCurrentFocus : ${currentFocus ?? '(not found)'}\n` +
          `  mFocusedApp   : ${focusedApp ?? '(not found)'}`,
        );
      }

      default:
        return text(`Unknown tool: "${name}"`);
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function text(str) {
  return { content: [{ type: 'text', text: str }] };
}

function requireArgs(args, keys) {
  const missing = keys.filter((k) => args[k] === undefined || args[k] === null);
  if (missing.length > 0) {
    throw new Error(`Missing required argument(s): ${missing.join(', ')}`);
  }
  return args;
}

// ── Connect transport ─────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
