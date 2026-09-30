/** The Settings screen's choices, read wherever they apply. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { type Preferences, preferences } from '@/api/core'
import { errorMessage } from '@/api/http'

const KEY = ['preferences']

/** What a new task gets until Settings has loaded; the same as Settings' own default. */
const FALLBACK_CORES = 4

export function usePreferences() {
  // The usual staleness, not forever: another open tab can change them, and a save sends the
  // whole set, so a copy held indefinitely would put that tab's change back.
  return useQuery({ queryKey: KEY, queryFn: preferences.get })
}

/** Saves a whole set of choices, showing it at once and putting the old one back if it fails. */
export function useSavePreferences() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: preferences.put,
    onMutate: async (next: Preferences) => {
      await queryClient.cancelQueries({ queryKey: KEY })
      const before = queryClient.getQueryData<Preferences>(KEY)
      queryClient.setQueryData(KEY, next)
      return { before }
    },
    onError: (error, _next, context) => {
      if (context?.before) queryClient.setQueryData(KEY, context.before)
      toast.error('That setting was not saved', { description: errorMessage(error) })
    },
    onSuccess: (saved) => queryClient.setQueryData(KEY, saved),
  })
}

/** A task form's cores: what it chose, or Settings' default until it chooses. */
export function useCores(chosen: number | null): number {
  const saved = usePreferences()
  return chosen ?? saved.data?.defaultCores ?? FALLBACK_CORES
}
