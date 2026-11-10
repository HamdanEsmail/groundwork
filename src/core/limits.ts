import { PRICES } from "./spend";

// Every cap and tunable in one place (spec 7). Change a limit here, nowhere else.

/** Most steps one Agent run may take. */
export const AGENT_MAX_STEPS = 14;
/** Longest one Agent run may last, in seconds. */
export const AGENT_MAX_DURATION_SECONDS = 170;
/** Monitors Groundwork may hold at once (the TinyFish plan allows 24; the rest stay free for the siblings). */
export const MAX_MONITORS = 10;
/** Curated demo addresses (admin-added, never expire). */
export const CURATED_ADDRESSES = 3;

/** Watch slots open to the public at one time. */
export const PUBLIC_WATCH_SLOTS = 4;
/** Days a public watch lasts before it expires. */
export const PUBLIC_WATCH_TTL_DAYS = 7;
/** Dossiers one visitor (hashed IP) may build per UTC day. */
export const PUBLIC_DOSSIERS_PER_IP_PER_DAY = 3;
/** Agent upgrades one visitor may request per UTC day. */
export const PUBLIC_UPGRADES_PER_IP_PER_DAY = 1;
/** Watches one visitor may start per UTC day. */
export const PUBLIC_WATCHES_PER_IP_PER_DAY = 1;

/** A dossier younger than this is returned instead of rebuilt. */
export const CACHE_HOURS = 24;
/** Days a public dossier is kept (rows and evidence) unless it is watched. */
export const PUBLIC_DOSSIER_TTL_DAYS = 7;
/** Days before a flood probe that found nothing is tried again. */
export const FLOOD_RETRY_DAYS = 7;

/** Retries of an atlas read that came back incomplete or failed transiently. */
export const FETCH_RETRY_ON_LOADING = 3;
/** Wait between those retries, in milliseconds. */
export const FETCH_RETRY_DELAY_MS = 10000;
/** Most rows kept per list in a deep read. */
export const DEEP_ROWS_MAX = 100;

/** Total spend (USD) at which public Agent upgrades pause; curated and admin dossiers keep running. */
export const PUBLIC_AGENT_PAUSE_USD = 6;
/** Total spend (USD) at which every paid TinyFish call pauses. */
export const SPEND_PAUSE_USD = 8;

/** Maximum cost of one section run. */
export const AGENT_SECTION_MAX_USD = AGENT_MAX_STEPS * PRICES.agent_step;
