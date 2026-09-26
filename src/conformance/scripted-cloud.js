// ScriptedCloud — the platform's gateway-facing behaviour, re-implemented from the public
// protocol and its documented semantics, attached to a MemoryBroker as a peer.
//
// It answers config requests exactly as the platform does (unchanged / full / chunk / silence
// when over budget), stores capability reports wholesale, keeps presence (90 s per device,
// 180 s for the gateway heartbeat), gates live data through the rate model, gates backfill
// through its ceiling, and records everything a scenario may want to assert on.
//
// Every uplink is validated TWICE:
//   - strictly (plain Ajv): an undeclared key is a conformance problem, recorded in `problems`,
//     even though the platform would silently strip it;
//   - the way the platform does (undeclared keys stripped): only a message that fails THAT is
//     dropped, so the scripted cloud reacts to exactly what the real one would process.

import Ajv from 'ajv';
import { createStrictValidators, fnv1a32, gatewayTopics, loadProtocol } from './protocol.js';
import { createRateModel } from './rate-model.js';

/** @typedef {import('../core/types.js').Clock} Clock */

export const DEVICE_WINDOW_MS = 90_000;
export const GATEWAY_STALE_MS = 180_000;
export const LEGACY_PACKET_BYTES = 4096;
export const MQTT_FRAMING_BYTES = 7;
export const CHUNK_ENVELOPE_BYTES = 64;
export const BUSY_CONFIG_MS = 120_000;
export const BUSY_FIRMWARE_MS = 300_000;
export const EMPTY_CONFIG = '{"devices":[],"success":true}';

/** Slice a payload the way the platform does: base64, whole 4-char quanta, `cap − 64` per part. */
export function chunkPayload(payloadStr, hash, cap) {
  const b64 = Buffer.from(payloadStr, 'utf8').toString('base64');
  let per = Math.max(4, cap - CHUNK_ENVELOPE_BYTES);
  per -= per % 4;
  const parts = Math.max(1, Math.ceil(b64.length / per));
  return { parts, per, part: (i) => ({ p: i, n: parts, h: hash, d: b64.slice(i * per, (i + 1) * per) }) };
}

function createLenientValidators() {
  const { schemas } = loadProtocol();
  const ajv = new Ajv({ useDefaults: true, removeAdditional: true, strict: false, validateFormats: false });
  const compiled = {};
  for (const [name, schema] of Object.entries(schemas)) compiled[name] = ajv.compile(schema);
  return (name, value) => (compiled[name] ? compiled[name](value) : false);
}

/**
 * @param {{broker: ReturnType<typeof import('./memory-transport.js').createMemoryBroker>, clock: Clock,
 *          plan?: string|Object, tenantWindowMs?: number}} opts
 */
