/**
 * UIAutomator XML hierarchy parser.
 * Mirrors the Dart UiAutomatorParser — produces a flat list of UiElements.
 */
import { XMLParser } from 'fast-xml-parser';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  allowBooleanAttributes: true,
});

/**
 * @typedef {Object} UiElement
 * @property {string} id         - "el_N"
 * @property {string} text
 * @property {string} contentDesc
 * @property {number[]} bounds   - [x1, y1, x2, y2]
 * @property {boolean} clickable
 * @property {boolean} enabled
 * @property {string|null} resourceId
 * @property {string|null} className
 */

/**
 * Parses a UIAutomator XML string into a flat array of UiElement objects.
 * @param {string} xmlString
 * @returns {UiElement[]}
 */
export function parseUiXml(xmlString) {
  if (!xmlString || !xmlString.trim()) return [];

  let doc;
  try {
    doc = xmlParser.parse(xmlString);
  } catch {
    return [];
  }

  const elements = [];
  let idCounter = 0;

  function visit(node) {
    if (typeof node !== 'object' || node === null) return;

    // Handle array of same-named child nodes
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }

    // Extract node attributes
    const boundsStr = node['@_bounds'];
    if (boundsStr) {
      const bounds = parseBounds(boundsStr);
      if (bounds) {
        elements.push({
          id: `el_${idCounter++}`,
          text: node['@_text'] ?? '',
          contentDesc: node['@_content-desc'] ?? '',
          bounds,
          clickable: node['@_clickable'] === 'true',
          enabled: node['@_enabled'] !== 'false',
          resourceId: node['@_resource-id'] || null,
          className: node['@_class'] || null,
        });
      }
    }

    // Recurse into child nodes (any key that doesn't start with @_)
    for (const key of Object.keys(node)) {
      if (key.startsWith('@_')) continue;
      visit(node[key]);
    }
  }

  // The root element of a UIAutomator dump is <hierarchy>
  const hierarchy = doc['hierarchy'] ?? doc;
  visit(hierarchy);

  return elements;
}

function parseBounds(raw) {
  const m = raw.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), parseInt(m[4], 10)];
}

/**
 * Serialises elements to a compact JSON-friendly array (mirrors PromptBuilder).
 * @param {UiElement[]} elements
 * @param {number} limit
 * @returns {object[]}
 */
export function compactElements(elements, limit = 25) {
  const prioritized = [...elements].sort((a, b) => {
    const aScore = (a.clickable ? 2 : 0) + (a.text || a.contentDesc ? 1 : 0);
    const bScore = (b.clickable ? 2 : 0) + (b.text || b.contentDesc ? 1 : 0);
    return bScore - aScore;
  });

  return prioritized.slice(0, limit).map((e) => ({
    id: e.id,
    text: e.text,
    content_desc: e.contentDesc,
    clickable: e.clickable,
    bounds: e.bounds,
    ...(e.resourceId ? { resource_id: e.resourceId } : {}),
    ...(e.className ? { class: e.className } : {}),
  }));
}

/**
 * Finds the best matching UiElement for a selector object.
 *
 * Selector fields (all optional, evaluated with AND logic):
 *   resourceId   – exact match against element.resourceId
 *   text         – case-insensitive substring match against element.text
 *   contentDesc  – case-insensitive substring match against element.contentDesc
 *   className    – exact match against element.className
 *   clickableOnly – if true, skip non-clickable elements
 *
 * Priority order when multiple elements match: resourceId first, then text, etc.
 *
 * @param {UiElement[]} elements
 * @param {object} selector
 * @returns {UiElement|null}
 */
export function findElement(elements, selector = {}) {
  const { resourceId, text, contentDesc, className, clickableOnly } = selector;
  for (const el of elements) {
    if (clickableOnly && !el.clickable) continue;
    if (resourceId !== undefined && el.resourceId !== resourceId) continue;
    if (text !== undefined && !el.text.toLowerCase().includes(text.toLowerCase())) continue;
    if (contentDesc !== undefined && !el.contentDesc.toLowerCase().includes(contentDesc.toLowerCase())) continue;
    if (className !== undefined && el.className !== className) continue;
    return el;
  }
  return null;
}
