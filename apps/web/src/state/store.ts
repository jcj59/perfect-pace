import { useSyncExternalStore } from "react";

/** A partial update, or a function of the current state that returns one. */
export type Update<S> = Partial<S> | ((state: S) => Partial<S>);

/** A minimal observable store. State is replaced, never mutated, so selectors can compare by identity. */
export interface Store<S extends object> {
  get: () => S;
  /** Shallow-merge an update. Listeners run only when some field actually changed. */
  set: (update: Update<S>) => void;
  /** Call `listener` after every change; returns the unsubscribe function. */
  subscribe: (listener: (state: S, previous: S) => void) => () => void;
}

export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<(state: S, previous: S) => void>();
  return {
    get: () => state,
    set: (update) => {
      const patch = typeof update === "function" ? update(state) : update;
      const changed = (Object.keys(patch) as (keyof S)[]).some((k) => !Object.is(patch[k], state[k]));
      if (!changed) return;
      const previous = state;
      state = { ...state, ...patch };
      for (const listener of listeners) listener(state, previous);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Subscribe a component to a slice of the store. The selector should return a field or another
 * value that keeps its identity while unchanged (not a freshly built object), or React re-renders forever.
 */
export function useStore<S extends object, T>(store: Store<S>, selector: (state: S) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.get()),
    () => selector(store.get()),
  );
}
