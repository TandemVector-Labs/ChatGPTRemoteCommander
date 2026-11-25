// Single source of GUI request schemas AND runtime validation. No input coercion.
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const str = (maxLength = 128) => ({ type: 'string', minLength: 1, maxLength });
const choice = (...values) => ({ type: 'string', enum: values });
const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const lease = { lease: str(128) };
const guarded = { ...lease, frame: str(128) };
const point = {
  x: { type: 'number', minimum: -65536, maximum: 65536 },
  y: { type: 'number', minimum: -65536, maximum: 65536 },
  coordinateMode: choice('absolute', 'relative'),
  screenIndex: integer(0, 31)
};
const button = choice('left', 'right', 'middle');
const sessionMode = choice('observe', 'takeover');
const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
// Clicking/typing/focusing can submit a form, overwrite work, or close an app.
const mutation = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
const coordination = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const defs = [
  ['gui_status', 'Report GUI policy and native desktop readiness. Does not capture the screen.', object(), 'status', null, ro],
  ['gui_session_begin', 'Acquire the single desktop coordination lease. Defaults to observe-only. Desktop input or focus requires mode=takeover and explicitUserAuthorization grounded in an explicit current user request. Busy sessions are not stolen.', object({ ttlSeconds: integer(10, 120), mode: sessionMode, explicitUserAuthorization: str(500) }), null, null, coordination],
  ['gui_session_renew', 'Renew a live desktop lease; does not revive an expired one.', object({ ...lease, ttlSeconds: integer(10, 120) }, ['lease']), null, null, coordination],
  ['gui_session_end', 'End your desktop lease without stopping other services.', object(lease, ['lease']), null, null, coordination],
  ['gui_screenshot', 'Capture one monitor as an MCP image. Returns native pixel bounds and a short-lived, single-use frame token for the next action.', object({ ...lease, screenIndex: integer(0, 31), format: choice('jpeg', 'png'), quality: integer(25, 90), maxWidth: integer(320, 1920) }, ['lease']), 'screenshot', 'allowScreenshot', ro],
  ['gui_cursor_position', 'Read cursor position for this lease.', object(lease, ['lease']), 'cursor', 'allowMouse', ro],
  ['gui_list_windows', 'List visible window handles, titles, and process IDs. Window titles may contain private data.', object(lease, ['lease']), 'listWindows', 'allowWindowEnumeration', ro],
  ['gui_mouse_move', 'Move within the monitor shown in a fresh frame.', object({ ...guarded, ...point }, ['lease', 'frame', 'x', 'y']), 'move', 'allowMouse', mutation],
  ['gui_mouse_delta', 'Apply a bounded relative mouse movement; not a low-latency game controller.', object({ ...guarded, dx: integer(-1000, 1000), dy: integer(-1000, 1000) }, ['lease', 'frame', 'dx', 'dy']), 'moveRelative', 'allowMouse', mutation],
  ['gui_mouse_scroll', 'Scroll the current foreground window after validating a fresh observation.', object({ ...guarded, delta: integer(-1200, 1200), horizontal: { type: 'boolean' } }, ['lease', 'frame', 'delta']), 'scroll', 'allowMouse', mutation],
  ['gui_mouse_click', 'Click a location from a fresh frame. Follow with a screenshot to verify the result.', object({ ...guarded, ...point, button, clicks: integer(1, 2), intervalMs: integer(20, 300) }, ['lease', 'frame', 'x', 'y']), 'click', 'allowMouse', mutation],
  ['gui_mouse_drag', 'Drag within the observed monitor; Escape or the local stop file cancels.', object({ ...guarded, from: object(point, ['x', 'y']), to: object(point, ['x', 'y']), button, durationMs: integer(50, 3000), steps: integer(2, 120) }, ['lease', 'frame', 'from', 'to']), 'drag', 'allowMouse', mutation],
  ['gui_type_text', 'Type literal Unicode text into the observed foreground window; never use this to enter secrets via chat.', object({ ...guarded, text: { type: 'string', minLength: 1, maxLength: 1024 }, intervalMs: integer(0, 100) }, ['lease', 'frame', 'text']), 'typeText', 'allowKeyboard', mutation],
  ['gui_key_press', 'Press validated keys then release them in finally. No cross-call held keys.', object({ ...guarded, keys: { type: 'array', minItems: 1, maxItems: 6, items: str(12) }, holdMs: integer(0, 3000) }, ['lease', 'frame', 'keys']), 'keyPress', 'allowKeyboard', mutation],
  ['gui_focus_window', 'Focus one exact observed handle. Title matches must be unique; focus failure is an error.', object({ ...guarded, handle: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' }, titleContains: str(160) }, ['lease', 'frame']), 'focusWindow', 'allowWindowFocus', mutation]
];
export const GUI_RULES = new Map(defs.map(([name, description, inputSchema, action, capability, annotations]) => [name, { name, description, inputSchema, action, capability, annotations }]));
export const guiToolDefinitions = [...GUI_RULES.values()].map(({ action, capability, ...definition }) => definition);

export function guiError(code) { return Object.assign(new Error(code), { rpcCode: -32602, guiCode: code }); }
export function validateValue(schema, value, label = 'arguments') {
  const reject = () => { throw guiError(`GUI_INVALID_${label}`); };
  switch (schema.type) {
    case 'object':
      if (value === null || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject();
      for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key)) reject();
      for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) reject();
      for (const [key, item] of Object.entries(value)) validateValue(schema.properties[key], item, `${label}.${key}`);
      break;
    case 'array':
      if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) reject();
      value.forEach((item) => validateValue(schema.items, item, label)); break;
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isSafeInteger(value)) || value < schema.minimum || value > schema.maximum) reject();
      break;
    case 'string':
      if (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 1024) || (schema.pattern && !new RegExp(schema.pattern).test(value))) reject();
      break;
    case 'boolean': if (typeof value !== 'boolean') reject(); break;
    default: reject();
  }
  if (schema.enum && !schema.enum.includes(value)) reject();
}
const aliases = { CONTROL: 'CTRL', WINDOWS: 'WIN', RETURN: 'ENTER', ESCAPE: 'ESC', DEL: 'DELETE', INS: 'INSERT', PAGEUP: 'PGUP', PAGEDOWN: 'PGDN' };
const namedKeys = new Set(['CTRL', 'SHIFT', 'ALT', 'WIN', 'ENTER', 'TAB', 'ESC', 'SPACE', 'BACKSPACE', 'DELETE', 'INSERT', 'HOME', 'END', 'PGUP', 'PGDN', 'LEFT', 'RIGHT', 'UP', 'DOWN']);
export function validateGuiInput(name, input) {
  const rule = GUI_RULES.get(name);
  if (!rule) throw guiError('GUI_UNKNOWN_TOOL');
  validateValue(rule.inputSchema, input);
  for (const p of [input, input.from, input.to].filter(Boolean)) {
    if (p.coordinateMode === 'relative' && (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) throw guiError('GUI_RELATIVE_RANGE');
    if (p.x !== undefined && (p.coordinateMode ?? 'absolute') === 'absolute' && (!Number.isInteger(p.x) || !Number.isInteger(p.y))) throw guiError('GUI_PIXEL_INTEGER');
  }
  if (name === 'gui_session_begin') {
    const mode = input.mode ?? 'observe';
    if (mode === 'takeover') {
      const authorization = input.explicitUserAuthorization?.trim();
      if (!authorization || authorization.length < 8) throw guiError('GUI_EXPLICIT_TAKEOVER_AUTHORIZATION_REQUIRED');
    } else if (input.explicitUserAuthorization !== undefined) {
      throw guiError('GUI_TAKEOVER_AUTHORIZATION_WITHOUT_TAKEOVER');
    }
  }
  if (name === 'gui_focus_window' && (Number(!!input.handle) + Number(!!input.titleContains) !== 1)) throw guiError('GUI_EXACTLY_ONE_WINDOW_SELECTOR');
  if (name === 'gui_type_text') {
    if (!input.text.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(input.text)) throw guiError('GUI_INVALID_TEXT');
    if (input.text.length * (input.intervalMs ?? 0) > 3000) throw guiError('GUI_DURATION_LIMIT');
  }
  if (name === 'gui_key_press') {
    const keys = input.keys.map(k => aliases[k.toUpperCase()] ?? k.toUpperCase());
    if (new Set(keys).size !== keys.length || keys.some(k => !namedKeys.has(k) && !/^[A-Z0-9]$|^F(?:[1-9]|1[0-9]|2[0-4])$/.test(k))) throw guiError('GUI_INVALID_KEY');
    // Escape is the always-available human emergency stop, not injected by this interface.
    if (keys.includes('ESC')) throw guiError('GUI_ESCAPE_RESERVED_FOR_STOP');
    return { ...input, keys };
  }
  return { ...input };
}
