import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const googleAntigravityApi = (): ProviderStreams => lazyApi(() => import("./google-antigravity.ts"));
