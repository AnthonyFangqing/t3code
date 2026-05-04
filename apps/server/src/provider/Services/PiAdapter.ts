/**
 * PiAdapter — shape type for the Pi provider adapter.
 *
 * Bundled per-instance as a captured closure by {@link ../Drivers/PiDriver}.
 *
 * @module PiAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * PiAdapterShape — per-instance Pi adapter contract. Carries a branded
 * driver kind as the nominal discriminant.
 */
export interface PiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
