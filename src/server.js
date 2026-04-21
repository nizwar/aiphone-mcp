import { createRequire } from 'module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import * as adbClient from './adb.js';
import { parseUiXml, compactElements, findElement } from './uiparser.js';
import { processScreenshot, mimeType } from './image.js';

const { version } = createRequire(import.meta.url)('../package.json');

const ADB_PATH = process.env.AIPHONE_ADB_PATH || 'adb';

const server = new Server(
  { name: 'aiphone-mcp', version },
  { capabilities: { tools: {} } },
);



server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_devices',
      description:
        'Lists all currently connected and online ADB Android device serials. ' +
        'Call this first to discover which devices are available.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },

    {
      name: 'take_screenshot',
      description:
        'Takes a screenshot of the device screen and returns it as an optimized image. ',
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
        required: [],
      },
    },
    // {
    //   name: 'get_ui_elements',
    //   description:
    //     'Returns a structured list of interactive UI elements (id, text, content_desc, bounds, clickable flag). ',
    //   inputSchema: {
    //     type: 'object',
    //     properties: {
    //       device_id: {
    //         type: 'string',
    //         description: 'ADB device serial (from list_devices).',
    //       },
    //       limit: {
    //         type: 'integer',
    //         description: 'Max number of elements to return (default 30, max 150). Prioritises clickable elements.',
    //         default: 30,
    //       },
    //     },
    //     required: [],
    //   },
    // },

    {
      name: 'tap',
      description:
        'Taps the device screen at absolute coordinates (x, y). ' +
        'Obtain x,y from the center of an element\'s bounds returned by get_ui_elements. ' +
        'IMPORTANT: Avoid tapping profile pictures, avatars, or person thumbnails unless the user explicitly asks to view a profile image, story, or similar media. ' +
        'For example, to open a chat/conversation, tap the conversation row (name/text area/contact name) — NOT the contact\'s avatar on the left.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          x: { type: 'integer', description: 'X coordinate in device pixels.' },
          y: { type: 'integer', description: 'Y coordinate in device pixels.' },
        },
        required: ['x', 'y'],
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
        required: ['x', 'y'],
      },
    },
    {
      name: 'tap_element',
      description:
        'Taps the center of a UI element identified by its bounds [x1, y1, x2, y2] from get_ui_elements. ' +
        'IMPORTANT: Avoid tapping profile pictures, avatars, or person thumbnails unless the user explicitly asks to view a profile image, story, or similar media. ' +
        'For example, to open a chat/conversation, tap the conversation row (name/text area/contact name) — NOT the contact\'s avatar.',
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
        required: ['bounds'],
      },
    },

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
        required: ['text'],
      },
    },

    {
      name: 'swipe',
      description:
        'Performs a swipe gesture. Use directional shortcuts (up/down/left/right) or explicit coordinates. ' +
        'Direction finger movements: up = top→bottom, down = bottom→top, left = left→right, right = right→left. ' +
        'Use cx to set the X column for up/down swipes, cy to set the Y row for left/right swipes.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          direction: {
            type: 'string',
            enum: ['up', 'down', 'left', 'right'],
            description:
              'Directional swipe: up = finger top→bottom, down = finger bottom→top, ' +
              'left = finger left→right, right = finger right→left. Mutually exclusive with x1/y1/x2/y2.',
          },
          cx: {
            type: 'integer',
            description: 'X center of the swipe for up/down directional swipes (default: screen horizontal center).',
          },
          cy: {
            type: 'integer',
            description: 'Y center of the swipe for left/right directional swipes (default: screen vertical center).',
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
        required: [],
      },
    },

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
        required: ['key'],
      },
    },


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
        required: ['package_name'],
      },
    },
    {
      name: 'open_url',
      description: 'Opens a URL in the device default browser via Android intent.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          url: { type: 'string', description: 'Full URL starting with http:// or https:// or custom scheme (e.g. myapp://path).' },
        },
        required: ['url'],
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
        required: [],
      },
    },


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
        required: [],
      },
    },


    {
      name: 'adb_connect',
      description:
        'Connects to an Android device over TCP/IP (wireless ADB). ' +
        'Call enable_wireless_adb + get_device_ip first (while device is on USB), then disconnect USB and call this.',
      inputSchema: {
        type: 'object',
        properties: {
          ip: { type: 'string', description: 'Device IP address (e.g. 192.168.1.42).' },
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
          device_id: { type: 'string', description: 'ADB device serial of the USB-connected device.' },
          port: { type: 'integer', description: 'TCP port to listen on (default 5555).', default: 5555 },
        },
        required: [],
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
        required: [],
      },
    },


    {
      name: 'force_stop_app',
      description: 'Force-stops an app by package name. Equivalent to Settings → App → Force Stop. Use to reset app state.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          package_name: { type: 'string', description: 'Android package name (e.g. com.instagram.android).' },
        },
        required: ['package_name'],
      },
    },
    {
      name: 'is_app_installed',
      description: 'Checks if an app package is installed on the device. Returns installed/not-installed.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          package_name: { type: 'string', description: 'Android package name to check.' },
        },
        required: ['package_name'],
      },
    },


    {
      name: 'get_screen_size',
      description: 'Returns the physical screen resolution (width x height in pixels) of the device.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
        },
        required: [],
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
        required: [],
      },
    },


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
              text: { type: 'string', description: 'Substring match against element text.' },
              resourceId: { type: 'string', description: 'Exact match against resource-id (e.g. com.app:id/login_button).' },
              contentDesc: { type: 'string', description: 'Substring match against content-desc.' },
              className: { type: 'string', description: 'Exact match against class (e.g. android.widget.Button).' },
              clickableOnly: { type: 'boolean', description: 'If true, only match clickable elements.' },
            },
          },
        },
        required: ['selector'],
      },
    },
    {
      name: 'tap_by_selector',
      description:
        'Finds a UI element by selector then taps its center. ',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          selector: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              resourceId: { type: 'string' },
              contentDesc: { type: 'string' },
              className: { type: 'string' },
              clickableOnly: { type: 'boolean' },
            },
          },
        },
        required: ['selector'],
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
              text: { type: 'string' },
              resourceId: { type: 'string' },
              contentDesc: { type: 'string' },
              className: { type: 'string' },
            },
          },
          text: { type: 'string', description: 'Text to type into the field.' },
        },
        required: ['selector', 'text'],
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
              text: { type: 'string' },
              resourceId: { type: 'string' },
              contentDesc: { type: 'string' },
              className: { type: 'string' },
              clickableOnly: { type: 'boolean' },
            },
          },
        },
        required: ['selector'],
      },
    },


    {
      name: 'go_home',
      description: 'Presses the Home button, returning to the Android home screen.',
      inputSchema: {
        type: 'object',
        properties: { device_id: { type: 'string', description: 'ADB device serial.' } },
        required: [],
      },
    },
    {
      name: 'go_back',
      description: 'Presses the Back button to navigate to the previous screen.',
      inputSchema: {
        type: 'object',
        properties: { device_id: { type: 'string', description: 'ADB device serial.' } },
        required: [],
      },
    },
    {
      name: 'open_recents',
      description: 'Opens the recent apps / app switcher screen.',
      inputSchema: {
        type: 'object',
        properties: { device_id: { type: 'string', description: 'ADB device serial.' } },
        required: [],
      },
    },


    {
      name: 'assert_foreground_app',
      description:
        'Checks that a specific app package is currently in the foreground. ' +
        'Returns PASS/FAIL with current mCurrentFocus and mFocusedApp.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          package_name: { type: 'string', description: 'Expected foreground package name.' },
        },
        required: ['package_name'],
      },
    },


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
        required: [],
      },
    },


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
            description: '0=portrait, 1=landscape, 2=reverse portrait, 3=reverse landscape.',
          },
        },
        required: ['rotation'],
      },
    },


    {
      name: 'post_notification',
      description: 'Posts a system notification on the device via `cmd notification post`.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          title: { type: 'string', description: 'Notification title.' },
          text: { type: 'string', description: 'Notification body text.' },
          tag: { type: 'string', description: 'Notification tag (default: aiphone).', default: 'aiphone' },
          style: {
            type: 'string',
            enum: ['bigtext', 'inbox', 'media'],
            description: 'Notification style (default: bigtext).',
            default: 'bigtext',
          },
        },
        required: ['title', 'text'],
      },
    },

    {
      name: 'dump_notifications',
      description: 'Returns the raw output of `dumpsys notification` — active notifications, history, and listener state.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
        },
        required: [],
      },
    },

    {
      name: 'set_wifi',
      description: 'Enables or disables WiFi on the device via `svc wifi`.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          enable: { type: 'boolean', description: 'true to enable, false to disable.' },
        },
        required: ['enable'],
      },
    },

    {
      name: 'set_mobile_data',
      description: 'Enables or disables mobile data on the device via `svc data`.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          enable: { type: 'boolean', description: 'true to enable, false to disable.' },
        },
        required: ['enable'],
      },
    },

    {
      name: 'set_airplane_mode',
      description: 'Enables or disables airplane mode. Note: on Android 8+ this may require the device to be rooted or have special permissions.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          enable: { type: 'boolean', description: 'true to enable, false to disable.' },
        },
        required: ['enable'],
      },
    },

    {
      name: 'adb_shell',
      description:
        'Runs an arbitrary `adb shell` command on the device. ' +
        'Use this as a last resort when no other tool covers the needed action.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          command: { type: 'string', description: 'Shell command to run (e.g. "pm clear com.example.app").' },
        },
        required: ['command'],
      },
    },

    {
      name: 'long_press',
      description: 'Long-presses the device screen at absolute coordinates (x, y) for a given duration.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          x: { type: 'integer', description: 'X coordinate in device pixels.' },
          y: { type: 'integer', description: 'Y coordinate in device pixels.' },
          duration_ms: {
            type: 'integer',
            description: 'Duration of the press in milliseconds (default 1000).',
            default: 1000,
          },
        },
        required: ['x', 'y'],
      },
    },

    {
      name: 'clear_text',
      description:
        'Clears text in the currently focused input field by selecting all (Ctrl+A) then deleting. ' +
        'Tap the target field first to focus it.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
        },
        required: [],
      },
    },

    {
      name: 'get_input_method',
      description: 'Returns the currently active input method (IME) on the device.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
        },
        required: [],
      },
    },

    {
      name: 'set_input_method',
      description:
        'Switches the active input method (IME) on the device. ' +
        'Use get_input_method to save the current IME before switching, then restore it afterwards.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial.' },
          ime: {
            type: 'string',
            description: 'IME component name (e.g. com.android.adbkeyboard/.AdbIME).',
          },
        },
        required: ['ime'],
      },
    },

    {
      name: 'is_connected',
      description:
        'Checks whether a device is currently connected and authorized via ADB. ' +
        'Omit device_id to check if any device is connected.',
      inputSchema: {
        type: 'object',
        properties: {
          device_id: { type: 'string', description: 'ADB device serial to check. Omit to check for any connected device.' },
        },
        required: [],
      },
    },

    {
      name: 'restart_adb_server',
      description:
        'Restarts the local ADB server (kill-server then start-server). ' +
        'Use when ADB is unresponsive or devices are not being detected.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  ],
}));