export function createScriptedCloud({ broker, clock, plan = 'free', tenantWindowMs }) {
  const strict = createStrictValidators();
  const lenient = createLenientValidators();
  const rate = createRateModel({ clock, plan, tenantWindowMs });

  /** @type {Map<string, any>} key `${tenant}/${gateway}` */
  const gateways = new Map();
  const uplinks = [];      // every uplink, parsed and classified
  const problems = [];     // conformance problems: schema, json, topic, retain, direction
  const events = [];       // what the platform would put in the user's event feed
  const commands = [];     // what the cloud sent
  const dataLog = [];      // live data decisions: {deviceId, body, at, accepted, reason, path, ephemeral}
  const backfillLog = [];  // {batch, at, bytes, accepted, dropped}

  const key = (tenant, gateway) => `${tenant}/${gateway}`;
  const now = () => clock.now();
  const event = (e) => { const ev = { at: now(), ...e }; events.push(ev); return ev; };

  function gw(tenant, gateway) {
    let g = gateways.get(key(tenant, gateway));
    if (!g) {
      // An unknown gateway still gets answered (with an empty config) — that is the platform's
      // way of letting a gateway drop a stale cache.
      g = makeGateway({ tenant, gateway, known: false });
      gateways.set(key(tenant, gateway), g);
    }
    return g;
  }

  function makeGateway({ tenant, gateway, known = true, config = EMPTY_CONFIG, capabilities = null, macros = [], jobConfig = null, maxConfigBytes }) {
    const topics = gatewayTopics({ tenant, gateway });
    const g = {
      tenant, gateway, known, topics,
      configString: '',
      capabilities, firmware: null, capsReports: [],
      reportedHash: null,          // what the gateway said it holds, from its last config/request
      busy: null,                  // {reason, until}
      macros,                      // null = never push macros
      jobConfig,                   // null = none configured (the platform then sends nothing)
      presence: null,              // {online, ts}
      heartbeats: [],              // arrival times of online:true status
      deviceDeadline: new Map(),   // deviceId -> offline deadline
      deviceSeen: new Map(),       // deviceId -> [arrival times of data or reachable status]
      deviceStatus: new Map(),     // deviceId -> last status body
      configRequests: [],          // {at, body, result, part}
      configPushes: [],            // {at, kind: 'full'|'unchanged'|'chunk', body, prompted}
      acks: [],
      alerts: [],
      other: [],
    };
    setConfigOn(g, config);
    if (maxConfigBytes != null) g.maxConfigBytes = maxConfigBytes;
    return g;
  }

  function setConfigOn(g, config) {
    g.configString = typeof config === 'string' ? config : Buffer.isBuffer(config) ? config.toString('utf8') : JSON.stringify(config);
    try { g.configDoc = JSON.parse(g.configString); } catch { g.configDoc = { devices: [] }; }
    g.deviceIds = new Set((g.configDoc.devices || []).map((d) => d && d._id).filter(Boolean));
  }

  function budgetFor(g) {
    const advertised = g.capabilities && g.capabilities.maxConfigBytes;
    if (Number.isFinite(advertised) && advertised > 0) return advertised;
    const topic = g.topics.topic('config/push');
    return Math.max(0, LEGACY_PACKET_BYTES - Buffer.byteLength(topic, 'utf8') - MQTT_FRAMING_BYTES);
  }

  const setBusy = (g, reason, ms) => { g.busy = { reason, until: now() + ms }; };
  const clearBusy = (g) => { g.busy = null; };
  const isBusy = (g) => !!(g.busy && g.busy.until > now());

  function publishDown(g, suffix, body, deviceId) {
    const topic = g.topics.topic(suffix, deviceId);
    let payload = typeof body === 'string' ? body : JSON.stringify(body);
    // Test hook: rewrite or swallow what the platform sends (tampered chunks, lost packets).
    if (cloud.downlinkFilter) {
      payload = cloud.downlinkFilter(topic, payload, suffix);
      if (payload == null) return { topic, payload: null };
    }
    broker.publish(topic, payload);
    return { topic, payload };
  }

  // ── presence ──
  function markDeviceSeen(g, deviceId) {
    const at = now();
    const was = (g.deviceDeadline.get(deviceId) || 0) > at;
    g.deviceDeadline.set(deviceId, at + DEVICE_WINDOW_MS);
    if (!g.deviceSeen.has(deviceId)) g.deviceSeen.set(deviceId, []);
    g.deviceSeen.get(deviceId).push(at);
    if (!was) event({ type: 'device/online', gateway: g.gateway, deviceId });
  }
  function evictDevice(g, deviceId, reason, fault) {
    const at = now();
    const was = (g.deviceDeadline.get(deviceId) || 0) > at;
    if (!was) return false;
    g.deviceDeadline.delete(deviceId);
    const type = reason === 'modbus/timeout' ? 'modbus/timeout' : reason === 'link/weak' ? 'link/weak' : 'device/offline';
    event({ type, gateway: g.gateway, deviceId, reason: reason || '', fault: !!fault });
    return true;
  }

  // ── handlers, keyed by topics.json id ──
  const handlers = {
    'gateway.status'(g, body) {
      const prev = g.presence ? g.presence.online : null;
      g.presence = { online: body.online, ts: body.ts || now(), serverTime: !body.ts };
      if (body.online) g.heartbeats.push(now());
      if (prev !== body.online) event({ type: body.online ? 'gateway/online' : 'gateway/offline', gateway: g.gateway });
      if (!body.online) {
        for (const id of [...g.deviceDeadline.keys()]) {
          if (g.deviceDeadline.get(id) > now()) {
            g.deviceDeadline.delete(id);
            event({ type: 'device/offline', gateway: g.gateway, deviceId: id, reason: 'gateway_offline' });
          }
        }
      }
    },
    'gateway.firmware-response'(g, body) {
      if (body.version || body.protocols) {
        if (body.version) g.firmware = body.version;
        if (body.protocols || body.sensorModels) {
          // Replaced wholesale: a field left out reads as unsupported.
          g.capabilities = {
            version: body.version, schemaVersion: body.schemaVersion, board: body.board,
            protocols: body.protocols, sensorModels: body.sensorModels, debug: body.debug,
            ethernet: body.ethernet, net: body.net, buffering: body.buffering, jobs: body.jobs,
            modbusFormats: body.modbusFormats, configChunked: body.configChunked,
            maxConfigBytes: body.maxConfigBytes, mqttPayloadBytes: body.mqttPayloadBytes,
          };
          g.capsReports.push({ at: now(), body });
        }
      }
      if (body.status === 'installed' || body.status === 'failed') clearBusy(g);
      if (body.status && body.status !== 'downloading') event({ type: `firmware/update/${body.status === 'accepted' ? 'started' : body.status === 'installed' ? 'complete' : 'failed'}`, gateway: g.gateway });
    },
    'gateway.config-request'(g, body) { handleConfigRequest(g, body); },
    'gateway.device-data'(g, body, m) {
      if (!g.deviceIds.has(m.deviceId)) {
        dataLog.push({ gateway: g.gateway, deviceId: m.deviceId, body, at: now(), accepted: false, reason: 'unknown_device' });
        return;
      }
      markDeviceSeen(g, m.deviceId);
      const res = rate.gateLive(m.deviceId, body);
      dataLog.push({ gateway: g.gateway, deviceId: m.deviceId, body, at: now(), ...res });
    },
    'gateway.device-status'(g, body, m) {
      if (!g.deviceIds.has(m.deviceId)) return;
      g.deviceStatus.set(m.deviceId, { ...body, at: now() });
      if (body.reachable) markDeviceSeen(g, m.deviceId);
      else evictDevice(g, m.deviceId, body.reason, true);
    },
    'gateway.data-backfill'(g, body, m) {
      const byDevice = new Map();
      for (const rec of body.batch) {
        if (!byDevice.has(rec.deviceId)) byDevice.set(rec.deviceId, []);
        byDevice.get(rec.deviceId).push(rec);
      }
      let accepted = 0;
      let dropped = 0;
      for (const [deviceId, recs] of byDevice) {
        if (!g.deviceIds.has(deviceId)) { dropped += recs.length; continue; }
        const r = rate.gateBackfill(deviceId, recs.length);
        if (r.accepted) accepted += recs.length; else dropped += recs.length;
      }
      backfillLog.push({ gateway: g.gateway, at: now(), batch: body.batch, bytes: m.raw.length, accepted, dropped });
    },
    'gateway.device-cmd-ack'(g, body, m) { g.acks.push({ at: now(), deviceId: m.deviceId, body }); },
    'gateway.device-alert'(g, body, m) { g.alerts.push({ at: now(), deviceId: m.deviceId, body }); },
  };

  function handleConfigRequest(g, body) {
    const payloadStr = g.known ? g.configString : EMPTY_CONFIG;
    const hash = fnv1a32(payloadStr);
    const reqHash = body && body.hash != null ? Number(body.hash) : null;
    const unchanged = !!(reqHash && reqHash === hash);
    g.reportedHash = reqHash ?? 0;
    const bytes = Buffer.byteLength(payloadStr, 'utf8');
    const budget = g.known ? budgetFor(g) : Infinity;
    const cap = Number(body && body.cap) > 0 ? Number(body.cap) : null;
    const reqPart = body && body.part != null ? Number(body.part) : null;
    let result;
    let part = null;
    if (unchanged) {
      publishDown(g, 'config/push', '{"unchanged":true}');
      g.configPushes.push({ at: now(), kind: 'unchanged', prompted: true });
      clearBusy(g);
      result = 'unchanged';
    } else if (bytes > budget) {
      // Silence: nothing is published, and the gateway is not marked busy.
      event({ type: 'gateway/config-too-large', gateway: g.gateway, severity: 'error', bytes, budget, overBy: bytes - budget });
      result = 'refused';
    } else if (cap && bytes > cap) {
      const chunked = chunkPayload(payloadStr, hash, cap);
      part = Number.isInteger(reqPart) && reqPart >= 0 && reqPart < chunked.parts ? reqPart : 0;
      const msg = chunked.part(part);
      publishDown(g, 'config/push', msg);
      g.configPushes.push({ at: now(), kind: 'chunk', prompted: true, body: msg });
      if (part === 0) setBusy(g, 'config', BUSY_CONFIG_MS);
      result = 'chunked';
    } else {
      publishDown(g, 'config/push', payloadStr);
      g.configPushes.push({ at: now(), kind: 'full', prompted: true, hash });
      setBusy(g, 'config', BUSY_CONFIG_MS);
      result = 'pushed';
    }
    g.configRequests.push({ at: now(), body, result, part, hash: reqHash });
    if (g.known) {
      // Re-sent after EVERY request, part requests included.
      if (g.macros) publishDown(g, 'macros/push', { macros: g.macros });
      if (g.jobConfig) publishDown(g, 'cmd', { command: 'job/config', ...g.jobConfig });
      event({ type: 'gateway/config-sync', gateway: g.gateway, result, severity: result === 'refused' ? 'error' : 'info' });
    }
  }

  function onUplink(msg) {
    const m = /^tenants\/([^/]+)\/sources\/gateway\/([^/]+)\/(.+)$/.exec(msg.topic);
    const rec = { topic: msg.topic, raw: msg.payload, qos: msg.qos, retain: msg.retain, publishedAt: msg.publishedAt, arrivedAt: msg.arrivedAt, lwt: !!msg.lwt, clientId: msg.clientId };
    uplinks.push(rec);
    if (!m) { problems.push({ kind: 'topic', topic: msg.topic, message: 'not under a gateway prefix' }); return; }
    const g = gw(m[1], m[2]);
    const cls = g.topics.classify(msg.topic);
    if (!cls) { problems.push({ kind: 'topic', topic: msg.topic, message: 'topic is not in topics.json' }); return; }
    rec.id = cls.entry.id;
    rec.schema = cls.entry.schema;
    rec.deviceId = cls.deviceId;
    rec.gateway = g.gateway;
    if (cls.entry.direction !== 'up') { problems.push({ kind: 'direction', topic: msg.topic, message: `${cls.entry.id} is a downlink topic; a gateway must not publish on it` }); return; }
    if (cls.deviceId && !/^[0-9a-fA-F]{24}$/.test(cls.deviceId)) problems.push({ kind: 'topic', topic: msg.topic, message: 'device id in topic is not 24 hex characters' });
    if (typeof cls.entry.retain === 'boolean' && rec.retain !== cls.entry.retain) {
      problems.push({ kind: 'retain', topic: msg.topic, message: `${cls.entry.id} must be published with retain=${cls.entry.retain}`, payload: msg.payload.toString('utf8').slice(0, 300) });
    }
    let body;
    try {
      body = msg.payload.length ? JSON.parse(msg.payload.toString('utf8')) : {};
    } catch {
      problems.push({ kind: 'json', topic: msg.topic, message: 'payload is not JSON', payload: msg.payload.toString('utf8').slice(0, 300) });
      return;
    }
    rec.body = body;
    const v = strict.validate(cls.entry.schema, body);
    rec.valid = v.ok;
    rec.errors = v.errors;
    if (!v.ok) problems.push({ kind: 'schema', topic: msg.topic, schema: cls.entry.schema, message: v.errors.join('; '), payload: msg.payload.toString('utf8').slice(0, 300) });
    const processed = structuredClone(body);
    if (!lenient(cls.entry.schema, processed)) { rec.droppedByPlatform = true; return; }
    const h = handlers[cls.entry.id];
    const run = () => {
      if (h) h(g, processed, { deviceId: cls.deviceId, raw: msg.payload });
      else g.other.push({ at: now(), id: cls.entry.id, deviceId: cls.deviceId, body: processed });
    };
    // Test hook: the platform may process one message type later than another that arrived
    // after it (e.g. the capability report after a config request).
    const lag = cloud.processingDelayMs[cls.entry.id];
    if (lag > 0) clock.setTimeout(run, lag);
    else run();
  }

  const detach = broker.attachPeer(onUplink);

  const cloud = {
    /** (topic, payload, suffix) => payload | null — set by a scenario to tamper with or drop downlinks. */
    downlinkFilter: null,
    /** {topicsJsonId: ms} — process that uplink type this much later than it arrived. */
    processingDelayMs: {},
    rate,
    uplinks,
    problems,
    events,
    commands,
    dataLog,
    backfillLog,
    detach,

    /** Register a gateway the platform knows, with its device configuration (string = exact bytes). */
    register({ tenant, gateway, config = EMPTY_CONFIG, capabilities = null, macros = [], jobConfig = null }) {
      const g = makeGateway({ tenant, gateway, known: true, config, capabilities, macros, jobConfig });
      gateways.set(key(tenant, gateway), g);
      return g;
    },
    gateway: (tenant, gateway) => gateways.get(key(tenant, gateway)) || null,
    setConfig(tenant, gateway, config) { setConfigOn(gw(tenant, gateway), config); },
    configString: (tenant, gateway) => gw(tenant, gateway).configString,
    configHash: (tenant, gateway) => fnv1a32(gw(tenant, gateway).configString),
    /** The platform's "is this gateway on the latest config" flag: true / false / null (unknown). */
    configCurrent(tenant, gateway) {
      const g = gw(tenant, gateway);
      return g.reportedHash == null ? null : g.reportedHash === fnv1a32(g.configString);
    },
    busy: (tenant, gateway) => isBusy(gw(tenant, gateway)),
    budget: (tenant, gateway) => budgetFor(gw(tenant, gateway)),

    /** Gateway presence as the app shows it: the flag, disbelieved after 180 s without a heartbeat. */
    gatewayOnline(tenant, gateway) {
      const p = gw(tenant, gateway).presence;
      if (!p || p.online !== true) return false;
      return now() - p.ts < GATEWAY_STALE_MS;
    },
    deviceOnline: (tenant, gateway, deviceId) => (gw(tenant, gateway).deviceDeadline.get(deviceId) || 0) > now(),
    /** Longest silence (ms) between presence refreshes of a device inside [from, to]. */
    maxPresenceGap(tenant, gateway, deviceId, from, to = now()) {
      const seen = (gw(tenant, gateway).deviceSeen.get(deviceId) || []).filter((t) => t >= from && t <= to);
      if (!seen.length) return to - from;
      let gap = seen[0] - from;
      for (let i = 1; i < seen.length; i++) gap = Math.max(gap, seen[i] - seen[i - 1]);
      return Math.max(gap, to - seen[seen.length - 1]);
    },

    // ── what the platform sends ──
    /** Unprompted full push (the user edited devices, or pressed Resend config). */
    pushConfig(tenant, gateway) {
      const g = gw(tenant, gateway);
      publishDown(g, 'config/push', g.configString);
      g.configPushes.push({ at: now(), kind: 'full', prompted: false, hash: fnv1a32(g.configString) });
      setBusy(g, 'config', BUSY_CONFIG_MS);
    },
    /** A raw config/push body (tests: tampered chunks, bogus payloads). */
    pushRaw(tenant, gateway, body) { publishDown(gw(tenant, gateway), 'config/push', body); },
    /** Device command. `read/once` arms the platform's read-once marker first, and is refused if that fails. */
    sendDeviceCmd(tenant, gateway, deviceId, body) {
      const g = gw(tenant, gateway);
      if (body && body.command === 'read/once' && !rate.armReadOnce(deviceId, body.tag)) {
        return { sent: false, reason: 'read-once gate (one per device per 5 s)' };
      }
      const { topic } = publishDown(g, 'devices/{deviceId}/cmd', body, deviceId);
      commands.push({ at: now(), topic, deviceId, body });
      return { sent: true, topic };
    },
    sendGatewayCmd(tenant, gateway, body) {
      const { topic } = publishDown(gw(tenant, gateway), 'cmd', body);
      commands.push({ at: now(), topic, body });
      return { sent: true, topic };
    },
    sendFirmwareRequest(tenant, gateway, body) {
      const g = gw(tenant, gateway);
      const { topic } = publishDown(g, 'firmware/request', body);
      if (body && body.type === 'update') setBusy(g, 'firmware', BUSY_FIRMWARE_MS);
      commands.push({ at: now(), topic, body });
      return { sent: true, topic };
    },
    sendMacros(tenant, gateway, suffix, body) {
      const { topic } = publishDown(gw(tenant, gateway), suffix, body);
      commands.push({ at: now(), topic, body });
      return { sent: true, topic };
    },

    // ── queries ──
    /** Parsed uplinks, optionally filtered by topics.json id (and device). */
    up(id, deviceId) { return uplinks.filter((u) => (!id || u.id === id) && (!deviceId || u.deviceId === deviceId)); },
    ackFor(tenant, gateway, correlationId) { return gw(tenant, gateway).acks.find((a) => a.body.correlationId === correlationId) || null; },
    eventsOf(type) { return events.filter((e) => e.type === type); },
  };
  return cloud;
}
