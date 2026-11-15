/**
 * The pacing plan for the current course and inputs, computed in the core worker. The planner
 * watches the app store: a new elevation profile gets its plan right away, and input changes
 * (goal, plan type, pace changes, shortest segment, split, breakpoints, units) are debounced, so dragging the slider or typing a
 * goal sends one request once the input settles. A newer request aborts the one before it, so a
 * stale plan never lands over a fresh one. The plan in view stays up, marked pending, until the
 * new one arrives.
 */
import type { ElevationProfile, Plan, PlanSegment } from "@pp/core";
import { suggestedGoalS } from "../plan/inputs.ts";
import type { CoreOps } from "../worker/protocol.ts";
import { coreClient } from "../worker/client.ts";
import type { CallOptions } from "../worker/rpc.ts";
import { type AppState, appStore } from "./app.ts";
import { readyProfile } from "./focus.ts";
import { type Store, createStore, useStore } from "./store.ts";

/** Quiet time after the last input change before the plan is recomputed. */
export const PLAN_DEBOUNCE_MS = 120;

/** Performance marks around a recompute, read by `e2e/tests/plan-perf.spec.ts`. */
export const PLAN_REQUEST_MARK = "pp:plan-request";
export const PLAN_RENDERED_MARK = "pp:plan-rendered";
/** From sending the request to the new plan being on screen (worker time, both messages and React). */
export const PLAN_RECOMPUTE_MEASURE = "pp:plan-recompute";

export interface PlanView {
  /** The profile the plan is for; null when no course has its elevation yet. */
  profile: ElevationProfile | null;
  /** The latest plan for `profile`, or null before the first arrives (or when the inputs failed). */
  plan: Plan | null;
  /** Why the latest inputs have no plan (for example a goal too fast for the course's descents). */
  error: string | null;
  /** A recompute for newer inputs is waiting or running; `plan` is for the inputs before. */
  pending: boolean;
}

const EMPTY: PlanView = { profile: null, plan: null, error: null, pending: false };

export const planStore: Store<PlanView> = createStore<PlanView>(EMPTY);

export function usePlanView<T>(selector: (view: PlanView) => T): T {
  return useStore(planStore, selector);
}

/** The goal the plan uses: the one entered, else the suggestion for the course. */
export function effectiveGoalS(state: Pick<AppState, "goalTimeS">, profile: ElevationProfile): number {
  return state.goalTimeS ?? suggestedGoalS(profile.course.points.at(-1)?.distM ?? 0);
}

type PlanInputs = CoreOps["plan"]["input"]["inputs"];

/** The inputs the plan type uses: the others stay out, so changing them recomputes nothing. */
export function inputsFor(state: AppState, profile: ElevationProfile): PlanInputs {
  const goalTimeS = effectiveGoalS(state, profile);
  const unit = state.units;
  switch (state.planType) {
    case "optimal":
      return { type: "optimal", goalTimeS, unit, paceChanges: state.paceChanges, minSegmentM: state.minSegmentM };
    case "even":
      return { type: "even", goalTimeS, unit, paceChanges: 0 };
    case "splits":
      return { type: "splits", goalTimeS, unit, paceChanges: 0, splitM: state.splitM };
    case "custom":
      return { type: "custom", goalTimeS, unit, paceChanges: 0, breakpointsM: state.breakpointsM };
  }
}

const sameBreakpoints = (a: readonly number[] = [], b: readonly number[] = []) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const sameInputs = (a: PlanInputs, b: PlanInputs) =>
  a.type === b.type &&
  a.goalTimeS === b.goalTimeS &&
  a.paceChanges === b.paceChanges &&
  a.unit === b.unit &&
  a.minSegmentM === b.minSegmentM &&
  a.splitM === b.splitM &&
  sameBreakpoints(a.breakpointsM, b.breakpointsM);

const sameBounds = (a: readonly PlanSegment[], b: readonly PlanSegment[]) =>
  a.length === b.length && a.every((s, i) => s.startIndex === b[i]?.startIndex);

/** The message for a plan the worker could not compute. */
export function planErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/too fast for this course's descents/.test(message)) {
    return "This goal is too fast for the course's steepest descents. Try a slower goal.";
  }
  return "The plan could not be worked out for these settings. Try changing one of them.";
}

export interface PlannerOptions {
  store?: Store<AppState>;
  plans?: Store<PlanView>;
  /** Sends the plan op; defaults to the core worker. */
  call?: (input: CoreOps["plan"]["input"], options: CallOptions) => Promise<Plan>;
  debounceMs?: number;
}

/** Start keeping `planStore` in step with the app store. Returns the function that stops it. */
export function startPlanner(options: PlannerOptions = {}): () => void {
  const store = options.store ?? appStore;
  const plans = options.plans ?? planStore;
  const call = options.call ?? ((input, opts) => coreClient().call("plan", input, opts));
  const debounceMs = options.debounceMs ?? PLAN_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let wanted: { profile: ElevationProfile; inputs: PlanInputs } | undefined;

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    controller?.abort();
    controller = undefined;
  };

  const send = (profile: ElevationProfile, inputs: PlanInputs) => {
    timer = undefined;
    controller?.abort();
    const current = new AbortController();
    controller = current;
    performance.clearMarks(PLAN_REQUEST_MARK);
    performance.mark(PLAN_REQUEST_MARK);
    call({ course: profile.course, inputs }, { signal: current.signal }).then(
      (plan) => {
        if (current.signal.aborted) return;
        controller = undefined;
        const before = plans.get().plan;
        plans.set({ plan, error: null, pending: false });
        const selected = store.get().selectedSegment;
        if (selected !== null && !(before && sameBounds(before.segments, plan.segments))) {
          store.set({ selectedSegment: null });
        }
      },
      (error: unknown) => {
        if (current.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        controller = undefined;
        console.error("Could not compute the plan", error);
        plans.set({ plan: null, error: planErrorMessage(error), pending: false });
        store.set({ selectedSegment: null });
      },
    );
  };

  const update = (state: AppState) => {
    const profile = readyProfile(state.course);
    if (!profile) {
      cancel();
      wanted = undefined;
      plans.set(EMPTY);
      return;
    }
    const inputs = inputsFor(state, profile);
    if (wanted && wanted.profile === profile && sameInputs(wanted.inputs, inputs)) return;
    const fresh = wanted?.profile !== profile;
    wanted = { profile, inputs };
    if (fresh) {
      // A new course: its plan replaces nothing, so ask right away.
      cancel();
      plans.set({ profile, plan: null, error: null, pending: true });
      send(profile, inputs);
      return;
    }
    plans.set({ pending: true });
    clearTimeout(timer);
    timer = setTimeout(() => send(profile, inputs), debounceMs);
  };

  const unsubscribe = store.subscribe((state) => update(state));
  update(store.get());
  return () => {
    unsubscribe();
    cancel();
    wanted = undefined;
  };
}