server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {


      case 'list_devices': {
        const serials = await adbClient.listDevices(ADB_PATH);
        if (serials.length === 0) {
          return text('No Android devices connected. Make sure USB debugging is enabled and the device is authorized.');
        }
        return text(`Connected devices (${serials.length}):\n${serials.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`);
      }


      case 'take_screenshot': {
        const device_id = args?.device_id ?? null;
        const rawPng = await adbClient.screenshot(ADB_PATH, device_id);
        const result = await processScreenshot(rawPng, {
          maxWidth: args.max_width ?? 1080,
          maxHeight: args.max_height ?? 1920,
          format: args.format ?? 'webp',
          quality: args.quality ?? 75,
        });
        const b64 = result.buffer.toString('base64');
        const sizeLine = result.fallback
          ? `${(result.buffer.length / 1024).toFixed(1)} KB (raw PNG — install sharp for WebP compression and resizing)`
          : (() => {
              const saved = Math.round((1 - result.buffer.length / result.originalBytes) * 100);
              return (
                `${result.width}x${result.height}px, ` +
                `${result.format}, ` +
                `${(result.buffer.length / 1024).toFixed(1)} KB ` +
                `(${saved}% smaller than raw PNG of ${(result.originalBytes / 1024).toFixed(1)} KB)`
              );
            })();
        return {
          content: [
            {
              type: 'text',
              text: `Screenshot from device ${device_id}: ${sizeLine}.`,
            },
            { type: 'image', data: b64, mimeType: mimeType(result.format) },
          ],
        };
      }


      case 'get_ui_elements': {
        const device_id = args?.device_id ?? null;
        const limit = Math.min(150, Math.max(1, args.limit ?? 30));
        const xml = await adbClient.uiDump(ADB_PATH, device_id);
        const elements = parseUiXml(xml);
        const compact = compactElements(elements, limit);
        const summary =
          `UI elements on device ${device_id} (showing ${compact.length} of ${elements.length} total, prioritised by clickable):\n` +
          JSON.stringify(compact, null, 2);
        return text(summary);
      }


      case 'tap': {
        const { x, y } = requireArgs(args, ['x', 'y']);
        const device_id = args?.device_id ?? null;
        await adbClient.tapPoint(ADB_PATH, device_id, Number(x), Number(y));
        return text(`Tapped at (${x}, ${y}) on device ${device_id}.`);
      }


      case 'double_tap': {
        const { x, y } = requireArgs(args, ['x', 'y']);
        const device_id = args?.device_id ?? null;
        await adbClient.doubleTapPoint(ADB_PATH, device_id, Number(x), Number(y));
        return text(`Double-tapped at (${x}, ${y}) on device ${device_id}.`);
      }


      case 'tap_element': {
        const { bounds } = requireArgs(args, ['bounds']);
        const device_id = args?.device_id ?? null;
        if (!Array.isArray(bounds) || bounds.length !== 4) {
          throw new Error('bounds must be an array of 4 integers [x1, y1, x2, y2].');
        }
        await adbClient.tapBounds(ADB_PATH, device_id, bounds.map(Number));
        const cx = Math.floor((bounds[0] + bounds[2]) / 2);
        const cy = Math.floor((bounds[1] + bounds[3]) / 2);
        return text(`Tapped element center at (${cx}, ${cy}) on device ${device_id}.`);
      }


      case 'type_text': {
        const { text: inputText } = requireArgs(args, ['text']);
        const device_id = args?.device_id ?? null;
        if (typeof inputText !== 'string' || inputText.length === 0) {
          throw new Error('"text" must be a non-empty string.');
        }
        await adbClient.typeText(ADB_PATH, device_id, inputText);
        return text(`Typed ${inputText.length} character(s) on device ${device_id}.`);
      }


      case 'swipe': {
        const device_id = args?.device_id ?? null;
        const durationMs = args.duration_ms ?? 300;
        if (args.direction) {
          const swipeCx = args.cx != null ? Number(args.cx) : null;
          const swipeCy = args.cy != null ? Number(args.cy) : null;
          await adbClient.swipeDirection(ADB_PATH, device_id, args.direction, 1080, 1920, swipeCx, swipeCy);
          const centerNote = swipeCx != null || swipeCy != null
            ? ` (center: ${swipeCx ?? 'default'}, ${swipeCy ?? 'default'})`
            : '';
          return text(`Swiped ${args.direction}${centerNote} on device ${device_id}.`);
        }
        const { x1, y1, x2, y2 } = requireArgs(args, ['x1', 'y1', 'x2', 'y2']);
        await adbClient.swipe(ADB_PATH, device_id, Number(x1), Number(y1), Number(x2), Number(y2), Number(durationMs));
        return text(`Swiped (${x1},${y1}) → (${x2},${y2}) in ${durationMs}ms on device ${device_id}.`);
      }


      case 'press_key': {
        const { key } = requireArgs(args, ['key']);
        const device_id = args?.device_id ?? null;
        await adbClient.pressKey(ADB_PATH, device_id, String(key));
        return text(`Pressed key "${key}" on device ${device_id}.`);
      }


      case 'open_app': {
        const { package_name } = requireArgs(args, ['package_name']);
        const device_id = args?.device_id ?? null;
        await adbClient.launchApp(ADB_PATH, device_id, package_name);
        return text(`Launched app "${package_name}" on device ${device_id}.`);
      }


      case 'open_url': {
        const { url } = requireArgs(args, ['url']);
        const device_id = args?.device_id ?? null;
        await adbClient.openUrl(ADB_PATH, device_id, url);
        return text(`Opened URL "${url}" on device ${device_id}.`);
      }


      case 'list_installed_apps': {
        const device_id = args?.device_id ?? null;
        const packages = await adbClient.listInstalledPackages(ADB_PATH, device_id);
        return text(
          `Installed packages on ${device_id} (${packages.length} total):\n${packages.sort().join('\n')}`,
        );
      }


      case 'get_foreground_app': {
        const device_id = args?.device_id ?? null;
        const { currentFocus, focusedApp } = await adbClient.getForegroundApp(ADB_PATH, device_id);
        const lines = [
          `Foreground app on device ${device_id}:`,
          `  mCurrentFocus : ${currentFocus ?? '(not found)'}`,
          `  mFocusedApp   : ${focusedApp ?? '(not found)'}`,
        ];
        return text(lines.join('\n'));
      }


      case 'rotate_screen': {
        const { rotation } = requireArgs(args, ['rotation']);
        const device_id = args?.device_id ?? null;
        await adbClient.rotate(ADB_PATH, device_id, Number(rotation));
        const labels = ['portrait', 'landscape', 'reverse portrait', 'reverse landscape'];
        return text(`Rotated device ${device_id} to ${labels[rotation] ?? rotation}.`);
      }


      case 'adb_connect': {
        const { ip } = requireArgs(args, ['ip']);
        const result = await adbClient.adbConnect(ADB_PATH, String(ip), Number(args.port ?? 5555));
        return text(`ADB connect result: ${result}`);
      }


      case 'adb_disconnect': {
        const result = await adbClient.adbDisconnect(ADB_PATH, args.target);
        return text(`ADB disconnect result: ${result}`);
      }


      case 'enable_wireless_adb': {
        const device_id = args?.device_id ?? null;
        await adbClient.adbTcpip(ADB_PATH, device_id, Number(args.port ?? 5555));
        return text(
          `TCP/IP mode enabled on device ${device_id} (port ${args.port ?? 5555}). ` +
          `Now call get_device_ip, then disconnect USB and call adb_connect.`
        );
      }


      case 'get_device_ip': {
        const device_id = args?.device_id ?? null;
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


      case 'force_stop_app': {
        const { package_name } = requireArgs(args, ['package_name']);
        const device_id = args?.device_id ?? null;
        await adbClient.forceStopApp(ADB_PATH, device_id, package_name);
        return text(`Force-stopped "${package_name}" on device ${device_id}.`);
      }


      case 'is_app_installed': {
        const { package_name } = requireArgs(args, ['package_name']);
        const device_id = args?.device_id ?? null;
        const installed = await adbClient.isAppInstalled(ADB_PATH, device_id, package_name);
        return text(`"${package_name}" is ${installed ? 'INSTALLED' : 'NOT installed'} on device ${device_id}.`);
      }


      case 'get_screen_size': {
        const device_id = args?.device_id ?? null;
        const { width, height } = await adbClient.getScreenSize(ADB_PATH, device_id);
        return text(`Screen size of device ${device_id}: ${width} x ${height} pixels.`);
      }


      case 'dump_ui_xml': {
        const device_id = args?.device_id ?? null;
        const xml = await adbClient.getRawUiXml(ADB_PATH, device_id);
        return text(xml);
      }


      case 'find_element': {
        const { selector } = requireArgs(args, ['selector']);
        const device_id = args?.device_id ?? null;
        const el = findElement(parseUiXml(await adbClient.uiDump(ADB_PATH, device_id)), selector);
        if (!el) return text(`No element found matching selector: ${JSON.stringify(selector)}`);
        return text(`Element found:\n${JSON.stringify(el, null, 2)}`);
      }


      case 'tap_by_selector': {
        const { selector } = requireArgs(args, ['selector']);
        const device_id = args?.device_id ?? null;
        const el = findElement(parseUiXml(await adbClient.uiDump(ADB_PATH, device_id)), selector);
        if (!el) throw new Error(`No element found matching selector: ${JSON.stringify(selector)}`);
        await adbClient.tapBounds(ADB_PATH, device_id, el.bounds);
        const cx = Math.floor((el.bounds[0] + el.bounds[2]) / 2);
        const cy = Math.floor((el.bounds[1] + el.bounds[3]) / 2);
        return text(`Tapped "${el.text || el.contentDesc || el.id}" at (${cx}, ${cy}) on device ${device_id}.`);
      }


      case 'wait_for_element': {
        const { selector } = requireArgs(args, ['selector']);
        const device_id = args?.device_id ?? null;
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


      case 'type_in_element': {
        const { selector, text: inputText } = requireArgs(args, ['selector', 'text']);
        const device_id = args?.device_id ?? null;
        const el = findElement(parseUiXml(await adbClient.uiDump(ADB_PATH, device_id)), selector);
        if (!el) throw new Error(`No element found matching selector: ${JSON.stringify(selector)}`);
        await adbClient.tapBounds(ADB_PATH, device_id, el.bounds);
        await new Promise((r) => setTimeout(r, 300));
        await adbClient.clearInputAndType(ADB_PATH, device_id, inputText);
        return text(`Typed into "${el.text || el.contentDesc || el.id}" on device ${device_id}.`);
      }


      case 'assert_element_exists': {
        const { selector } = requireArgs(args, ['selector']);
        const device_id = args?.device_id ?? null;
        const el = findElement(parseUiXml(await adbClient.uiDump(ADB_PATH, device_id)), selector);
        if (!el) return text(`FAIL: No element found matching selector: ${JSON.stringify(selector)}`);
        return text(`PASS: Element exists.\n${JSON.stringify(el, null, 2)}`);
      }


      case 'go_home': {
        const device_id = args?.device_id ?? null;
        await adbClient.pressKey(ADB_PATH, device_id, 'home');
        return text(`Pressed Home on device ${device_id}.`);
      }


      case 'go_back': {
        const device_id = args?.device_id ?? null;
        await adbClient.pressKey(ADB_PATH, device_id, 'back');
        return text(`Pressed Back on device ${device_id}.`);
      }


      case 'open_recents': {
        const device_id = args?.device_id ?? null;
        await adbClient.pressKey(ADB_PATH, device_id, 'recent');
        return text(`Opened recent apps on device ${device_id}.`);
      }


      case 'get_device_info': {
        const device_id = args?.device_id ?? null;
        const info = await adbClient.getDeviceInfo(ADB_PATH, device_id);

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


      case 'assert_foreground_app': {
        const { package_name } = requireArgs(args, ['package_name']);
        const device_id = args?.device_id ?? null;
        const { currentFocus, focusedApp } = await adbClient.getForegroundApp(ADB_PATH, device_id);
        const combined = `${currentFocus ?? ''} ${focusedApp ?? ''}`;
        const pass = combined.includes(package_name);
        return text(
          `${pass ? 'PASS' : 'FAIL'}: Expected "${package_name}" in foreground.\n` +
          `  mCurrentFocus : ${currentFocus ?? '(not found)'}\n` +
          `  mFocusedApp   : ${focusedApp ?? '(not found)'}`,
        );
      }


      case 'post_notification': {
        const { title, text: body } = requireArgs(args, ['title', 'text']);
        const device_id = args?.device_id ?? null;
        await adbClient.postNotification(ADB_PATH, device_id, {
          title,
          text: body,
          tag: args.tag ?? 'aiphone',
          style: args.style ?? 'bigtext',
        });
        return text(`Notification posted on device ${device_id}: "${title}" — ${body}`);
      }

      case 'dump_notifications': {
        const device_id = args?.device_id ?? null;
        const output = await adbClient.dumpNotifications(ADB_PATH, device_id);
        return text(output);
      }

      case 'set_wifi': {
        const { enable } = requireArgs(args, ['enable']);
        const device_id = args?.device_id ?? null;
        await adbClient.setWifi(ADB_PATH, device_id, Boolean(enable));
        return text(`WiFi ${enable ? 'enabled' : 'disabled'} on device ${device_id}.`);
      }

      case 'set_mobile_data': {
        const { enable } = requireArgs(args, ['enable']);
        const device_id = args?.device_id ?? null;
        await adbClient.setMobileData(ADB_PATH, device_id, Boolean(enable));
        return text(`Mobile data ${enable ? 'enabled' : 'disabled'} on device ${device_id}.`);
      }

      case 'set_airplane_mode': {
        const { enable } = requireArgs(args, ['enable']);
        const device_id = args?.device_id ?? null;
        await adbClient.setAirplaneMode(ADB_PATH, device_id, Boolean(enable));
        return text(`Airplane mode ${enable ? 'enabled' : 'disabled'} on device ${device_id}.`);
      }

      case 'adb_shell': {
        const { command } = requireArgs(args, ['command']);
        const device_id = args?.device_id ?? null;
        const output = await adbClient.adbShell(ADB_PATH, device_id, command);
        return text(output || '(no output)');
      }

      case 'long_press': {
        const { x, y } = requireArgs(args, ['x', 'y']);
        const device_id = args?.device_id ?? null;
        const durationMs = args.duration_ms ?? 1000;
        await adbClient.longPress(ADB_PATH, device_id, Number(x), Number(y), Number(durationMs));
        return text(`Long-pressed at (${x}, ${y}) for ${durationMs}ms on device ${device_id}.`);
      }

      case 'clear_text': {
        const device_id = args?.device_id ?? null;
        await adbClient.clearText(ADB_PATH, device_id);
        return text(`Cleared text in focused field on device ${device_id}.`);
      }

      case 'get_input_method': {
        const device_id = args?.device_id ?? null;
        const ime = await adbClient.getInputMethod(ADB_PATH, device_id);
        return text(`Active input method on device ${device_id}: ${ime}`);
      }

      case 'set_input_method': {
        const { ime } = requireArgs(args, ['ime']);
        const device_id = args?.device_id ?? null;
        await adbClient.setInputMethod(ADB_PATH, device_id, String(ime));
        return text(`Input method set to "${ime}" on device ${device_id}.`);
      }

      case 'is_connected': {
        const device_id = args?.device_id ?? null;
        const connected = await adbClient.isConnected(ADB_PATH, device_id);
        if (device_id) {
          return text(`Device "${device_id}" is ${connected ? 'CONNECTED' : 'NOT connected'}.`);
        }
        return text(`ADB: ${connected ? 'At least one device is connected.' : 'No devices connected.'}`);
      }

      case 'restart_adb_server': {
        await adbClient.restartAdbServer(ADB_PATH);
        return text('ADB server restarted (kill-server + start-server).');
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



const transport = new StdioServerTransport();
await server.connect(transport).catch((err) => {
  process.stderr.write(`[aiphone-mcp] Failed to start: ${err.message}\n`);
  process.exit(1);
});
