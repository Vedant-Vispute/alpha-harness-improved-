/** Whether Research Labs shows legacy Power Pool labs or the general lab entry points. */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface LabMode {
  powerPool: boolean
  setPowerPool: (powerPool: boolean) => void
}

export const useLabMode = create<LabMode>()(
  persist(
    (set) => ({
      powerPool: true,
      setPowerPool: (powerPool) => set({ powerPool }),
    }),
    { name: 'alpha-harness-lab-mode' },
  ),
)
