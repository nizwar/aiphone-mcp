# aiphone-mcp

A Model Context Protocol (MCP) server that enables AI assistants to control Android devices via ADB (Android Debug Bridge). The server exposes 35 tools covering screen observation, UI interaction, app lifecycle management, wireless device connectivity, and full hardware and system diagnostics.

Compatible with any MCP-capable client, including LM Studio, Claude Desktop, and Cursor.

---

## Features

- **Screen observation** — take screenshots with automatic compression (WebP, JPEG, PNG)
- **UI inspection and interaction** — tap, double-tap, swipe, type, and query UI elements by selector
- **App control** — launch, force-stop, check installation status, and open URLs
- **Wireless ADB** — enable TCP/IP mode, connect and disconnect devices over Wi-Fi
- **Device diagnostics** — hardware identity, battery, memory, storage, and network interfaces
- **Navigation** — home, back, notifications, recent apps
- **State assertions** — verify foreground app and element presence with PASS/FAIL results

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | 18 or later | Required to run the server |
| ADB | Any current | Part of [Android SDK Platform Tools](https://developer.android.com/studio/releases/platform-tools) |
| Android device | Android 8+ | USB Debugging must be enabled |

**Enable USB Debugging on your device:**  
Settings → Developer Options → USB Debugging → On

If Developer Options is not visible, go to Settings → About Phone and tap Build Number seven times.

---

## Installation

### Option 1 — npx (no installation required)

MCP clients can launch the server on demand using npx. No prior installation step is needed:

```bash
npx aiphone-mcp
```

### Option 2 — Global npm install

```bash
npm install -g aiphone-mcp
```

After installation, the `aiphone-mcp` binary is available directly in your PATH.

### Option 3 — Local development clone

```bash
git clone <repository-url>
cd AIAutomator/mcp
npm install
npm link          # makes aiphone-mcp available globally from this local clone
```

---

## MCP Client Configuration

### LM Studio

Open the MCP servers panel and add the following entry:

```json
{
  "aiphone": {
    "command": "npx",
    "args": ["aiphone-mcp"]
  }
}
```

### Claude Desktop

Edit the configuration file at:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "aiphone": {
      "command": "npx",
      "args": ["aiphone-mcp"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project root, or to the global Cursor MCP settings:

```json
{
  "mcpServers": {
    "aiphone": {
      "command": "npx",
      "args": ["aiphone-mcp"]
    }
  }
}
```

### Windsurf / Codeium

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "aiphone": {
      "command": "npx",
      "args": ["aiphone-mcp"]
    }
  }
}
```

### Local clone (any client)

Replace `npx` with a direct path to the binary:

```json
{
  "aiphone": {
    "command": "node",
    "args": ["/absolute/path/to/AIAutomator/mcp/bin/aiphone-mcp.js"]
  }
}
```

---

## Configuration

The server reads optional JSON configuration files from the `config/` directory. The default location is resolved relative to the MCP project root. Override it with the `AIPHONE_CONFIG_DIR` environment variable.

| File | Purpose |
|------|---------|
| `config/app_config.json` | Ollama endpoint, model names, generation parameters |
| `config/device_config.json` | Per-device persona and role assignments |
| `config/personas.json` | Persona definitions used for role-play automation |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AIPHONE_CONFIG_DIR` | `../config` | Path to the config directory |
| `AIPHONE_ADB_PATH` | `adb` | Absolute path to the adb binary |

Pass environment variables through your MCP client config:

```json
{
  "aiphone": {
    "command": "npx",
    "args": ["aiphone-mcp"],
    "env": {
      "AIPHONE_ADB_PATH": "/usr/local/bin/adb",
      "AIPHONE_CONFIG_DIR": "/absolute/path/to/config"
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
| `open_notifications` | Open the Android notification shade |
| `open_recents` | Open the recent apps switcher |
| `rotate_screen` | Set device rotation: 0=portrait, 1=landscape, 2=reverse portrait, 3=reverse landscape |

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

### Configuration

| Tool | Description |
|------|-------------|
| `get_app_config` | Return the current `app_config.json` settings |
| `list_device_configs` | Return per-device persona assignments from `device_config.json` |

---

## Screenshot Parameters

The `take_screenshot` tool accepts the following optional parameters:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `max_width` | integer | 1080 | Maximum output width in pixels (scales proportionally) |
| `max_height` | integer | 1920 | Maximum output height in pixels (scales proportionally) |
| `format` | string | `webp` | Output format: `webp`, `jpeg`, or `png` |
| `quality` | integer | 75 | Compression quality 1-100 (not applicable for PNG) |

The server never upscales images. If the device resolution is smaller than the specified limits, the image is returned at its native size.

---

## Selector Reference

Several tools accept a `selector` object to locate UI elements:

| Field | Match type | Example |
|-------|-----------|---------|
| `resourceId` | Exact match | `"com.example.app:id/search_bar"` |
| `text` | Substring match | `"Sign in"` |
| `contentDesc` | Substring match | `"Close button"` |
| `className` | Exact match | `"android.widget.EditText"` |
| `clickableOnly` | Boolean filter | `true` |

Matching priority: `resourceId` > `text` > `contentDesc` > `className`.

---

## Troubleshooting

**No devices listed by `list_devices`**  
Ensure USB Debugging is enabled and the device is authorized. On first connection, accept the "Allow USB Debugging" dialog on the device. Run `adb devices` in a terminal to confirm.

**`adb` not found**  
Install the Android SDK Platform Tools and confirm `adb` is in your PATH, or set `AIPHONE_ADB_PATH` to the full binary path.

**Wireless connection fails**  
Both the host machine and the Android device must be on the same Wi-Fi network. Run `enable_wireless_adb` while the device is still connected via USB, obtain the IP with `get_device_ip`, then call `adb_connect` with that IP.

**Screenshot is very large**  
Pass `max_width: 720` and `format: "webp"` to the `take_screenshot` tool to reduce size while preserving quality suitable for vision models.

---

## License

MIT
