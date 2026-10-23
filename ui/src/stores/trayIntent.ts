import { create } from 'zustand';

interface TrayIntentState {
  pendingProfileId: string | null;
  set: (profileId: string | null) => void;
  consume: () => string | null;
}

export const useTrayIntent = create<TrayIntentState>((set, get) => ({
  pendingProfileId: null,
  set: (pendingProfileId) => set({ pendingProfileId }),
  consume: () => {
    const id = get().pendingProfileId;
    if (id !== null) set({ pendingProfileId: null });
    return id;
  },
}));
