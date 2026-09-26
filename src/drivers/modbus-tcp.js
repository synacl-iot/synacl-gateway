// `modbus-tcp` driver — holding/input registers, coils and discrete inputs on Modbus TCP
// devices (PLCs, meters, TCP→RTU bridges).
//
// conn: {modbusId = 1, ip, port = 502, sampleIntervalMs | tickDuration (ms), readIntervalMs?}
// tag:  {mbAddress (0-based protocol address, used as-is), registerType, mbFormat, mbWordOrder}
//
// Reads: holding → FC03, input → FC04, coil → FC01, discrete → FC02 (coils/discretes read 0/1).
// Raw values are published; scale factor and offset are applied by the platform. A device is
// reachable when at least one tag answered. Reasons when it is not:
//   modbus/timeout                                  connect or response timeout (the platform
//                                                   raises its own event type for it)
//   TCP connect failed to <ip>:<port> (<code>)      refused, unreachable, DNS, …
//   modbus exception <n> (<name>) at <register>     the device answered with an exception
// Writes: coil → FC05, holding → FC06 (one 16-bit register; −32768..65535).

import ModbusRTU from 'modbus-serial';
import { defineDriver, DriverError } from './api.js';
import { wordCount, decodeWords, encodeRegisterWrite, exceptionName, registerLabel } from './modbus-codec.js';

/** @typedef {import('../core/types.js').DriverContext} DriverContext */
/** @typedef {import('../core/types.js').DeviceSpec} DeviceSpec */
/** @typedef {import('../core/types.js').TagSpec} TagSpec */
/** @typedef {import('../core/types.js').ReadResult} ReadResult */
/** @typedef {import('../core/types.js').WriteOp} WriteOp */
/** @typedef {import('../core/types.js').WriteResult} WriteResult */

const READERS = { holding: 'readHoldingRegisters', input: 'readInputRegisters', coil: 'readCoils', discrete: 'readDiscreteInputs' };

const toInt = (v, fallback) => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isInteger(n) ? n : NaN;
};

/**
 * Build the modbus-tcp driver.
 * @param {{ModbusClient?: new () => any, timeoutMs?: number, connectTimeoutMs?: number}} [deps]
 *   `timeoutMs` bounds each request (default 3000, as on the reference firmware's TCP path plus
 *   headroom for a TCP→RTU hop); `connectTimeoutMs` the TCP connect (default = timeoutMs).
 */
