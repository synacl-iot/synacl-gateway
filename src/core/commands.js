// Downlink commands: gateway commands, device commands, firmware requests and macros.
//
// Dispatch is by the keys present, like the reference firmware, not by schema: the platform
// adds commands and optional keys within v1, and a gateway that errors, reboots or drops a
// message it does not fully recognise breaks. Inbound schema checks are therefore logged only,
// and anything unrecognised is ignored. A command is acknowledged only when it carries a
// correlationId — that is how the platform matches the ack to what it sent.

import { NOT_IN_CONFIG } from './scheduler.js';

/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./types.js').Clock} Clock */

const MACRO_REFUSAL = 'unknown macro (synacl-gateway does not run macros)';

function parse(buf) {
  try {
    const v = JSON.parse(Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** 'gateway.device-cmd' and 'device-cmd' name the same downlink. */
function shortKind(kind) {
  return String(kind || '').replace(/^gateway\./, '');
}

/**
 * @param {Object} deps
 * @param {ReturnType<typeof import('./scheduler.js').createScheduler>} deps.scheduler
 * @param {{restart(): Promise<void>, resetConfig(): Promise<void>, setSim(on: boolean): void}} deps.lifecycle
 * @param {{diag(correlationId: string): Promise<unknown>, startLogs(cats?: number): void, stopLogs(): void}} deps.debug
 * @param {Object|(() => Object)} deps.capabilities  The capability report, or a function returning it.
 * @param {ReturnType<typeof import('./publisher.js').createPublisher>} deps.publisher
 * @param {Logger} deps.log
 * @param {Clock} [deps.clock]
 * @param {{validate(schema: string, value: unknown): {ok: boolean, errors: string[]}}} [deps.validators]
 */
export function createCommands({ scheduler, lifecycle, debug, capabilities, publisher, log, clock, validators }) {
  const cmdLog = log.child ? log.child('commands') : log;
  const macroLog = log.child ? log.child('macros') : log;
  const now = () => (clock ? clock.now() : publisher.now());

  function shapeCheck(schema, body) {
    if (!validators) return;
    try {
      const r = validators.validate(schema, body);
      if (!r.ok) cmdLog.debug(`inbound ${schema} does not match the published schema (handled by keys anyway)`, { errors: r.errors.slice(0, 3) });
    } catch { /* validation is advisory only */ }
  }

  function correlationOf(body) {
    return typeof body.correlationId === 'string' && body.correlationId ? body.correlationId : null;
  }

  async function ackError(deviceId, correlationId, error) {
    if (!correlationId) return;
    await publisher.ack(deviceId, { correlationId, status: 'error', error });
  }

  // ─── device commands ──────────────────────────────────────────────────────────────────

  async function onDeviceCmd(deviceId, body) {
    shapeCheck('device-cmd', body);
    const corr = correlationOf(body);
    const dev = deviceId ? scheduler.snapshot().find((d) => d.id === deviceId) : null;
    if (!dev) {
      cmdLog.warn('command for a device that is not in the applied configuration', { deviceId });
      await ackError(deviceId, corr, NOT_IN_CONFIG);
      return;
    }

    // READ CONTROL (and the stepper `move`) carries `command`.
    if (typeof body.command === 'string') {
      switch (body.command) {
        case 'read/once': {
          if (typeof body.tag !== 'string' || !body.tag) { await ackError(deviceId, corr, 'tag is required'); return; }
          await scheduler.readOnce(deviceId, body.tag, corr);
          return;
        }
        case 'set/interval': {
          const iv = Number(body.interval);
          if (!Number.isFinite(iv)) { cmdLog.warn('set/interval without a numeric interval — ignored', { deviceId }); return; }
          scheduler.setInterval(deviceId, iv);
          return;
        }
        case 'read/disable':
          scheduler.pause(deviceId, body.mode, body.durationMs);
          return;
        case 'read/enable':
          scheduler.resume(deviceId);
          return;
        case 'move':
          cmdLog.warn('stepper move refused', { deviceId, protocol: dev.protocol });
          await ackError(deviceId, corr, `actuator writes are not supported for protocol "${dev.protocol}"`);
          return;
        default:
          cmdLog.debug(`unknown device command "${body.command}" ignored`, { deviceId });
          return;
      }
    }

    // MODBUS WRITE carries `fc` + `address`. `register_type` wins over `fc` (5 → coil,
    // 6 → holding); only single writes are accepted.
    if ('fc' in body || 'register_type' in body) {
      const fc = Number(body.fc);
      let error = null;
      let registerType = typeof body.register_type === 'string' ? body.register_type : '';
      if (!registerType) registerType = fc === 5 ? 'coil' : fc === 6 ? 'holding' : '';
      const address = Number(body.address);
      if (fc === 15 || fc === 16 || Array.isArray(body.value)) error = 'multi-register writes not supported';
      else if (registerType !== 'coil' && registerType !== 'holding') error = 'unknown register type';
      else if (!Number.isInteger(address) || address < 0 || address > 65535) error = 'invalid address';
      else if (typeof body.value !== 'number' || !Number.isFinite(body.value)) error = 'invalid value';
      if (error) {
        cmdLog.warn(`modbus write refused: ${error}`, { deviceId });
        await ackError(deviceId, corr, error);
        return;
      }
      const res = await scheduler.write(deviceId, { kind: 'modbus', registerType, address, value: body.value });
      cmdLog.info(`modbus write ${registerType}@${address}=${body.value} ${res.ok ? 'ok' : `FAILED: ${res.error}`}`, { deviceId });
      if (!corr) return;
      await publisher.ack(deviceId, res.ok
        ? { correlationId: corr, status: 'ok', error: null, value: res.value ?? body.value }
        : { correlationId: corr, status: 'error', error: res.error || 'write failed' });
      return;
    }

    // ACTUATOR WRITE: `value` (+ `dir`) and neither `command` nor `fc`. A driver may implement
    // it; the built-in ones do not, and the scheduler answers with the protocol name.
    if ('value' in body) {
      if (typeof body.value !== 'number' || !Number.isFinite(body.value)) { await ackError(deviceId, corr, 'invalid value'); return; }
      const op = { kind: 'actuator', value: body.value, ...(body.dir === 0 || body.dir === 1 ? { dir: body.dir } : {}) };
      const res = await scheduler.write(deviceId, op);
      cmdLog.info(`actuator write ${body.value} ${res.ok ? 'ok' : `FAILED: ${res.error}`}`, { deviceId });
      if (!corr) return;
      await publisher.ack(deviceId, res.ok
        ? { correlationId: corr, status: 'ok', error: null, value: res.value ?? body.value }
        : { correlationId: corr, status: 'error', error: res.error || 'write failed' });
      return;
    }

    cmdLog.debug('unrecognised device command ignored', { deviceId });
  }

  // ─── gateway commands ─────────────────────────────────────────────────────────────────

  function background(what, p) {
    // Lifecycle actions tear down the very connection this message arrived on; they run
    // detached so the message handler returns first.
    Promise.resolve().then(p).catch((err) => cmdLog.error(`${what} failed`, { err }));
  }

  async function onGatewayCmd(body) {
    shapeCheck('gateway-cmd', body);
    const command = typeof body.command === 'string' ? body.command : '';
    switch (command) {
      case 'restart':
        cmdLog.info('restart requested by the platform');
        background('restart', () => lifecycle.restart());
        return;
      case 'reset/config':
        cmdLog.info('configuration reset requested by the platform');
        background('reset/config', () => lifecycle.resetConfig());
        return;
      case 'sim/start':
      case 'sim/stop':
        cmdLog.info(`simulation mode ${command === 'sim/start' ? 'on' : 'off'}`);
        lifecycle.setSim(command === 'sim/start');
        return;
      case 'debug/diag': {
        const corr = correlationOf(body);
        if (!corr) { cmdLog.debug('debug/diag without correlationId ignored'); return; }
        await debug.diag(corr);
        return;
      }
      case 'debug/logs/start':
        debug.startLogs(Number.isInteger(body.cats) ? body.cats : undefined);
        return;
      case 'debug/logs/stop':
        debug.stopLogs();
        return;
      case 'job/config':
      case 'ble/scan':
        cmdLog.debug(`${command} ignored (not supported by this gateway)`);
        return;
      default:
        cmdLog.debug(`unknown gateway command "${command}" ignored`);
    }
  }

  // ─── firmware + macros ────────────────────────────────────────────────────────────────

  async function onFirmwareRequest(body) {
    if (body.type === undefined) {
      const report = typeof capabilities === 'function' ? await capabilities() : capabilities;
      if (report) await publisher.gateway('gateway.firmware-response', report);
      return;
    }
    if (body.type === 'update') {
      const v = typeof body.version === 'string' ? body.version : 'latest';
      cmdLog.info(`firmware update to ${v} requested — synacl-gateway is updated with npm (npm i -g synacl-gateway@${v}), not over the air`);
      return;
    }
    cmdLog.debug('firmware/request of an unknown type ignored');
  }

  async function onMacrosRun(body) {
    const { runId, macroId } = body;
    if (typeof runId !== 'string' || typeof macroId !== 'string') { macroLog.debug('macros/run without runId/macroId ignored'); return; }
    macroLog.warn('macro run refused — this gateway does not run macros', { macroId, runId });
    await publisher.gateway('gateway.macro-run-status', { runId, macroId, phase: 'error', message: MACRO_REFUSAL, severity: 'error', ts: now() });
  }

  return {
    /**
     * @param {string} kind  topics.json id of the downlink ('gateway.cmd', 'gateway.device-cmd', …)
     * @param {string|undefined} deviceId
     * @param {Buffer|string} buf
     */
    async onMessage(kind, deviceId, buf) {
      const k = shortKind(kind);
      const body = parse(buf);
      if (!body) { cmdLog.warn(`unparseable ${k} message ignored`); return; }
      try {
        switch (k) {
          case 'device-cmd': await onDeviceCmd(deviceId, body); return;
          case 'cmd': await onGatewayCmd(body); return;
          case 'firmware-request': await onFirmwareRequest(body); return;
          case 'macros-run': await onMacrosRun(body); return;
          case 'macros-push':
            macroLog.info(`macros/push ignored (${Array.isArray(body.macros) ? body.macros.length : 0} macros) — this gateway does not run macros`);
            return;
          case 'macros-abort':
            macroLog.debug('macros/abort ignored');
            return;
          default:
            cmdLog.debug(`downlink "${k}" not handled here`);
        }
      } catch (err) {
        // A command must never take the gateway down.
        cmdLog.error(`${k} handling failed`, { err });
      }
    },
  };
}
