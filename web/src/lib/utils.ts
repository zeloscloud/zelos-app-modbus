/** Tiny dependency-free helpers every layer is allowed to reach for. Nothing
 *  here may import a component, a hook, or sonner — `lib/codec` and
 *  `lib/watch-store` depend on it. */

import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn-style class-name merger. `clsx` for conditional joins, `tailwind-merge`
 *  to resolve Tailwind class conflicts (later classes win). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** The message off anything a `catch` can hand you. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
