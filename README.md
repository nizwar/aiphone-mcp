# aiphone-mcp

MCP server for controlling Android devices via ADB. Exposes tools for screenshots, UI interaction, app management, wireless ADB, and device diagnostics.

Works with any MCP-compatible client: LM Studio, Claude Desktop, Cursor, Windsurf.

---

## Features

- Screenshots with automatic compression (WebP, JPEG, PNG)
- UI inspection — tap, swipe, type, find elements by selector
- App control — launch, stop, install checks, open URLs
- Wireless ADB over TCP/IP
- Device info — battery, memory, storage, network interfaces
- Navigation — home, back, recents, screen rotation
- Notifications — post and inspect system notifications
- Connectivity — toggle WiFi, mobile data, airplane mode 
- Assertions — foreground app and element presence checks
- Escape hatch — run any arbitrary `adb shell` command

---

## Requirements

- Node.js 18+
- [ADB](https://developer.android.com/studio/releases/platform-tools) in your PATH
- Android 8+ with USB Debugging enabled

To enable USB Debugging: Settings → About Phone → tap Build Number 7 times → Developer Options → USB Debugging.

---

## Installation

**npx** (no install needed):
```bash
npx aiphone-mcp
```

**Global install**:
```bash
npm install -g aiphone-mcp
```

**Local clone**:
```bash
git clone <repository-url>
cd aiphone-mcp
npm install
npm link
```

---

## Client Configuration

All clients use the same config structure. The entry point is `npx aiphone-mcp`.

```json
{
  "aiphone": {
    "command": "npx",
    "args": ["aiphone-mcp"]
  }
}
```

---

## Configuration
 
| Variable | Default | Description |
|----------|---------|-------------| 
| `AIPHONE_ADB_PATH` | `adb` | Path to adb binary |


```json
{
  "aiphone": {
    "command": "npx",
    "args": ["aiphone-mcp"],
    "env": {
      "AIPHONE_ADB_PATH": "/usr/local/bin/adb", 
    }
  }
}
```

---

## Available Tools

### Device

| Tool | Description |
|------|-------------|
| `list_devices` | List all connected ADB device serials |
| `get_device_info` | Full hardware identity, battery, memory, storage, and network info |
| `get_screen_size` | Physical screen resolution in pixels |
| `get_foreground_app` | Package and window currently visible to the user |

### Screen Observation

| Tool | Description |
|------|-------------|
| `take_screenshot` | Capture the screen as an optimized image (WebP by default). Supports `max_width`, `max_height`, `format`, and `quality` parameters. |
| `get_ui_elements` | Parsed list of interactive UI elements from the UIAutomator hierarchy |
| `dump_ui_xml` | Raw UIAutomator XML hierarchy string |

### Interaction

| Tool | Description |
|------|-------------|
| `tap` | Tap at absolute screen coordinates |
| `double_tap` | Double-tap at absolute screen coordinates |
| `tap_element` | Tap the center of an element by its bounds array `[x1, y1, x2, y2]` |
| `tap_by_selector` | Find an element by selector and tap it |
| `swipe` | Swipe gesture — directional (`up`, `down`, `left`, `right`) or coordinate-based |
| `type_text` | Type text into the currently focused input field |
| `type_in_element` | Find an input field by selector, focus it, clear existing text, and type |
| `press_key` | Press a key by name (`back`, `home`, `enter`, `search`, `delete`, ...) or numeric keycode |

### Element Selectors

| Tool | Description |
|------|-------------|
| `find_element` | Find an element by `resourceId`, `text`, `contentDesc`, or `className` |
| `wait_for_element` | Poll until a matching element appears or timeout elapses |
| `assert_element_exists` | Assert that an element matching a selector is present — returns PASS/FAIL |

### Navigation

| Tool | Description |
|------|-------------|
| `go_home` | Press the Home button |
| `go_back` | Press the Back button |
| `open_recents` | Open the recent apps switcher |
| `rotate_screen` | Set device rotation: 0=portrait, 1=landscape, 2=reverse portrait, 3=reverse landscape |
| `delay` | Wait for a specified number of milliseconds (max 10 000) |

### App Control

| Tool | Description |
|------|-------------|
| `open_app` | Launch an app by package name using the LAUNCHER intent |
| `open_url` | Open a URL in the device default browser |
| `force_stop_app` | Force-stop an app by package name |
| `is_app_installed` | Check whether a package is installed on the device |
| `list_installed_apps` | Return all installed package names |
| `assert_foreground_app` | Assert a package is currently in the foreground — returns PASS/FAIL |

### Wireless ADB

| Tool | Description |
|------|-------------|
| `enable_wireless_adb` | Switch a USB-connected device to TCP/IP mode (run before disconnecting USB) |
| `get_device_ip` | Return all active network interfaces with IP addresses |
| `adb_connect` | Connect to a device over TCP/IP at a given IP and port |
| `adb_disconnect` | Disconnect a wireless ADB target, or all wireless devices if no target is specified |

### Notifications

| Tool | Description |
|------|-------------|
| `post_notification` | Post a system notification (`bigtext`, `inbox`, or `media` style) |
| `dump_notifications` | Return raw `dumpsys notification` output — active notifications and history |

### Connectivity

| Tool | Description |
|------|-------------|
| `set_wifi` | Enable or disable WiFi |
| `set_mobile_data` | Enable or disable mobile data |
| `set_airplane_mode` | Enable or disable airplane mode |

### Escape Hatch

| Tool | Description |
|------|-------------|
| `adb_shell` | Run any arbitrary `adb shell` command — use when no other tool covers the action |

---

## Screenshot Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `max_width` | integer | 1080 | Max width in pixels (downscales proportionally) |
| `max_height` | integer | 1920 | Max height in pixels (downscales proportionally) |
| `format` | string | `webp` | `webp`, `jpeg`, or `png` |
| `quality` | integer | 75 | Compression quality 1–100 (ignored for PNG) |

Images are never upscaled.

---

## Selectors

Tools that locate elements accept a `selector` object with these fields:

| Field | Match | Example |
|-------|-------|---------|
| `resourceId` | Exact | `"com.example.app:id/search_bar"` |
| `text` | Substring | `"Sign in"` |
| `contentDesc` | Substring | `"Close button"` |
| `className` | Exact | `"android.widget.EditText"` |
| `clickableOnly` | Filter | `true` |

Priority: `resourceId` > `text` > `contentDesc` > `className`.

---

## Troubleshooting

**No devices found** — check that USB Debugging is enabled and the device is authorized. Run `adb devices` to verify.

**adb not found** — make sure `adb` is in your PATH, or set `AIPHONE_ADB_PATH` to the full binary path.

**Wireless connection fails** — both machines must be on the same network. Run `enable_wireless_adb` while USB is still connected, get the IP with `get_device_ip`, then call `adb_connect`.

**Screenshot too large** — use `max_width: 720, format: "webp"` to reduce output size.

---

## License

MIT. See [LICENSE](LICENSE) for the full text.