export function createModbusTcpDriver({ ModbusClient = ModbusRTU, timeoutMs = 3000, connectTimeoutMs = timeoutMs } = {}) {
  return defineDriver({
    apiVersion: 1,
    name: 'modbus-tcp',
    protocols: ['modbus-tcp'],
    capabilities: { modbusFormats: true },
    /** @param {DriverContext} ctx */
    create(ctx) {
      const { log, clock } = ctx;
      /** @type {Map<string, ReturnType<typeof createLink>>} */
      const links = new Map();

      const timeoutError = (what) => new DriverError(`${what} timed out`, { reason: 'modbus/timeout', code: 'timeout' });

      /** Reject after `ms` on the injected clock; `onTimeout` tears the connection down. */
      function withTimeout(promise, ms, what, onTimeout) {
        return new Promise((resolve, reject) => {
          const t = clock.setTimeout(() => {
            onTimeout?.();
            reject(timeoutError(what));
          }, ms);
          promise.then(
            (v) => { clock.clearTimeout(t); resolve(v); },
            (e) => { clock.clearTimeout(t); reject(e); },
          );
        });
      }

      // One connection per ip:port, shared by every device behind it (a TCP→RTU bridge fronts
      // many unit ids), with a queue so exactly one transaction is in flight at a time: many
      // devices and bridges handle one request at a time and drop or garble the rest.
      function createLink(host, port) {
        const target = `${host}:${port}`;
        const link = { target, refs: 0, client: null, tail: Promise.resolve(), closed: false };

        const destroy = (c) => {
          if (!c) return;
          if (link.client === c) link.client = null;
          try {
            c.destroy(() => {});
          } catch {
            // already gone
          }
        };

        async function connect() {
          const c = new ModbusClient();
          c.on?.('error', () => {}); // socket errors surface through the request that hit them
          try {
            await withTimeout(Promise.resolve(c.connectTCP(host, { port })), connectTimeoutMs, `TCP connect to ${target}`, () => destroy(c));
          } catch (err) {
            destroy(c);
            if (err instanceof DriverError) throw err;
            const code = err?.code ?? err?.errno;
            if (code === 'ETIMEDOUT') throw timeoutError(`TCP connect to ${target}`);
            const reason = `TCP connect failed to ${target} (${code || err?.message || 'error'})`.slice(0, 128);
            throw new DriverError(reason, { reason, code: 'connect', cause: err });
          }
          if (link.closed) {
            destroy(c);
            throw new DriverError(`connection to ${target} closed`, { code: 'closed' });
          }
          c.on?.('close', () => {
            if (link.client === c) link.client = null;
          });
          link.client = c;
          log.debug(`modbus-tcp: connected to ${target}`);
        }

        link.ensureConnected = async () => {
          if (link.closed) throw new DriverError(`connection to ${target} closed`, { code: 'closed' });
          if (!link.client || link.client.isOpen !== true) {
            destroy(link.client);
            await connect();
          }
          return link.client;
        };

        /**
         * Run one Modbus transaction for `unitId` through the queue.
         * @template T
         * @param {number} unitId
         * @param {string} what  For the timeout message.
         * @param {(client: any) => Promise<T>} op
         * @returns {Promise<T>}
         */
        link.request = (unitId, what, op) => {
          const run = link.tail.then(async () => {
            const c = await link.ensureConnected();
            c.setID(unitId); // per request: devices behind one bridge differ only by unit id
            try {
              return await withTimeout(Promise.resolve(op(c)), timeoutMs, what, () => destroy(c));
            } catch (err) {
              // An exception is a well-formed answer; anything else leaves the stream in an
              // unknown state, so start the next transaction on a fresh connection.
              if (err?.modbusCode === undefined) destroy(c);
              throw err;
            }
          });
          link.tail = run.catch(() => {});
          return run;
        };

        link.close = () => {
          link.closed = true;
          destroy(link.client);
        };
        return link;
      }

      /**
       * Describe a failed transaction.
       * @returns {{kind: 'timeout'|'connect'|'exception'|'other', reason: string}}
       */
      function classify(err, label) {
        if (err?.modbusCode !== undefined) {
          return { kind: 'exception', reason: `modbus exception ${err.modbusCode} (${exceptionName(err.modbusCode)}) at ${label}` };
        }
        if (err instanceof DriverError && err.code === 'timeout') return { kind: 'timeout', reason: 'modbus/timeout' };
        if (err instanceof DriverError && err.code === 'connect') return { kind: 'connect', reason: err.reason };
        if (err?.errno === 'ETIMEDOUT') return { kind: 'timeout', reason: 'modbus/timeout' };
        return { kind: 'other', reason: `${label}: ${err?.message || String(err)}`.slice(0, 128) };
      }

      /** @param {any} h @param {TagSpec} tag */
      async function readTag(h, tag) {
        const fn = READERS[tag.registerType];
        if (!fn) throw new DriverError(`unknown register type "${tag.registerType}"`, { code: 'config' });
        const bits = tag.registerType === 'coil' || tag.registerType === 'discrete';
        const count = bits ? 1 : wordCount(tag.mbFormat);
        const addr = tag.mbAddress ?? 0;
        if (!Number.isInteger(addr) || addr < 0 || addr + count - 1 > 65535) {
          throw new DriverError(`address ${addr} is outside 0..65535`, { code: 'config' });
        }
        const label = registerLabel(tag.registerType, addr);
        const res = await h.link.request(h.unitId, `read ${label} from ${h.link.target} unit ${h.unitId}`, (c) => c[fn](addr, count));
        const data = res?.data ?? [];
        if (bits) return data[0] ? 1 : 0;
        return decodeWords(data[0], data[1], tag.mbFormat, tag.mbWordOrder);
      }

      return {
        /** @param {DeviceSpec} device */
        async open(device) {
          const conn = device.conn ?? {};
          const host = typeof conn.ip === 'string' ? conn.ip.trim() : '';
          const port = toInt(conn.port, 502);
          const unitId = toInt(conn.modbusId, 1);
          const bad = (why) => new DriverError(`modbus-tcp device ${device.id}: ${why}`, { reason: why.slice(0, 128), code: 'bad-config' });
          // An unset address can only ever time out; say what is wrong instead.
          if (!host || host === '0.0.0.0') throw bad('no valid device IP configured');
          if (!(port >= 1 && port <= 65535)) throw bad(`port ${JSON.stringify(conn.port)} is not a TCP port (1..65535)`);
          if (!(unitId >= 0 && unitId <= 255)) throw bad(`modbusId ${JSON.stringify(conn.modbusId)} is not a unit id (0..255)`);

          const key = `${host}:${port}`;
          let link = links.get(key);
          if (!link) {
            link = createLink(host, port);
            links.set(key, link);
          }
          link.refs++;
          return { id: device.id, link, key, unitId, closed: false, lastSummary: '' };
        },

        /**
         * @param {any} h
         * @param {TagSpec[]} tags
         * @param {{reason?: 'interval'|'once', signal?: AbortSignal}} [opts]
         * @returns {Promise<ReadResult>}
         */
        async read(h, tags, { signal } = {}) {
          if (h.closed) return { values: {}, reachable: false, reason: 'device closed' };
          const values = {};
          const errors = {};
          let answered = 0;
          let connectFailure = null;
          let timedOut = false;
          let firstException = null;
          let firstOther = null;

          if (tags.length === 0) {
            // Nothing to read, but reachability still means something: can we connect?
            try {
              await h.link.request(h.unitId, `connect to ${h.link.target}`, () => undefined);
              return { values, reachable: true };
            } catch (err) {
              return { values, reachable: false, reason: classify(err, h.link.target).reason };
            }
          }

          for (const tag of tags) {
            if (signal?.aborted) { errors[tag.name] = 'read cancelled'; continue; }
            if (connectFailure) { errors[tag.name] = connectFailure; continue; }
            // A unit that let one tag time out twice will not answer the next: skipping keeps
            // one dead device from holding the shared connection for tags × 2 × timeout.
            if (timedOut) { errors[tag.name] = 'skipped: the device did not answer an earlier tag'; continue; }
            const label = registerLabel(tag.registerType, tag.mbAddress ?? 0);
            let lastErr;
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                const v = await readTag(h, tag);
                answered++;
                lastErr = undefined;
                if (v === undefined) errors[tag.name] = `${label}: ${tag.mbFormat} value is not a finite number (NaN or infinity)`;
                else values[tag.name] = v;
                break;
              } catch (err) {
                lastErr = err;
                const kind = err instanceof DriverError && err.code === 'config' ? 'config' : classify(err, label).kind;
                // One retry, as on the reference firmware — but not for answers that would
                // repeat themselves (an exception, bad config) or when the connection failed.
                if (kind === 'exception' || kind === 'connect' || kind === 'config' || signal?.aborted) break;
              }
            }
            if (lastErr === undefined) continue;
            if (lastErr instanceof DriverError && lastErr.code === 'config') {
              errors[tag.name] = `${label}: ${lastErr.message}`;
              firstOther ??= errors[tag.name];
              continue;
            }
            const c = classify(lastErr, label);
            errors[tag.name] = c.reason;
            if (c.kind === 'connect') connectFailure = c.reason;
            else if (c.kind === 'timeout') timedOut = true;
            else if (c.kind === 'exception') firstException ??= c.reason;
            else firstOther ??= c.reason;
          }

          const reachable = answered > 0;
          /** @type {ReadResult} */
          const res = { values, reachable };
          if (!reachable) res.reason = connectFailure ?? (timedOut ? 'modbus/timeout' : firstException ?? firstOther ?? 'no tag could be read');
          const failed = Object.keys(errors);
          if (failed.length) res.errors = errors;

          // Log on change only: a device that stays down must not write a line every interval.
          const summary = failed.length ? `${failed.length}/${tags.length} tags failed (${errors[failed[0]]})` : 'ok';
          if (summary !== h.lastSummary) {
            const where = `modbus-tcp: ${h.link.target} unit ${h.unitId} (device ${h.id})`;
            if (failed.length) log.warn(`${where}: ${summary}`);
            else if (h.lastSummary) log.info(`${where}: all ${tags.length} tags read again`);
            h.lastSummary = summary;
          }
          return res;
        },

        /**
         * @param {any} h
         * @param {WriteOp} op
         * @returns {Promise<WriteResult>}
         */
        async write(h, op) {
          if (h.closed) return { ok: false, error: 'device closed' };
          if (op?.kind !== 'modbus') return { ok: false, error: 'actuator writes are not supported for protocol "modbus-tcp"' };
          const addr = op.address;
          if (!Number.isInteger(addr) || addr < 0 || addr > 65535) return { ok: false, error: `address ${JSON.stringify(addr)} is outside 0..65535` };
          const label = registerLabel(op.registerType, addr);
          let call;
          let value;
          if (op.registerType === 'coil') {
            if (typeof op.value !== 'number' || !Number.isFinite(op.value)) return { ok: false, error: `value ${JSON.stringify(op.value)} is not a number` };
            const on = op.value !== 0;
            value = on ? 1 : 0;
            call = (c) => c.writeCoil(addr, on); // FC05
          } else if (op.registerType === 'holding') {
            const enc = encodeRegisterWrite(op.value);
            if (!enc.ok) return { ok: false, error: enc.error };
            value = op.value;
            call = (c) => c.writeRegister(addr, enc.word); // FC06
          } else {
            return { ok: false, error: `${op.registerType} registers are read-only; only coil and holding can be written` };
          }
          try {
            await h.link.request(h.unitId, `write ${label} on ${h.link.target} unit ${h.unitId}`, call);
            log.info(`modbus-tcp: wrote ${label}=${value} on ${h.link.target} unit ${h.unitId} (device ${h.id})`);
            return { ok: true, value };
          } catch (err) {
            const c = classify(err, label);
            const error = c.kind === 'timeout' ? `no reply from ${h.link.target} unit ${h.unitId} writing ${label} (modbus/timeout)` : c.reason;
            log.warn(`modbus-tcp: write ${label}=${value} on ${h.link.target} unit ${h.unitId} failed: ${error}`);
            return { ok: false, error };
          }
        },

        async close(h) {
          if (!h || h.closed) return;
          h.closed = true;
          const link = h.link;
          link.refs--;
          if (link.refs <= 0) {
            link.close();
            if (links.get(h.key) === link) links.delete(h.key);
          }
        },
      };
    },
  });
}

/** The built-in modbus-tcp driver. */
export const modbusTcpDriver = createModbusTcpDriver();
export default modbusTcpDriver;
