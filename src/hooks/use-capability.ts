/** Composes `extensions.list` + `actions.list` + `modbus/list_interfaces`
 *  (per agent) into a `ModbusDiscovery` driven by the pure resolver. No
 *  selected-agent is passed in — discovery is agent-set-wide; the UI decides
 *  what to render after seeing the full picture.
 *
 *  Polling cadence:
 *  - extensions.list + actions.list: every 5s (lifecycle changes are rare).
 *  - modbus/list_interfaces: every 5s per agent that has the extension running.
 *    Interface churn only happens on an extension restart, so anything faster
 *    is wasted round-trips.
 */

import { actions, extensions, type BridgeTransport } from "@zeloscloud/app-extension-sdk";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { listInterfaces } from "@/lib/modbus-bridge";
import { discoverModbus, type ModbusDiscovery } from "@/lib/capability";
import {
  MODBUS_EXTENSION_INSTALL_IDS,
  type ModbusInterfaceEntry,
  type WorkspaceModeKind,
} from "@/lib/types";

const DISCOVERY_POLL_MS = 5_000;

export interface UseModbusDiscoveryInput {
  bridge: BridgeTransport | null;
  workspaceModeKind: WorkspaceModeKind;
}

export function useModbusDiscovery(input: UseModbusDiscoveryInput): {
  discovery: ModbusDiscovery;
  isLoading: boolean;
  refetch: () => void;
} {
  const enabled = input.bridge !== null && input.workspaceModeKind === "LIVE";

  const extensionsQuery = useQuery({
    queryKey: ["modbus-extensions-list"],
    queryFn: async () => extensions.list(input.bridge!),
    enabled,
    staleTime: 2000,
    refetchInterval: enabled ? DISCOVERY_POLL_MS : false,
  });

  const actionsQuery = useQuery({
    queryKey: ["modbus-actions-list"],
    queryFn: async () => actions.list(input.bridge!),
    enabled,
    staleTime: 2000,
    refetchInterval: enabled ? DISCOVERY_POLL_MS : false,
  });

  // Only ask `modbus/list_interfaces` of agents that look like they're running
  // the Modbus extension — calling it against an agent that doesn't have it
  // produces a noisy "unknown action" error per poll cycle.
  const interfaceAgents = useMemo<string[]>(() => {
    const byAgent = extensionsQuery.data;
    if (!byAgent) return [];
    const result: string[] = [];
    for (const [agent, exts] of Object.entries(byAgent)) {
      if (exts.some((e) => MODBUS_EXTENSION_INSTALL_IDS.has(e.id) && e.state === "running")) {
        result.push(agent);
      }
    }
    return result.sort();
  }, [extensionsQuery.data]);

  const interfaceQueries = useQueries({
    queries: interfaceAgents.map((agent) => ({
      queryKey: ["modbus-list-interfaces", agent],
      queryFn: async () => listInterfaces(input.bridge!, agent),
      enabled,
      staleTime: 2000,
      refetchInterval: enabled ? DISCOVERY_POLL_MS : false,
    })),
  });

  const interfacesByAgent = useMemo<Record<string, ModbusInterfaceEntry[] | undefined>>(() => {
    const out: Record<string, ModbusInterfaceEntry[] | undefined> = {};
    interfaceAgents.forEach((agent, i) => {
      out[agent] = interfaceQueries[i]?.data?.interfaces;
    });
    return out;
  }, [interfaceAgents, interfaceQueries]);

  const discovery = useMemo(
    () =>
      discoverModbus({
        workspaceModeKind: input.workspaceModeKind,
        extensionsByAgent: extensionsQuery.data ?? null,
        actionsByAgent: actionsQuery.data ?? null,
        interfacesByAgent,
      }),
    [input.workspaceModeKind, extensionsQuery.data, actionsQuery.data, interfacesByAgent],
  );

  return {
    discovery,
    isLoading:
      extensionsQuery.isLoading ||
      actionsQuery.isLoading ||
      interfaceQueries.some((q) => q.isLoading),
    refetch: () => {
      void extensionsQuery.refetch();
      void actionsQuery.refetch();
      interfaceQueries.forEach((q) => void q.refetch());
    },
  };
}
