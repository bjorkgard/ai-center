// Every constant of the estimation model (PLAN section 2), in one place. All of them are
// invented, not measured: the numbers they produce are labelled `estimated`.

// [estimated] Idle draw of one rack, kW.
export const IDLE_KW = 0.8;
// [estimated] Extra kW per token/min of a rack's session and its subagents.
export const KW_PER_TOKEN_PER_MIN = 0.004;
// [estimated] A rack never draws more than this, kW.
export const RACK_MAX_KW = 40;
// [estimated] Rack inlet temperature at zero load, °C.
export const INLET_BASE_C = 22;
// [estimated] Inlet rise per kW of rack draw, °C.
export const INLET_C_PER_KW = 0.25;
// [estimated] Hot aisle rise over the inlet at full rack load, °C.
export const HOT_AISLE_DELTA_C = 12;
// [estimated] Time constant of the inlet's first-order lag, seconds.
export const LAG_TAU_S = 30;
// [estimated] Heat the cooling plant removes at 100% duty, kW per placed hall.
export const HALL_COOLING_CAPACITY_KW = 400;
// [estimated] A session with no event for this long has ended, ms.
export const IDLE_END_MS = 30 * 60_000;
// Halls A and B always exist (D8): the floor for the number of placed halls.
export const MIN_PLACED_HALLS = 2;
// The trailing window of tokens/min, in one-second buckets.
export const RATE_WINDOW_S = 60;
