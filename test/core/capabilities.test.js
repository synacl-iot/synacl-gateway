import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCapabilities } from '../../src/core/capabilities.js';
import { version } from '../../src/index.js';
import { createValidators } from '../_support/core-runtime/fakes.js';

const registry = (protocols, caps = {}) => ({ protocols: () => protocols, capabilities: () => caps });

test('the report validates against firmware-response and has the documented shape', () => {
  const caps = buildCapabilities({
    version, gatewayId: 'gw_3f2a9c1e7b41', configCap: null, platform: 'linux', arch: 'arm64',
    drivers: registry(['host', 'mqtt-bridge', 'modbus-tcp'], { modbusFormats: true, sensorModels: {} }),
  });
  assert.ok(createValidators().validate('firmware-response', caps).ok);
  assert.deepEqual(caps, {
    version, schemaVersion: 2, board: 'node-linux-arm64', mac: 'gw_3f2a9c1e7b41',
    protocols: ['host', 'mqtt-bridge', 'modbus-tcp'], sensorModels: {},
    debug: true, ethernet: false, buffering: true, jobs: false, modbusFormats: true, configChunked: true,
    maxConfigBytes: 1048576, mqttPayloadBytes: 65535,
  });
});

test('sensorModels is always present (the platform only stores a report that has it or protocols)', () => {
  const caps = buildCapabilities({ version: '0.1.0', gatewayId: 'g1x', drivers: registry([]) });
  assert.deepEqual(caps.sensorModels, {});
  assert.deepEqual(caps.protocols, []);
  assert.equal(caps.modbusFormats, false);
});

test('merged driver capabilities flow through; protocols are de-duplicated', () => {
  const caps = buildCapabilities({
    version: '0.1.0', gatewayId: 'g1x', configCap: 4096,
    drivers: registry(['http', 'http', 'rs485'], { sensorModels: { i2c: ['BME280'] } }),
  });
  assert.deepEqual(caps.protocols, ['http', 'rs485']);
  assert.deepEqual(caps.sensorModels, { i2c: ['BME280'] });
  assert.equal(caps.mqttPayloadBytes, 65535, 'configCap never lowers the packet size the platform plans pushes with');
  assert.ok(createValidators().validate('firmware-response', caps).ok);
});
