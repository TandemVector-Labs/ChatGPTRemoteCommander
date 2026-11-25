import { createConnection } from 'node:net';
import { createHmac } from 'node:crypto';

const SOCKETS = Object.freeze({
  linux: '/run/chatgpt-remote-commander/privileged.sock',
  win32: String.raw`\\.\pipe\ChatGPTRemoteCommanderPrivilegeV1`
});
const ACTIONS = Object.freeze({
  linux: Object.freeze(['os.probe', 'system_unit.status', 'system_unit.start']),
  win32: Object.freeze(['os.probe', 'broker.task.status'])
});

/** Fixed-action client: never interpolates a command, path, target unit, or shell. */
export async function requestPrivilegeBroker(action, {
  platform = process.platform,
  socketPath = SOCKETS[platform],
  timeoutMs = platform === 'win32' ? 4000 : 1200,
  dial = createConnection
} = {}) {
  if (!Object.hasOwn(ACTIONS, platform)) return { ok: false, code: 'BROKER_PLATFORM_NOT_SUPPORTED' };
  if (!ACTIONS[platform].includes(action)) return { ok: false, code: 'BROKER_ACTION_NOT_ALLOWED' };
  if (typeof socketPath !== 'string' || socketPath !== SOCKETS[platform] || socketPath.length > 240 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5000) {
    return { ok: false, code: 'BROKER_CLIENT_INVALID_OPTIONS' };
  }
  const oneAttempt = () => new Promise((resolve) => {
    let socket;
    let completed = false;
    let buffer = '';
    function finish(value) {
      if (completed) return;
      completed = true;
      socket?.destroy();
      resolve(value);
    }
    try {
      socket = dial({ path: socketPath });
      socket.setTimeout(timeoutMs);
      socket.on('connect', () => {
        socket.write(JSON.stringify({ action }) + '\n');
      });
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (Buffer.byteLength(buffer, 'utf8') > 4096) {
          finish({ ok: false, code: 'BROKER_RESPONSE_OVERSIZE' });
          return;
        }
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        let value;
        try { value = JSON.parse(buffer.slice(0, newline)); }
        catch { finish({ ok: false, code: 'BROKER_RESPONSE_INVALID' }); return; }
        if (value === null || typeof value !== 'object' || Array.isArray(value) ||
            typeof value.ok !== 'boolean') {
          finish({ ok: false, code: 'BROKER_RESPONSE_INVALID' });
          return;
        }
        if (value.action !== undefined && value.action !== action) {
          finish({ ok: false, code: 'BROKER_ACTION_MISMATCH' });
          return;
        }
        if (action === 'os.probe' && value.ok === true) {
          if (platform === 'linux' && (value.root !== true || value.effectiveUid !== 0)) {
            finish({ ok: false, code: 'BROKER_ROOT_NOT_VERIFIED' });
            return;
          }
          if (platform === 'win32' && (value.isSystem !== true || value.sid !== 'S-1-5-18')) {
            finish({ ok: false, code: 'BROKER_SYSTEM_NOT_VERIFIED' });
            return;
          }
        }
        finish(value);
      });
      socket.on('timeout', () => finish({ ok: false, code: 'BROKER_TIMEOUT' }));
      socket.on('error', (error) => finish({
        ok: false, code: ['EACCES', 'EPERM'].includes(error.code) ? 'BROKER_ACCESS_DENIED' :
          ['ENOENT', 'ECONNREFUSED', 'EBUSY'].includes(error.code)
            ? 'BROKER_UNAVAILABLE' : 'BROKER_TRANSPORT_ERROR'
      }));
      socket.on('end', () => finish({ ok: false, code: 'BROKER_RESPONSE_MISSING' }));
    } catch { finish({ ok: false, code: 'BROKER_CONNECT_FAILED' }); }
  });
  // A single-instance Windows named pipe briefly disappears while the SYSTEM
  // broker closes a completed request and recreates its next listener. Retry
  // ONLY the two read-only fixed actions, and ONLY transient connection
  // unavailability. Never replay auth errors, transport ambiguity, or a
  // potentially mutating native grant request.
  let result = await oneAttempt();
  if (platform !== 'win32' || result.code !== 'BROKER_UNAVAILABLE') return result;
  const deadline = Date.now() + timeoutMs;
  for (const delayMs of [80, 160, 320, 640]) {
    if (Date.now() + delayMs >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, delayMs));
    result = await oneAttempt();
    if (result.code !== 'BROKER_UNAVAILABLE') break;
  }
  return result;
}

export async function privilegeBrokerStatus(options = {}) {
  const platform = options.platform ?? process.platform;
  const response = await requestPrivilegeBroker('os.probe', options);
  if (response.ok !== true) return { installed: false, available: false, reason: response.code ?? 'BROKER_UNVERIFIED' };
  // The OS identity of this fixed-action helper is not a grant to execute
  // arbitrary Administrator/root commands. Existing actions require no repeat
  // elevation, whereas new action classes require separately approved policy.
  // An action being implemented by the broker does not mean THIS profile
  // currently holds its independent native grant. In particular the Linux
  // system-unit mutation is default-denied until a root-managed credential
  // and matching owner-worker credential have both been provisioned.
  const nativeGrantRequiredActions = platform === 'linux'
    ? ['system_unit.start'] : [];
  const scope = {
    actionScope: 'fixed-allowlist',
    supportedActions: [...ACTIONS[platform]],
    allowedActions: ACTIONS[platform].filter(a => !nativeGrantRequiredActions.includes(a)),
    allowedMutations: [],
    nativeGrantRequiredActions,
    nativeProfileBindingVerified: false,
    operationalFullAccess: false,
    unrestrictedAdminShell: false,
    newActionsRequireOwnerConsent: true
  };
  return platform === 'win32'
    ? { ...scope, installed: true, available: true, effectiveSid: 'S-1-5-18',
        noRepeatedUacRequiredForExistingActions: true }
    : { ...scope, installed: true, available: true, effectiveUid: 0,
        noRepeatedSudoRequiredForExistingActions: true };
}


