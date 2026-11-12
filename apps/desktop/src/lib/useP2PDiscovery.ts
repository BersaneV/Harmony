import { useQuery } from "@tanstack/react-query";
import { api, getSession } from "./api";

export interface AvailableProbe {
  id: string;
  host_name: string;
  expires_in: number;
}
export interface ProbeInfo {
  enabled: boolean;
  duration_seconds: number;
  stun_configured: boolean;
  relay_configured: boolean;
  available: AvailableProbe[];
}
export function useP2PDiscovery(channelId: string, enabled = true) {
  return useQuery({
    queryKey: ["p2p", channelId, getSession()?.user.id],
    queryFn: async ({ signal }) => {
      const value = await api<ProbeInfo>(
        `/api/channels/${channelId}/p2p-probes`,
        { signal },
      );
      return {
        ...value,
        available: Array.isArray(value.available) ? value.available : [],
      };
    },
    enabled,
    retry: false,
    staleTime: 0,
    refetchInterval: (query) => (query.state.error ? false : 5000),
  });
}
