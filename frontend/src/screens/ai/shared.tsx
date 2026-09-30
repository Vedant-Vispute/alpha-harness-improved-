import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNow } from '@/lib/now'
import { llm } from '@/screens/ai/api'

export const useKeys = (refetchInterval: number | false = false) =>
  useQuery({ queryKey: ['ai', 'keys'], queryFn: llm.keys, refetchInterval })
export const useProviders = () =>
  useQuery({
    queryKey: ['ai', 'providers'],
    queryFn: llm.providers,
    staleTime: 10 * 60 * 1000,
  })
export const useModels = () => useQuery({ queryKey: ['ai', 'models'], queryFn: llm.models })

/** After a Key or a model changes: everything that shows models or what is left of them. */
export function useInvalidateKeys() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['ai', 'keys'] })
    void queryClient.invalidateQueries({ queryKey: ['ai', 'models'] })
    void queryClient.invalidateQueries({ queryKey: ['ai', 'chat', 'options'] })
    void queryClient.invalidateQueries({ queryKey: ['ai', 'offered'] })
    void queryClient.invalidateQueries({ queryKey: ['power-pool-lab', 'options'] })
    void queryClient.invalidateQueries({ queryKey: ['today'] })
  }
}

export function useProviderLabel() {
  const providers = useProviders()
  return (id: string) => providers.data?.providers.find((p) => p.id === id)?.label ?? id
}

/** Seconds left on a server countdown, ticking locally between refetches. */
export function useCountdown(seconds: number | undefined, fetchedAt: number): number | undefined {
  const now = useNow(15_000)
  return seconds == null ? undefined : Math.max(0, seconds - (now - fetchedAt) / 1000)
}
