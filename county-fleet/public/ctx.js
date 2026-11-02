/* Shared mutable state for the views. `refresh` re-renders the current screen. */
export const ctx = { user: null, assets: null, lookups: null, refresh: () => {} };
