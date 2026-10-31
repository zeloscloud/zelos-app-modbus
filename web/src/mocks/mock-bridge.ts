/** Test-only: the mock host on a bridge, in one place.
 *
 *  Both the mock-host contract tests and the DevicePanel integration tests
 *  need the same shim — a minimal `MockBridge` stand-in with the simulator
 *  installed on it, and an `invoke` that routes straight at the installed
 *  handler. Nothing in the app imports this, so it never reaches the bundle. */

import type { BridgeTransport, MockBridge } from "@zeloscloud/app-extension-sdk";

import { installModbusMockHost, type MockScenario } from "./modbus-mock";

export interface InstalledMockBridge {
  bridge: BridgeTransport;
  /** Stops the simulated device's clock. Call it in `afterEach`. */
  teardown: () => void;
}

export function installedMockBridge(scenario: MockScenario = "ready"): InstalledMockBridge {
  let handler: ((method: string, params: unknown) => unknown | Promise<unknown>) | null = null;
  const mock = {
    setInvokeHandler(next: typeof handler) {
      handler = next;
    },
  } as unknown as MockBridge;
  const teardown = installModbusMockHost(mock, { scenario });
  const bridge = {
    mode: "standalone",
    invoke: async (method: string, params?: unknown) => {
      if (!handler) throw new Error("mock host has no invoke handler");
      return await handler(method, params);
    },
    getSnapshot: () => {
      throw new Error("unused in tests");
    },
    on: () => () => {},
    destroy: () => {},
  } as unknown as BridgeTransport;
  return { bridge, teardown };
}
