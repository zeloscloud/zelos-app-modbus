/** Composes `extensions.list` + `actions.list` + `Modbus/list_devices`
 *  (per agent) into a `ModbusDiscovery` driven by the pure resolver. No
 *  selected-agent is passed in — discovery is agent-set-wide; the UI decides
 *  what to render after seeing the full picture.
 *
 *  Polling cadence:
 *  - extensions.list + actions.list: every 5s (lifecycle changes are rare).
 *  - Modbus/list_devices: every 5s per agent that has the extension running
 *    and the action registered. Device churn only happens on an extension
 *    restart, so anything faster is wasted round-trips.
 *
 *  Identity matters here: everything below this hook memoizes on what it returns,
 *  so the per-agent device map is folded inside `useQueries` through `combine`
 *  — which only reruns when a result changes — rather than in a `useMemo` over
 *  the results array, which is a fresh array every render and so memoizes
 *  nothing.
 */

import { actions, extensions, type BridgeTransport } from "@zeloscloud/app-extension-sdk";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { listDevices } from "@/lib/modbus-bridge";
import { discoverModbus, type ModbusDiscovery } from "@/lib/capability";
import {
  MODBUS_EXTENSION_INSTALL_IDS,
  MODBUS_METHODS,
  modbusActionPath,
  type ModbusDeviceEntry,
  type WorkspaceModeKind,
} from "@/lib/types";
import { errorMessage } from "@/lib/utils";

const DISCOVERY_POLL_MS = 5_000;

export interface UseModbusDiscoveryInput {
  bridge: BridgeTransport;
  workspaceModeKind: WorkspaceModeKind;
}

export function useModbusDiscovery(input: UseModbusDiscoveryInput): {
  discovery: ModbusDiscovery;
  isLoading: boolean;
  refetch: () => void;
} {
  const { bridge, workspaceModeKind } = input;
  const enabled = workspaceModeKind === "LIVE";

  const extensionsQuery = useQuery({
    queryKey: ["modbus-extensions-list"],
    queryFn: async () => extensions.list(bridge),
    enabled,
    staleTime: 2000,
    refetchInterval: enabled ? DISCOVERY_POLL_MS : false,
  });

  const actionsQuery = useQuery({
    queryKey: ["modbus-actions-list"],
    queryFn: async () => actions.list(bridge),
    enabled,
    staleTime: 2000,
    refetchInterval: enabled ? DISCOVERY_POLL_MS : false,
  });

  // Only ask `Modbus/list_devices` of agents running the extension that have
  // registered it. Calling it earlier (or against an agent without it) produces
  // a noisy "unknown action" error per poll cycle.
  const deviceAgents = useMemo<string[]>(() => {
    const byAgent = extensionsQuery.data;
    if (!byAgent) return [];
    const listDevicesPath = modbusActionPath(MODBUS_METHODS.listDevices);
    const result: string[] = [];
    for (const [agent, exts] of Object.entries(byAgent)) {
      if (
        exts.some((e) => MODBUS_EXTENSION_INSTALL_IDS.has(e.id) && e.state === "running") &&
        actionsQuery.data?.[agent]?.includes(listDevicesPath)
      ) {
        result.push(agent);
      }
    }
    return result.sort();
  }, [extensionsQuery.data, actionsQuery.data]);

  const devices = useQueries({
    queries: deviceAgents.map((agent) => ({
      queryKey: ["modbus-list-devices", agent],
      queryFn: async () => listDevices(bridge, agent),
      enabled,
      staleTime: 2000,
      refetchInterval: enabled ? DISCOVERY_POLL_MS : false,
    })),
    combine: (results) => ({
      byAgent: Object.fromEntries(
        deviceAgents.map((agent, i) => [agent, results[i]?.data?.devices]),
      ) as Record<string, ModbusDeviceEntry[] | undefined>,
      // A failure has to reach the resolver, or a permanently failing agent sits
      // on "Discovering devices…" forever.
      errorsByAgent: Object.fromEntries(
        deviceAgents.map((agent, i) => {
          const error = results[i]?.error;
          return [agent, error ? errorMessage(error) : undefined];
        }),
      ) as Record<string, string | undefined>,
      isLoading: results.some((r) => r.isLoading),
      refetch: () => results.forEach((r) => void r.refetch()),
    }),
  });

  const discovery = useMemo(
    () =>
      discoverModbus({
        workspaceModeKind,
        extensionsByAgent: extensionsQuery.data ?? null,
        actionsByAgent: actionsQuery.data ?? null,
        devicesByAgent: devices.byAgent,
        deviceErrorsByAgent: devices.errorsByAgent,
      }),
    [
      workspaceModeKind,
      extensionsQuery.data,
      actionsQuery.data,
      devices.byAgent,
      devices.errorsByAgent,
    ],
  );

  const queryClient = useQueryClient();
  const refetchExtensions = extensionsQuery.refetch;
  const refetchActions = actionsQuery.refetch;
  const refetchDevices = devices.refetch;
  const refetch = useCallback(() => {
    void refetchExtensions();
    void refetchActions();
    refetchDevices();
    // The register catalogs are cached forever on purpose (a map is immutable
    // for the life of an extension process), so Refresh is the only thing that
    // can retire one after a restart — or retry one that failed.
    void queryClient.invalidateQueries({ queryKey: ["modbus-registers"] });
  }, [refetchExtensions, refetchActions, refetchDevices, queryClient]);

  return {
    discovery,
    isLoading: extensionsQuery.isLoading || actionsQuery.isLoading || devices.isLoading,
    refetch,
  };
}
