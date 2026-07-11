import assert from "node:assert/strict";
import test from "node:test";
import { detectCapabilities } from "../dist/capabilities.js";
import { KaelixApiError } from "../dist/client.js";

function clientThatThrows(error) {
  return {
    request: async () => {
      throw error;
    },
  };
}

function clientThatSucceeds() {
  return { request: async () => ({ running: true }) };
}

test('mode "on" registers local-ai tools without probing', async () => {
  const client = clientThatThrows(new Error("should not be called"));
  const caps = await detectCapabilities(client, "on");
  assert.equal(caps.localAi, true);
});

test('mode "off" never registers local-ai tools without probing', async () => {
  const client = clientThatSucceeds();
  const caps = await detectCapabilities(client, "off");
  assert.equal(caps.localAi, false);
});

test('mode "auto" enables local-ai tools when the probe succeeds', async () => {
  const caps = await detectCapabilities(clientThatSucceeds(), "auto");
  assert.equal(caps.localAi, true);
});

test('mode "auto" disables local-ai tools on a 404 (route missing on older backends)', async () => {
  const error = new KaelixApiError("not found", { kind: "not_found", path: "/local-ai/status", status: 404 });
  const caps = await detectCapabilities(clientThatThrows(error), "auto");
  assert.equal(caps.localAi, false);
});

test('mode "auto" fails safe (disabled) when the backend is unreachable', async () => {
  const error = new KaelixApiError("network", { kind: "network", path: "/local-ai/status" });
  const caps = await detectCapabilities(clientThatThrows(error), "auto");
  assert.equal(caps.localAi, false);
});
