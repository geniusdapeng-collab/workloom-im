/** 随服务端制品审核的巡检行业适配器目录。 */
import type { InspectionAdapterRegistration } from "../service/inspection-adapter.js";
import { hotelInspectionAdapter } from "./hotel/inspection-adapter.js";

export const BUNDLED_INSPECTION_ADAPTERS: readonly InspectionAdapterRegistration[] = Object.freeze([
  Object.freeze({
    adapter: hotelInspectionAdapter,
    bundleIds: Object.freeze(["hotel"]),
  }),
]);
