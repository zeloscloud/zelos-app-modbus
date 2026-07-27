/** shadcn-style class-name merger. `clsx` for conditional joins, `tailwind-merge`
 *  to resolve Tailwind class conflicts (later classes win). */

import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