/**
 * Optional Linux V1 native-grant handshake. The key is supplied by a trusted
 * owner-session credential provider, never MCP arguments or profile JSON.
 * Same-UID processes can potentially read one another's client keys; this
 * proves possession of an owner-provisioned bearer grant, NOT distinct ChatGPT
 * identity or independently isolated Windows/Linux principals.
 *
 * The installed Linux broker implements this fixed-action challenge/HMAC protocol.
 * It still fails closed until a root-owned per-profile grant record exists and the
 * matching 32-byte systemd LoadCredentialEncrypted secret is delivered to the
 * owner worker. The audited dev23 Linux hosts currently have neither a grant
 * registry file nor a worker CREDENTIALS_DIRECTORY, so profile mutation is not
 * operational. The Windows broker intentionally exposes only read-only
 * os.probe and broker.task.status; it has no per-profile mutation grant path.
 */
export async function requestGrantedPrivilegeBroker(action, {
  platform = process.platform, profileId, grantKey,
  socketPath = SOCKETS[platform], timeoutMs = 4000,
  dial = createConnection, uidProvider = () => process.getuid?.()
} = {}) {
  if (platform !== 'linux' || action !== 'system_unit.start') {
    return { ok:false, code:'BROKER_GRANT_ACTION_UNSUPPORTED' };
  }
  if (typeof profileId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(profileId) ||
      !Buffer.isBuffer(grantKey) || grantKey.length !== 32) {
    return { ok:false, code:'BROKER_NATIVE_CREDENTIAL_REQUIRED' };
  }
  if (socketPath !== SOCKETS.linux || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 100 || timeoutMs > 5000) {
    return { ok:false, code:'BROKER_CLIENT_INVALID_OPTIONS' };
  }
  const uid = uidProvider();
  if (!Number.isSafeInteger(uid) || uid < 1000) {
    return { ok:false, code:'BROKER_UID_INVALID' };
  }
  return new Promise(resolve => {
    let socket, complete=false, stage='CHALLENGE', buffer='';
    const finish = result => {
      if (complete) return;
      complete=true;
      socket?.destroy();
      resolve(result);
    };
    try {
      socket=dial({ path:socketPath });
      socket.setTimeout(timeoutMs);
      socket.on('connect', () => {
        socket.write(JSON.stringify({ action:'system_unit.start', profile:profileId }) + '\n');
      });
      socket.on('data', chunk => {
        buffer += chunk.toString('utf8');
        if (Buffer.byteLength(buffer, 'utf8') > 4096) {
          finish({ok:false,code:'BROKER_RESPONSE_OVERSIZE'}); return;
        }
        while (buffer.includes('\n') && !complete) {
          const at=buffer.indexOf('\n'), raw=buffer.slice(0,at);
          buffer=buffer.slice(at+1);
          let msg;
          try { msg=JSON.parse(raw); }
          catch { finish({ok:false,code:'BROKER_RESPONSE_INVALID'}); return; }
          if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
            finish({ok:false,code:'BROKER_RESPONSE_INVALID'}); return;
          }
          if (stage === 'CHALLENGE') {
            if (msg.ok === false) {
              finish({ok:false,code:typeof msg.code === 'string' ? msg.code : 'BROKER_GRANT_DENIED'});
              return;
            }
            if (msg.action !== action || msg.profile !== profileId ||
                typeof msg.challenge !== 'string' || !/^[a-f0-9]{64}$/.test(msg.challenge) ||
                !Number.isSafeInteger(msg.revision) || msg.revision < 1) {
              finish({ok:false,code:'BROKER_CHALLENGE_INVALID'}); return;
            }
            const canonical = ['RC_FULL_ACCESS_START_V1',profileId,String(uid),
              String(msg.revision),msg.challenge].join('\n');
            const signature=createHmac('sha256',grantKey).update(canonical,'ascii').digest('hex');
            stage='RESULT';
            socket.write(JSON.stringify({revision:msg.revision,signature})+'\n');
          } else {
            // A successful native mutation must attest the exact action,
            // hardcoded service target, and submitted state. Bare {ok:true}
            // or a response for a different unit is never effect evidence.
            if (typeof msg.ok !== 'boolean' ||
                (msg.action !== undefined && msg.action !== action) ||
                (msg.ok === true && (
                  msg.action !== action ||
                  msg.unit !== 'chatgpt-remote-commander.service' ||
                  msg.submitted !== true
                ))) {
              finish({ok:false,code:'BROKER_RESPONSE_INVALID'}); return;
            }
            finish(msg);
          }
        }
      });
      socket.on('timeout', () => finish({ok:false,code:'BROKER_TIMEOUT'}));
      socket.on('error', error => finish({ok:false,
        code: ['ENOENT','ECONNREFUSED','EACCES'].includes(error.code)
          ? 'BROKER_UNAVAILABLE' : 'BROKER_TRANSPORT_ERROR'}));
      socket.on('end', () => finish({ok:false,code:'BROKER_RESPONSE_MISSING'}));
    } catch {
      finish({ok:false,code:'BROKER_CONNECT_FAILED'});
    }
  });
}
